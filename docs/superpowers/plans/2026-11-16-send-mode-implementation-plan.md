# 实现计划：会话发送模式开关（抢占式 vs 排队等待）

- 对应 spec：`docs/superpowers/specs/2026-11-16-send-mode-preempt-vs-queue-design.md`
- 日期：2026-11-16

## 任务清单（按顺序执行）

### T1 后端数据模型
文件：`apps/agent-server/src/conversations.ts`
1. `ConversationDoc` 加 `sendMode?: "preempt" | "queue"`（带注释：队列模式忙时排队、默认抢占）。
2. `ConversationPatch` 加同名字段。
3. `patchConversation` 的 `$set` 白名单数组加 `"sendMode"`。
4. `ACTIVITY_NEUTRAL_KEYS` 加 `"sendMode"`。
验证：`tsc --noEmit` 通过；现有 conversations 测试通过。

### T2 后端判定与 PATCH 端点
文件：`apps/agent-server/src/app.ts`
1. `/chat/stream`：`canPreempt` 表达式加 `&& convDoc?.sendMode !== "queue"`（保持 `owner` 在判定前声明）。
2. PATCH `/chat/conversations/:id`：body 类型加 `sendMode?: string`；仅当值为 `"preempt"`/`"queue"` 时写入 `patch.sendMode`（非法值忽略或 400，选忽略与既有字段风格一致）。
验证：`tsc --noEmit` 通过。

### T3 前端 API 类型
文件：`apps/web/src/api.ts`
1. `ConversationDto` 加 `sendMode?: "preempt" | "queue"`。
2. `patchConversation` 的 patch 类型加 `sendMode?: "preempt" | "queue"`。
验证：`vue-tsc --noEmit` 通过。

### T4 前端 UI（ChatPage 右键菜单）
文件：`apps/web/src/pages/ChatPage.vue`
1. 右键菜单（约 L5802-5815 免打扰/完全访问处）加一项「发送模式：抢占式 / 排队等待」，显示当前档位。
2. 处理器 `toggleSendMode(id)`：仿 `toggleMute`——从 `conversations.value` 读当前值算新值，乐观更新 DTO，`patchConversation(id,{sendMode})`，失败回滚 + 提示。
3. 菜单点击后不关闭面板也可（与现有项行为一致）。
验证：`vue-tsc --noEmit` 通过；菜单文案本地化 4 语种齐全。

### T5 E2E 测试
文件：`apps/agent-server/tests/send-mode.test.ts`（新增）
沿用 `createApp().request()` 范式，覆盖：
1. 默认（无 sendMode）会话忙时交互任务可抢占。
2. `sendMode=queue` 会话忙时新消息返回 409 `CONVERSATION_BUSY` 并入队、收束后出队。
3. 队列满 `CHAT_QUEUE_FULL`（可复用队列测试思路，简测）。
4. 切回 `preempt` 后恢复可抢占；unattended 始终不抢占。
5. PATCH 读写 sendMode：合法落库可读、非法忽略。
6. sendMode 切换不改 updatedAt（ACTIVITY_NEUTRAL）。

### T6 全量验证与文档
1. `pnpm type-check`。
2. 全量 vitest（用脚本规避 watch 误判），确认全绿。
3. 改动文件 lint 0 错误。
4. 更新 `docs/chat-preempt-plan.md`：记录本功能已实现、验证结果。

## 风险与注意
- `convDoc` 在 `/chat/stream` 已取到，T2 无需新增查询；确认变量名与作用域。
- `canPreempt` 改动必须保留 `!preemptTarget.unattended` 在前，硬约束不变。
- 队列链路（409 入队 / drainQueue / watchAndDrain / sendQueueItemNow）一律不改。
- MoviePage 不改。
