// 观影数据源接线自检（只读）：走**我们自己的** MCP hub 与 .env 配置，验证「配置 → 连接 → 工具白名单」整链路。
// 与 _movie-mcp-probe.mjs 的分工：探针直连候选服务器（换源选型时用）；本脚本验证本仓配置在我们的 hub 下解析正确。
//
// 跑法：cd apps/agent-server && node --import tsx scripts/_movie-hub-check.mjs
import "dotenv/config";

const { loadServers } = await import("../src/mcp/config.js");
const { collectToolsDetailed } = await import("../src/mcp/hub.js");

const MOVIE = "movie";
const server = loadServers().find((s) => s.id === MOVIE);
if (!server) {
  console.log(`FAIL：.env 的 MCP_BUILTIN_SERVERS 里没有 id=${MOVIE} 的服务器`);
  process.exit(1);
}

const allow = server.tools || [];
console.log(
  `配置：transport=${server.transport} 命令=${server.command || "-"} url=${server.url || "-"} ` +
    `超时=${server.timeoutMs || "-"}ms 白名单=${allow.length ? allow.join(",") : "（未声明＝全部注入）"}`,
);

const collected = await collectToolsDetailed([MOVIE]);
const ready = collected.ready.find((item) => item.id === MOVIE);
const unavailable = collected.unavailable.map((item) => `${item.id}(${item.reason})`).join("|");
console.log(`连接：connected=${Boolean(ready)} 工具数=${ready?.tools ?? 0} 不可用=${unavailable || "-"}`);

const names = collected.tools.map((tool) => tool.name);
console.log(`注入模型的工具名（${names.length}）：`);
for (const name of names) console.log(`  - ${name}`);

// 断言：白名单里的工具一个不少，且没有白名单之外的工具被注入（收窄暴露面是这条配置的主要目的）。
const want = allow.map((tool) => `mcp__${MOVIE}__${tool}`);
const missing = want.filter((name) => !names.includes(name));
const extra = names.filter((name) => !want.includes(name));
const ok = Boolean(ready) && missing.length === 0 && extra.length === 0;
console.log(
  ok
    ? "\n=== movie-hub PASS（配置 → 连接 → 白名单全部一致） ==="
    : `\n=== movie-hub FAIL === 连接=${Boolean(ready)} 缺=${missing.join(",") || "-"} 多=${extra.join(",") || "-"}`,
);
process.exit(ok ? 0 : 1);
