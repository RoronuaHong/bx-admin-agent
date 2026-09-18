// 电影 MCP 候选探针（只读）：握手 + 列工具 + 打印入参 schema + 可选真实调用。
// 用途：换源前确认真实工具名（写进 .env 的 tools 白名单）与返回形态（决定 SKILL.md 怎么描述）。
//
// 跑法：
//   cd apps/agent-server
//   node scripts/_movie-mcp-probe.mjs orca                 # 默认：远程托管，零 key
//   node scripts/_movie-mcp-probe.mjs tmdb                 # npx -y tmdb-mcp（需 TMDB_API_TOKEN）
//   node scripts/_movie-mcp-probe.mjs http://host/mcp      # 任意 Streamable HTTP 端点
//   node scripts/_movie-mcp-probe.mjs orca call <tool> '{"k":v}'   # 额外做一次真实调用（只读）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const target = process.argv[2] || "orca";
const CALL_TOOL = process.argv[3] === "call" ? process.argv[4] : "";
// 入参用 `k=v` 传（值按需转数字/布尔）：避免 PowerShell 剥掉内层双引号、也避免中文参数被控制台编码搞坏。
const CALL_ARGS = {};
for (const pair of process.argv.slice(5)) {
  const i = pair.indexOf("=");
  if (i < 0) continue;
  const k = pair.slice(0, i);
  const raw = pair.slice(i + 1);
  CALL_ARGS[k] = /^-?\d+$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
}

function makeTransport() {
  if (target === "orca") {
    return new StreamableHTTPClientTransport(new URL("https://orca-mcp.mmdju.workers.dev/mcp"));
  }
  if (target === "tmdb") {
    const t = new StdioClientTransport({ command: "npx", args: ["-y", "tmdb-mcp"], env: process.env, stderr: "pipe" });
    t.stderr?.on("data", (d) => {
      const s = String(d).trim();
      if (s) console.log(`[stderr] ${s.slice(0, 300)}`);
    });
    return t;
  }
  if (target.startsWith("http")) return new StreamableHTTPClientTransport(new URL(target));
  throw new Error(`未知目标：${target}`);
}

const timeout = (ms, label) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms));

const client = new Client({ name: "movie-probe", version: "0" }, { capabilities: {} });
const transport = makeTransport();

try {
  await Promise.race([client.connect(transport), timeout(30000, "connect")]);
  const info = client.getServerVersion();
  console.log(`[OK] 已连接：${target}  服务端=${info?.name || "?"} v${info?.version || "?"}`);

  const { tools } = await Promise.race([client.listTools(), timeout(30000, "listTools")]);
  console.log(`\n共 ${tools.length} 个工具：`);
  for (const t of tools) {
    const desc = String(t.description || "").replace(/\s+/g, " ").slice(0, 110);
    console.log(`  - ${t.name}  |  ${desc}`);
  }

  if (!CALL_TOOL) {
    console.log("\n--- 入参 schema（搜索/详情/相似/趋势类）---");
    for (const t of tools) {
      if (!/search|detail|similar|trend|top|chart|popular/i.test(t.name)) continue;
      console.log(`\n=== ${t.name} ===`);
      console.log(JSON.stringify(t.inputSchema));
    }
  }

  if (CALL_TOOL) {
    console.log(`\n=== call ${CALL_TOOL} ${JSON.stringify(CALL_ARGS)} ===`);
    const res = await Promise.race([client.callTool({ name: CALL_TOOL, arguments: CALL_ARGS }), timeout(60000, "callTool")]);
    const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    console.log(`isError=${Boolean(res.isError)}  长度=${text.length}`);
    console.log(text.slice(0, 1600));
  }
} catch (err) {
  console.log(`[FAIL] ${String(err?.message || err)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
