# 对话抢占式生成（Chat Preempt）实施与验收记录

> **文档重建于 2026-11-13**。原 `chat-preempt-plan.md`（含完整动机、现状、风险推演、场景验证等约 87KB 历史内容）在会话间隙被删除/移走，本文件聚焦 **P0 实施落地与验收记录**，不再重建完整推演史。如需完整计划文档请从 git 历史恢复。
>
> 本文档覆盖：P0 改动清单、修复落地清单（§2）、全链路查缺补漏与实地读码验证（§3）、P1 待办（§4）。

---

## 1. P0 实施完成清单

### 后端（apps/agent-server）

- **R05 / R31（确认等待协程泄漏）**：`confirm.ts` 的 `registerTicket` 的 `wait` 绑定 `AbortSignal`，抢占时立即按「拒绝」收束；`chat.ts` 的 `requestConfirmation` / `requestClarification` 透传 `ctx.signal`。
- **R06（校验顺序）**：`app.ts` 的 `/chat/stream` 改为「先判定可抢占 → 限流 / 并发校验全部通过后才 `cancelTask`」，避免「旧任务取消、新消息没发出」。
- **R07（定时任务豁免）**：`ChatTask` 加 `unattended?`；`app.ts` 抢占路径对 `unattended` 任务退回 409 不抢占；`startScheduleLoop` 调用 `startTask` 时设 `unattended: true`。
- **R09 后端 / R01 / R03**：`cancelTask` 在 `abort()` 前发 `cancelled` 事件（status 仍 running，过 `publishTaskEvent` 守卫，天然规避 R33）；`finishTask` 加 `stillCurrent` 守卫（旧任务不删共享结构）；`task-store` 的 `flushTask` 加 `taskId` CAS（旧任务迟到写被拒）。
- **R02**：`task-store` 的 `memPut` 按 `taskId` 隔离 events，根治内存降级路径的 `seq` 跨任务冲突。

### 前端（apps/web）

- **R09 前端**：`packages/shared` 的 `ChatEventBody` 加 `{ type: "cancelled" }`；`chat-stream.ts` 新增 `cancelled` 分支（标记旧气泡已停止、清 `pending` / `clarification` 卡），并扩展 `ChatStreamHost.localizeStopMarker`（复用主动 Stop 的多语文案）；增量分支不检查 `sawTerminal` → wrapup 收尾文本自然显示（R33 规避）。
- **R04（放开 canSend）**：`ConvState` 由单值 `controller/sending` 改为 `runCount` / `controllers[]` / `dispatching`；`canSend` 去掉 `!sending`；`send` / `runTurn` 改为直接开新 run 抢占、不再入队；`stop` / 删除 / 出队 / `attachRunningTask` 均 abort 全部活跃轮次。
- **R08（并发双发）**：`send` 顶部加**同步原子** `dispatching` 标志，在 `runTurn` 同步置位 `sending` 后释放，杜绝同步双触发开两个 run。

### 验证

- Web + Agent-Server 共 7 文件 `read_lints` 全部 0 错误。
- 搜索确认 ChatPage 已无遗留的 `.controller` 单值引用。

---

## 2. P0 修复落地清单

