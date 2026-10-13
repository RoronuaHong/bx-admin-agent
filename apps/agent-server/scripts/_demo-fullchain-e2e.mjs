// 全链路 E2E：验证「技能 + 自定义连接器(MCP)」——模型先 read_skill 读 demo-greeter，再调用 demo 连接器的 demo_greet。
// 用法：node scripts/_demo-fullchain-e2e.mjs [modelSlotId] [demoMcpPort]
import process from "node:process";

const model = process.argv[2] || "ds4flash0731";
const mcpPort = Number(process.argv[3] || 8911);
const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";

let cookie = "";
async function api(path, method, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length) cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log("== 0) 清理上次残留（幂等，可重复跑）==");
const delSkill = await api("/skills/demo-greeter", "DELETE");
console.log("cleanup skill:", delSkill.status);
const delMcp = await api("/chat/mcp/custom/demo", "DELETE");
console.log("cleanup connector:", delMcp.status);

console.log("== 1) 创建对话 ==");
const conv = await api("/chat/conversations", "POST", { title: "demo 全链路验证" });
const convId = conv.json?.conversation?.id || conv.json?.id;
if (!convId) { console.error("建对话失败:", conv.status, conv.text.slice(0, 300)); process.exit(1); }
console.log("convId=", convId);

console.log("== 2) 创建本地技能 demo-greeter ==");
const skillBody = `# Demo Greeter 技能

当用户要求「演示 demo」或「演示 demo-greeter 技能」时使用本技能。

步骤：
1. 调用 read_skill 工具读取本技能（名称 demo-greeter）的完整说明——你已经看到这段，这是演示。
2. 调用 MCP 工具 mcp__demo__demo_greet，把用户的原始问题作为 message 参数传入。
3. 把工具返回的 greeting 与 echoed 整理成一句中文给用户，并说明这是通过 demo 连接器拿到的数据。`;
const skillRes = await api("/skills", "POST", {
  dir: "demo-greeter",
  name: "Demo Greeter",
  description: "演示技能：技能 + 自定义连接器全链路。",
  roles: [],
  body: skillBody,
});
console.log("skill:", skillRes.status, skillRes.json?.skill?.dir || skillRes.text.slice(0, 150));
if (!skillRes.json?.skill?.dir) { console.error("建技能失败，终止（残留旧技能会导致读到重复 frontmatter）"); process.exit(1); }

console.log("== 3) 添加自定义连接器 demo（HTTP）==");
const customRes = await api("/chat/mcp/custom", "POST", {
  id: "demo",
  label: "Demo MCP",
  url: `http://127.0.0.1:${mcpPort}/mcp`,
});
console.log("custom:", customRes.status, customRes.json?.ok ?? customRes.text.slice(0, 150));

console.log("== 4) 在对话里启用 demo 连接器 + demo-greeter 技能 ==");
const enMcp = await api("/chat/mcp/servers", "PUT", { conversationId: convId, enabled: ["demo"] });
console.log("enable mcp:", enMcp.status, enMcp.json?.enabled ?? enMcp.text.slice(0, 120));
const enSkill = await api("/chat/skills", "PUT", { conversationId: convId, enabled: ["demo-greeter"] });
console.log("enable skill:", enSkill.status, enSkill.json?.ok ?? enSkill.text.slice(0, 120));

console.log("== 5) 流式对话：触发 read_skill + mcp__demo__demo_greet ==");
const prompt =
  "请演示 demo-greeter 技能：先调用 read_skill 工具读取 demo-greeter 的完整说明，" +
  "然后严格按照说明调用 demo 连接器的 demo_greet 工具（把本句原话作为 message 传入），最后用中文告诉我结果。";
const streamRes = await fetch(`${base}/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ text: prompt, model, conversationId: convId }),
});
if (!streamRes.ok) { console.error("stream HTTP", streamRes.status, await streamRes.text()); process.exit(1); }
const setCookies = streamRes.headers.getSetCookie?.() ?? [];
if (setCookies.length) cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

const reader = streamRes.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let answer = "";
const calls = [];
const results = [];
let modelEcho = "";
const start = Date.now();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const payload = line.trim();
    if (!payload.startsWith("{")) continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.type === "text_delta") answer += ev.text;
      if (ev.type === "model" && ev.id) modelEcho = ev.id;
      if (ev.type === "tool_call") calls.push(`${ev.name}${ev.server ? `(${ev.server})` : ""}`);
      if (ev.type === "tool_result") results.push({ name: ev.name, ok: ev.ok, text: (ev.text || "").slice(0, 120) });
      if (ev.type === "error") answer += `\n[error] ${JSON.stringify(ev).slice(0, 200)}`;
    } catch { /* ignore */ }
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nmodel=${modelEcho || "?"} elapsed=${elapsed}s`);
console.log("tool_calls:", JSON.stringify(calls));
console.log("tool_results:", JSON.stringify(results));
console.log(`answer(${answer.length} chars):\n${answer.slice(0, 800)}`);

const hasReadSkill = calls.some((c) => c.startsWith("read_skill"));
const hasDemoTool = calls.some((c) => c.startsWith("mcp__demo__demo_greet"));
console.log("\n== 结论 ==");
console.log("技能链路(read_skill):", hasReadSkill ? "PASS" : "FAIL");
console.log("连接器链路(mcp__demo__demo_greet):", hasDemoTool ? "PASS" : "FAIL");
console.log("有最终回答:", answer.trim() ? "PASS" : "FAIL");
process.exit(hasReadSkill && hasDemoTool && answer.trim() ? 0 : 2);
