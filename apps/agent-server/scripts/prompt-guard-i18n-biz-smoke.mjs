/**
 * 多语言业务读链路实例冒烟（测试夹具，非服务端业务词写死）。
 * 意图对齐 chain-multirun read：「用户列表前3页」→ 各语种等价表述。
 * 判据：SSE 收束 + G1-G6（expectTools=call_api）+ 至少 1 张 table。
 *
 *   EVAL_COUNTRY=… EVAL_USER=… EVAL_PASS=… pnpm exec tsx scripts/prompt-guard-i18n-biz-smoke.mjs
 */
import { getRun, latestRunId } from "../src/trace.ts";
import { assertTraceGates, summarize } from "./eval-core.mjs";

const BASE = process.env.AGENT_BASE_URL || "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      country: process.env.EVAL_COUNTRY,
      username: process.env.EVAL_USER,
      password: process.env.EVAL_PASS,
    }),
  });
  const c = resp.headers.get("set-cookie")?.split(";")[0];
  if (!c) throw new Error(`login failed status=${resp.status}`);
  return c;
}

async function chat(cookie, text) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text, model: process.env.EVAL_MODEL || "auto" }),
  });
  if (resp.status !== 200 || !resp.body) {
    return { events: [], durMs: Date.now() - t0, fetchErr: `status=${resp.status}` };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { events, durMs: Date.now() - t0 };
}

function traceMetrics(runId) {
  const spans = runId ? getRun(runId) : [];
  const llm = spans.filter((s) => s.kind === "llm");
  return {
    rounds: llm.length,
    emptyRounds: llm.filter((s) => !s.usage).length,
    tokens: llm.reduce((a, s) => a + (s.usage?.totalTokens || 0), 0),
    tools: spans.filter((s) => s.kind === "tool").map((s) => s.name),
  };
}

/** 夹具：同一业务意图，多语种表述（本地评测层） */
const ALL_CASES = [
  { id: "zh", text: "用户列表前3页" },
  { id: "en", text: "Show the first 3 pages of the user list" },
  { id: "es", text: "Muestra las primeras 3 paginas de la lista de usuarios" },
  { id: "ar", text: "اعرض أول 3 صفحات من قائمة المستخدمين" },
  { id: "hi", text: "उपयोगकर्ता सूची के पहले 3 पेज दिखाएं" },
  { id: "ja", text: "ユーザー一覧の最初の3ページを表示して" },
];
const only = (process.env.I18N_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const cases = only.length ? ALL_CASES.filter((c) => only.includes(c.id)) : ALL_CASES;

if (!process.env.EVAL_COUNTRY || !process.env.EVAL_USER || !process.env.EVAL_PASS) {
  console.error("missing EVAL_COUNTRY/EVAL_USER/EVAL_PASS");
  process.exit(2);
}

let pass = 0;
for (const c of cases) {
  const cookie = await login();
  const before = latestRunId();
  const { events, durMs, fetchErr } = await chat(cookie, c.text);
  const runId = latestRunId() !== before ? latestRunId() : before;
  const m = traceMetrics(runId);
  const spans = getRun(runId);
  const gates = assertTraceGates({ spans, rejectMode: "observe", expectTools: ["call_api"] });
  const s = summarize(gates);
  const tables = events.filter((e) => e.type === "table").length;
  const finalText = [...events].reverse().find((e) => e.type === "text")?.text || "";
  const dataOk = tables >= 1;
  const ok = !fetchErr && s.pass === s.total && dataOk;
  if (ok) pass += 1;
  console.log(
    [
      ok ? "PASS" : "FAIL",
      c.id,
      `gates=${s.pass}/${s.total}`,
      `data=${dataOk}`,
      `tables=${tables}`,
      `rounds=${m.rounds}`,
      `empty=${m.emptyRounds}`,
      `tokens=${m.tokens}`,
      `dur=${durMs}ms`,
      fetchErr ? `fetchErr=${fetchErr}` : "",
      `tools=${(m.tools || []).join(",") || "-"}`,
      `final=${JSON.stringify(finalText.slice(0, 80).replace(/\n/g, " "))}`,
    ]
      .filter(Boolean)
      .join(" | "),
  );
  for (const g of gates.filter((g) => !g.ok)) {
    console.log(`       - FAIL gate ${g.name} | ${g.detail}`);
  }
  await sleep(3000);
}

console.log(`TOTAL ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