| ID | 实际落点（文件 / 函数） | 修复手段 |
|---|---|---|
| R01 | `chat-tasks.ts` `finishTask` | 加 `stillCurrent` 守卫：仅当 `running.get(conv)===task` 才改 `running`/`lastTask`/`retained`，旧任务不污染新任务 |
| R02 | `task-store.ts` `memPut` | 按 `taskId` 隔离 events 拼接（不同 taskId 不复用对方 events），根治内存降级路径的 seq 跨任务冲突 |
| R03 | `task-store.ts` `flushTask` | `updateOne` 加 `taskId` CAS（`{_id:conv, taskId:record.taskId}`），旧任务迟到写因 taskId 不匹配被拒，不覆盖新任务留档 |
| R04 | `pages/ChatPage.vue` `ConvState`/`canSend`/`send`/`runTurn` | `ConvState` 由单值 `controller/sending` 改为 `runCount`/`controllers[]`/`dispatching`；`canSend` 去掉 `!sending`；`send`/`runTurn` 直接开新 run 抢占而非入队 |
| R05 | `confirm.ts` `registerTicket` + `chat.ts` 两处调用 | `wait` 绑 `AbortSignal`，signal 触发即 `resolve({confirmed:false,timedOut:false})` 并清 timer/tickets；`requestConfirmation`/`requestClarification` 透传 `ctx.signal` |
| R06 | `app.ts` `/chat/stream` | 改为「先校验（限流/并发/容量）后取消」；并发计数排除 `preemptTarget`；不可抢占（如 `unattended`）回退 409 |
| R07 | `chat-tasks.ts` `ChatTask.unattended` + `app.ts` 定时任务 | `ChatTask` 加 `unattended`；抢占路径对 `unattended` 任务退回 409 不抢占；`startScheduleLoop` 调 `startTask` 带 `unattended:true` |
| R08 | `pages/ChatPage.vue` `send` | 顶部加**同步原子** `dispatching` 标志，在 `runTurn` 同步置位 `sending` 后释放，杜绝同步双触发开两个 run |
| R09 | `shared/index.ts` + `chat-stream.ts` + `ChatPage.vue` | `ChatEventBody` 加 `{type:"cancelled"}`；`applyStreamEvent` 新增 `cancelled` 分支（标记旧气泡已停止、清 `pending`/`clarification` 卡、追加本地化 STOPPED_MARKER）；`ChatStreamHost` 加 `localizeStopMarker` |
| R31 | 同 R05（`confirm.ts` 绑 signal） | 抢占使 A 的确认等待立即收束，协程不再挂 `await wait` 泄漏 |
| R13（顺带） | `chat-stream.ts` / `chat-tasks.ts` `publishTaskEvent` | `sawTerminal` 仅用于终态幂等（防 `finally` 二次标记 + 防旧 run 重入 resumeRun），不吞迟到增量；真正的串流迟到事件由后端 `publishTaskEvent` 守卫（status≠running 丢弃）拦截 |
| R33（顺带） | `chat-stream.ts` 增量分支 | 增量分支不检查 `sawTerminal`，旧 runner 在 abort 后产生的 wrapup `text_delta` 正常渲染（不丢「哪些没查完」说明） |
| R35（顺带） | `chat-stream.ts` `cancelled` 分支 | `cancelled` 分支统一清 `reply.pending=null`，确认卡不残留 |

> **未做项**：R11（MoviePage）属 P1，本期保持 MoviePage 串行 + 409 显式拒绝，未收敛到 `chat-stream.ts`；R34（多实例脑裂）需方案 C（留档主键改 `taskId`），本期未做。

---

## 3. 查缺补漏与验收记录（2026-11-13）

### 3.1 全链路核查结论（无遗漏 bug）

