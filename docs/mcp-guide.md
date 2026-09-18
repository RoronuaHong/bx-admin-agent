# MCP 连接能力 · 实现与使用指南

> 版本：v1（2026-09-16）
> 定位：MCP 能力的**权威实现参考 + 用户使用手册**，与 `docs/mcp-connect-plan.md`（设计稿）配套。
> 设计原则贯穿全文：**不勾选任何 MCP 时，保持纯直连大模型的行为完全不变**（一次调用、流式直出）；只有勾选了服务器才进入工具循环。

本项目位置：后端 `apps/agent-server/src`，前端 `apps/web/src`，共享类型 `packages/shared/src`。

---

## 1. 能力概览

- 入口是**输入框左下角「＋」工具菜单**（与「技能」合并；菜单项：添加文件 / 技能 / 连接器）。点「连接器」在菜单右侧飞出面板（搜索框 + 列表 + 底部操作），从已配置的服务器里勾选要连到当前对话的（可多选、可随时取消），勾上即连、模型即可用其工具；一个都不勾就是纯直连。
- 服务器清单由部署侧提供（`.env` 的 `MCP_BUILTIN_SERVERS` 或 `.data/mcp-servers.json`），前端只做选择，不含「添加 / 删除」。
- 支持的传输：`stdio`（子进程）与 `Streamable HTTP`（远程）。
- 工具以 `mcp__<serverId>__<tool>` 命名空间注入模型，多源工具不重名冲突。
- **内置工具**（勾选 MCP 才注入；直连模式零工具）：`fs_write / fs_read / fs_edit / fs_ls`（对话工作区）、`write_todos`（任务计划）、`task`（委派子代理）、`read_skill`（技能全文）、`search_tools`（按需加载检索）、**`search_knowledge` / `knowledge_sources`（本地知识库检索，见 `docs/agent-infrastructure.md` §7）**。全部在 `BUILTIN_RISK` 登记级别，启动时 `assertBuiltinRiskCoverage()` 断言无漏登记。
- 写操作护栏：`requireConfirm` 的服务器，每次调用前弹出确认卡，用户允许才执行；超时按拒绝处理。
- **对话级启用集**：勾选结果持久化在该对话文档（GET/PUT `/chat/mcp/servers` 带 `conversationId`；旧实现的「会话级」已迁移），切换对话互不影响；技能启用集同构（`GET/PUT /chat/skills`）。
- 连接失败只记录状态、不影响聊天主流程；未连接/连接失败的服务器在工具循环里静默跳过。

成熟度：对照 `docs/agent-infrastructure.md` 的路线图，本项目处于 **M1（工具闭环）已达成**。

---

## 2. 架构与数据流

```
用户勾选 MCP ──PUT /chat/mcp/servers──▶ 会话启用集(per-session) + 按需 connect
                                                  │
提问 ──POST /chat/stream──▶ chatStream                       │
                              │                               │
  collected=collectToolsDetailed(enabled) ──▶ hub.connect(id)（全局一条长连接，多服务器并行）
                              │                               │
              ┌───────────────┴───────────────┐              │
              │  runWithTools（工具循环）         │              │
              │   model.callAgent(tools,auto)  │              │
              │     → tool_calls?              │              │
              │     → 执行 callMcpTool          │──▶ hub.callTool
              │     → 结果回灌 role:tool         │◀── 工具结果
              │     → 再调用模型 …               │              │
              │   直到无 tool_calls 或达轮次上限   │              │
              └───────────────┬───────────────┘              │
                              │                               │
                  NDJSON: text_delta / tool_call / tool_result│
                       / confirmation_required / confirmation_response / text / done
                              ▼
                         前端气泡渲染工具步骤 + 确认卡
```

**关键模块分工**

