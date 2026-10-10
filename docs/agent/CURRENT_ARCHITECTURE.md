# 当前架构：Deep-Agent 框架（唯一权威）

> **版本**：基于 `apps/agent-server/src` 实际代码核对（2026-09-26）。
> **定位**：本文是 `docs/agent/` 下文档的**当前架构唯一权威**。本目录其余文件均为「PC 后台管理 Agent」历史快照，与当前代码已脱节，请勿照抄。
> **关联规划**：`docs/deep-agents-plan.md`（D1–D4 实施记录）、`docs/agent-infrastructure.md`（旧基础设施基线，已过时）。
> **范围**：不上多进程 Agent 集群、不接 A2A。进程内 `task` 只做上下文隔离。新领域顺序见 [`domain-adaptation-guide.md`](../domain-adaptation-guide.md) 文首；生产白名单与脚本来源见 [`mcp-guide.md`](../mcp-guide.md) §10。外部 Agent 不能共用这套设备 cookie、或某个领域要独立扩容时，再单独立项，先做 A2A Server。

## 0. 一句话

当前 `apps/agent-server` 是一个**领域无关的 deep-agent harness**（不是某个具体后台的管理 Agent）：核心是一个工具调用循环，外面挂了系统提示 / Skills、虚拟文件系统、todo 规划、子 Agent 委派、MCP，以及一套治理与安全层（审计 / 限流 / 风险 / 不可信内容护栏 / SQL 只读闸 / 接地门禁 / Trace / 成本）。**领域适配通过 `roles`（角色）+ `skills`（技能）+ `MCP 服务器` 完成，而非写死某个后台的模块/接口。**

> ⚠️ **核对说明**：本文描述的 `audit.ts` / `schedules.ts` 等治理能力当前仍为**未提交的工作树改动**；其余均为已纳入版本库的代码。治理层文件（`rate-limit` / `risk` / `cost` / `trace` / `untrusted`）的存在与职责已逐文件核实源码头部，细节以源码为准。

## 1. 核心循环

- `chat.ts`：`chatStream` / `runWithTools` —— `AsyncGenerator<ChatEvent>`；模型 → tool_calls → 执行（MCP/内置）→ 回灌 → 再调，单轮 ≤ `MCP_MAX_TOOL_ROUNDS=14` 轮。
- 事件流 `ChatEvent`：`text_delta` / `tool_call` / `confirmation_required` / `usage` / `subagent_start|delta|end` / `todos` / `done`。
- 对话级并发：`chat-tasks.ts`（任务注册表 `startTask`/`consumeTask`、运行中流、pending 队列、对话级 409）。

## 2. 能力层（D1–D4，已落地，依据 `docs/deep-agents-plan.md` §8）

| 期 | 能力 | 落点 |
|---|---|---|
| D1 | 系统提示 + Skills + Prompt Caching | `system-prompt.ts`（稳定前缀 `SAFETY_GUARDRAIL`+`TOOLING_RULES` + 动态后缀：记忆/历史摘要/回复语言）；`skills.ts`（skills 目录索引常驻、`read_skill` 按需注入全文）；`models.ts`（anthropic 通道对稳定段加 `cache_control: ephemeral`，openai 走隐式前缀缓存） |
| D2 | 虚拟文件系统 | `fs-store.ts`（磁盘 backend `.data/fs/<convId>/`，拒绝 `..`/绝对路径/反斜杠，单文件 256KB、每对话 100 文件）；工具结果超预算先卸载为 `results/<callId>.txt` 并留 `fs_read` 指针。工具：`fs_write`/`fs_edit`/`fs_ls`/`fs_read` |
| D3 | 任务规划 todo | `builtins.ts(write_todos)` + `conversation.todos` + NDJSON `todos` 事件 + 前端计划卡（✓/•/○/×） |
| D4 | 子 Agent 委派（通用型） | `builtins.ts(task)` + `chat.ts runLoop/runSubagent`：独立上下文（只看 description）+ 最小工具集（剔除 `task`/`write_todos`）+ `SUBAGENT_PROMPT` + 回传摘要（≤4000 字）+ 并行上限 3（worker 池）+ 取消级联（沿用主代理 signal）+ `SUBAGENT_MAX_ROUNDS=10` |

`task` 是同一次运行里的上下文隔离，不是多进程集群（Anthropic《Building effective agents》：上下文互相污染或必须并行、且只需要摘要时才拆子任务）。

