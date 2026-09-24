// 临时 e2e 探针：向观影助手（movie 角色，含 21 个 MCP 数据源工具）发一句寒暄，
// 验证「接地护栏」不再把「无需数据的问候」误判成「未接地」而拦截。
// 验收信号：最终回复里不得出现 UNGROUNDED_REPLY 的固定兜底文案。
const BASE = "http://localhost:8787";
const jar = [];

function cookieHeader() {
  return jar.join("; ");
}

async function post(path, body, withCookie) {
  const headers = { "content-type": "application/json" };
  if (withCookie && jar.length) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = res.headers.get?.("set-cookie");
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : raw ? [raw] : [];
  for (const c of setCookies) jar.push(c.split(";")[0]);
  return res;
}

async function createConv(agentId) {
  const res = await post("/chat/conversations", { agentId }, false);
  const j = await res.json();
  return j.conversation.id;
}

async function streamChat(convId, text, agentId, model) {
  const res = await post("/chat/stream", { text, conversationId: convId, agentId, ...(model ? { model } : {}) }, true);
  if (!res.body) throw new Error("no body " + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let rounds = 0;
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
        else if (ev.type === "done") return { full, rounds };
        else if (ev.type === "error") {
          console.error("STREAM ERROR", ev);
          return { full, rounds };
        }
      } catch {
        /* ignore non-json */
      }
    }
  }
  return { full, rounds };
}

(async () => {
  const model = process.env.PROBE_MODEL || undefined;
  console.log("model:", model || "(default)");
  const convId = await createConv("movie");
  console.log("convId:", convId);
  const { full, rounds } = await streamChat(convId, "你好，你是谁？", "movie", model);
  console.log("tool_rounds:", rounds);
  console.log("REPLY:", full);
  const blocked = /没能取到|不能凭印象|支撑回答的数据/.test(full);
  const selfId = /观影助手/.test(full);
  console.log(blocked ? "VERDICT: BLOCKED (false positive — guard wrongly intercepted a greeting)" : "VERDICT: PASSED (greeting not intercepted)");
  if (selfId) console.log("NOTE: model correctly self-identified as 观影助手");
})().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