| 文件 | 职责 |
|---|---|
| `src/mcp/config.ts` | 服务器配置持久化（`.data/mcp-servers.json`）；`loadServers / getServer / upsertServer / deleteServer / validateServerInput / toPublic`（凭据脱敏为键名）；`toolRisks` 工具级风险覆盖。 |
| `src/mcp/hub.ts` | 连接管理：`connect / disconnect / disconnectAll / listStatuses / reload / collectToolsDetailed / collectTools / callMcpTool / describeMcpTool`。每个 server 全局一条长连接（多服务器**并行**接入），工具命名空间编码，缺席服务器带原因上报。 |
| `src/risk.ts` | **工具风险分级（单一真相）**：`resolveToolRisk`（工具级 toolRisks → 内置登记表 → 服务器级 requireConfirm → 注解 → 未知兜底 → 会话只读授权）+ `verdictNeedsConfirm`；默认 fail-closed（未声明/查不到按 `MCP_UNKNOWN_TOOLS` 处理，默认弹确认卡）。 |
| `src/confirm.ts` | 写操作二次确认通道（一次性票据）：`requestConfirmation` 签发 `cfm_<uuid>` 票据并与 (sessionId, conversationId) 绑定，`answerConfirmation(ticket, sessionId, confirmed)` 校验归属后解挂；票据一次性；超时按拒绝。 |
| `src/audit.ts` | 安全审计留痕：append-only JSONL（`.data/audit/audit-YYYYMM.jsonl`），记录 allowed / confirmed / denied / timeout / grant_read / subagent_refused / ownership_mismatch；参数只存脱敏摘要 + sha256。 |
| `src/chat.ts` | 聊天引擎：`chatStream`（无工具→直连单次；有工具→`runWithTools`）；闸门接线（子代理默认只读 / deny 拒绝 / 票据确认 / 审计）；`streamCall` 边收增量边 yield；护栏常量。 |
| `src/models.ts` | 模型适配：OpenAI / Anthropic / Ollama；恢复 function calling（工具定义 + 流式 `tool_calls` 增量解析，按 index 拼接）；工具调用兜底 id 不可猜（`call_<uuid>`）。 |
| `src/session.ts` | 匿名会话：cookie `bx_agent_sid`、启用集 `mcpServers`、引用计数的落盘。 |
| `src/app.ts` | 端点装配：`/mcp/servers*`、`/chat/mcp/servers`、`/chat/confirm`（票据 + 会话归属校验 + 只读授权）、`/chat/stream` 等。 |
| `packages/shared/src/index.ts` | `ChatEvent` 类型（含 `tool_call / tool_result / confirmation_required（ticket/level/argSummary/canGrantRead）/ confirmation_response`）。 |
| `apps/web/src/api.ts` | 前端接口封装 + `ChatEvent` 镜像类型；`confirmToolCall(ticket, confirmed, { grantRead })`。 |
| `apps/web/src/pages/ChatPage.vue` | MCP 抽屉、工具步骤气泡、确认卡（**纯展示**：级别徽标 + 参数摘要表 + 只读授权勾选；无任何自动批准逻辑）。 |

---

## 3. 配置（服务器清单）

配置文件：`<agent-server>/.data/mcp-servers.json`（数组，原子写入：临时文件 + rename）。
**凭据（env / headers）只落本机文件**，接口一律只返回键名（`envKeys / headerKeys`）。

`McpServerConfig` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定标识，同时作工具命名空间前缀；仅允许 `^[A-Za-z0-9_-]{1,32}$`。 |
| `label` | string | 展示名；缺省回退到 `id`。 |
| `transport` | `"stdio" \| "http"` | 传输方式。 |
| `enabled` | boolean | 是否启用（全局清单维度；会话维度另由启用集决定）。 |
| `command` | string | stdio：可执行命令。 |
| `args` | string[] | stdio：参数。 |
| `cwd` | string | stdio：工作目录。 |
| `env` | Record<string,string> | stdio：环境变量（**不回显**）。 |
| `url` | string | http：端点 URL。 |
| `headers` | Record<string,string> | http：请求头（**不回显**）。 |
| `timeoutMs` | number | 连接 / 调用超时（正数；默认 60_000）。 |
| `requireConfirm` | boolean | 该服务器的**全部**工具调用都需用户二次确认。 |
| `toolRisks` | object | 工具级风险覆盖（`{ "tool": "read" \| "write" \| "destructive" }`），优先级高于 `requireConfirm` 与注解（判定见 `src/risk.ts`）。 |
| `tools` | string[] | 工具白名单（**server 上的原始工具名**，非命名空间名）：声明后只把列出的工具注入模型，其余忽略；未声明 = 全部注入。用于「一个 server 提供多领域工具、但某角色只需其中一部分」——收窄暴露面、减少无关 schema（`src/mcp/hub.ts` `refreshTools` 过滤）。 |

`upsertServer` 的「合并」语义：保存时未传 `env` / `headers` 视为「保持原值」，避免编辑表单时清空已有凭据；前端凭据框为空即不覆盖。

---

## 4. 后端 API 契约

所有端点前缀按前端代理为 `/agent`（见 `apps/web` 的代理配置）；下表用服务侧原始路径。

