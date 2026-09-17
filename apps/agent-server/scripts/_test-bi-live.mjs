import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["scripts/metabase-mcp.mjs"],
  cwd: process.cwd(),
  env: { ...process.env },
});
const client = new Client({ name: "tester", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS=" + tools.tools.length);
const res = await client.callTool({ name: "list_databases", arguments: {} });
const text = res.content.map((c) => c.text).join("\n");
console.log("LIST_DATABASES isError=" + Boolean(res.isError));
console.log(text.slice(0, 3000));
await client.close();
