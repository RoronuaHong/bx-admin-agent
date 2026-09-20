// 详细探针：dump 观影助手一次问答的全部事件（含 error / usage），定位最终回复为空的根因。
// 运行：node scripts/_movie-probe-detail.mjs
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
const sid = globalThis.crypto?.randomUUID?.() || `probe-${Date.now()}`;
let cookie = `bx_agent_sid=${sid}`;
const PROMPT = process.env.MOVIE_E2E_PROMPT || "10部恐怖搞笑电影，高分，不同国家";
const MODEL = process.env.MOVIE_E2E_MODEL || "";

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/bx_agent_oid=([^;]+)/);
  if (m) cookie = `${cookie}; bx_agent_oid=${m[1]}`;
  return { status: res.status, body: await res.json().catch(() => null) };
}

const conv = await postJson("/chat/conversations", { agentId: "movie", title: "probe-detail" });
const id = conv.body?.conversation?.id;
console.log(`[probe] 对话 ${id}，MCP=${JSON.stringify(conv.body?.conversation?.mcpServers)}`);
console.log(`[probe] 提问：${PROMPT}\n`);

const started = Date.now();
const res = await fetch(`${BASE}/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ conversationId: id, agentId: "movie", text: PROMPT, ...(MODEL ? { model: MODEL } : {}) }),
});
console.log(`[probe] stream HTTP ${res.status}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let lastTextEvent = "";
let deltaLen = 0;
const counts = {};
const toolCalls = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n");
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    counts[ev.type] = (counts[ev.type] || 0) + 1;
    if (ev.type === "text_delta") deltaLen += String(ev.text || "").length;
    else if (ev.type === "text") lastTextEvent = String(ev.text || "");
    else if (ev.type === "error") console.log(`  !! error: ${JSON.stringify(ev).slice(0, 400)}`);
    else if (ev.type === "usage") console.log(`  usage: ${JSON.stringify(ev)}`);
    else if (ev.type === "tool_call") toolCalls.push(ev.name);
    else if (ev.type === "model") console.log(`  model: ${ev.label}`);
  }
}
console.log(`\n[probe] 事件统计: ${JSON.stringify(counts)}`);
console.log(`[probe] tool 调用(${toolCalls.length}): ${toolCalls.join(", ")}`);
console.log(`[probe] text_delta 累计字符=${deltaLen}`);
console.log(`[probe] 最终 text 事件字符=${lastTextEvent.length}`);
console.log(`[probe] 耗时=${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`\n----最终回复(前 1200 字符)----\n${lastTextEvent.slice(0, 1200)}`);