| 方法 + 路径 | 说明 | 请求 | 响应 |
|---|---|---|---|
| `GET /mcp/servers` | 全局服务器清单（脱敏） | — | `{ servers: McpServerPublic[] }` |
| `POST /mcp/servers` | 新增或更新服务器（按 `id` upsert） | `Partial<McpServerConfig>` | `{ server: McpServerPublic }` / 400（校验失败） |
| `DELETE /mcp/servers/:id` | 删除配置并断开连接，从所有会话启用集摘除 | — | `{ ok: true }` / 404 |
| `POST /mcp/servers/:id/reload` | 重连并重列工具（配置变更后刷新） | — | `{ status: ServerStatus }` / 404 |
| `GET /chat/mcp/servers` | 可用服务器（含连接状态）+ **该对话**已启用 id | `?conversationId=` | `{ conversationId; available: ServerStatus[]; enabled: string[] }` |
| `PUT /chat/mcp/servers` | 保存勾选结果到**该对话**，触发对应连接/断开（异步） | `{ conversationId; enabled: string[] }` | `{ conversationId; enabled: string[]; available: ServerStatus[] }` |
| `GET /chat/skills` | 技能目录索引 + 该对话勾选的技能 | `?conversationId=` | `{ conversationId; available: SkillMeta[]; enabled: string[] }` |
| `PUT /chat/skills` | 保存该对话勾选的技能（勾选 = 全文注入系统提示动态后缀） | `{ conversationId; enabled: string[] }` | `{ conversationId; enabled: string[] }` |
| `POST /chat/confirm` | 写操作确认回调（**用一次性票据**，不用 callId） | `{ ticket; confirmed: boolean; grantRead?: boolean }` | `{ ok: boolean; confirmed: boolean }` / 403（票据与会话不匹配，记 `ownership_mismatch` 审计） |
| `POST /chat/stream` | 一轮对话（HTTP Streamable，NDJSON 分块） | `{ text; model?; images?; conversationId? }` | `application/x-ndjson`（每行一条 `ChatEvent` JSON） |
| `POST /chat/subagent/:conversationId/:subagentId/cancel` | **独立取消**某一个运行中的子代理（不影响主代理继续运行） | — | `{ ok: true; cancelled: boolean }`（未命中运行中实例 → `cancelled:false`）/ 404（对话不存在或不属于当前设备） |

`ServerStatus`：`{ id, label, transport, enabled, connected, connecting?, error?, toolsError?, tools, toolNames }`（`connecting` = 连接过程未完（工具清单还没列完），此时 `connected=false`；`toolsError` = 连接正常但 `listTools` 失败，与「服务器本来没有工具」区分）。

会话 cookie 注意：`GET/PUT /chat/mcp/servers` 与 `POST /chat/stream` 在「未带有效会话 cookie」时**必须回写 cookie**，否则每次请求都生成新会话，启用集存不住（已修复）。

流式与断连：`/chat/stream` 走 HTTP Streamable（`Transfer-Encoding: chunked` + NDJSON，每行一条事件），**不使用 SSE**——`text/event-stream` 会被 vite dev 代理缓冲，导致工具步骤/确认事件无法实时到达前端。前端点“停止”或关闭页面时，`@hono/node-server` 会 abort `c.req.raw.signal`；该信号已透传给 `chatStream → callModel` 的 `fetch` **以及 MCP 工具调用（`callMcpTool` 的 `signal`）**，可中止在途模型调用与在途 MCP 调用（避免服务端空跑）。

vite 代理注意：`apps/web/vite.config.ts` 只对 `/agent` 设 `Accept-Encoding: identity`，**不要**在 `proxyRes` 监听里再手动 `pipe`——http-proxy 默认已透传响应，手动再 pipe 会叠加成双管道，导致每个流事件重复两遍。

---

## 5. 事件契约（server → web，HTTP Streamable / NDJSON）

`ChatEvent`（`packages/shared/src/index.ts`，前端镜像在 `apps/web/src/api.ts`）：

```ts
| { type: "text"; text: string }
| { type: "text_delta"; text: string }                 // 流式增量
| { type: "model"; id: string; label: string }
| { type: "tool_call"; id: string; name: string; server?: string; args?: string }
| { type: "tool_result"; id: string; name: string; ok: boolean; text: string }
| { type: "confirmation_required"; id: string; name: string; args?: string; reason?: string }
| { type: "confirmation_response"; id: string; confirmed: boolean }
// 子代理（task 委派）独立事件维度：异步产出，旧前端忽略未知 type 即向后兼容。
| { type: "subagent_start"; id: string; parentId: string; description: string }
| { type: "subagent_delta"; id: string; text: string }
| { type: "subagent_end"; id: string; ok: boolean; status: "done"|"cancelled"|"error"; text: string }
| { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
| { type: "usage"; tokens: number; budget: number; window: number; turns: number; dropped: number; toolResultsCleared: number }  // 上下文用量（透明度）
| { type: "done" }
```

事件顺序（工具循环内一轮）：`text_delta* → tool_call → (confirmation_required → confirmation_response)? → tool_result → … → 下一轮 text_delta* … → text → usage → done`。

**子代理事件**：模型调用 `task` 时，服务端为每个子代理产出 `subagent_start → subagent_delta* → subagent_end`（`subagent_start.id` 为子代理运行 id，供**独立取消**使用；`parentId` 是发起委派的 `task` 工具调用 id，用于 UI 关联步骤）。子代理执行期间主代理阻塞等待交接摘要，但事件逐片转发，前端可见实时进度；交接摘要仍经 `tool_result` 回灌模型上下文。

