// M1 自然问法路由评测：验证「未显式分步指令」时模型是否会先 route_to_agent，
// 以及选对 domain；模糊句是否走反问而非硬猜。
//
// 机制前提（2026-09-05 完善）：未路由时仅 META 工具可见 → 模型必须先路由才能取数/检索。
//
// 判定（不写死业务词匹配用户句；只断言工具通道行为）：
//   backend 期望：出现 route_to_agent 且 domain=backend-api
//   knowledge 期望：route_to_agent domain=knowledge，且未成功执行后台 call_api
//   clarify 期望：request_clarification，且未成功执行 call_api / search_knowledge_base
//
// 运行：node scripts/eval-m1-routing-natural.mjs
// 环境：AGENT_BASE、A2A_COUNTRY/A2A_USER/A2A_PASS、可选 A2A_MODEL
// 每案前 POST /chat/context/clear 清空 Worker，保证独立。

const BASE = process.env.AGENT_BASE || "http://localhost:8787";
const COUNTRY = process.env.A2A_COUNTRY || "india";
const USER = process.env.A2A_USER || "admin";
const PASS = process.env.A2A_PASS || "123456";
const MODEL = process.env.A2A_MODEL || "";

/** @type {Array<{ id: string; text: string; expect: "backend" | "knowledge" | "clarify" }>} */
const CASES = [
  { id: "kb-policy", text: "公司年假制度是怎样的？", expect: "knowledge" },
  { id: "kb-attend", text: "考勤制度里迟到怎么处理？", expect: "knowledge" },
  { id: "biz-list", text: "帮我查一下用户列表前两页", expect: "backend" },
  { id: "biz-detail", text: "查一下基础配置列表", expect: "backend" },
  { id: "ambiguous", text: "查一下", expect: "clarify" },
];

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
  const callApiOk = isSuccessfulToolResult(events, "call_api");
  const kbOk =
    isSuccessfulToolResult(events, "search_knowledge_base") ||
    isSuccessfulToolResult(events, "search_dingtalk_doc");
  return { toolCalls, domains, clarified, callApiOk, kbOk };
}

function judge(expect, s) {
  if (expect === "knowledge") {
    const routedKb = s.domains.includes("knowledge");
    // 路由到 knowledge，且未成功执行后台 call_api（越权/误路由）
    const ok = routedKb && !s.callApiOk;
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
  // clarify：必须反问；不得成功取数/检索
  const ok = s.clarified && !s.callApiOk && !s.kbOk;
  return {
    ok,
    detail: `clarified=${s.clarified} callApiOk=${s.callApiOk} kbOk=${s.kbOk} route=${s.domains.join("|") || "-"}`,
  };
}

(async () => {
  const cookie = await login();
  log(`[login] OK  cases=${CASES.length} model=${MODEL || "default"}`);
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
