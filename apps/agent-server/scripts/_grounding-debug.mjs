// 调试：流式打印「你是谁」的全部事件，定位为何返回空。
const BASE = "http://localhost:8787";
const jar = [];
async function post(path, body, withCookie) {
  const headers = { "content-type": "application/json" };
  if (withCookie && jar.length) headers.cookie = jar.join("; ");
  const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of setCookies) jar.push(c.split(";")[0]);
  return res;
}
(async () => {
  const convId = (await (await post("/chat/conversations", { agentId: "movie" }, false)).json()).conversation.id;
  const text = process.argv[2] || "你是谁？";
  console.log("TEXT:", text, "CONV:", convId);
  const res = await post("/chat/stream", { text, conversationId: convId, agentId: "movie" }, true);
  if (!res.body) { console.log("NO BODY", res.status); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "text") { full += ev.text; console.log(`[text] len=${ev.text.length}`); }
        else if (ev.type === "tool_call") console.log(`[tool_call] ${ev.name || ""}`);
        else if (ev.type === "tool_result") console.log(`[tool_result] ${String(ev.text || "").slice(0, 60)}`);
        else if (ev.type === "confirmation_required") console.log(`[confirm] ${ev.callId}`);
        else if (ev.type === "done") console.log(`[done] full_len=${full.length}`);
        else if (ev.type === "error") console.log(`[ERROR] ${JSON.stringify(ev).slice(0, 300)}`);
        else console.log(`[${ev.type}]`);
      } catch { console.log("[nonjson]", line.slice(0, 80)); }
    }
  }
  console.log("FINAL FULL:", JSON.stringify(full));
})().catch((e) => console.error("FAIL", e));