**上下文预算**：以 token 计并由模型窗口推导 —— 历史预算 = `(CONTEXT_WINDOW − MODEL_MAX_OUTPUT_TOKENS − 工具 schema − MCP_TOOL_RESULT_BUDGET) × CONTEXT_SAFETY_RATIO`；跨轮裁剪后保证首条为 `user`（部分 provider 要求）。本轮工具结果超 `MCP_TOOL_RESULT_BUDGET` 时从最旧的开始清理并替换为占位文本，但保留最近 `MCP_TOOL_RESULT_KEEP` 组与 `MCP_TOOL_RESULT_PROTECT` 白名单。跨轮只保留工具**轻量句柄**（工具名 + 参数摘要 + 结果规模），不保留结果正文。窗口由 `MODEL_<ID>_CONTEXT_WINDOW` / `MODEL_CONTEXT_WINDOW` 配置。

---

## 6. 工具循环与护栏

`src/chat.ts` 中的常量（均可经环境变量覆盖）：

| 常量 | 默认 | 环境变量 | 说明 |
|---|---|---|---|
| `HISTORY_MAX_TURNS` | 8 | — | 带入模型的历史轮数（实际取 `×2` 条消息）。 |
| `HISTORY_CHAR_BUDGET` | 24000 | — | 历史字符预算，超了从头裁剪。 |
| `MCP_MAX_TOOLS` | 80 | `MCP_MAX_TOOLS` | 注入模型的工具数上限。超出时按确定性顺序截断，并把**被裁掉的服务器**写进系统提示（不静默丢弃）。 |
| `RECONNECT_COOLDOWN_MS` | 30000 | `MCP_RECONNECT_COOLDOWN_MS` | 连接失败后的重试冷却：避免一个挂掉的 server 让**每一轮对话**都等一次连接超时（前端「重连」可即时绕过）。 |
| `TOOL_SEARCH_MODE` | auto | `TOOL_SEARCH_MODE` | 工具 schema 注入策略：`auto` = 超出窗口比例才按需加载，`on` = 强制按需，`off` = 永远全量。 |
| `TOOL_SEARCH_RATIO` | 0.1 | `TOOL_SEARCH_RATIO` | auto 的阈值：MCP 工具 schema 占上下文窗口超过该比例 → 改为按需检索加载。 |
| `TOOL_SEARCH_RESULTS` | 8 | `TOOL_SEARCH_RESULTS` | 单次检索最多返回并加载多少个工具（硬上限 20）。 |
| `TOOL_CATALOG_MAX_NAMES` | 200 | `TOOL_CATALOG_MAX_NAMES` | 系统提示里工具索引（仅名称）最多列多少个，防止索引本身变成新负担。 |
| `MCP_IDLE_TIMEOUT_MS` | 1800000 | `MCP_IDLE_TIMEOUT_MS` | 空闲连接回收阈值（0 = 关闭回收）。 |
| `MCP_IDLE_SWEEP_MS` | 300000 | `MCP_IDLE_SWEEP_MS` | 空闲回收扫描间隔（定时器 unref，不阻止进程退出）。 |
| `MCP_CONFIRM_STRICT` | off | `MCP_CONFIRM_STRICT` | 设为 `on` 时，「无注解」工具也需用户确认（对齐规范里 `destructiveHint` 缺省 true 的保守口径）。 |
| `MAX_TOOL_ROUNDS` | 14 | `MAX_TOOL_ROUNDS` | 工具循环轮次上限，达上限即收束报错而非编造。 |
| `MAX_TOOL_RESULT_CHARS` | 12000 | `MAX_TOOL_RESULT_CHARS` | 单条工具结果回灌截断长度。 |
| `TOOL_DEDUP_SAME_ROUND` | on | `TOOL_DEDUP_SAME_ROUND` | 同轮同参数去重：一轮内模型重复发出的相同工具调用（`name` + 规范化参数）只执行一次，其余回灌「已跳过（同轮重复）」。 |
| `DOOM_LOOP_MAX_ROUNDS` | 3 | `MCP_DOOM_LOOP_MAX` | 跨轮 Doom Loop 熔断：同一组工具调用**连续**重复达到该轮数即主动收束（追加提示并 `break`），避免无限循环空耗 token；设置 ≥2。 |
| — | 60000 | — | `src/mcp/hub.ts` 连接/调用默认超时。 |
| — | 120000 | `MCP_CONFIRM_TIMEOUT_MS` | `src/confirm.ts` 确认等待超时（超时按拒绝）。 |

工具注入使用 `tool_choice: "auto"`；Ollama 通道不接工具（工具结果降级为 user 文本，保证多轮连贯）。

