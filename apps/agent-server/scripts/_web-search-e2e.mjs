// 活路径 e2e（真实模型 + 工具模式）：联网检索工具是否被真实调用并产出可引用来源。
// 前置：agent-server 已启动且配好 WEB_SEARCH_*（默认 searxng @ http://localhost:8888）；
//       本脚本自建对话并勾选内置 MCP 服务器（chart，只读）以进入工具模式。
// 运行：node --import tsx scripts/_web-search-e2e.mjs ["提问内容"]
// 判定：模型没调联网工具 → SKIP（模型行为不可控，不伪装通过）；调了但失败/无结果 → FAIL。
import assert from "node:assert/strict";

const BASE = process.env.E2E_BASE || "http://127.0.0.1:8787";
const cookie = `bx_agent_oid=${process.env.E2E_OWNER || "webe2e0001"}`;
const PROMPT = process.argv[2] || "帮我在网上查一下最近有什么关于人工智能的新闻，给出来源链接";

let pass = 0;
let skip = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    if (err && err.skip) {
      skip += 1;
      console.log(`SKIP ${name}: ${err.message}`);
      return;
    }
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
const skipped = (message) => Object.assign(new Error(message), { skip: true });

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function stream(conversationId, text) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ conversationId, text }),
    signal: AbortSignal.timeout(300_000),
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

const conv = await req("POST", "/chat/conversations", { title: "web-search-e2e" });
const id = conv.body?.conversation?.id;
assert.ok(id, `建对话失败：${JSON.stringify(conv).slice(0, 300)}`);
await req("PATCH", `/chat/conversations/${id}`, { mcpServers: ["chart"] });

const t0 = Date.now();
const events = await stream(id, PROMPT);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const searchResults = events.filter((ev) => ev.type === "tool_result" && ev.name === "web_search");
const fetchResults = events.filter((ev) => ev.type === "tool_result" && ev.name === "fetch_url");
let text = "";
for (const ev of events) {
  if (ev.type === "text") text = ev.text;
  if (ev.type === "text_delta") text += ev.text;
}
const answer = text.trim();

console.log(`\n=== 联网检索 e2e（${secs}s）===`);
console.log(`提问：${PROMPT}`);
console.log(`web_search 调用：${searchResults.length} 次；fetch_url 调用：${fetchResults.length} 次`);
console.log(`最终回复（前 300 字）：${answer.slice(0, 300) || "（空）"}\n`);

await check("模型自主调用联网检索工具", () => {
  if (!searchResults.length) throw skipped("模型本轮没有调用 web_search（模型行为不可控）");
});

await check("检索结果均成功且带真实链接", () => {
  if (!searchResults.length) throw skipped("未调用，无结果可校验");
  for (const item of searchResults) {
    assert.equal(item.ok, true, `检索失败：${String(item.text).slice(0, 200)}`);
    assert.match(item.text, /https?:\/\//, "检索结果里应含链接");
  }
  console.log(`  → 示例：${String(searchResults[0].text).split("\n").slice(0, 3).join(" | ")}`);
});

await check("最终回复引用了来源链接", () => {
  if (!searchResults.length) throw skipped("未调用，无法判断引用");
  assert.match(answer, /https?:\/\//, "最终回复应给出可核查的来源链接");
});

console.log(`\n结果：PASS ${pass} / SKIP ${skip}${process.exitCode ? " / FAIL" : ""}`);