| 场景 | 用什么 |
|---|---|
| 探陌生库结构、并行几路只读、主对话只要结论 | `task` |
| 分页列表按小时计数 | `count_list_by_time`。模型或子代理逐页累加会丢页 |
| 其它只读汇总 | `run_tool_code`。脚本进程里没有 MCP，不能拿来翻 MCP 分页 |
| 要确认的写操作、删文件、跑命令、改定时任务 | 留在主对话。定时运行会直接拒绝这些工具 |

当前 skills 目录（`apps/agent-server/skills/`）：`business-data-query` / `chart-visualization` / `metric-caliber-check` / `movie` / `pdf` / `schema-probe` / `support-salesiq` / `web-research`。索引按角色过滤：`movie`、`support-salesiq` 只出现在对应角色的系统提示里。

## 3. 治理与安全层

| 层 | 文件 | 职责（已核实源码头部） |
|---|---|---|
| 安全审计 | `audit.ts` | append-only JSONL（`.data/audit`）；决策：allowed/confirmed/denied/timeout/grant_read/subagent_refused/clarify_deferred/ownership_mismatch；凭据不落盘（仅脱敏摘要 + sha256） |
| 入口限流 | `rate-limit.ts` | 滑动窗口、进程内存、单实例；只拦 `/chat/stream`；key = owner cookie（与归属隔离同身份）；配 0 关闭 |
| 工具风险分级 | `risk.ts` | 工具危险度由「工具声明 + 服务端策略」决定，默认 fail-closed；判据来源含 `sql-readonly`；与 `builtins.ts` 的 `BUILTIN_RISK` 联动（如 `request_clarification`=read/workspace、`web_search`=read/workspace、`search_dingtalk_doc`=read/external） |
| 不可信内容护栏 | `untrusted.ts` | Prompt 注入防护（对齐 OWASP LLM01）：靠**结构隔离**而非词表——清洗不可见/危险控制符、每请求随机 nonce 定界并标注来源、中和伪造闭合标签；不检测自然语言 |
| SQL 只读闸 | `sql-readonly.ts` | `isReadOnlySql` fail-closed：首词白名单（select/with/show/describe/explain）+ 黑名单词 + 危险构造（`into outfile`/`load_file`/`pg_read_file`/`writable_schema`）；与 Metabase MCP 适配器纵深防御 |
| 接地门禁 | `grounding.ts` | 角色声明或本轮有外部数据源工具（`web_search`/`fetch_url`/`search_knowledge`/`mcp__*`）时开启。零证据且回答含事实断言 → 作废并回灌纠正；没有事实断言则放行 |
| 确认门 | `confirm.ts` + `toolNeedsConfirm` | 事件流内确认卡，队列在确认等待时暂停 |
| 运行追踪 | `trace.ts` | run 级 JSONL（runId/会话归属/模型/轮次/token/耗时/状态/错误），是排障、评测基线、成本聚合的地基 |
| 成本计量 | `cost.ts` | 只读聚合 `trace.ts` 落盘的 run 级记录；tokens 估算，单价 `COST_RATE_<模型ID大写>_PER_1K`，未配置记 `unpricedTokens`（如实显示「未定价」，不编造金额） |

