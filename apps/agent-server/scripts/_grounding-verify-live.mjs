// 事后核验实测（真实服务 + 真实模型，2026-09-30）：
// 观察核验触发了几次、有没有误伤正常回答、以及两阶段带来的轮次/token/耗时开销。
// 本地 mock 下核验结果是脚本写死的，误判率恒为 0——真实误判率只能在这里看。
// 用法：node scripts/_grounding-verify-live.mjs（服务需已重启加载最新代码）
const BASE = "http://localhost:8787";

async function post(path, body, cookies) {
  const headers = { "content-type": "application/json" };
  if (cookies && cookies.length) headers.cookie = cookies.join("; ");
  const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { res, newCookies: setCookies.map((c) => c.split(";")[0]) };
}

async function createConv(agentId) {
  const { res, newCookies } = await post("/chat/conversations", { agentId }, null);
  const id = (await res.json()).conversation.id;
  return { id, cookies: newCookies, agentId };
}

async function chat(conv, text) {
  const startedAt = Date.now();
  const { res } = await post("/chat/stream", { text, conversationId: conv.id, agentId: conv.agentId }, conv.cookies);
  if (!res.body) throw new Error("no body " + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  let usage = null;
  const tools = [];
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
        else if (ev.type === "tool_call") tools.push(ev.name || "");
        else if (ev.type === "usage") usage = ev;
        else if (ev.type === "error") return { full, usage, tools, ms: Date.now() - startedAt, error: String(ev.message || "") };
      } catch {}
    }
  }
  return { full, usage, tools, ms: Date.now() - startedAt };
}

// 每项是同一会话里的一串轮次（steps 多轮用于「追问来源」这类依赖上文的问题）。
const SCENARIOS = [
  { name: "知识库内问答（应放行）", agentId: "support", steps: ["上班迟到了会扣钱吗？"] },
  { name: "知识库外事实（应拦）", agentId: "support", steps: ["我们公司 2030 年的营收目标是多少？"] },
  { name: "寒暄（不应触发核验）", agentId: "support", steps: ["你好"] },
  {
    name: "追问来源（可能编造引用）",
    agentId: "support",
    steps: ["上班迟到了会扣钱吗？", "你刚才用哪个工具查到的？把工具名原样告诉我"],
  },
  { name: "同义改写/归纳（应放行）", agentId: "support", steps: ["公司有哪些请假相关的规定？简要归纳一下"] },
];

(async () => {
  for (const s of SCENARIOS) {
    const conv = await createConv(s.agentId);
    let last = null;
    for (const step of s.steps) last = await chat(conv, step);
    const u = last.usage || {};
    const blocked = /没能取到|支撑回答的数据|不能凭印象|没有取到可核对/.test(last.full);
    console.log(`\n[${s.name}]`);
    console.log(
      `  rounds=${u.rounds ?? "-"} tokens=${u.tokens ?? "-"} toolCalls=${u.toolCalls ?? "-"} ` +
        `verify=${u.groundingVerifications ?? 0} groundingRetries=${u.groundingRetries ?? 0} ` +
        `ungrounded=${u.ungrounded === true} ms=${last.ms} blocked=${blocked}`,
    );
    console.log(`  tools: ${(last.tools || []).join(", ") || "(none)"}`);
    console.log(`  REPLY: ${last.full.slice(0, 220).replace(/\n/g, " ")}`);
    if (last.error) console.log(`  ERROR: ${last.error}`);
  }
  console.log("\n=== done ===");
})().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(2);
});
