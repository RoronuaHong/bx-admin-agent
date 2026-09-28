# bi-mcp —— 业务取数（Metabase）MCP 集成规范

> 现行（live）集成规范，对应 `scripts/metabase-mcp.mjs`（stdio MCP，`server.name = "bi-metabase"`）。相关的取数/口径/探查技能见 `skills/business-data-query`、`skills/metric-caliber-check`、`skills/schema-probe`。

## 1. 概述

业务取数走 **Metabase**（BI 平台），通过 `scripts/metabase-mcp.mjs` 这个 **stdio MCP server** 接入，serverId 在 `.env` 的 `MCP_BUILTIN_SERVERS` 中为 `bi`，工具命名空间 `mcp__bi__*`。

- 把 Metabase REST API（仪表盘、卡片/提问、数据库元数据、原生 SQL）暴露为 MCP 工具。
- 鉴权：请求头 `X-API-Key`（Metabase API Key）。**优先用只读账号 Key**（`BI_READONLY_API_KEY`），没有才回落管理员 `BI_API_KEY`；真正的只读边界仍须数据库/账号层用专用角色 `GRANT SELECT` 强制（适配器层只是「以只读身份访问」，不是只读保证）。
- `mcp__bi__*` 是**接地证据工具**（外部数据源，`isGroundingEvidenceTool` 判真，见 `tests/grounding-guard.test.ts`），即这些工具返回算「外部数据证据」。

## 2. 接入与配置

- 经 `.env` 的 `MCP_BUILTIN_SERVERS`（JSON 数组，serverId `bi`）声明 → `mcp/config.ts` 加载 → `mcp/hub.ts` 以 `StdioClientTransport` 拉起 `metabase-mcp.mjs` 并连接。
- 环境变量（由父进程 `.env` 继承，脚本不落凭据）：`BI_BASE_URL`（实例地址）、`BI_API_KEY` / `BI_READONLY_API_KEY`、`BI_TIMEOUT_MS`（默认 30000；BI 查询可能很慢，可调大）。
- 单次请求超时 fail-closed：超时返回可操作提示（但 DB 上 SQL 仍在跑，彻底掐断需 DB 层 `statement_timeout`）。

## 3. 工具清单（来自 `scripts/metabase-mcp.mjs`）

| 工具 | 作用 | 只读性 |
|---|---|---|
| `list_databases` | 列出可用数据库 | 只读（元数据） |
| `get_database_schema` | 某库的表/字段结构（`skip_fields` 控制粒度） | 只读（元数据） |
| `get_field_values` | 取字段真实取值域（取证、避免把真实取值当脏数据） | 只读（元数据） |
| `list_cards` / `get_card` | 列出/获取已保存提问（含其 SQL 与口径） | 只读（元数据） |
| `list_dashboards` / `get_dashboard` | 列出/获取仪表盘（卡片数组 `dashcards`） | 只读（元数据） |
| `search` | 按关键字搜卡片/仪表盘/表 | 只读（元数据） |
| `run_native_query` | 在指定库执行原生 SQL（SELECT/WITH/SHOW/EXPLAIN 等），返回行列文本（默认 200 行，超长截断） | **受服务端只读闸约束（见 §4）** |

> 除 `run_native_query` 外，其余工具均为只读元数据/数据集查询，声明 `readOnlyHint: true`（服务端风险判定第 4 条据此免确认）。

## 4. 只读安全模型（sql-readonly 闸）

`run_native_query` 执行**任意 SQL**，效果取决于传入文本，因此**不声明 `readOnlyHint`**，交由服务端按 `toolRisks` / 未知兜底决定是否需要用户确认（与 yapi 适配器同一原则：声明事实而非放行）。

服务端 `src/sql-readonly.ts` 对 `run_native_query`（在 `readOnlySqlTools` 白名单内）做**硬编码只读判定，fail-closed**：
- 单条语句（分号分隔算多条 → 拒）；
- 首词白名单：`select` / `with` / `show` / `describe` / `desc` / `explain`；
- 全文黑名单：`insert` `update` `delete` `drop` `alter` `create` `truncate` `merge` `replace` `upsert` `grant` `revoke` `attach` `detach` `exec` `execute` `call` `copy` `load` `set` `reset`；
- 危险构造：`into outfile` / `load_file()` / `pg_read_file()` / `writable_schema` 等；
- 非只读 → `risk.ts` 直接判 `destructive` + `deny`（**硬拒**，双重保险，即便 MCP 适配器层被绕过/改坏仍拦一道）。
- 适配器侧 `metabase-mcp.mjs` 内有一份**同口径** `isReadOnlySql`（纵深防御：适配器粗筛 + 服务端硬拒）；改白/黑名单须两侧同步，否则口径漂移。

## 5. 关联的取数技能

- `skills/business-data-query`：业务取数主流程（先定口径 → 找存量口径 → 取证 → 取数 → 核对 → 交付；陌生表先 `get_field_values` 取证，查询只读、写操作会被硬拒）。
- `skills/metric-caliber-check`：口径核对（用 `list_cards`/`get_card` 取 SQL 与描述，必要时 `run_native_query` 跑最小验证 SQL + LIMIT）。
- `skills/schema-probe`：结构探查（大结构委派子代理，只带结论回来）。
- `skills/chart-visualization`：取数后调 `render_chart` 本地出图（数据须来自真实工具，禁编造）。

## 6. 与历史文档的关系

`docs/agent/` 历史文档中的「BI 查询」相关描述（如 `ENTERPRISE_ROADMAP` 的 BI 段）反映的是旧 PC 后台 Agent 形态；当前 BI 能力即本规范的 Metabase MCP 接入，属活跃集成。
