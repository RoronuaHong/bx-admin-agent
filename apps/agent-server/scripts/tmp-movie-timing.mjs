// 临时诊断（跑完即删）：按事件逐条打时间戳，把观影角色一轮对话的耗时归到具体阶段。
// 用法：node scripts/tmp-movie-timing.mjs  （中文提问写死在文件里，避免 PowerShell 传参乱码）
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
const cookie = "bx_agent_oid=bx_movie_timing";
const PROMPT = process.argv[2] || "我先休息了";

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const conv = await post("/chat/conversations", { agentId: "movie", title: "timing" });
const id = conv.body?.conversation?.id;
if (!id) {
  console.error(`建对话失败 HTTP ${conv.status}`);
  process.exit(2);
}

const res = await fetch(`${BASE}/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ conversationId: id, agentId: "movie", text: PROMPT }),
});
console.log(`[${at()}] POST /chat/stream → HTTP ${res.status}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let firstText = null;
let firstThinking = null;
let text = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n");
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "thinking_delta") {
      firstThinking ??= at();
      continue; // 思考增量很密，只记首个
    }
    if (ev.type === "text_delta") {
      firstText ??= at();
      text += ev.text;
      continue;
    }
    if (ev.type === "text") text = ev.text;
    const brief =
      ev.type === "tool_call" ? `${ev.name} ${String(ev.args || "").slice(0, 80)}` : ev.type === "tool_result" ? `${ev.name} ok=${ev.ok !== false}` : "";
    console.log(`[${at()}] ${ev.type}${brief ? `  ${brief}` : ""}${ev.type === "usage" ? `  ${JSON.stringify(ev).slice(0, 160)}` : ""}`);
  }
}
console.log(`\n首个思考增量：${firstThinking || "-"}｜首个正文增量：${firstText || "-"}｜结束：${at()}`);
console.log(`最终回复：${text.trim().replace(/\n+/g, " ").slice(0, 200) || "（空）"}`);
