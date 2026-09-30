// 多场景接地护栏探针：每会话独立 cookie，避免多会话 cookie 串台。
const BASE = "http://localhost:8787";
async function post(path, body, cookies) {
  const headers = { "content-type": "application/json" };
  if (cookies && cookies.length) headers.cookie = cookies.join("; ");
  const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const newCookies = setCookies.map((c) => c.split(";")[0]);
  return { res, newCookies };
}
async function createConv(agentId) {
  const { res, newCookies } = await post("/chat/conversations", { agentId }, null);
  const id = (await res.json()).conversation.id;
  return { id, cookies: newCookies, agentId };
}
async function streamChat(conv, text, agentId, model) {
  if (!agentId) agentId = conv.agentId;
  const { res } = await post("/chat/stream", { text, conversationId: conv.id, agentId, ...(model ? { model } : {}) }, conv.cookies);
  if (!res.body) throw new Error("no body " + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "", rounds = 0;
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
        if (ev.type === "text") full += ev.text;
        else if (ev.type === "tool_call") rounds++;
        else if (ev.type === "done") { const blocked = /没能取到|支撑回答的数据|不能凭印象|没取得任何数据源|本次没有取得/.test(full); return { full, rounds, blocked }; }
        else if (ev.type === "error") { console.error("STREAM ERROR", ev); return { full, rounds, blocked: false }; }
      } catch {}
    }
  }
  const blocked = /没能取到|支撑回答的数据|不能凭印象|没取得任何数据源|本次没有取得/.test(full);
  return { full, rounds, blocked };
}

const SCENARIOS = [
  { name: "[movie]问候", text: "你好", agentId: "movie" },
  { name: "[movie]问身份", text: "你是谁？你是哪个助手？", agentId: "movie" },
  { name: "[movie]超职责范围(天气)", text: "今天珠海天气怎么样？", agentId: "movie" },
  { name: "[movie]查不存在的电影", text: "查一下电影《不存在的影片xyz123》的简介", agentId: "movie" },
  { name: "[movie]正常取数基线", text: "推荐几部科幻电影", agentId: "movie" },
  { name: "[support]问候", text: "你好", agentId: "support" },
  { name: "[support]问身份", text: "你是哪个助手？", agentId: "support" },
  { name: "[support]制度问答(需知识库)", text: "上班迟到了会扣钱吗？", agentId: "support" },
];

(async () => {
  const model = process.env.PROBE_MODEL || undefined;
  console.log("model:", model || "(server default)");
  let pass = 0, fail = 0;
  for (const s of SCENARIOS) {
    const conv = await createConv(s.agentId);
    const { full, rounds, blocked } = await streamChat(conv, s.text, s.agentId, model);
    const empty = full.trim().length === 0;
    let verdict;
    if (blocked) verdict = "FAIL(被误拦成没取到数据)";
    else if (empty) verdict = "FAIL(空回复)";
    else verdict = "PASS";
    if (verdict.startsWith("PASS")) pass++; else fail++;
    console.log(`\n[${s.name}] rounds=${rounds} verdict=${verdict}`);
    console.log("  REPLY:", full.slice(0, 200).replace(/\n/g, " "));
  }
  console.log(`\n=== SUMMARY: ${pass} pass / ${fail} fail ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE FAILED:", e); process.exit(2); });
