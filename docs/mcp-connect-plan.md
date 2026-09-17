# 连接 MCP 服务器（设计稿）

> 状态：**已实现（2026-09-16）**，接口与 UI 均已接线并通过端到端冒烟（stdio 服务器连接 → 工具发现 `tools=1` → 模型调用 `mcp__probe__echo` → 结果回灌 → 基于真实结果回答，未编造）。
> 实现要点：`src/mcp/config.ts`（配置持久化 + 凭据脱敏）、`src/mcp/hub.ts`（stdio / Streamable HTTP 连接与工具调用）、
> `src/confirm.ts`（写操作确认通道）、`models.ts` 恢复 function calling（OpenAI 流式 tool_calls 增量 / anthropic tool_use）、
> `chat.ts` 工具循环（未勾选 MCP 时保持原直连路径不变）、`app.ts` 端点、前端 `ChatPage.vue` 的 MCP 面板与工具步骤气泡。
> 注意：会话靠匿名 cookie 识别，`/chat/mcp/servers` 的 GET/PUT 必须回写 cookie，否则启用集存不住。
>
> 📘 **实现与使用指南（权威参考）见 `docs/mcp-guide.md`**：含模块分工、API 契约、事件契约、护栏常量、会话/连接生命周期、前端用法与添加服务器示例。本文为设计/交互稿，第 2 节描述的是「瘦身之后、接入 MCP 之前」的基线，仅作对照。

## 1. 目标

聊天页面提供「连接 MCP」的**选择入口**：用户从已配置的 MCP 服务器里**勾选要连接哪些**（可多选、可随时取消），勾上即连到当前会话，模型就能用这些服务器暴露的工具；一个都不勾就是纯直连。

- 一级入口 = 「选择连接哪些 MCP」的多选控件（不是新增表单）
- 次级入口 = 在同一个面板里「添加新的 MCP 服务器」（stdio / http）
- 核心原则：**不勾任何 MCP 时保持现在的「直连大模型」行为不变**（一次调用、流式直出）；勾选后才走工具循环

## 2. 现状（2026-09-16 瘦身之后）

后端（`apps/agent-server/src`，共 9 个文件）：

- `chat.ts`：一次模型调用 + 流式 `text_delta → text → done`，无工具、无循环
- `models.ts`：anthropic / openai（流式）/ ollama 纯文本，**已删除 function-calling 相关代码**
- `app.ts`：`/health`、`/models`、`/chat/stream`、`/chat/conversations*`、`/chat/upload`
- 无 `mcp/`、`engine/`、`rag/`，无登录、无 ownerKey

前端（`apps/web/src`）：只有 `pages/ChatPage.vue`（会话侧栏 + 流式气泡 + 模型下拉 + 图片上传 + markdown），`api.ts` 的 `ChatEvent` 只有 `text/text_delta/model/error/done`。

共享类型（`packages/shared/src/index.ts`）：`LocalizedToken / ApiErrorPayload / ChatEvent`。

> 旧实现可参考备份：`.data/trash-20260916/code/apps-agent-server-src/mcp/*.ts`（需按新契约裁剪，旧的含登录/权限/索引等已删逻辑）。

## 3. 交互设计（前端）

### 3.1 主入口：MCP 选择器（多选）

顶部工具栏「MCP」按钮（模型下拉旁）→ 点开下拉面板：

```
┌ MCP 连接 ─────────────────────────────┐
│ ☑ 文件系统        stdio  ● 已连接  12 工具 │
│ ☐ 数据库查询      http   ● 未连接   8 工具 │
│ ☐ 内部接口        stdio  ● 失败（超时）   │
│ ─────────────────────────────────────  │
│ ＋ 添加 MCP 服务器                       │
│ 全部断开                                │
└────────────────────────────────────────┘
```

- 每一行 = 一个已配置的 MCP 服务器：复选框 + 名称 + 传输方式 + 连接状态点 + 工具数量
- **勾选即连接**到当前会话（异步连接，转圈 → 成功/失败）；取消勾选即断开
- 状态点：已连接（绿）/ 未连接（灰）/ 连接失败（红，hover 显示原因）
- 点条目可展开只读工具清单（工具名 + 描述）
- 底部「全部断开」= 清空选择，回到纯直连
- 顶部显示已选数量，如「MCP · 2」

