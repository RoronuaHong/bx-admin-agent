# 会话发送模式开关：抢占式 vs 排队等待

- 日期：2026-11-16
- 状态：设计已确认，待实现计划
- 决策来源：与用户逐项确认（粒度/默认、UI 范围、切换语义、逃生口）

## 1. 背景与目标

当前实现把"同一对话生成中再次发送"固定为**抢占式**（新消息直接开新 run，旧轮由服务端 `cancelled` 事件标记「已停止生成」）。但部分场景需要等待当前生成完成、再把新消息按顺序发出——即原设计文档 `docs/conversation-state-plan.md` §11.2 的 **B 档（排队等待）**。

目标：让用户在**每个对话**上选择「抢占式 / 排队等待」，默认保持抢占（不破坏现有手感），排队模式复用已有的、经过并发加固的队列链路（409 → 原子入队 → 上一轮成功收束后自动出队）。

对应关系：排队 = B 档，抢占 = C 档（现行为），A 档（队列项「立即发送」中断当前轮）已内嵌于队列 UI，D 档（实时注入 steer）不做。

## 2. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 开关粒度 / 默认值 | 每对话独立；无字段（新/老对话）默认 **抢占式** |
| UI 范围 | 仅 ChatPage 侧栏右键菜单；MoviePage 不动（极简页，固定抢占） |
| 切换时对当前轮 | 纯设置、无副作用：不中止正在生成的轮次，只影响下一条消息 |
| 队列项「立即发送」 | 保留（沿用 `sendQueueItemNow`，排队中可中断当前轮插队） |
| unattended 定时任务 | 无论哪档都**永不抢占**（硬约束不变） |
| 多标签页一致性 | 后端按会话文档判定，设置对所有标签页立即生效 |

不做：全局 / 账号级默认、MoviePage 支持、D 档实时注入。

> 已知约束：MoviePage 保持极简、固定抢占，且 ChatPage 按 `agentId=generic` 过滤看不到 movie 对话，故 UI 上无法给 movie 对话切档。但 `sendMode` 是会话级字段，若通过 API 直接把某 movie 对话设成 `queue`，MoviePage 撞忙时会收到 409 而没有入队链路（它只在 UI 路径下不可达）。这是刻意接受的边界，不在本功能范围。

## 3. 方案选择

- **方案 A（采用）**：会话级字段 `sendMode` + 后端权威判定 `canPreempt` + 复用现有 409 入队链路。改动最小，多标签页语义一致。
- 方案 B（弃）：前端发消息前预判 busy 直接入队。存在前后端 busy 判定竞态，且需 409 兜底，等于做两遍。
- 方案 C（弃）：请求 body 每次携带 mode。各标签页各带各的，模式不一致。

## 4. 详细设计

### 4.1 数据模型（`apps/agent-server/src/conversations.ts`）

- `ConversationDoc` 与 `ConversationPatch` 新增 `sendMode?: "preempt" | "queue"`。
- `patchConversation` 的 `$set` 白名单数组加入 `sendMode`（否则 PATCH 成功但不落库）。
- `ACTIVITY_NEUTRAL_KEYS` 加入 `sendMode`（切换设置是整理动作，不刷新 `updatedAt`、不把对话顶到列表最前）。

### 4.2 后端判定（`apps/agent-server/src/app.ts`）

唯一核心改动，位于 `/chat/stream` 抢占判定处：

```
canPreempt = !!preemptTarget && !preemptTarget.unattended && convDoc?.sendMode !== "queue"
```

- `convDoc` 在该处已通过 `getConversation(conversationId)` 取到，无需新增查询。
- 无字段 / `preempt` → 允许抢占（默认行为不变）。
- `queue` → `canPreempt=false`，自然落到已有的 409 `CONVERSATION_BUSY` 分支（`app.ts` 约 1820-1822），前端复用入队。
- `unattended` 的 `!preemptTarget.unattended` 条件保留在前，硬约束不变。
- 429（限流 / 并发上限）与 409 `CHAT_QUEUE_FULL` 语义不变。

PATCH 端点（`app.ts` 约 2135-2169）：body 类型加 `sendMode` 并做枚举校验（仅 `preempt`/`queue`），赋值进 `ConversationPatch`。

### 4.3 前端 API（`apps/web/src/api.ts`）

- `ConversationDto` 加 `sendMode?: "preempt" | "queue"`。
- `patchConversation` 的 patch 类型加 `sendMode?`。
- `streamChat` 的 body **不改**（会话级方案无需前端每次传 mode）。

