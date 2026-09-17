// 以真实 MCP 客户端（StdioClientTransport，与 hub 同路径）调用每个工具，校验输出是否正确。
import "dotenv/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "tools-check", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(here, "metabase-mcp.mjs")],
  env: { ...process.env },
  stderr: "pipe",
});
transport.onerror = (e) => console.log(`[transport error] ${e}`);

await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools=${tools.length}: ${tools.map((t) => t.name).join(", ")}`);

async function call(name, args) {
  const t0 = Date.now();
  let res;
  try {
    res = await client.callTool({ name, arguments: args });
  } catch (err) {
    console.log(`\n=== ${name} → 抛错：${String(err?.message || err)}`);
    return "";
  }
  const text = (res.content || []).map((c) => c.text || "").join("\n");
  const head = text.slice(0, 600).split("\n").map((l) => `  ${l}`).join("\n");
  console.log(`\n=== ${name} ${args ? JSON.stringify(args) : ""} [${res.isError ? "ERR" : "ok"}] ${((Date.now() - t0) / 1000).toFixed(1)}s len=${text.length}\n${head}`);
  return text;
}

const dbText = await call("list_databases");
let dbId = 2;
try {
  const parsed = JSON.parse(dbText);
  if (Array.isArray(parsed) && parsed[0]?.id) dbId = parsed[0].id;
} catch {
  /* 保底 */
}

await call("get_database_schema", { database_id: dbId, search: "user" });
await call("get_database_schema", { database_id: dbId, table: "不存在的表" });
await call("search", { query: "用户", models: ["table", "card"], limit: 5 });
await call("list_cards", { limit: 3 });
await call("list_dashboards");
await call("get_dashboard", { dashboard_id: 4 });
await call("get_card", { card_id: 96 });
// 原生（native）类型卡片：应直接返回其 SQL，不经过编译
await call("get_card", { card_id: 338 });
await call("run_native_query", { database_id: dbId, query: "SELECT 1", limit: 5 });

await client.close();
console.log("\n[check done]");
