// span 埋点端到端检查（真实服务）：跑一次会调工具的对话 → 取该 run 的 span，
// 确认 llm / tool 两层都落了盘、且能按 runId 读回（含耗时与成败）。
// 用法：node scripts/_span-check.mjs（服务需已重启加载最新代码）
const BASE = "http://localhost:8787";

async function post(path, body, cookies) {
  const headers = { "content-type": "application/json" };
  if (cookies && cookies.length) headers.cookie = cookies.join("; ");
  return fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
}

(async () => {
  const convRes = await post("/chat/conversations", { agentId: "support" }, null);
  const cookies = (convRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]);
  const convId = (await convRes.json()).conversation.id;
  console.log("conv:", convId);

  const res = await post("/chat/stream", { text: "上班迟到了会扣钱吗？", conversationId: convId, agentId: "support" }, cookies);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
        if (ev.type === "tool_call") console.log("  tool_call:", ev.name);
        if (ev.type === "done") console.log("  done");
      } catch {}
    }
  }

  const runsRes = await fetch(`${BASE}/chat/trace/runs?limit=5`, { headers: { cookie: cookies.join("; ") } });
  const runs = (await runsRes.json()).runs || [];
  if (!runs.length) {
    console.log("还没有 run 记录");
    return;
  }
  const runId = runs[0].runId;
  console.log("runId:", runId, "rounds:", runs[0].rounds, "toolCalls:", runs[0].toolCalls);

  const spanRes = await fetch(`${BASE}/chat/trace/spans?runId=${encodeURIComponent(runId)}`, {
    headers: { cookie: cookies.join("; ") },
  });
  console.log("spans http:", spanRes.status);
  const spans = (await spanRes.json()).spans || [];
  for (const s of spans) {
    console.log(`  [${s.kind}] ${s.name || "-"} ${s.durationMs}ms ok=${s.ok}${s.error ? ` err=${s.error}` : ""}`);
  }
  const kinds = new Set(spans.map((s) => s.kind));
  console.log(`=== kinds: ${[...kinds].join(",") || "(none)"} · total ${spans.length} ===`);
})().catch((e) => {
  console.error("SPAN CHECK FAILED:", e);
  process.exit(2);
});
