# bi-mcp —— 业务取数（Metabase）MCP 集成规范

> 现行（live）集成规范，对应 `scripts/metabase-mcp.mjs`（stdio MCP，`server.name = "bi-metabase"`）。相关的取数/口径/探查技能见 `skills/business-data-query`、`skills/metric-caliber-check`、`skills/schema-probe`。

## 1. 概述

业务取数走 **Metabase**（BI 平台），通过 `scripts/metabase-mcp.mjs` 这个 **stdio MCP server** 接入，serverId 在 `.env` 的 `MCP_BUILTIN_SERVERS` 中为 `bi`，工具命名空间 `mcp__bi__*`。

- 把 Metabase REST API（仪表盘、卡片/提问、数据库元数据、原生 SQL）暴露为 MCP 工具。
- 鉴权：请求头 `X-API-Key`（Metabase API Key）。**优先用只读账号 Key**（`BI_READONLY_API_KEY`）。生产环境未配置只读 Key 时拒绝连接，不回落 `BI_API_KEY`；开发环境仍可回落。真正的只读边界仍须数据库/账号层用专用角色 `GRANT SELECT` 强制（适配器层只是「以只读身份访问」，不是只读保证）。
- `mcp__bi__*` 是**接地证据工具**（外部数据源，`isGroundingEvidenceTool` 判真，见 `tests/grounding-guard.test.ts`），即这些工具返回算「外部数据证据」。

## 2. 接入与配置

- 经 `.env` 的 `MCP_BUILTIN_SERVERS`（JSON 数组，serverId `bi`）声明 → `mcp/config.ts` 加载 → `mcp/hub.ts` 以 `StdioClientTransport` 拉起 `metabase-mcp.mjs` 并连接。
- 环境变量（由父进程 `.env` 继承，脚本不落凭据）：`BI_BASE_URL`（实例地址）、`BI_API_KEY` / `BI_READONLY_API_KEY`、`BI_TIMEOUT_MS`（默认 30000；BI 查询可能很慢，可调大）。
- 单次请求超时 fail-closed：超时返回可操作提示（但 DB 上 SQL 仍在跑，彻底掐断需 DB 层 `statement_timeout`）。

## 3. 工具清单（来自 `scripts/metabase-mcp.mjs`）

| 工具 | 作用 | 只读性 |
|---|---|---|
| `list_databases` | 列出可用数据库 | 只读（元数据） |
| `get_database_schema` | 某库的表/字段结构（`mode=mschema` 出紧凑 M-Schema；`with_values=true` 可选补实测取值域，默认关闭、会增加首拉延迟） | 只读（元数据） |
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

## 7. 关联关系（FK）现状与优化方案（已实施）

> **状态：A1 / A2 / A3 / A4（技能侧）/ A5 已落地**（2026-11-02，commit `4bdd3bb` "feat(metabase): 新增表外键关联工具与整库元数据缓存"）。本节保留最初的现状分析与方案推导，其中 §7.1、§7.2 描述的是**实施前**的状态，§7.3/§7.4/§7.5 标注了每条的实际落地情况。
> **仍未做**：前置项 B（Metabase 后台确认 FK 定义正确）需管理员在 Metabase 侧核查；A4 的第二半（`construct_query` 阶段回灌 `references` 正向提示）未做——`JOIN_DANGLING_REF` 负向校验维持「不依赖 FK」不变。

### 7.1 实施前的现状：Metabase 的关联关系数据「可取却没用好」

Metabase 的表间关联（外键 / FK）其实**已经可取**：DB 级 `/database/{id}/metadata` 返回的每个字段带 `fk_target_field_id`，`metabase-mcp.mjs` 的 `mapField`（`scripts/metabase-mcp.mjs` L179–188）已把它解析成 `references: "table.field"`。但现状是：

- **没有专门的「关系图」工具**：`TOOLS`（`scripts/metabase-mcp.mjs` L333–1055）里**没有** `get_table_relationships` / `get_foreign_keys` 之类工具；FK 只作为每个字段的一个属性散落，无聚合出口。
- **技能不引导模型用 FK 选 join key**：`skills/business-data-query/SKILL.md` L18、L28 只让模型用 `search_columns` 扫列名 + `DESCRIBE` 确认关联键，不提 `references`。
- **完全没有元数据缓存**：结果缓存 `queryCache` 只缓存 `db + 规范化SQL + limit`（见 `bi-query-cache.mjs`），不治元数据；每轮实时重拉整库 metadata（实测 47 张表，见 `docs/text2sql-text2api-plan.md` L111）。
- **三处实现不一致**（代码级，见 §7.3 的 A3）：`get_field_values` 不带 `skip_fields` 就拉全量字段（L513）；`read_resource(type:"table")` 却用 `skip_fields=true`（L1033）→ 字段永远为空；`buildFieldIndex(tables)` 每次调用都全库遍历（L155，调用点 L401 / L1043）。

### 7.2 实施前观察到的摩擦（实证）