> **完全访问模式（`fullAccess`）的姿态说明（已逐行核实源码；属既定产品决策，维持现状，仅记录在案）**
>
> `fullAccess` **缺省为 true（开箱即完全授权）**：`conversations.ts:259` 定义 `input.fullAccess ?? getRole(input.agentId).defaultFullAccess ?? true`；运行期取值 `conversation?.fullAccess ?? true`（`chat.ts:2895`）。（早期版本在新建会话处写死 `true`，现已改为角色默认优先，未配置角色默认仍 true。）
>
> 完全访问下**跳过一道闸（仅确认卡）**：`chat.ts:2068` 的二次确认卡带 `&& !ctx.fullAccess`；`chat.ts:1253` 注释据此说明。即开箱状态下，destructive 级操作**不弹确认卡、直接执行**（既定决策，见下文论证）。**注意：硬拒（deny）不在此列**——见下方「已修」段，deny 自 2026-10-06 起不受 fullAccess 影响。
>
> **这是既定决策而非缺陷**（对齐 CodeBuddy「完全访问模式」）：`risk.ts:198-204` 论证"闸门过密会制造确认疲劳，用户退化成橡皮图章，反而降低整体安全性"。可按对话关闭——`patchConversation` 支持该字段（`conversations.ts:437`），设 `false` 即恢复逐项确认。
>
> **不因完全访问而失效**：子代理范围闸（`chat.ts:2028`）、澄清期冻结（`2055`）、失败熔断、接地门禁、SQL 只读闸、不可信内容护栏、归属守卫、限流与审计留痕均照常生效（`chat.ts:1253`）。
>
> **硬拒（`deny`）已不受 `fullAccess` 影响（2026-10-06 已修，现于 `chat.ts:2042`）**：此前 chat.ts 写的是 `verdict.deny && !ctx.fullAccess`，
> 而 `fullAccess` 缺省为 true，于是硬拒在**默认配置下从不生效**——运维显式配置的 `MCP_UNKNOWN_TOOLS=deny`
> 被默认开关静默覆盖；`source=sql-readonly` 的原生 SQL 非只读硬拒同样被跳过，使「适配器粗筛 + 服务端硬拒」
> 这道纵深防御默认只剩适配器一层。现抽出 `risk.ts` 的 `isHardDenied(v)`（**签名里没有 fullAccess**，
> 结构上就不可能被完全访问豁免），chat.ts 改为 `if (isHardDenied(verdict))`。
>
> **未收紧的部分（刻意保持）**：确认卡跳过逻辑一行未动——`verdictNeedsConfirm` 仍只看级别，
> 是否弹卡仍由 `fullAccess` 决定。理由：确认疲劳（`risk.ts:198-204`）针对的是「要不要问人」，
> 而 `deny` 是「按运维写下的策略根本不该执行」，两者性质不同。完全访问的便利性原样保留。
>
> 回归锚点 `tests/risk-hard-deny.test.ts`：真值表 + `MCP_UNKNOWN_TOOLS` 三档口径 +
> **接线断言**（读 chat.ts 源码，硬拒调用行内不得出现 `fullAccess`——因为结构保证证伪不了「有人加回去」）。

## 4. 工具与数据接入

工具分两层：**内置工具**（agent-server 自带）与 **MCP 工具**（外部服务器提供，命名空间 `mcp__<serverId>__*`）。**领域适配完全发生在 MCP 层——换后台 = 换 MCP server，框架源码不动**，这正是「领域无关的 deep-agent 框架」的含义。

### 4.1 内置工具（`builtins.ts`）

agent-server 自带的本机能力，经 `execBuiltin` 分发（另含两个内部路由工具 `task` / `search_tools`）。完整清单（与 `builtins.ts` 的 `execBuiltin` 分支及 `BUILTIN_RISK` 一一对应，无遗漏、无臆造）：

- **文件系统 `fs_*`**（7 个，无 move/chmod）：`fs_read` / `fs_write` / `fs_ls` / `fs_glob` / `fs_grep` / `fs_edit` / `fs_delete`
- **规划与记忆**：`write_todos`（任务规划卡）/ `save_memory` / `recall_memory`
- **知识与检索**：`search_knowledge` / `knowledge_sources`（本地资料库）/ `search_dingtalk_doc`（钉钉文档）/ `web_search` / `fetch_url`（公网抓取，含 SSRF 防护）
- **可视化与成稿**：`render_chart`（浏览器本地 AntV 渲染，数据不出本机）/ `export_data`（叙述 + 图表 + 表格 → html/pdf/docx/csv 文件）
- **定时任务**：`list_schedules` / `manage_schedule`（复用 `schedules.ts` 底座）
- **本机执行**：`run_command` / `run_script`（对应 chat.ts 注释里的 exec 概念）
- **图像**：`image_gen`（OpenAI 兼容 `/images/generations`，需 `IMAGE_GEN_*`，未配置如实报错不静默跳过）
- **交互**：`request_clarification`（澄清门）
- **技能**：`read_skill`（按需读取 SKILL.md）
- **内部路由**：`task`（子 Agent 委派）/ `search_tools`（工具按需检索入口，deferred 模式下唯一可见入口）
- **领域专属**：`record_watched_movies`（movie 角色写本地观影画像，见 `movie/profile.ts`）

风险等级（`read`/`write` × `workspace`/`external`）由 `builtins.ts` 的 `BUILTIN_RISK` 声明，与服务端 `risk.ts` 策略联动（见 §3）；服务端 `toolRisks` 优先级更高。