**工具模式与工具通道现状**：「工具模式」由**对话是否勾选了 MCP** 决定（勾了就注入内置工具），而不是「是否成功发现到 MCP 工具」——否则某个服务器连不上会让整个对话静默降级成直连（内置工具一并消失）。系统提示**动态段**会注入「工具通道现状」：本次注入了多少 MCP/内置工具、来自哪些服务器、哪些勾选的服务器缺席及原因（未配置 / 已禁用 / 连接失败 / 工具清单失败 / 无工具）、因上限被裁掉哪些服务器。目的是让模型知道**能力边界**：用户问到缺席域时如实说明，而不是编造或用别的域数据推断。

**顺序与缓存**：工具清单按 `serverId → 工具名` 双排序（`chatStream` 对启用集去重排序 + hub 内排序），保证 system+tools 前缀跨轮稳定 —— 顺序随勾选顺序漂移会让 prompt 缓存全部失效。

**工具按需加载（Tool Search）**：工具定义本身是纯开销，服务器一多就会把上下文吃掉（Anthropic 实测：全量注入在读到用户请求前就消耗数十万 token，改按需后 150k → 2k）。因此当 MCP 工具 schema 占上下文窗口超过 `TOOL_SEARCH_RATIO`（默认 10%，对齐 Claude Code `ENABLE_TOOL_SEARCH=auto`）时自动切换：

- 注入的工具只剩内置工具 + `search_tools`，MCP 工具**只把名字**写进系统提示（工具索引，按服务器分组，受 `TOOL_CATALOG_MAX_NAMES` 限制）；
- 模型要调用某个 MCP 工具，先调 `search_tools({query})`（关键词可命中工具名 / 描述 / 服务器名），命中的工具 schema 立即加载并可在同一轮后续调用；
- **未加载的工具直接调用会被拒绝**并回灌引导（模型只见过名字，没见过参数）；
- 加载受 `MCP_MAX_TOOLS` 约束，超限时如实说明哪些没有加载；
- 子代理同样按需（各自独立一份已加载集合）。

| 环节 | 行为 |
|---|---|
| 阈值判定 | `toolSearchEnabled(model, eagerTokens)`：off 永不 / on 强制 / auto 比比例 |
| 检索排序 | `searchMcpTools`：原始工具名精确命中 100 > 命名空间名包含 60 > 描述 20 > 服务器 10，未命中的关键词扣分（多词查询要求大部分命中）；平票按名字排序（确定性） |
| 索引上限 | 只列前 `TOOL_CATALOG_MAX_NAMES` 个名字，并标注「只列了 x/y」 |

> 小规模接入（十几个工具）不会触发，行为与全量注入完全一致；只有工具多到会挤占上下文时才切换。

**已知护栏缺口**（对照基础设施文档 M1 项，待补）：并发工具调用、断点恢复。当前已做：轮次上限 + 工具数/结果长度上限 + **同轮同参数去重** + **跨轮 Doom Loop 熔断**（见下方 §6.1）。

**§6.1 循环护栏（同轮去重 + 跨轮 Doom Loop 熔断）**：agent 最典型的失效模式是「模型卡在同一组工具调用上无限循环」——既拿不到进展，又持续烧 token。`runLoop` 内置两道护栏：
- **同轮同参数去重**：每轮维护一个已执行签名集合（工具名 + 规范化参数；参数按 key 递归排序后序列化，故 key 顺序不同但语义相同不误判）。一轮内模型重复发出的相同调用只执行一次，其余回灌一条 `tool_result`（ok=false，文案「已跳过（同轮重复）」），保持模型上下文对齐（每个 `tool_call` id 都有对应结果）。`task` 批量内的重复子任务同样去重。跨轮允许重新执行，避免误杀「重新取数」等合法重复。
- **跨轮 Doom Loop 熔断**：每轮结束后把「本轮实际执行的调用指纹」（去重后的签名集合）交给 `LoopGuard`。同一指纹**连续**重复达到 `DOOM_LOOP_MAX_ROUNDS`（默认 3）即判定陷入无效循环，主动 `break` 并追加一段提示（建议用户调整问题 / 换更具体的检索词 / 收窄勾选的服务器）。指纹变化或空轮（无执行）会重置连击，不会误伤正常多轮任务。
- 两道护栏都由纯函数支撑（`toolCallSignature` / `LoopGuard`），已在 `_mcp-multi-server-check.mjs` 中单测覆盖；开关见上表。

---

## 7. 写操作确认流程（risk.ts 风险分级 + 一次性票据）

**确认门判定顺序**（`src/risk.ts` `resolveToolRisk`，对齐 MCP 工具注解语义，**fail-closed**）：

