// M1 自然问法路由评测：验证「未显式分步指令」时模型是否会先 route_to_agent，
// 以及选对 domain；模糊句是否走反问而非硬猜。
//
// 机制前提（2026-09-05 完善）：未路由时仅 META 工具可见 → 模型必须先路由才能取数/检索。
//
// 判定（不写死业务词匹配用户句；只断言工具通道行为）：
//   backend 期望：出现 route_to_agent 且 domain=backend-api
//   knowledge 期望：route_to_agent domain=knowledge，且未成功执行后台 call_api
//   explain 期望：submit_understood_intent.responseMode=explain-capability，且未成功执行 call_api
//   clarify 期望：request_clarification，且未成功执行 call_api / search_knowledge_base
//
// 运行：node scripts/eval-m1-routing-natural.mjs
// 环境：AGENT_BASE、A2A_COUNTRY/A2A_USER/A2A_PASS、可选 A2A_MODEL
// 过滤：M1_CASE_FILE（默认同目录 .cases.json）、M1_CASE_IDS=id1,id2、M1_CASE_TAGS=multilingual,explain
// 每案前 POST /chat/context/clear 清空 Worker，保证独立。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.AGENT_BASE || "http://localhost:8787";
const COUNTRY = process.env.A2A_COUNTRY || "india";
const USER = process.env.A2A_USER || "admin";
const PASS = process.env.A2A_PASS || "123456";
const MODEL = process.env.A2A_MODEL || "";
const __dirname = dirname(fileURLToPath(import.meta.url));
const CASE_FILE = resolve(__dirname, process.env.M1_CASE_FILE || "./eval-m1-routing-natural.cases.json");
const ENABLE_CASES = /^(1|true|yes)$/i.test(String(process.env.M1_ENABLE_CASES || ""));
const FILTER_IDS = new Set(
  String(process.env.M1_CASE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const FILTER_TAGS = new Set(
  String(process.env.M1_CASE_TAGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.M1_DRY_RUN || ""));

/** @typedef {"backend" | "knowledge" | "explain" | "clarify"} ExpectKind */
/** @typedef {{ id: string; text: string; expect: ExpectKind; lang?: string; tags?: string[] }} RoutingCase */

/** @returns {RoutingCase[]} */
function loadCases() {
  const raw = JSON.parse(readFileSync(CASE_FILE, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`case file 不是数组：${CASE_FILE}`);
  return raw
    .map((c) => ({
      id: String(c.id || "").trim(),
      text: String(c.text || "").trim(),
      expect: String(c.expect || "").trim(),
      lang: c.lang ? String(c.lang).trim() : undefined,
      tags: Array.isArray(c.tags) ? c.tags.map((x) => String(x).trim()).filter(Boolean) : [],
    }))
    .filter((c) => c.id && c.text && ["backend", "knowledge", "explain", "clarify"].includes(c.expect));
}

const CASES = !ENABLE_CASES
  ? []
  : loadCases().filter((c) => {
      if (FILTER_IDS.size && !FILTER_IDS.has(c.id)) return false;
      if (FILTER_TAGS.size && !c.tags?.some((t) => FILTER_TAGS.has(t))) return false;
      return true;
    });

function log(...a) {
  console.log(...a);
}

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ country: COUNTRY, username: USER, password: PASS }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login failed ${res.status}: ${JSON.stringify(data)}`);
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/bx_agent_sid=([^;]+)/);
  if (!m) throw new Error("login 无 bx_agent_sid");
  return m[1];
}

async function clearContext(cookie) {
  const res = await fetch(`${BASE}/chat/context/clear`, {
    method: "POST",
    headers: { cookie: `bx_agent_sid=${cookie}` },
  });
  if (!res.ok) throw new Error(`context/clear ${res.status}`);
}

async function streamChat(cookie, text) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.M1_CASE_TIMEOUT_MS || 240000));
  try {
    const res = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `bx_agent_sid=${cookie}` },
      body: JSON.stringify(MODEL ? { text, model: MODEL } : { text }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`chat/stream ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

function isRejectedResult(result) {
  const r = typeof result === "string" ? result : JSON.stringify(result ?? "");
  return r.includes("不允许调用") || r.includes("不在本 Worker") || r.includes("拒绝");
}

function isSuccessfulToolResult(events, name) {
  return events.some(
    (e) =>
      e.type === "tool_result" &&
      e.name === name &&
      !isRejectedResult(e.result) &&
      !(typeof e.result === "string" && e.result.startsWith("错误：")),
  );
}

function summarize(events) {
  const toolCalls = events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({ name: e.name, input: e.input || {} }));
  const routes = toolCalls.filter((c) => c.name === "route_to_agent");
  const domains = routes.map((c) => String(c.input?.domain || "")).filter(Boolean);
  const clarified = toolCalls.some((c) => c.name === "request_clarification");
  const understood = toolCalls.find((c) => c.name === "submit_understood_intent");
  const responseMode = understood?.input?.responseMode ? String(understood.input.responseMode) : "";
  const callApiOk = isSuccessfulToolResult(events, "call_api");
  const kbOk =
    isSuccessfulToolResult(events, "search_knowledge_base") ||
    isSuccessfulToolResult(events, "search_dingtalk_doc");
  return { toolCalls, domains, clarified, responseMode, callApiOk, kbOk };
}

function judge(expect, s) {
  if (expect === "knowledge") {
    const routedKb = s.domains.includes("knowledge");
    // 知识类应进入 knowledge 路径，且未成功执行后台 call_api（越权/误路由）
    const ok = (routedKb || s.kbOk) && !s.callApiOk;
    return {
      ok,
      detail: `routeDomains=${s.domains.join("|") || "-"} kbOk=${s.kbOk} callApiOk=${s.callApiOk}`,
    };
  }
  if (expect === "backend") {
    const routedBe = s.domains.includes("backend-api");
    // 路由到 backend-api；允许尚未取到数（定位失败），但不得成功跑 knowledge 检索冒充完成
    const ok = routedBe && !s.kbOk;
    return {
      ok,
      detail: `routeDomains=${s.domains.join("|") || "-"} callApiOk=${s.callApiOk} kbOk=${s.kbOk}`,
    };
  }
  if (expect === "explain") {
    const ok = s.responseMode === "explain-capability" && !s.callApiOk;
    return {
      ok,
      detail: `responseMode=${s.responseMode || "-"} routeDomains=${s.domains.join("|") || "-"} callApiOk=${s.callApiOk} kbOk=${s.kbOk}`,
    };
  }
  // clarify：当前实现允许服务端直接根据 understood 生成澄清文本，因此不再强依赖 request_clarification 事件
  const ok = (s.responseMode === "clarify" || s.clarified) && !s.callApiOk && !s.kbOk;
  return {
    ok,
    detail: `responseMode=${s.responseMode || "-"} clarified=${s.clarified} callApiOk=${s.callApiOk} kbOk=${s.kbOk} route=${s.domains.join("|") || "-"}`,
  };
}

(async () => {
  if (!ENABLE_CASES) {
    log(`[skip] 评测集已暂时关闭；如需启用，请设置 M1_ENABLE_CASES=1。file=${CASE_FILE}`);
    process.exit(0);
  }
  if (!CASES.length) throw new Error(`没有匹配的用例：file=${CASE_FILE}`);
  if (DRY_RUN) {
    log(`[dry-run] cases=${CASES.length} file=${CASE_FILE}`);
    for (const c of CASES) {
      log(`- ${c.id} | expect=${c.expect} | lang=${c.lang || "-"} | tags=${(c.tags || []).join(",")}`);
    }
    process.exit(0);
  }
  const cookie = await login();
  log(`[login] OK  cases=${CASES.length} model=${MODEL || "default"} file=${CASE_FILE}`);
  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    await clearContext(cookie);
    log(`\n----- ${c.id} expect=${c.expect} -----`);
    log(`prompt: ${c.text}`);
    let events;
    try {
      events = await streamChat(cookie, c.text);
    } catch (e) {
      fail++;
      log(`FAIL | ${c.id} | ${e.message || e}`);
      continue;
    }
    const s = summarize(events);
    const names = s.toolCalls.map((t) => t.name);
    log(`tools: ${JSON.stringify(names)}`);
    const { ok, detail } = judge(c.expect, s);
    if (ok) {
      pass++;
      log(`PASS | ${c.id} | ${detail}`);
    } else {
      fail++;
      log(`FAIL | ${c.id} | ${detail}`);
    }
  }

  log(`\n========== M1 自然问法路由：${pass} PASS / ${fail} FAIL / ${CASES.length} total ==========`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(2);
});
