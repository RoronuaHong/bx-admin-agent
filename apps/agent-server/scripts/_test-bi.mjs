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
const res = await client.listTools();
console.log("DISCOVERY_OK tools=" + res.tools.length);
console.log(res.tools.map((t) => "- " + t.name).join("\n"));
await client.close();