1. 工具级显式覆盖（服务器配置 `toolRisks[tool]`）→ 按配置；
2. 内置工具登记表（`builtins.ts` 的 `BUILTIN_RISK`；启动时 `assertBuiltinRiskCoverage()` 断言无漏登记）→ 按登记；
3. 服务器级 `requireConfirm: true` → `destructive`（全部工具确认）；
4. 注解 `readOnlyHint: true` → `read`，不确认；
5. 注解 `destructiveHint: true` → `destructive`，确认；
6. 注解两者均显式 `false` → `write`，确认；
7. 未命中（含**查不到 / 未连接**）→ 按 `MCP_UNKNOWN_TOOLS`：`confirm`（默认，弹卡）| `deny`（直接拒绝）| `allow`（按只读放行）；
8. 会话级只读授权（确认卡勾选写入 `conversation.readGrants`）：仅对「未声明级别」且同服务器的工具降为 `read`。

确认口径：**只有「外部副作用」且级别非 read 才弹卡**；内置工作区写（`fs_write` 等，无外部副作用）免确认；`run_native_query` 这类「效果取决于传入文本」的工具按工具级配置定级（destructive = 永远弹卡，不看 SQL 内容）。判定只在服务端做，前端**零自动批准**。

流程：

1. 判定为需确认的调用，模型返回 `tool_calls`。
2. `runLoop` 调 `requestConfirmation({ sessionId, conversationId, callId, tool, serverId })` 签发**一次性票据** `cfm_<uuid>`（与请求会话绑定），随后 yield `confirmation_required`（带 `ticket / level / reason / argSummary（脱敏参数摘要）/ canGrantRead`），挂起等待。
3. 前端收到事件 → 渲染确认卡（工具名 + 服务器 + 级别徽标 + 原因 + 参数摘要表）→ 用户点「允许 / 拒绝」（可选勾选「本对话内按只读处理」）→ `POST /chat/confirm { ticket, confirmed, grantRead? }`。
4. `answerConfirmation(ticket, sessionId, confirmed)`：ticket 不存在/已失效 → 拒绝；**sessionId 与当前请求会话不匹配 → 403 且记审计（ownership_mismatch）**；匹配则解挂，`confirmation_response` 回推前端；允许则执行，拒绝/超时把结果回灌模型。
5. 确认请求本身零副作用；超时（默认 120s）按拒绝处理；票据一次性（应答即删，伪造/重放无效）。
6. 每次闸门决策写审计（`src/audit.ts`）：allowed（仅外部只读）/ confirmed / denied / timeout / grant_read / subagent_refused / ownership_mismatch，参数只存脱敏摘要 + sha256。

子代理默认**只读**（`SUBAGENT_ALLOW_WRITE` 仅作预留，当前忽略并告警）：子代理内非只读操作在闸门处**立即拒绝**并回喂明确错误（不进入确认流程，避免确认事件被子代理消费循环丢弃后静默挂起到超时）。

---

## 8. 会话与连接生命周期

- 会话：匿名 cookie `bx_agent_sid`（UUID 校验防伪造），TTL 由 `config.sessionTtlMs` 决定；停用会话的启用集一并清除。
- 启用集：**每个对话文档**保存 `mcpServers: string[]`（勾选的 id）。空数组 = 纯直连。技能启用集同理存 `conversation.skillsEnabled`。
- 连接复用：hub 内 `conns` 以 serverId 为键，全局一条长连接；**多服务器并行接入**（串行会让等待时间随服务器数量线性增长）。
- 连接单飞（single-flight）：连接过程的 promise 记在 `pendingConns`，并发/过早的 `connect` 复用同一次连接 —— 否则第二个调用会拿到「工具清单还没列完」的半成品，被误判成「服务器未暴露任何工具」。连接期间 `ServerStatus.connecting=true` 且 `connected=false`（前端显示「连接中」），工具清单列完才转「已连接」。
- 失败处理：连接失败 / 工具清单失败分别记入该连接的 `error` / `toolsError`，并**如实上报给模型**（见 §6「工具通道现状」）；连接失败后进入 30s 冷却窗口（`MCP_RECONNECT_COOLDOWN_MS`），窗口内复用失败状态、不再重复等待超时，前端「重连」不受冷却限制。连接失败时立即关闭传输，避免留下孤儿 stdio 子进程。
- 可观测：每轮工具模式对话打一行 `[chat:tools] mcp=<注入数> builtin=<内置数> ready=<id(工具数)> unavailable=<id(原因)> dropped=<被裁服务器>` —— 排查「模型说没有这个能力」时先看这行。
- 连接/断开策略（`PUT /chat/mcp/servers`）：新勾选的立即 `connect`（异步，不阻塞响应）；取消勾选的，只有当**没有任何对话**仍引用（`listEnabledMcpServers()` 跨对话统计）才 `disconnect`（引用计数）。
- 空闲回收：`startIdleSweeper()`（`src/index.ts` 启动）每 `MCP_IDLE_SWEEP_MS`（默认 5 分钟）扫一次，超过 `MCP_IDLE_TIMEOUT_MS`（默认 30 分钟）没被使用的连接直接断开（stdio 子进程不常驻），下次用到时自动重连。**在途调用（`busy>0`）与正在连接的连接不动**；阈值配 0 = 关闭回收。
- 进程退出：`disconnectAll()` 断开全部。
- 状态可见：`listStatuses()` 不主动建连（仅上报配置），连接状态由勾选后的 `connect` 真实反映（`connected / connecting / error / toolsError`）；前端勾选后 1.5s 轮询一次拿到真实状态。