| 环节 | 验证结果 |
|---|---|
| 后端事件隔离 | `publishTaskEvent` 经 **per-task 的 `task.waiters`** 推送；`cancelTask` 发 `cancelled` 给**旧** task → 仅旧 run 的前端连接收到，新 run 的 `followTask(新task)` 隔离 ✅ |
| 前端事件路由 | 每个 `runTurn` 调 `streamChat` 时 `onEvent` 闭包捕获该 `run`；`api.streamChat` 用 `readNdjson` 透明转发所有事件 → `applyChatEvent` 不过滤 → `applyStreamEvent.cancelled` 分支作用于**正确** reply ✅ |
| 抢占路径（app.ts） | 1797 `canPreempt`、1801 限流**先于**取消（R06）、1814 不可抢占回退 409、1818 可抢占 `cancelTask` ✅ |
| 前后端 409 对齐 | 后端回 `code:"CONVERSATION_BUSY"`（1815），前端 `runTurn` catch 识别并入队（3663），闭环吻合 ✅ |
| R01 / R02 / R03 | `finishTask` 的 `stillCurrent` 守卫 + `flushTask` 的 `taskId` CAS + `memPut` 按 `taskId` 隔离 ✅ |
| R04 / R08 | `ConvState` 改 `runCount/controllers/dispatching`；`send` 同步原子 `dispatching`；`runTurn` 计数化；`stop`/删除/出队/attach 遍历 `controllers` ✅ |
| R05 / R31 / R35 | `confirm.ts` 的 `wait` 绑 `AbortSignal`，抢占使确认等待立即收束 ✅ |
| R09 | `cancelled` 分支标记旧气泡 + 清 `pending`/`clarification` + 本地化 STOPPED_MARKER；`sawTerminal` 仅终态幂等（不吞增量，R33 天然规避）✅ |
| queue 仍活 | `drainQueue` 在 3708 被调用，不可抢占时入队的消息会出队自动发 ✅ |
| host 接口完整 | `thinkPhaseEnd` / `closeReasoning` 等均实现，lint 0 错误 ✅ |

**澄清两处「看似可疑、实为正确」**

- **ChatPage 3663 的 `enqueueMessage`**：非遗漏旧逻辑，而是 `CONVERSATION_BUSY` catch 分支——对应 `unattended` 定时任务/限流场景的「不可抢占兜底入队」，与后端 409 精确对齐，应保留。
- **`sawTerminal` 不吞迟到增量**：`cancelled` 分支设标志仅用于防 `finally` 二次标记 + 防 `resumeRun` 重入；增量分支（`text_delta` 等）不检查它，故抢占后模型补的 wrapup 文本正常显示（R33 规避）。实地确认 `applyStreamEvent` 顶部（98-100 行）只有 seq 记账与解构，**无** `if (run.sawTerminal) return`，完全符合定稿口径。

**本轮补充发现并修复（历史遗留，非 P0 引入）**
- **`canSend` 漏判 `pendingDocs`**：`ChatPage.vue:1954-1956` 原 `canSend` 只检查 `input.trim()` 与 `pendingImages.length`，未含 `pendingDocs`；但 `send()`（3460 行）明确允许纯文档消息、UI 也展示 pendingDocs chip（6804 行）。后果：用户只上传文档（无文字/图片）时发送按钮被错误禁用、文档发不出去。git blame 显示原 committed 版本即缺 `pendingDocs`（历史遗留，非 P0 改动引入）。**已修复**：`canSend` 加上 `|| current.value.pendingDocs.length`，lint 0 错误。

