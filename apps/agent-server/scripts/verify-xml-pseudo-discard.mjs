// 验证选项 A：XML 形态伪调用在响应层被丢弃（不累积进 text / 不进 toolCalls）
// 用本地 HTTP 服务器注入 SSE 流模拟弱模型退化输出 <tool_call><function=call_api>...，
// 走真实 callAgent（openai 分支）代码路径，断言 text 为空、toolCalls 为空，
// 从而 understand 节点看到空 text → 触发首轮 [workflow/tool-calling] retry。
//
// 运行：node --import tsx scripts/verify-xml-pseudo-discard.mjs

import http from "node:http";
import { callAgent } from "../src/models.ts";

const PORT = 18759;

// 模拟弱模型（laguna 系）退化输出：把 call_api 写成 <tool_call> 伪 XML 文本
const XML_STREAM = [
  `data: {"choices":[{"delta":{"content":"<tool_call>\\n"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"<function=call_api>\\n"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"<parameter=operation>\\nsystemUser_page\\n"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"</parameter>\\n<parameter=params>\\n{\\n"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"\\"pageNum\\": 2,\\n\\"pageSize\\": 20\\n}\\n"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"</parameter>\\n</function>\\n</tool_call>"}}]}\n\n`,
  `data: [DONE]\n\n`,
].join("");

// 对照：正常 function calling 通道（应提取到 toolCalls，text 为空）
// 真实 OpenAI 兼容端点 tool_calls 首片即带 id（models.ts 合并处 filter 要求 acc.id 存在）
const SCHEMA_STREAM = [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"call_api","arguments":"{\\"method\\":\\"GET\\",\\"operation\\":\\"dataReport/clickhouseTotal.getList\\",\\"base\\":\\"user\\",\\"params\\":{\\"eventNames\\":\\"apk_2026_IndiaA_castleappz_212\\"}}"}}]}}]}\n\n`,
  `data: [DONE]\n\n`,
].join("");

function makeServer(kind) {
  return http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const body = kind === "xml" ? XML_STREAM : SCHEMA_STREAM;
    res.end(body);
  });
}

const model = {
  id: "verify",
  label: "verify",
  provider: "openai",
  name: "verify-model",
  baseUrl: `http://localhost:${PORT}`,
  apiKey: "x",
  apiKeys: ["x"],
  vision: "none",
  timeoutMs: 10000,
  contextChars: 16000,
  tools: true,
  agentCapable: true,
};

const tools = [
  { name: "call_api", description: "call", inputSchema: { type: "object", properties: {} } },
  { name: "search_api_module", description: "s", inputSchema: { type: "object", properties: {} } },
];

async function run(kind) {
  const server = makeServer(kind);
  await new Promise((r) => server.listen(PORT, r));
  try {
    const result = await callAgent(model, [{ role: "user", content: "查询 clickhouse 数据统计，事件名：apk_2026_IndiaA_castleappz_212" }], [], tools, [], undefined, {});
    return result;
  } finally {
    server.close();
  }
}

let pass = 0;
let total = 0;

total++;
{
  const r = await run("xml");
  const ok = r.text.trim() === "" && r.toolCalls.length === 0;
  if (ok) pass++;
  console.log(`${ok ? "✅" : "❌"} XML伪调用丢弃: text=${JSON.stringify(r.text)} toolCalls=${r.toolCalls.length}`);
  if (!ok) console.log(`   detail=${JSON.stringify(r).slice(0, 300)}`);
}

total++;
{
  const r = await run("schema");
  const ok = r.toolCalls.length === 1 && r.toolCalls[0].name === "call_api";
  if (ok) pass++;
  console.log(`${ok ? "✅" : "❌"} 正常schema通道: text=${JSON.stringify(r.text)} toolCalls=${r.toolCalls.map((t) => t.name).join(",")}`);
  if (!ok) console.log(`   detail=${JSON.stringify(r).slice(0, 300)}`);
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