### 4.2 MCP 子系统（`mcp/`）
- `mcp/config.ts`：服务器来源有二——① `MCP_BUILTIN_SERVERS`（`.env` 里的 JSON 数组，部署期确定、不落盘；stdio 子进程只接收运行所需变量、`BI_` / `YAPI_` 前缀和该服务器声明的 `env`，这些凭据放 `.env` 即可）；② 运行时经 `POST /mcp/servers` 由用户添加。`conversation.mcpServers` 持久化「本对话启用集」。
- `mcp/hub.ts`：`connect()` → `buildTransport()`（`StdioClientTransport` 命令式 / `StreamableHTTPClientTransport`）→ 拉取工具清单；含空闲回收、重连冷却、stdio 子进程 stderr 转发（避免日志黑洞）。外部工具统一命名空间 `mcp__<serverId>__*`。
- 启动期（`index.ts`）自动重连所有已启用服务器；面板勾选态经 `app.ts` 增删并清理悬空引用。

### 4.3 领域适配器（MCP 接入的真实例子）
| 领域 | MCP server | 接入方式 | 暴露的关键工具 |
|---|---|---|---|
| **PC 后台管理**（bx-film-admin-in2） | `scripts/yapi-mcp.mjs`（stdio，`name: yapi-docs`） | `.env` 的 `MCP_BUILTIN_SERVERS` → `mcp/hub.ts` | `list_projects` / `list_categories` / `search_apis` / `get_api_desc` / `call_api`（**仅 GET** 只读调用 YApi 接口）；完整规范 → [yapi-mcp 集成规范](./yapi-mcp.md) |
| 观影助手 | TMDb（公共托管，Streamable HTTP） | `roles.ts` 的 `movie` 角色 `defaultMcpServers: ["movie"]` | `mcp__movie__*`（约 21 个只读工具：检索/详情/相似/趋势/评分/分季分集等）；完整规范 → [movie-mcp 集成规范](./movie-mcp.md) |
| **业务取数 / BI**（Metabase） | `scripts/metabase-mcp.mjs`（stdio，`name: bi-metabase`） | `.env` 的 `MCP_BUILTIN_SERVERS`（serverId `bi`）→ `mcp/hub.ts` | `list_databases` / `get_database_schema` / `get_field_values` / `list_cards` / `get_card` / `list_dashboards` / `get_dashboard` / `search` / `run_native_query`（原生 SQL，**服务端 sql-readonly 闸只读硬拒写操作**）；完整规范 → [bi-mcp 集成规范](./bi-mcp.md) |

> **与 `docs/agent/` 历史文档的关系**：被标记为「历史快照」的 PC 后台文档（`PC_STRUCTURE_AND_OUTPUT_TYPES` / `WORKFLOW_CLARIFICATION_GATE` / `PORTAL_*` / `CHAT_FLOW` 等）描述的是**旧版「PC 后台管理 Agent」**（`bx-film-admin-in2` 集成：`search_api_module` / `call_api` / `render_table` / `get_list_columns` 等内置工具）。该能力随「通用 deep-agent 框架」重构而**外置为 MCP 服务器**（`docs/deep-agents-plan.md`：「原 call_api / search_api_module 等业务/领域能力已外置为 MCP 服务器 bi / yapi / movie / chart」）。（注：`chart` 实际以「技能 + 内置 `render_chart`」落地，见 §4.4，并非独立 MCP 服务器；此处沿用计划文档的统称。）当前现实形态：只读调用走本表首行的 `yapi-docs` MCP（仅接口文档发现 + 只读 `call_api`）；`render_table` / `export_dataset` / `search_api_module` / `get_list_columns` 等旧内置工具已在重构中移除、不在仓库源码，仅历史文档保留作参考。标记「历史」即为此意——它们不是失效，而是被「框架 + MCP 适配层」取代。

### 4.4 可视化（技能 + 内置工具，非 MCP）

图表出图走 `skills/chart-visualization` 技能 + 内置工具 `render_chart`：**本地渲染**（浏览器 AntV，**零外链、数据不出本机**，故无需数据外发确认卡），数据必须来自真实取数工具（如 BI）**禁止编造**；建议 ≤50 数据点（服务端 5000 行兜底截断）。详见 [chart-visualization 规范](./chart-visualization.md)。

### 4.5 技能层（skills/）