---

## 9. 前端使用

- **输入框左下角「＋」工具菜单**（2026-09-17 起，原顶栏「MCP」按钮已迁至此并与技能入口合并；对齐 ima 等主流产品）：菜单项为 添加文件 / 技能 / 连接器；点（或悬停）「技能」「连接器」在菜单**右侧飞出面板**——顶部搜索框 + 图标·名称·描述列表 + 底部操作，选中行右侧打勾，列表按名称/描述/标识本地过滤；打开菜单即预取两份列表。Esc 收起。
- **面板只做选择**：勾选即连、取消即断；每行可展开只读工具清单、重连；底部「取消全部已选连接器」清回纯直连。服务器清单由部署侧提供（见 §10），前端不提供「添加 / 删除」。
- **技能面板**（与连接器面板同构）：`available` 来自服务端 skills 目录索引，`enabled` 按对话持久化（`conversation.skillsEnabled`）。勾选 = 用户明确「本对话要用这个技能」→ 全文注入系统提示**动态后缀**（稳定前缀不动，prompt cache 不受影响）；不勾 ≠ 禁用（模型仍可按索引 + `read_skill` 自主加载）。
- 对话中：助手气泡内展示工具步骤（命名空间工具名 + 服务器 + 状态 + 结果折叠）；需确认的工具弹出确认卡（工具名 + **确认原因** + 参数预览 + 可选「本对话只读授权」勾选），允许/拒绝即时生效；推理区还展示任务计划、子代理实时进度与知识库检索来源。
- 关键前端函数（`apps/web/src/api.ts`）：`fetchChatMcpServers / setChatMcpServers / reloadMcpServer / confirmToolCall`，`streamChat`（NDJSON 逐行解析）。

---

## 10. 如何提供 MCP 服务器（部署手册）

服务器来源两处，**同 id 时以文件配置为准**（便于本地覆盖）：

- **A. 内置（推荐）**：环境变量 `MCP_BUILTIN_SERVERS`（JSON 数组），随环境变化、**不落盘**、前端不可删。
  凭据**不要**写进这个变量——stdio 子进程会继承父进程环境，凭据放 `.env` 即可。
- **B. 文件配置**：`apps/agent-server/.data/mcp-servers.json`（或调用 `POST /mcp/servers` 写入）。

**stdio 示例**（本地文件系统类服务器）：

```jsonc
// .env
MCP_BUILTIN_SERVERS=[{"id":"fs","label":"文件系统","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"],"requireConfirm":true}]
```

stdio 字段：`id / label / command / args(数组) / cwd / env / requireConfirm`
（`cwd` 缺省继承服务进程工作目录；`env` 缺省继承父进程环境）。

**http 示例**（远程 Streamable HTTP 服务器）：

```jsonc
MCP_BUILTIN_SERVERS=[{"id":"remote-api","label":"内部接口","transport":"http","url":"https://mcp.internal.example.com/mcp","headers":{"AUTHORIZATION":"Bearer xxxxx"}}]
```

加好后 `pm2 restart agent-server-dev` → 打开「MCP」抽屉勾选 → 状态变「已连接 + N 工具」→ 提问即触发 `mcp__<id>__<tool>` 调用，气泡显示步骤并基于真实结果回答。

> 已勾选启用的服务器会在服务启动时自动重连（`src/index.ts`），面板不会再长时间停留在「未连接」。

### 内置 BI 服务器（Metabase）的工具清单

`scripts/metabase-mcp.mjs` 把实例 REST API 暴露为 8 个只读工具。接口形状按**实例自带**的 `GET /api/docs/openapi.json` 核对（当前实例 v0.62.x）：

| 工具 | 对应接口 | 说明 |
|---|---|---|
| `list_databases` | `GET /api/database` | 数据库 id / name / engine / timezone |
| `get_database_schema` | `GET /api/database/:id/metadata` | 默认只列表（`skip_fields=true`，可用 `search` 过滤）；给 `table` 才取该表字段 |
| `run_native_query` | `POST /api/dataset` | 原生 SQL，按 `limit` 截断；未完成时如实报错 |
| `search` | `GET /api/search` | 关键词找表 / 提问 / 仪表盘（写 SQL 前先定位数据） |
| `list_cards` / `get_card` | `GET /api/card[/:id]` | 已保存提问，详情含 MBQL 定义 |
| `list_dashboards` / `get_dashboard` | `GET /api/dashboard[/:id]` | 仪表盘与其中卡片 |

