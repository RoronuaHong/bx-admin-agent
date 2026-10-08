// 原生 SQL 只读判定的服务端入口。
//
// **单一可信来源在 scripts/sql-readonly-common.mjs**：本文件只做再导出，逻辑不在这一份里——
// 避免 TS 侧与 MCP 适配器（scripts/metabase-mcp.mjs）各写一份导致口径漂移。
// 改白名单 / 黑名单 / 危险构造 / 多语句规则，只改 common 模块（见该文件顶部注释）。
//
// 调用方（src/risk.ts）仍按 `source=sql-readonly` 对非只读 SQL 硬拒，与 MCP 适配器那道构成纵深防御。
export { isReadOnlySql } from "../scripts/sql-readonly-common.mjs";