### 4.4 前端 UI（`apps/web/src/pages/ChatPage.vue`）

- 侧栏对话右键菜单新增一项「发送模式：抢占式 / 排队等待」，与「免打扰」「完全访问」并列（约 L5802-5815 区域）。
- 处理器仿 `toggleMute()` / `toggleFullAccess()`：乐观更新会话列表 DTO + `patchConversation(id, { sendMode })` + 失败回滚 + 提示。
- 开关是纯设置：不 abort 当前任务、不改 `sending` / `runCount`、不动输入框。
- 菜单项显示当前值（勾选态或文字后缀），让用户可辨认当前对话处于哪档。
- `send()` / `runTurn()` / 409 catch 入队 / `drainQueue()` / `watchAndDrain()` / `sendQueueItemNow()` **全部不改**。

### 4.5 数据流

```
用户在右键菜单切「排队等待」
  → patchConversation(convId, { sendMode: "queue" })（乐观更新 + 回滚）
用户发消息
  → runTurn → streamChat（body 不变）
  → 后端读 convDoc.sendMode
       ├─ 缺省 / "preempt" → canPreempt=true → 抢占：开新 run，旧轮 cancelled 标记已停止
       └─ "queue" → canPreempt=false → 409 CONVERSATION_BUSY
            → 前端 catch：enqueueMessage + watchAndDrain
            → 上一轮成功收束 → drainQueue 自动发出下一条
```

切换瞬间正在跑的轮次不受影响；新设置从下一条消息起生效。队列模式下仍可点队列项的「立即发送」中断当前轮插队。

### 4.6 错误处理

- PATCH `sendMode` 非法值：后端静默忽略（与既有字段风格一致，返回 200、保持原值），前端只发合法值；网络失败才乐观回滚。
- 队列满：`CHAT_QUEUE_FULL`（409）沿用现有提示，不改。
- 排队模式下若上一轮出错 / 被停止 / 待确认：`drainQueue` 的现有条件（`ok && !sending && !pending`）保证不自动发下一条，等用户决定——语义不变。
- unattended 定时任务期间：新消息仍走 409 入队，无论开关取值。

## 5. 测试

新增 E2E 文件 `apps/agent-server/tests/send-mode.test.ts`，沿用 `preempt-e2e.test.ts` 的 `createApp().request()` 真实 HTTP 路由范式（不改动已加固的现有测试文件）：

1. 默认（无 `sendMode`）会话：交互任务忙时仍可抢占（canPreempt=true）。
2. `sendMode="queue"` 会话：交互任务忙时返回 409 `CONVERSATION_BUSY`，且消息进入 pendingQueue；上一轮收束后出队。
3. `sendMode="queue"` 会话的队列满：返回 409 `CHAT_QUEUE_FULL`，不丢已有项。
4. 模式切换中途切回 `preempt`：不影响 `unattended` 永不抢占约束。
5. PATCH 端点读写 `sendMode`：合法值落库可读、非法值被拒。
6. `sendMode` 切换不改变 `updatedAt`（ACTIVITY_NEUTRAL 语义）。

前端 UI 无单测框架，靠 type-check + 手动审查验证（与项目现状一致）。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `apps/agent-server/src/conversations.ts` | `ConversationDoc` / `ConversationPatch` 加 `sendMode`；`$set` 白名单 + `ACTIVITY_NEUTRAL_KEYS` |
| `apps/agent-server/src/app.ts` | `/chat/stream` 的 `canPreempt` 加 `convDoc.sendMode !== "queue"`；PATCH body 加 `sendMode` 校验与赋值 |
| `apps/web/src/api.ts` | `ConversationDto` / `patchConversation` 加 `sendMode` |
| `apps/web/src/pages/ChatPage.vue` | 右键菜单加开关项 + 处理器（乐观更新 / 回滚） |
| `apps/agent-server/tests/send-mode.test.ts`（新增） | 上述 6 个 E2E 用例 |

不改：MoviePage、`chat-tasks.ts`、`task-store.ts`、`chat-stream.ts`、队列端点、`streamChat` body。

## 7. 验收标准

- 默认行为与现状完全一致（抢占）。
- 排队对话在忙时消息入队、不抢占、上一轮成功后按序自动发出；队列满有明确提示。
- 切换模式不影响当前生成、不影响 unattended 约束、对所有标签页生效。
- `pnpm type-check` 通过；全量 vitest 通过；改动文件 lint 0 错误。