**三个已踩过的坑（按文档修正）**：

1. 仪表盘详情的卡片数组字段是 **`dashcards`**；`ordered_cards` 自 v0.5x 起已移除，读错会**永远返回空卡片**。
2. 表结构默认用 **`skip_fields=true`** 只取表清单；否则一次会拉回全部表（本例 47 张）的所有字段，必被工具结果长度上限截断。
3. `POST /api/dataset` 返回 **202**（`res.ok` 仍为真），必须判 `status` 与 `data.cols` 是否存在，不能假定一定有结果。

验证脚本：
- `node scripts/_bi-tools-check.mjs` —— 以真实 MCP 客户端逐个调用并打印输出（冒烟）。
- `node scripts/_bi-openapi.mjs` —— 打印我们用到端点在实例 OpenAPI 里的权威签名（**升级 Metabase 后先跑它**）。

---

## 11. 验证状态

已实现并通过端到端冒烟（2026-09-16）：

1. 用最小 stdio MCP server（echo 工具）验证「真实连接 → 工具发现 `tools=1` → 模型调用 `mcp__probe__echo` → 结果回灌 → 基于真实结果回答，未编造」。
2. 无 MCP 勾选时回归纯直连路径，行为与改动前一致。
3. 凭据接口只返回键名；连接失败状态可见且不影响主流程。

建议固化脚本化冒烟（MCP 连接 / 流式 / 写确认 / 工具循环四条链路），纳入 CI（见基础设施文档第 15 章）。

**已固化**：`node --import tsx scripts/_mcp-multi-server-check.mjs`（55 项断言，自带 mock stdio server，用 `MCP_BUILTIN_SERVERS` 注入、不碰真实的 `.mcp-servers.json`）。覆盖：多服务器聚合与顺序确定性、缺席服务器上报（5 类原因）、工具数超限回报、工具通道现状注入、取消信号透传、失败冷却、并行连接、连接单飞、确认门注解矩阵、按需加载（阈值 + 检索排序 + 提示）、子代理服务器白名单、空闲回收、同轮去重签名（key 顺序无关）、跨轮 Doom Loop 熔断（连续同指纹触发 / 指纹变化重置 / 空轮不计入）。

**安全闸门（P0）已固化**：`node --import tsx scripts/_risk-gate-check.mjs`（15 项断言，纯函数不依赖真实 MCP / 模型）。覆盖：内置工具登记表（fs_write 免确认 / task 只读）、未知工具 fail-closed（confirm / deny / allow 三口径）、会话级只读授权降级（含未连接服务器）、票据会话绑定（错会话拒绝且一次性）、参数摘要脱敏（敏感键 ••• / 截断 / 上限 8 项）、审计落盘回读。

**2026-09-17 新增回归**（均为零外部依赖，可直接跑）：

| 脚本 | 项数 | 覆盖 |
|---|---|---|
| `scripts/_async-subagent-check.mjs` | 6 | 子代理注册表独立取消（跨会话/未知 id 不命中）、`POST /chat/subagent/:conversationId/:subagentId/cancel` 404/未命中/级联 |
| `scripts/_rag-check.mjs` | 23 | 知识库：解析分发 / 二进制拒绝 / 切片 / 混合检索与来源 / embedding 降级 / 指纹增量 / 索引按 mtime 重载 / 工具接线 / 真实语料命中 |
| `scripts/_untrusted-check.mjs` | 12 | 注入防护：nonce 定界 / 伪造闭合与伪造开标签中和 / 不可见控制符清洗不误伤 / 规则只在工具模式注入 |
| `scripts/_mute-check.mjs` | 7 | 免打扰：持久化 / 列表可见 / 回落 / **不刷新 updatedAt** / 归属守卫 / 非法类型不写脏值 |

活路径（需真实模型，用 `scripts/run-*.ps1` 后台跑）：`_rag-e2e.mjs`（知识库问答 + 子代理并行委派事件流）、`_rag-inject-e2e.mjs`（注入探针实战）。

---

## 12. 关联文档

- `docs/mcp-connect-plan.md`：设计稿（含交互原型、验收标准、实施步骤）。
- `docs/chart-visualization-plan.md`：图表可视化接入方案（AntV Chart MCP，**路线 1 已实施**：官方出图服务 + `requireConfirm` 数据外发确认；自托管/前端渲染挂账）。
- `docs/agent-infrastructure.md`：通用 Agent 基建指南，第 3/4/5/14 章对应当前实现与缺口。
- 历史参考实现（已瘦身的登录/权限/审计/RAG/异步任务等）：`.data/trash-20260916/code/`，按需按新契约裁剪恢复。
