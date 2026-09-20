// 观影助手活路径 e2e：复用合法会话 cookie + 回传 owner cookie（bx_agent_oid），避免归属校验 404。
// 运行：node scripts/_movie-e2e-now.mjs ["你的问题"]
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
const sid = globalThis.crypto?.randomUUID?.() || `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let cookie = `bx_agent_sid=${sid}`;
const PROMPT = process.argv[2] || "What is the movie Inception about?";
const MODEL = process.env.MOVIE_E2E_MODEL || "";

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  // 服务端可能签发 owner cookie（bx_agent_oid），回传以保持归属一致。
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/bx_agent_oid=([^;]+)/);
  if (m) cookie = `${cookie}; bx_agent_oid=${m[1]}`;
  return { status: res.status, body: await res.json().catch(() => null) };
}

const conv = await postJson("/chat/conversations", { agentId: "movie", title: "e2e-movie-now" });
const id = conv.body?.conversation?.id;
if (!id) {
  console.error(`建对话失败：HTTP ${conv.status} ${JSON.stringify(conv.body).slice(0, 300)}`);
  process.exit(2);
}
console.log(`[movie] 对话 ${id}，默认 MCP=${JSON.stringify(conv.body.conversation.mcpServers)}`);
console.log(`[movie] 提问：${PROMPT}\n`);

const res = await fetch(`${BASE}/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ conversationId: id, agentId: "movie", text: PROMPT, ...(MODEL ? { model: MODEL } : {}) }),
});
if (!res.ok) {
  const errBody = await res.text().catch(() => "");
  console.error(`stream 失败：HTTP ${res.status} ${errBody.slice(0, 300)}`);
  process.exit(2);
}
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let text = "";
const movieCalls = [];
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
    if (ev.type === "tool_call") {
      if (ev.name?.includes("movie")) {
        let arg = "";
        try { arg = JSON.stringify(JSON.parse(ev.args || "{}")).slice(0, 120); } catch {}
        movieCalls.push(`${ev.name}(${arg})`);
        console.log(`  → 调工具：${ev.name} ${arg}`);
      }
    } else if (ev.type === "tool_result" && ev.name?.includes("movie")) {
      console.log(`  ← 结果(${ev.ok ? "ok" : "ERR"})：${String(ev.text || "").slice(0, 160).replace(/\n/g, " ")}`);
    } else if (ev.type === "text") {
      text = ev.text;
    } else if (ev.type === "text_delta") {
      text += ev.text;
    }
  }
}
console.log(`\n电影工具调用次数：${movieCalls.length}`);
console.log(`最终回复：\n${text.slice(0, 800)}`);
const ok = movieCalls.length > 0;
console.log(`\n=== movie e2e ${ok ? "PASS(调用了真实工具)" : "FAIL(没调电影工具)"} ===`);
process.exit(ok ? 0 : 1);
