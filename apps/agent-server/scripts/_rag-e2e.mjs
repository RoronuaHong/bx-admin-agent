// 活路径 e2e（真实模型 + 工具模式）：验证知识库检索工具与子代理独立事件维度。
// 前置：agent-server 已启动；本脚本自建对话并勾选内置 MCP 服务器（chart，只读）以进入工具模式。
// 运行：node --import tsx scripts/_rag-e2e.mjs
const BASE = process.env.E2E_BASE || "http://127.0.0.1:8787";
const OWNER = "e2eowner0001";
const cookie = `bx_agent_oid=${OWNER}`;

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function stream(conversationId, text) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ conversationId, text }),
  });
  if (!res.ok) throw new Error(`stream http ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) if (line.trim()) events.push(JSON.parse(line));
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

function summarize(events) {
  const types = {};
  const toolCalls = [];
  let text = "";
  for (const ev of events) {
    types[ev.type] = (types[ev.type] || 0) + 1;
    if (ev.type === "tool_call") toolCalls.push(ev.name);
    if (ev.type === "text") text = ev.text;
    if (ev.type === "text_delta") text += ev.text;
  }
  return { types, toolCalls, text: text.trim() };
}

async function scenario(name, prompt, expect) {
  const conv = await post("/chat/conversations", { title: `e2e-${name}` });
  const id = conv.body?.conversation?.id;
  if (!id) throw new Error(`建对话失败：${JSON.stringify(conv).slice(0, 200)}`);
  await patch(`/chat/conversations/${id}`, { mcpServers: ["chart"] });
  const t0 = Date.now();
  const events = await stream(id, prompt);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const s = summarize(events);
  const ok = expect(s, events);
  console.log(`\n=== ${name} (${secs}s) ${ok ? "PASS" : "FAIL"} ===`);
  console.log(`事件类型：${JSON.stringify(s.types)}`);
  console.log(`工具调用：${s.toolCalls.join(", ") || "（无）"}`);
  console.log(`最终回复：${s.text.slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
  return { events, summary: s };
}

// 场景 1：知识库检索 —— 答案只在文档里，模型应自主调用 search_knowledge 并标注来源。
await scenario(
  "rag",
  "忘记打卡了怎么办？公司制度里怎么规定的？请说明依据来源。",
  (s) => s.toolCalls.includes("search_knowledge") && /考勤|补卡/.test(s.text),
);

// 场景 2：子代理委派 —— 两个独立子任务并行，应出现 subagent_start/delta/end 独立事件维度。
await scenario(
  "subagent",
  "请用 task 工具同时委派两个子代理并行执行：第一个用 fs_write 把内容 SA-A 写入 /sa-a.txt，第二个用 fs_write 把内容 SA-B 写入 /sa-b.txt。完成后简要汇报两者的结果。",
  (s, events) => {
    const starts = events.filter((e) => e.type === "subagent_start");
    const ends = events.filter((e) => e.type === "subagent_end");
    return starts.length >= 1 && ends.length >= starts.length;
  },
);

console.log(`\n退出码：${process.exitCode || 0}`);