1. **关联发现靠猜**：跨表 JOIN 的关联键不是由 FK 得出，而是 `search_columns` 按列名子串跨集群扫（`metabase-column-search.mjs` 拼 ClickHouse `system.columns` 的 SQL）+ 人工 `DESCRIBE` 确认。文档原话"单一元数据工具被调 24 次，27 轮预算大半耗在重复探查"。
2. **冗余调用撑爆上下文**：每轮向 Metabase 重拉全库 metadata，既费 token 又打 BI。
3. **最危险失效 = join 路径错**（文档原话）：查询跑通、结果看着合理，但 join 路径错或漏了过滤条件。现在只靠执行后回显 SQL + `JOIN_DANGLING_REF` 负向校验兜底，**没用 FK 主动防错**（`JOIN_DANGLING_REF` 明确「不依赖运行时 schema，避免 FK 误报」，见 `docs/text2sql-text2api-plan.md` L500）。

### 7.3 优化方向（每条带证据；落地情况已标注）

**A1｜新增专用关系工具 `get_table_relationships`** ✅ 已实施
一次性读 `/database/{id}/metadata`，输出 join 图（边：`子表.列 → 父表.列`）。让"两张表怎么连"成为**直接答案**，替代列名猜测。FK 已在 `mapField` 解析，但无聚合出口。收益：直击"关联发现靠猜"。风险：低（只读聚合）。
落地：工具已进 `TOOLS`（`scripts/metabase-mcp.mjs` L1087 起），`skills/business-data-query/SKILL.md` L18 已写明「写跨表 JOIN 前先用它对关联键」。

**A2｜加内存元数据缓存**（按 `database_id` 缓存 `metadata` + 预建 `fieldIndex`，复用 `queryCache` 的 TTL/容量模式） ✅ 已实施
消除每轮重拉 47 表的冗余调用。证据：`get_database_schema` / `get_field_values` / `read_resource` 每次实时拉。收益：最高（省上下文 + 省往返）。**风险：需 TTL + 失效开关**——技能指出 Metabase 元数据常同步不全，缓存会放大陈旧，必须短 TTL + 手动 invalidate。
落地：`getDatabaseMetadata()` 统一走缓存（TTL 由 `BI_METADATA_TTL_MS` 控制，默认 120s）；本地始终存全量，`skip_fields` 只是 API 侧减负、按需克隆裁字段，不污染缓存本体。

**A3｜修两处 bug（无争议）** ✅ 已实施
- `get_field_values` 改用缓存 + 只展开目标表；
- `read_resource(type:"table")` 不再 `skip_fields=true`，字段/FK 真的返回。
证据见 §7.1。收益：立竿见影、零副作用。

**A4｜让 FK `references` 驱动 JOIN 构造** ◐ 部分实施
在 `SKILL.md` 引导模型优先用 `references` 作 join key（与 `search_columns` 互补）——**已做**（SKILL.md L18）；可在 `construct_query` 阶段把 `references` 作为**正向提示**回灌——**未做**（与现有 `JOIN_DANGLING_REF` 负向校验并存，后者仍「不依赖 FK」，避免误报）。收益：直击"join 路径错"。风险：须保留既有护栏，FK 只作建议、不作硬校验。

**A5｜一次性 `buildFieldIndex`**（含在 A2 内） ✅ 已实施：缓存命中后复用，不再每次全库遍历。

**B｜确认 Metabase 自身 FK 已正确定义**（前置、非代码） ⬜ 未做（需管理员）
若 Metabase 里这些表的外键**根本没定义或定义错了**，A1–A4 都无从谈起。需管理员在 Metabase 后台核实：相关表（尤其事实表 ↔ `elt_user_full`）的 FK 是否已建立且指向正确列。这是代码优化的**前提**。

### 7.4 落地顺序与实际结果

| 优先级 | 动作 | 性质 | 风险 | 实际 |
|---|---|---|---|---|
| P0 | **B：先确认 Metabase FK 定义正确** | 配置核查 | —（前提） | ⬜ 待管理员在 Metabase 后台核实 |
| P1 | **A3 修两处 bug** + **A1 新增关系工具** | 代码 | 极低 / 低 | ✅ 已落地（commit `4bdd3bb`） |
| P2 | **A2 + A5 元数据缓存（带 TTL/失效）** | 代码 | 中（陈旧性） | ✅ 已落地（TTL 120s，可用 `BI_METADATA_TTL_MS` 调） |
| P3 | **A4 FK 引导 + construct_query 正向提示** | 技能+代码 | 中（须保留护栏） | ◐ 技能侧已落地；`construct_query` 回灌未做 |

实际执行顺序与建议一致（P0 核查未做、P1/P2 已做），风险面未扩大：`JOIN_DANGLING_REF` 负向校验未被触动，FK 仍只作建议不作硬校验。

### 7.5 原待确认问题与结论

1. 是否认可「先 B 核查 Metabase FK、再动代码」的顺序？→ **认可且已按此执行**（B 仍是唯一未完成项，且不阻塞已落地的 A1–A3/A5）。
2. A2 缓存是否接受带 TTL？→ **接受**：换取省上下文/省往返，代价是潜在陈旧，用短 TTL（120s）+ `BI_METADATA_TTL_MS` 可调来控制。
3. A4 把 `references` 写进 JOIN 指引？→ **同意，已写入**（只作建议，不与护栏冲突）；`construct_query` 回灌暂缓。
4. 是否需要整理 P0 的 FK 核查清单？→ **待办**：需先确认要核对的表清单（尤其事实表 ↔ `elt_user_full`），再产出给 Metabase 管理员逐条核对。
