# MCP 连接能力 · 实现与使用指南

> 版本：v1（2026-09-16）
> 定位：MCP 能力的**权威实现参考 + 用户使用手册**，与 `docs/mcp-connect-plan.md`（设计稿）配套。
> 设计原则贯穿全文：**不勾选任何 MCP 时，保持纯直连大模型的行为完全不变**（一次调用、流式直出）；只有勾选了服务器才进入工具循环。

本项目位置：后端 `apps/agent-server/src`，前端 `apps/web/src`，共享类型 `packages/shared/src`。

---

## 1. 能力概览

- 聊天页顶部「MCP」按钮是一个**多选抽屉**：从已配置的服务器里勾选要连到当前会话的（可多选、可随时取消），勾上即连、模型即可用其工具；一个都不勾就是纯直连。
- 服务器清单由部署侧提供（`.env` 的 `MCP_BUILTIN_SERVERS` 或 `.data/mcp-servers.json`），前端只做选择，不含「添加 / 删除」。
- 支持的传输：`stdio`（子进程）与 `Streamable HTTP`（远程）。
- 工具以 `mcp__<serverId>__<tool>` 命名空间注入模型，多源工具不重名冲突。
- 写操作护栏：`requireConfirm` 的服务器，每次调用前弹出确认卡，用户允许才执行；超时按拒绝处理。
- 会话级启用集：按匿名 cookie 识别的会话保存「勾选了哪些」，切换会话互不影响。
- 连接失败只记录状态、不影响聊天主流程；未连接/连接失败的服务器在工具循环里静默跳过。

成熟度：对照 `docs/agent-infrastructure.md` 的路线图，本项目处于 **M1（工具闭环）已达成**。

---

## 2. 架构与数据流

```
用户勾选 MCP ──PUT /chat/mcp/servers──▶ 会话启用集(per-session) + 按需 connect
                                                  │
提问 ──POST /chat/stream──▶ chatStream                       │
                              │                               │
              tools=collectTools(enabled)  ──▶ hub.connect(id)（全局一条长连接）
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
| `src/mcp/config.ts` | 服务器配置持久化（`.data/mcp-servers.json`）；`loadServers / getServer / upsertServer / deleteServer / validateServerInput / toPublic`（凭据脱敏为键名）。 |
| `src/mcp/hub.ts` | 连接管理：`connect / disconnect / disconnectAll / listStatuses / reload / collectTools / callMcpTool / toolNeedsConfirm`。每个 server 全局一条长连接，工具命名空间编码。 |
| `src/confirm.ts` | 写操作二次确认通道：`waitForConfirmation(callId)` 挂起，`answerConfirmation(callId, confirmed)` 由前端应答解挂；超时按拒绝。 |
| `src/chat.ts` | 聊天引擎：`chatStream`（无工具→直连单次；有工具→`runWithTools`）；`streamCall` 边收增量边 yield；护栏常量。 |
| `src/models.ts` | 模型适配：OpenAI / Anthropic / Ollama；恢复 function calling（工具定义 + 流式 `tool_calls` 增量解析，按 index 拼接）。 |
| `src/session.ts` | 匿名会话：cookie `bx_agent_sid`、启用集 `mcpServers`、引用计数的落盘。 |
| `src/app.ts` | 端点装配：`/mcp/servers*`、`/chat/mcp/servers`、`/chat/confirm`、`/chat/stream` 等。 |
| `packages/shared/src/index.ts` | `ChatEvent` 类型（含 `tool_call / tool_result / confirmation_required / confirmation_response`）。 |
| `apps/web/src/api.ts` | 前端接口封装 + `ChatEvent` 镜像类型。 |
| `apps/web/src/pages/ChatPage.vue` | MCP 抽屉、工具步骤气泡、确认卡。 |

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
| `requireConfirm` | boolean | 该服务器工具调用前是否需用户确认。 |

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
| `GET /chat/mcp/servers` | 当前会话可用服务器（含连接状态）+ 已启用 id | — | `{ available: ServerStatus[]; enabled: string[] }`；首次访问回写会话 cookie |
| `PUT /chat/mcp/servers` | 保存勾选结果，触发对应连接/断开（异步） | `{ enabled: string[] }` | `{ enabled: string[]; available: ServerStatus[] }` |
| `POST /chat/confirm` | 写操作确认回调 | `{ callId: string; confirmed: boolean }` | `{ ok: boolean; confirmed: boolean }` |
| `POST /chat/stream` | 一轮对话（HTTP Streamable，NDJSON 分块） | `{ text; model?; images? }` | `application/x-ndjson`（每行一条 `ChatEvent` JSON） |

`ServerStatus`：`{ id, label, transport, enabled, connected, error?, tools, toolNames }`。

会话 cookie 注意：`GET/PUT /chat/mcp/servers` 与 `POST /chat/stream` 在「未带有效会话 cookie」时**必须回写 cookie**，否则每次请求都生成新会话，启用集存不住（已修复）。

流式与断连：`/chat/stream` 走 HTTP Streamable（`Transfer-Encoding: chunked` + NDJSON，每行一条事件），**不使用 SSE**——`text/event-stream` 会被 vite dev 代理缓冲，导致工具步骤/确认事件无法实时到达前端。前端点“停止”或关闭页面时，`@hono/node-server` 会 abort `c.req.raw.signal`；该信号已透传给 `chatStream → callModel` 的 `fetch`，可中止在途模型调用（避免服务端空跑）。

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
| { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
| { type: "usage"; tokens: number; budget: number; window: number; turns: number; dropped: number; toolResultsCleared: number }  // 上下文用量（透明度）
| { type: "done" }
```