适配器与内置工具只解决"能不能调"，**技能（SKILL.md）解决"拿到工具后怎么用"**。`default: true` 只是不出现在技能勾选面板；索引仍常驻，全文在命中时用 `read_skill` 加载，不是整份注入。角色（`roles.ts`）决定启用哪些 MCP；技能描述决定何时加载。各技能自带 `SKILL.md` 即其规范：

| 技能 | 触发场景 | 关键依赖 |
|---|---|---|
| [`business-data-query`](../../apps/agent-server/skills/business-data-query/SKILL.md)（业务取数） | 数字属于已连接的自有业务数据。主体在外部世界时不用 | BI MCP（`mcp__bi__*`） |
| [`schema-probe`](../../apps/agent-server/skills/schema-probe/SKILL.md)（陌生库探查） | 已经确定在查自有数据，但库表还不熟。通用角色 | BI MCP 元数据工具（`get_database_schema` / `get_field_values`） |
| [`metric-caliber-check`](../../apps/agent-server/skills/metric-caliber-check/SKILL.md)（指标口径核对） | 自有数据的指标定义或两个数对不上。通用角色 | BI MCP（`list_cards` / `get_card` / `run_native_query`） |
| [`chart-visualization`](../../apps/agent-server/skills/chart-visualization/SKILL.md)（图表可视化） | 画图/可视化。通用角色与客服角色 | 上游取数 + 内置 `render_chart`（本地 AntV） |
| [`movie`](../../apps/agent-server/skills/movie/SKILL.md)（观影助手） | 找片/了解影片/推荐/对比 | TMDb MCP（`mcp__movie__*`） |
| [`pdf`](../../apps/agent-server/skills/pdf/SKILL.md)（PDF 资料问答） | 答案只在文档里（制度/报告/合同/附件） | 本地资料库检索（pdf/docx/xlsx 入库；无解析器如实报错，不静默跳过） |
| [`support-salesiq`](../../apps/agent-server/skills/support-salesiq/SKILL.md)（客服会话） | 客服角色查在线会话列表或做时段计数 | Zoho SalesIQ MCP |
| [`web-research`](../../apps/agent-server/skills/web-research/SKILL.md)（联网检索与核实） | 外部世界的公开事实。自有业务数据不走这里 | 内置 `web_search` / `fetch_url` |

> 取数链路：`business-data-query` / `schema-probe` / `metric-caliber-check` 只进通用角色，服务于自有数据（先取证、再取数、再核对口径）。`movie`、`support-salesiq` 只进各自角色。`web-research` 只进通用角色。`pdf` 与 `chart-visualization` 进通用角色和客服角色。索引按 `roles` 过滤，不是整份注入。

## 5. 异步与定时

- `chat-tasks.ts`：任务底座（`startTask`/`consumeTask`、运行中流、pending 队列、对话级 409）。
- `schedules.ts`：`croner` 周期/一次性调度，Mongo `chat_schedules`；复用任务底座，结果回投到**任务专属对话**（`ownConversation`，避免刷屏）；任务级 `mcpServers` 最小权限白名单（运行时取「对话启用集 ∩ 清单」）；`notifyOn` 控制投递。

## 6. 持久化与上下文

- `conversations.ts`：Mongo `bx_agent`（`conversation.context` `$push/$inc` 原子追加对标 checkpointer、`chat_schedules`、`conversation.todos`）。
- `history.ts`：窗口 → 无损裁剪 → LLM 摘要（预算按模型窗口推导）。
- `memory.ts`：显式写入、可查删、注入 system。
- `fs-store.ts`：大结果卸载落盘（见 §2 D2）。

## 7. 与旧文档的关系

`docs/agent/` 下**除本文外**的所有文件（`AGENT_CHARTER` / `PRODUCTION_READINESS` / `PROMPT_ARCHITECTURE` / `A2A_INTEGRATION` / `CAPABILITY_MATCH` / `CHAT_FLOW` / `ENTERPRISE_ROADMAP` / `MULTI_AGENT_ARCHITECTURE` / `PC_STRUCTURE_AND_OUTPUT_TYPES` / `PORTAL_SUPERVISOR_AGENT` / `PORTAL_TRACE` / `VERIFY_SCENARIOS` / `VIEWING_ASSISTANT_AGENT` / `WORKFLOW_CLARIFICATION_GATE` 及 `README.md`）均描述**已移除的 PC 后台管理 Agent**，与当前代码脱节，仅作历史参考。旧基础设施基线 `docs/agent-infrastructure.md` 同样过时。