### 3.2 次级入口：添加服务器表单

面板内「＋ 添加 MCP 服务器」→ 表单：

- 通用：`id`、`label`、`transport`、`timeoutMs`、`requireConfirm`
- stdio：`command`、`args`、`cwd`、`env`
- http：`url`、`headers`
- 凭据（env / headers）**只写不回显**，接口只返回键名
- 保存后自动出现在选择列表，并可立即勾选

### 3.3 默认行为

- 新会话默认**不勾选任何 MCP** → 纯直连
- 选择结果按会话保存（`PUT /chat/mcp/servers`），切换会话互不影响

## 4. 后端设计

新增 / 修改文件：

| 文件 | 职责 |
|---|---|
| `src/mcp/config.ts` | 配置持久化 `.data/mcp-servers.json`；`loadServers / getServer / upsertServer / deleteServer / validateServerInput`；对外脱敏 |
| `src/mcp/hub.ts` | 连接管理（stdio 子进程 / Streamable HTTP）：`collectTools(serverIds)`、`callMcpTool(name, input)`、`listStatuses()`、`disconnect(id)` |
| `src/chat.ts` | 启用 MCP 时：把工具定义随模型请求发出 → 模型返回 `tool_calls` → 执行 → 结果回灌 → 再次调用，直到模型给出结论或达 `MAX_TOOL_ROUNDS`；未启用时保持现有直连逻辑 |
| `src/models.ts` | 恢复 function calling：请求体带 `tools`（含 `tool_choice`）、解析流式 `tool_calls` 增量 |
| `src/app.ts` | `/mcp/servers`（GET 列表 / POST 新增或更新 / DELETE 删除 / POST `:id/reload` 重连重列工具）、`/chat/mcp/servers`（**GET 返回 `{ available: 服务器[]含连接状态, enabled: 本会话已选 id[] }`；PUT 保存勾选结果，并触发对应服务器的连接/断开**）、`/chat/confirm`（写操作确认回调） |
| `packages/shared/src/index.ts` | `ChatEvent` 扩展 `tool_call / tool_result / confirmation_required / confirmation_response` |

工具命名：`mcp__<serverId>__<toolName>`。

## 5. 数据结构

```ts
interface McpServerConfig {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled: boolean;
  requireConfirm?: boolean;
}
```

## 6. 安全与护栏

- 凭据只落本机文件，接口返回仅键名，绝不回传值
- `requireConfirm` 的服务器：调用前发 `confirmation_required`，等前端 `POST /chat/confirm` 确认后才执行
- 工具数量上限 `MCP_MAX_TOOLS`（默认 80），超出截断并打日志
- 单次工具结果截断 `MAX_TOOL_RESULT_CHARS`（默认 12000）
- 轮次上限 `MAX_TOOL_ROUNDS`（默认 14）；同签名重复调用熔断（Doom Loop）
- 进程退出时断开全部连接

## 7. 验收标准

1. 顶部「MCP」按钮可点开选择面板，列出已配置服务器及其连接状态
2. 勾选一个 → 自动连接并显示「已连接 + 工具数」；提问触发工具调用 → 气泡显示工具步骤 → 基于真实结果回答，不编造
3. 取消勾选 / 「全部断开」→ 立即断开，回到纯直连，行为与现在完全一致
4. 面板内添加 stdio 服务器 → 保存后出现在选择列表并能立即勾选
5. 连接失败时状态点变红并显示原因，不影响聊天主流程
6. 选择结果按会话保存，切换会话互不影响
7. 凭据字段在接口返回中只出现键名
8. 后端 `tsc --noEmit` 通过、前端 `vite build` 通过

## 8. 实施步骤（建议顺序）

1. `pnpm add @modelcontextprotocol/sdk`（agent-server 依赖）
2. 恢复并裁剪 `src/mcp/config.ts`、`src/mcp/hub.ts`
3. `app.ts` 加 MCP 管理端点与会话启用集端点
4. `models.ts` 恢复 function calling；`chat.ts` 加工具循环（未启用 MCP 时走原路径）
5. `packages/shared` 扩展 `ChatEvent`
6. 前端：`api.ts` 加接口 → `ChatPage.vue` 加「连接 MCP」抽屉、工具步骤渲染、确认弹窗
7. 端到端验证（含无 MCP 时的回归）