**第七轮流程走查发现并修复（P0 并发化引入的落库竞态）**
- **并发多 run 下 `persist` 增量水位竞态**：`persist`（`ChatPage.vue:2332-2360`）用 `persistedCount` 水位做增量回写，隐含假设「同一时刻只有一条 reply 在流式更新」；抢占并发打破它。两种收束时序均有问题：
  - **时序 A（先发的 A 先收束）**：A 收束时增量回写尾部（含 B_reply 流式半截），水位推到最新；B 收束时 `length === prev` 只回写末条 B_reply 终态——B 是末条所以正确，但此前增量写库的行为已把「B 半截 + 提问重复」固化（服务端 `applyDeltaMessages` 对 `at=L-1` 之外的 tail 一律 push，多消息 tail 会把已存在的提问再 push 一遍 → M2 重复）。
  - **时序 B（后发的 B 先收束）**：B 收束增量写库（含 A_reply 半截）并把水位推到最新；A 收束时 `length === prev` 只回写末条 B_reply——**A_reply 是中间项，其终态永远落不库**，刷新后停在流式半截。
  - **服务端兜底不可靠**：`consumeTask:408` 的 `persistTaskOutcome`（全量回投）条件为 `opts.persistOutcome || !task.live`；交互运行 `persistOutcome` 为 false，且 `finishTask` 的 `wake(null)` 同步返回后 `task.live` 仍为 true（followTask 的 finally 在微任务中才执行）→ 被抢占任务收束时**大概率不触发回投**，前端 persist 是唯一落库路径。
  - **修复**：`ConvState` 新增 `hadConcurrent` 标记（runTurn/attachRunningTask 在 `runCount += 1` 后若 `> 1` 则置位）；收束 finally 中 `persist(convId, bubbles, state.hadConcurrent)`——并发周期内**一律全量落库**（`full: true`，以本地 bubbles 即 UI 真相源覆盖服务端，顺带清掉增量竞态写出的半截/重复），`runCount` 归零后复位标记、恢复正常增量。全量写仅在抢占轮次发生（通常 1-2 次），性能影响可控。lint 0 错误、`vue-tsc` 通过。
  - 附带确认（无需改动）：`drainQueue` 出队保护正确（finally 先递减 runCount 再判 `sending`，仅最后一个收束 run 出队）；`runTurn` 队列参数类型匹配（`PendingMessage.images: string[]` ↔ `runTurn` 第 3 参 `imageIds: string[]`）；`failedModelIds` 多 run 竞态属启发式黑名单，最后收束者定论可接受。

**第七轮流程走查确认无误的链路**
- **确认/澄清卡生命周期**：`answerToolConfirm:3973-4003` 先同步清 `bubble.pending` 防重复点；服务端 `/chat/confirm`（`app.ts:1698-1736`）一次性票据 + 会话归属校验（403 `CHAT_CONFIRM_OWNERSHIP_MISMATCH`）；`scheduleConfirmExpiry:4058-4077` 用 ticket 比对防过期误清；cancelled 分支清 `pending`/`clarification`。
- **停止 / 删除联动**：`stop():3714-3718` 中止该对话全部 controllers + 服务端 cancel；删除对话（2898）、批量关闭（3272）、队列立即发送（3956）均遍历 controllers；服务端 `/chat/cancel`（1930-1940）归属守卫 + 幂等；`DELETE /chat/conversations/:id`（2081）先 `cancelTask` 再删，防任务收束 upsert 复活已删对话。
- **续传防串流**：`resumeChatTaskEvents`（`api.ts:176-196`）带 `from` 游标 + `taskId`，`Last-Event-ID` 头同值；服务端按 taskId 校验，不匹配返回 false 走如实收口。
- **abort 后 wrapup 渲染闭环**：`chat.ts:3842-3859` `abortedRun=true` → `wrapUpWith` 独立 25s deadline signal（`chat.ts:681`，不随原 abort 立即失败）→ 产出经 `chatStream` yield → `publishTaskEvent` 推给仍挂着的 waiters → 前端增量分支不检查 `sawTerminal`（R33）→ 正常渲染，与文档 §4.4 定稿口径一致。

### 3.2 实地读码验证清单（函数落点，带行号）

> 以下为查缺补漏时**逐函数实地读取源码**确认，非推断。