事件顺序（工具循环内一轮）：`text_delta* → tool_call → (confirmation_required → confirmation_response)? → tool_result → … → 下一轮 text_delta* … → text → usage → done`。

**上下文预算**：以 token 计并由模型窗口推导 —— 历史预算 = `(CONTEXT_WINDOW − MODEL_MAX_OUTPUT_TOKENS − 工具 schema − MCP_TOOL_RESULT_BUDGET) × CONTEXT_SAFETY_RATIO`；跨轮裁剪后保证首条为 `user`（部分 provider 要求）。本轮工具结果超 `MCP_TOOL_RESULT_BUDGET` 时从最旧的开始清理并替换为占位文本，但保留最近 `MCP_TOOL_RESULT_KEEP` 组与 `MCP_TOOL_RESULT_PROTECT` 白名单。跨轮只保留工具**轻量句柄**（工具名 + 参数摘要 + 结果规模），不保留结果正文。窗口由 `MODEL_<ID>_CONTEXT_WINDOW` / `MODEL_CONTEXT_WINDOW` 配置。

---

## 6. 工具循环与护栏

`src/chat.ts` 中的常量（均可经环境变量覆盖）：

| 常量 | 默认 | 环境变量 | 说明 |
|---|---|---|---|
| `HISTORY_MAX_TURNS` | 8 | — | 带入模型的历史轮数（实际取 `×2` 条消息）。 |
| `HISTORY_CHAR_BUDGET` | 24000 | — | 历史字符预算，超了从头裁剪。 |
| `MCP_MAX_TOOLS` | 80 | `MCP_MAX_TOOLS` | 注入模型的工具数上限，超出截断并告警。 |
| `MAX_TOOL_ROUNDS` | 14 | `MAX_TOOL_ROUNDS` | 工具循环轮次上限，达上限即收束报错而非编造。 |
| `MAX_TOOL_RESULT_CHARS` | 12000 | `MAX_TOOL_RESULT_CHARS` | 单条工具结果回灌截断长度。 |
| — | 60000 | — | `src/mcp/hub.ts` 连接/调用默认超时。 |
| — | 120000 | `MCP_CONFIRM_TIMEOUT_MS` | `src/confirm.ts` 确认等待超时（超时按拒绝）。 |

工具注入使用 `tool_choice: "auto"`；Ollama 通道不接工具（工具结果降级为 user 文本，保证多轮连贯）。

**已知护栏缺口**（对照基础设施文档 M1 项，待补）：同轮同参数去重、跨轮 Doom Loop 熔断、并发工具调用、断点恢复。当前仅做了轮次上限 + 工具数/结果长度上限。

---

## 7. 写操作确认流程（requireConfirm）

1. 勾选了 `requireConfirm` 的服务器，模型返回对该服务器工具的 `tool_calls`。
2. `runWithTools` 对该调用先 yield `confirmation_required`，随后 `await waitForConfirmation(call.id)` 挂起。
3. 前端收到事件 → 在气泡内渲染确认卡（工具名 + 参数预览）→ 用户点「允许 / 拒绝」→ `POST /chat/confirm { callId, confirmed }`。
4. `answerConfirmation` 解挂，`confirmation_response` 回推前端；允许则执行 `callMcpTool`，拒绝/超时则把「已取消/已拒绝」作为工具结果回灌模型，让模型自行调整。
5. 确认请求本身零副作用；超时（默认 120s）按拒绝处理。

---

## 8. 会话与连接生命周期

- 会话：匿名 cookie `bx_agent_sid`（UUID 校验防伪造），TTL 由 `config.sessionTtlMs` 决定；停用会话的启用集一并清除。
- 启用集：每个会话保存 `mcpServers: string[]`（勾选的 id）。空数组 = 纯直连。
- 连接复用：hub 内 `conns` 以 serverId 为键，全局一条长连接。
- 连接/断开策略（`PUT /chat/mcp/servers`）：新勾选的立即 `connect`（异步，不阻塞响应）；取消勾选的，若**没有其它会话**仍引用，才 `disconnect`（引用计数）。
- 进程退出：`disconnectAll()` 断开全部。
- 状态可见：`listStatuses()` 不主动建连（仅上报配置），连接状态由勾选后的 `connect` 真实反映；前端勾选后 1.5s 轮询一次拿到真实状态。

---

## 9. 前端使用

- 顶部「MCP」按钮（模型下拉旁）：点开抽屉会先刷新一次状态，列出可用服务器及状态点（已连接绿 / 未连接灰 / 失败红）。
- **面板只做选择**：勾选即连、取消即断；每行可展开只读工具清单、重连；顶部「全部取消」清回纯直连。服务器清单由部署侧提供（见 §10），前端不再提供「添加 / 删除」。
- 对话中：助手气泡内展示工具步骤（命名空间工具名 + 服务器 + 状态 + 结果折叠）；`requireConfirm` 服务器弹出确认卡，允许/拒绝即时生效。
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

---

## 12. 关联文档

- `docs/mcp-connect-plan.md`：设计稿（含交互原型、验收标准、实施步骤）。
- `docs/agent-infrastructure.md`：通用 Agent 基建指南，第 3/4/5/14 章对应当前实现与缺口。
- 历史参考实现（已瘦身的登录/权限/审计/RAG/异步任务等）：`.data/trash-20260916/code/`，按需按新契约裁剪恢复。
