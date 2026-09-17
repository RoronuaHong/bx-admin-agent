// 通用 MCP server 探针：只连一次，列出工具并（可选）调用一个工具，用于接入前验证。
// 用法：node scripts/_probe-mcp-server.mjs <command> [args...] [--call <toolName>] [--arg k=v]... [--args <json>]
// 例：  node scripts/_probe-mcp-server.mjs node scripts/yapi-mcp.mjs --call list_projects --arg group_id=257
// 说明：--arg 用 key=value（值自动识别 true/false/数字），比 --args 的 JSON 更适合 PowerShell（双引号会被吞）。
//      子进程继承当前进程环境（含 apps/agent-server/.env，由 dotenv 预加载）。
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const FLAGS = ["--call", "--args", "--arg", "--args-file"];
const firstFlag = argv.findIndex((a) => FLAGS.includes(a));
const cmdArgs = argv.slice(0, firstFlag >= 0 ? firstFlag : argv.length);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : "");
const callName = flag("--call");
const callArgs = {};
if (flag("--args")) Object.assign(callArgs, JSON.parse(flag("--args")));
if (flag("--args-file")) Object.assign(callArgs, JSON.parse(readFileSync(flag("--args-file"), "utf8")));
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== "--arg") continue;
  const [k, ...rest] = String(argv[i + 1] || "").split("=");
  const raw = rest.join("=");
  if (!k) continue;
  callArgs[k] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

if (!cmdArgs.length) {
  console.error(
    "用法：node scripts/_probe-mcp-server.mjs <command> [args...] [--call <tool>] [--arg k=v]... [--args <json>] [--args-file <json文件>]",
  );
  process.exit(2);
}

const [command, ...args] = cmdArgs;
const transport = new StdioClientTransport({
  command,
  args,
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "bx-probe", version: "1.0.0" }, { capabilities: {} });

const stderrChunks = [];
transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

try {
  await client.connect(transport, { timeout: 30_000 });
  const { tools } = await client.listTools(undefined, { timeout: 30_000 });
  console.log(`connected: ${command} ${args.join(" ")}`);
  console.log(`tools(${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
  console.log("--- tools detail ---");
  for (const t of tools) console.log(`* ${t.name}: ${t.description || ""}`);

  if (callName) {
    console.log(`--- call ${callName} ${JSON.stringify(callArgs)} ---`);
    const res = await client.callTool({ name: callName, arguments: callArgs }, undefined, { timeout: 60_000 });
    const text = (res.content || [])
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
    console.log(`isError=${Boolean(res.isError)}`);
    console.log(text.slice(0, 4000));
  }
} catch (err) {
  console.error(`probe failed: ${String(err?.message || err)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  const tail = stderrChunks.join("").trim().split("\n").slice(-12).join("\n");
  if (tail) console.error(`--- server stderr (last lines) ---\n${tail}`);
}