| 验证项 | 函数落点 | 结论 |
|---|---|---|
| cancelled 按 task 隔离（不误标新 run） | `followTask` `chat-tasks.ts:494-524`（`task.waiters.add(wake)`）+ `cancelTask:535` 仅对旧 task `publishTaskEvent` | ✅ 新 run 的 `followTask(新task)` 收不到旧 task 的 cancelled |
| 先 cancelled 后 abort | `cancelTask:532-538` 取 `running.get(conv)`（旧 task）→ 发事件 → `task.abort.abort()` | ✅ 且发事件时 status 仍 running 过 `publishTaskEvent` 守卫 |
| R01 stillCurrent 守卫 | `finishTask:305-334` `if (stillCurrent)` 才改 running/lastTask/retained | ✅ 旧任务不污染新任务 |
| R03 taskId CAS | `flushTask:130-133` `updateOne({_id, taskId})` | ✅ 旧任务迟到写因 taskId 不匹配被拒 |
| R02 taskId 隔离 | `memPut:69-72` 仅 `existing.taskId === record.taskId` 复用 events | ✅ 不跨任务拼接 |
| R07 unattended 豁免 | `startTask:198-209` 接受并设 `task.unattended` | ✅ 定时任务不被抢占 |
| R05 / R31 signal 绑定 | `confirm.ts:44-74` abort → `settleReject`（clearTimeout + 按拒绝收束）；`chat.ts:3483` / `3615` 透传 `ctx.signal` | ✅ 确认等待协程立即收束，不泄漏 |
| 前端透明转发 | `readNdjson:96-120` 逐行 `onEvent(JSON.parse)` 不过滤；`applyChatEvent:3525` 直转 `applyStreamEvent` | ✅ cancelled 必达正确 run |
| R08 并发双发 | `ChatPage` `dispatching` 同步原子（已查无遗留 `.controller` 单值引用） | ✅ |
| ChatEvent 类型 | `shared:216` `{ type: "cancelled" }` | ✅ |
| R11 确为 P1 | `MoviePage.vue:127-129` 仍 `isBusyError(CONVERSATION_BUSY)`、`311` 直接 `streamChat` | ✅ 未收敛到抢占路径，留作 P1 |

### 3.3 验收状态

- **构建 / 类型检查**：`npm run build` / `vue-tsc` 通过（`shared` 改 `ChatEvent` 类型，workspace 软链已重指）。
- **端到端验证**：S1（单抢占留档不串）、S2（确认等待中抢占立即收束）、S5（定时任务不被误杀）、S8（快速双击只开一个 run）均通过。
- **Lint**：Web + Agent-Server 共 7 文件 0 错误。

---

## 4. P1 待办清单（P0 未覆盖，独立改造）

| ID | 说明 | 落点 | 状态 |
|---|---|---|---|
| R11 | `MoviePage` 未收敛到 `chat-stream.ts` 的抢占/多 run 架构，仍走旧串行 + `CONVERSATION_BUSY` 回滚路径 | `apps/web/src/pages/MoviePage.vue` 的 `send`/流式/`停止` | 待做（P1） |
| R34 | 多实例脑裂下留档单主键晚到覆盖；`flushTask` 的 `taskId` CAS 仅缓解**同实例**，跨实例需方案 C | `chat-tasks.ts` `flushTask` / `task-store.ts` | 待做（P1，方案 C：留档主键改 `taskId` 或加 `instanceId` 条件） |

> 其余 P1–P3 体验项（R10 评测口径、R14–R26 等）仍按原严重度待处理，详见原风险登记表（需从 git 历史恢复）。

---

## 5. 关键决策与约束（重建摘要）

- **抢占语义**：同一对话正在生成时，新发送直接开新 run（R04），不进队列；多轮可并发（runCount 驱动 sending），旧轮次收到 `cancelled` 事件后其气泡显示「已停止生成」。
- **不可抢占兜底**：`unattended`（定时任务）/限流/容量不足时退回 409 `CONVERSATION_BUSY`，前端入队待发——与「可抢占直接开新 run」互补，不丢消息。
- **终态幂等口径**：`sawTerminal` 仅在 `done`/`cancelled`/`error` 分支内设置（且幂等），用途是阻止旧 run 进入 `resumeRun` 自动续传、防止 `streamChat.finally` 二次追加「已停止」；**所有增量分支不检查 `sawTerminal`**，迟到增量照常渲染（R33 规避）。
- **不撤销 C1 时序约束的替代**：保留 `cancelTask` 在 `abort()` 前同步发 `cancelled`（status 仍 running 放行），R33 规避点在前端（增量不吞），而非延后发 cancelled。
