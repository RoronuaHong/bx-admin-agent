# 当前架构：Deep-Agent 框架（唯一权威）

> **版本**：基于 `apps/agent-server/src` 实际代码核对（2026-09-26）。
> **定位**：本文是 `docs/agent/` 下文档的**当前架构唯一权威**。本目录其余文件均为「PC 后台管理 Agent」历史快照，与当前代码已脱节，请勿照抄。
> **关联规划**：`docs/deep-agents-plan.md`（D1–D4 实施记录）、`docs/agent-infrastructure.md`（旧基础设施基线，已过时）。

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

当前 skills 目录（`apps/agent-server/skills/`）：`business-data-query` / `chart-visualization` / `metric-caliber-check` / `movie` / `pdf` / `schema-probe` / `web-research`。

## 3. 治理与安全层

| 层 | 文件 | 职责（已核实源码头部） |
|---|---|---|
| 安全审计 | `audit.ts` | append-only JSONL（`.data/audit`）；决策：allowed/confirmed/denied/timeout/grant_read/subagent_refused/clarify_deferred/ownership_mismatch；凭据不落盘（仅脱敏摘要 + sha256） |
| 入口限流 | `rate-limit.ts` | 滑动窗口、进程内存、单实例；只拦 `/chat/stream`；key = owner cookie（与归属隔离同身份）；配 0 关闭 |
| 工具风险分级 | `risk.ts` | 工具危险度由「工具声明 + 服务端策略」决定，默认 fail-closed；判据来源含 `sql-readonly`；与 `builtins.ts` 的 `BUILTIN_RISK` 联动（如 `request_clarification`=read/workspace、`web_search`=read/workspace、`search_dingtalk_doc`=read/external） |
| 不可信内容护栏 | `untrusted.ts` | Prompt 注入防护（对齐 OWASP LLM01）：靠**结构隔离**而非词表——清洗不可见/危险控制符、每请求随机 nonce 定界并标注来源、中和伪造闭合标签；不检测自然语言 |
| SQL 只读闸 | `sql-readonly.ts` | `isReadOnlySql` fail-closed：首词白名单（select/with/show/describe/explain）+ 黑名单词 + 危险构造（`into outfile`/`load_file`/`pg_read_file`/`writable_schema`）；与 Metabase MCP 适配器纵深防御 |
| 接地门禁 | `grounding.ts` | `enforceGrounding`：本轮「零外部数据证据却以事实正文收束」→ 作废该段 + 回灌纠正；外部数据工具 = `web_search`/`fetch_url`/`search_knowledge`/`mcp__*`，按工具动态开启；角色级 `enforceGrounding` 开关（`roles.ts`） |
| 确认门 | `confirm.ts` + `toolNeedsConfirm` | 事件流内确认卡，队列在确认等待时暂停 |
| 运行追踪 | `trace.ts` | run 级 JSONL（runId/会话归属/模型/轮次/token/耗时/状态/错误），是排障、评测基线、成本聚合的地基 |
| 成本计量 | `cost.ts` | 只读聚合 `trace.ts` 落盘的 run 级记录；tokens 估算，单价 `COST_RATE_<模型ID大写>_PER_1K`，未配置记 `unpricedTokens`（如实显示「未定价」，不编造金额） |

## 4. 工具与数据接入

工具分两层：**内置工具**（agent-server 自带）与 **MCP 工具**（外部服务器提供，命名空间 `mcp__<serverId>__*`）。**领域适配完全发生在 MCP 层——换后台 = 换 MCP server，框架源码不动**，这正是「领域无关的 deep-agent 框架」的含义。

### 4.1 内置工具（`builtins.ts`）
`request_clarification`、`web_search`、`search_dingtalk_doc`、`write_todos`、`task`、`fs_*`、`read_skill`、`search_tools` 等；风险等级见 §3 `risk.ts`。

### 4.2 MCP 子系统（`mcp/`）
- `mcp/config.ts`：服务器来源有二——① `MCP_BUILTIN_SERVERS`（`.env` 里的 JSON 数组，部署期确定、不落盘；stdio 子进程继承父进程环境，凭据放 `.env` 即可）；② 运行时经 `POST /mcp/servers` 由用户添加。`conversation.mcpServers` 持久化「本对话启用集」。
- `mcp/hub.ts`：`connect()` → `buildTransport()`（`StdioClientTransport` 命令式 / `StreamableHTTPClientTransport`）→ 拉取工具清单；含空闲回收、重连冷却、stdio 子进程 stderr 转发（避免日志黑洞）。外部工具统一命名空间 `mcp__<serverId>__*`。
- 启动期（`index.ts`）自动重连所有已启用服务器；面板勾选态经 `app.ts` 增删并清理悬空引用。

### 4.3 领域适配器（MCP 接入的真实例子）
| 领域 | MCP server | 接入方式 | 暴露的关键工具 |
|---|---|---|---|
| **PC 后台管理**（bx-film-admin-in2） | `scripts/yapi-mcp.mjs`（stdio，`name: yapi-docs`） | `.env` 的 `MCP_BUILTIN_SERVERS` → `mcp/hub.ts` | `list_projects` / `list_categories` / `search_apis` / `get_api_desc` / `call_api`（**仅 GET** 只读调用 YApi 接口）；完整规范 → [yapi-mcp 集成规范](./yapi-mcp.md) |
| 观影助手 | TMDb（公共托管，Streamable HTTP） | `roles.ts` 的 `movie` 角色 `defaultMcpServers: ["movie"]` | `mcp__movie__*`（21 个只读工具：检索/详情/相似/榜单/评分/分季分集等） |

> **与 `docs/agent/` 历史文档的关系**：被标记为「历史快照」的 PC 后台文档（`PC_STRUCTURE_AND_OUTPUT_TYPES` / `WORKFLOW_CLARIFICATION_GATE` / `PORTAL_*` / `CHAT_FLOW` 等）描述的正是上表第一行的 `yapi-docs` MCP 集成——**该能力当前仍活跃**，只是以 MCP server 形式存在、而非写死在 agent-server 源码里（故 `apps/agent-server/src` 中搜不到 `call_api` 等字样）。标记「历史」是因为这些文档写的是该 MCP server 暴露的接口契约/治理约定，不属于 deep-agent 框架本身。

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
