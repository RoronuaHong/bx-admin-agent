// Demo MCP 服务器（HTTP · StreamableHTTP，无状态）：用于验证「技能 + 自定义连接器」全链路。
// ⚠️ 纯演示：内存里就一个只读工具 demo_greet，没有真实数据、没有凭据。
// 启动：node scripts/demo-mcp.mjs   （默认监听 127.0.0.1:8911，可用 DEMO_MCP_PORT 覆盖）
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.DEMO_MCP_PORT || 8911);

const TOOLS = [
  {
    name: "demo_greet",
    description:
      "演示工具（只读）。传入一段消息，返回一句带时间戳的中文问候，并原样回显这条消息。" +
      "用于验证 MCP 自定义连接器能否被模型正常调用。",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "要回显的消息内容" },
      },
      required: ["message"],
    },
  },
];

const server = new Server({ name: "demo-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params || {};
  if (name !== "demo_greet") {
    return { content: [{ type: "text", text: JSON.stringify({ error: `未知工具 ${name}` }) }], isError: true };
  }
  const message = String(args.message || "").trim();
  const now = new Date().toISOString();
  const result = {
    greeting: `你好，这是来自 demo 连接器的问候（${now}）`,
    echoed: message,
    note: "本工具为只读演示工具，不接触任何真实数据",
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/mcp") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid json" }));
        return;
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[demo-mcp] listening on http://127.0.0.1:${PORT}/mcp`);
});
