// 临时脚本：验证「默认模型失败（402 额度耗尽）时候选链是否切到下一个可用模型」。
// 用完即删。用法：node scripts/_fallback-check.mjs [文字] [agentId]
const BASE = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const text = process.argv[2] || "推荐3部不同国家的科幻恐怖片，先查真实数据再答";
const agentId = process.argv[3] || "movie";

let cookie = "";
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (sc.length) {
    const parts = sc.map((c) => c.split(";")[0]).filter(Boolean);
    if (parts.length) cookie = parts.join("; ");
  }
  return res;
}

await req("/chat/preferences");
// 建对话时就带上 agentId：角色默认勾选的 MCP（如 movie → ["movie"]）才会生效。
const conv = await (
  await req("/chat/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "fallback-check", ...(agentId ? { agentId } : {}) }),
  })
).json();
const conversationId = conv.id || conv.conversation?.id;
// 等角色默认勾选的连接器连上（否则 movie 角色没有电影工具，问题会变成「没工具」而不是「模型」）。
for (let i = 0; i < 30; i += 1) {
  const st = await (await req(`/chat/mcp/servers?conversationId=${conversationId}`)).json();
  const ready = (st.available || []).filter((s) => (st.enabled || []).includes(s.id) && s.connected && s.tools > 0);
  if (!(st.enabled || []).length || ready.length) {
    if ((st.enabled || []).length) console.log("MCP ready:", ready.map((s) => `${s.id}(${s.tools})`).join(", "));
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log("PROMPT:", text, "| agentId:", agentId || "(generic)", "| conv:", conversationId);
const t0 = Date.now();
const res = await req("/chat/stream", {
  method: "POST",
  body: JSON.stringify({
    text,
    conversationId,
    ...(agentId ? { agentId } : {}),
    ...(process.env.AGENT_MODEL ? { model: process.env.AGENT_MODEL } : {}),
  }),
});
if (!res.ok || !res.body) {
  console.error("stream failed", res.status, await res.text().catch(() => ""));
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const models = [];
const counts = {};
let err = null;
let finalText = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    counts[ev.type] = (counts[ev.type] || 0) + 1;
    if (ev.type === "model") {
      models.push(ev.id + "/" + ev.label);
      console.log("  [model]", ev.id, ev.label);
    }
    if (ev.type === "tool_call") console.log("  [tool_call]", ev.name);
    if (ev.type === "error") {
      err = ev.message || JSON.stringify(ev.error);
      console.log("  [ERROR]", String(err).slice(0, 220));
    }
    if (ev.type === "usage") console.log("  [usage] modelFallbacks=", ev.modelFallbacks, "rounds=", ev.rounds, "toolCalls=", ev.toolCalls);
    if (ev.type === "text") finalText = ev.text;
  }
}
console.log("\n耗时", ((Date.now() - t0) / 1000).toFixed(1) + "s | 事件", JSON.stringify(counts));
console.log("模型事件（按顺序）:", models.join(" → "));
console.log("错误:", err ? "有" : "无");
console.log("文本:", finalText.slice(0, 200));
process.exit(err ? 2 : 0);
