# 对话抢占式生成（Chat Preempt）实施与验收记录

> **文档重建于 2026-11-13**。原 `chat-preempt-plan.md`（含完整动机、现状、风险推演、场景验证等约 87KB 历史内容）在会话间隙被删除/移走，本文件聚焦 **P0 实施落地与验收记录**，不再重建完整推演史。如需完整计划文档请从 git 历史恢复。
>
> 本文档覆盖：P0 改动清单、修复落地清单（§2）、全链路查缺补漏与实地读码验证（§3）、P1 待办（§4）。
> **2026-11-23 补修（工作区未提交）**：断网等无 `serverErrorCode` 的连接类错误不再进模型黑名单；auto 模式改记实际 `servedModel`；模型冷却只延长不缩短，避免 90s 弱失败覆盖 UTC 日切级额度冷却（含回归用例）。详见 `engineering-optimization-review.md` §9。

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

> **P0 阶段未做项**：R11（MoviePage）与 R34（多实例脑裂）当时留 P1；两者已于 2026-11-16 完成，见 §4（R11 抢占路径收敛、R34 方案 C 留档主键改 `taskId`）。

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
| R11 确为 P1（2026-11-13 时点） | `MoviePage.vue:127-129` 当时仍 `isBusyError(CONVERSATION_BUSY)`、`311` 直接 `streamChat` | ✅ 当时未收敛，2026-11-16 已完成（见 §4） |

### 3.3 验收状态

- **构建 / 类型检查**：`npm run build` / `vue-tsc` 通过（`shared` 改 `ChatEvent` 类型，workspace 软链已重指）。
- **端到端验证**：S1（单抢占留档不串）、S2（确认等待中抢占立即收束）、S5（定时任务不被误杀）、S8（快速双击只开一个 run）均通过。
- **Lint**：Web + Agent-Server 共 7 文件 0 错误。

---

## 4. P1 待办清单（P0 未覆盖，独立改造）

| ID | 说明 | 落点 | 状态 |
|---|---|---|---|
| R11 | `MoviePage` 未收敛到 `chat-stream.ts` 的抢占/多 run 架构，仍走旧串行 + `CONVERSATION_BUSY` 回滚路径 | `apps/web/src/pages/MoviePage.vue` 的 `send`/流式/`停止` | ✅ 已完成（2026-11-16）：`send` 拆同步原子的 `dispatching` + `runTurn`，多轮并发 `runCount/controllers`、抢占由服务端 `cancelled` 事件标记旧气泡；事件分支收敛到 `applyStreamEvent`（`ChatStreamHost` 空实现工具/确认能力）；`stop`/卸载 abort 全部轮次。本页 persist 全量写，无 /chat 的增量水位竞态。type-check 通过。 |
| R34 | 多实例脑裂下留档单主键晚到覆盖；`flushTask` 的 `taskId` CAS 仅缓解**同实例**，跨实例需方案 C | `chat-tasks.ts` `flushTask` / `task-store.ts` | ✅ 已完成（2026-11-16，方案 C）：留档主键 `_id` 由 `conversationId` 改为全局唯一 `taskId`，MongoDB / 内存降级两侧 flush、read、markInterrupted 同步换键；新增 `loadLatestTaskRecord`（按 `startedAt` 取最新轮，非易被迟到写刷新的 `updatedAt`）+ `{conversationId,startedAt:-1}` 索引；`loadTaskForResume` 接可选 `taskId` 精确取轮，`recoverStaleTasks` 用 `item.taskId`，`/chat/task/events` 透传 `wantTaskId`。新增回归测试 [G]。type-check + 959 测试全通过。 |

> R10 / R14–R26 的原风险登记表已在 git/stash/各分支均找不到，**逐条状态无法确认**；§4.1 的 B1–B8 / F1–F10 及 R11 复查项已全部修复，二者不是同一批，不能用本表反推 R10/R14–R26 已完成。

---

## 4.1 全链路复查（2026-11-16）

原始风险登记表（R10/R14–R26 明细）在本仓库 git 历史 / stash / 所有分支均不存在（只有本重建版），无法按编号恢复。改从源码逐链路审查，发现并修复以下遗留问题（均有源码证据）：

**已修**
- **B1（高）**：抢占后 `cancelled` 追加的「已停止生成」会被随后服务端 `text` 全文快照（替换语义，`chat.ts` abortedRun / 正常收尾都会发）抹掉，旧气泡显示成正常完成。`chat-stream.ts` 加 `StreamRun.cancelled` 标志 + `appendStopMarker`，`text`/`done` 分支保住 marker，`done` 且 cancelled 时不再 `rememberModel`。
- **B2（高）**：被抢占的旧 run 以「成功」身份触发 `drainQueue`，可能替最新一轮发出队列消息。ChatPage 出队条件加 `!run.cancelled`。
- **F1（高）**：抢占后旧 taskId 续传被 `app.ts` 内存路径的 404 截断，R34 存的旧轮留档（含 wrapup）拿不到。改为 taskId 不匹配时 fall through 到留档按 taskId 精确取。
- **F2（高）**：显式 `/chat/cancel` 会取消 unattended 定时任务（违反 `ChatTask.unattended` 契约、会误发 IM 失败通知）。`cancelTask` 加 `includeUnattended` 参数，`/chat/cancel` 传 `false`；调度器主动终止仍走默认 `true`。
- **B4（高）**：清空对话守卫只看 `sending`，盖不住 finally 里 `sending` 归零后仍在飞行的 `persist`，后到快照把已清消息写回。两页加在途 persist Promise 登记（`pendingPersists` / `pendingPersist`），清空动作先 await。
- **B5（中）**：MoviePage 多 run 同时 409 时回滚 `input.value = text` 互相覆盖丢消息；改为非空时前插。
- **F10（中）**：重复 `cancelTask` 产生重复 `cancelled` 事件；`cancelTask` 加 `status`/`abort.signal.aborted` 守卫。
- **F5（中）**：R34 换主键后内存留档从「每对话一条」变「每任务一条」，无界增长。`task-store` 加 `CHAT_TASK_MEM_CAP`（默认 500）+ 写入时按 `updatedAt` 淘汰最旧。
- **R11 回归**：MoviePage `rememberModel` 空实现导致 auto 模式「上次成功优先」失效（把 `"auto"` 记成模型 id，被 `resolveModel` 忽略）；改为记录真实 `servedModel`，黑名单跳过 `"auto"`（2026-11-23 工作区未提交，见文首补修注）。

**第二轮复查（同日）继续修复**
- **F3（中）**：`detachTask` / `followTask.finally` 无条件把 `live` 置 false，误伤多标签 / 断线重连的其它订阅者。改为按 `waiters.size` 重算，`followTask` 清理复用 `detachTask`。
- **F4（中）**：`followTask` 先回放再注册 waiter，回放窗口里的 `text_delta`（只累加 text、不进 buffer）永久丢失。改为先注册 waiter + `startSeq` 水印，回放存量、订阅期增量走队列，不重不漏。新增 `tests/follow-task.test.ts` 4 个实例测试（手动驱动生成器模拟回放窗口）。
- **F6（中）**：并发计数扣除 `canPreempt` 未校验 owner，无主对话被别的设备占用时会绕过每 owner 上限。加 `preemptIsMine`（ownerKey 严格相等）参与扣减；`owner` 声明前移。
- **F7（中）**：`outcomePersisted` 写到「该对话最后一条摘要」上，抢占后可能属于新任务。加 `summary.id === task.id` 校验。
- **F8（低）**：R34 换主键后，部署 TTL 窗口内旧 `_id=conversationId` 留档匹配不到。`markTaskInterrupted` 加可选 conversationId，主键未命中时回退 `{_id: conversationId, taskId}` 精确匹配；两调用点传参。
- **F9（中）**：定时任务在 `getSchedule` 的 await 之后到 `startTask` 之间有抢占窗口，可能顶掉用户交互消息。`startTask` 前紧邻再查 `isTaskRunning`，被占返回 `"skipped"` 由调度器下 tick 补跑。
- **B7（中）**：`watchBackgroundDone` 把被抢占 / 停止的后台任务当「完成」弹 toast。改用 `fetchChatTaskStatus`，仅 `last.status === "success"` 才报，`last` 为空（过 retain 期）保守不报。
- **B3（中）**：409 入队后队列在另一标签页那轮结束时有出队入口缺失，消息卡死。加 `watchAndDrain` 轮询占用释放后 `drainQueue`，入队处调用。
- **B8（中）**：多 run 收束各自 persist，慢请求晚到覆盖新快照 / `persistedCount` 水位乱序。两页 persist 改为按对话串行链执行。
- **R11 改进**：movie 角色 `forceToolCall` 走 TMDb 取数，工具执行阶段 MoviePage 只有通用「正在生成…」。Bubble 补 `steps`（复用 `ToolStep`），无 thinking 但有 steps 时显示「正在查询影片数据…」。

**第三轮复查（同日）**
- **B6（中）**：待发队列多处「读整数组→整体 PATCH 覆盖」，多标签 / 自动出队并发丢项。后端新增原子端点 `POST /chat/conversations/:id/queue/enqueue`（`$push` + `$expr/$size` 上限，满返回 409 `CHAT_QUEUE_FULL`）与 `/queue/dequeue`（`findOneAndUpdate` + `$pop` 返回队首与剩余），`conversations.ts` 加 `enqueuePending`/`dequeuePending`（含内存降级）；前端 `enqueueMessage`/`drainQueue` 改走原子端点并用服务端返回的完整队列同步本地，重排/编辑/删除的 `setQueue` 加按 conv 串行链。新增实例测试：conversations [③] + `preempt-e2e.test.ts`（5 个真实 HTTP 路由测试）。

**实例验证（端到端，非单测）**
- 新增 `tests/preempt-e2e.test.ts`：在真实 Hono `createApp().request()` 上走完整 HTTP 路由 / 中间件 / 序列化，验证 ①队列原子并发入队不丢、出队各取不同队首且 FIFO ②队列满返回 409 且不丢已有项 ③显式 Stop 不取消 unattended、普通任务可取消且重复取消幂等 ④任务状态端点 running/last 摘要 ⑤对话 CRUD 未被队列改造破坏。5 个全通过。

**结论**：审查发现的 B1–B8 / F1–F10 及 R11 回归全部修复，无遗留项。
验证：`pnpm type-check` 通过；vitest 137 文件 / 970 用例全通过（含新增 followTask 4 例 + 端到端 5 例；修复测试对并发入队顺序的硬编码依赖，连续两次全量运行一致）；改动文件 lint 0 错误。

---

## 4.2 用户可选「抢占式 / 排队等待」（2026-11-16）

新增会话级开关 `sendMode`：`preempt`（默认，新消息抢占旧轮）/ `queue`（新消息排队，等上一轮成功收束后自动发）。设计见 `docs/superpowers/specs/2026-11-16-send-mode-preempt-vs-queue-design.md`，实现计划见 `docs/superpowers/plans/2026-11-16-send-mode-implementation-plan.md`。

- **决策**：每对话独立、默认抢占；UI 只在 ChatPage 侧栏右键菜单（MoviePage 不动）；切换纯设置、不影响当前轮；队列项「立即发送」逃生口保留；unattended 永不抢占硬约束不变；后端按会话文档判定（多标签页一致）。
- **实现**：`conversations.ts` 加字段 + `$set` 白名单 + `ACTIVITY_NEUTRAL_KEYS`；`app.ts` 的 `canPreempt` 加 `convDoc.sendMode !== "queue"` + PATCH body 校验；`api.ts` 的 DTO/patch 类型；ChatPage 右键菜单加 `toggleSendMode`（乐观更新 + 回滚）。队列链路（409 入队 / drainQueue / sendQueueItemNow）原样复用。
- **E2E**：新增 `tests/send-mode.test.ts`（7 例：S1 queue 忙时 409 不抢占且不入队、S2 默认抢占旧轮收 cancelled 且新任务接管、S3 unattended 始终 409、S4 PATCH 合法/非法/updatedAt 不变、S5 queue 完整闭环 409→入队→上一轮成功收束→出队、S6 队列满 409 `CHAT_QUEUE_FULL` 不丢已有项、S7 切回 preempt 恢复可抢占）。
- **查缺补漏（同日）**：①`app.ts` 把 `CONVERSATION_BUSY` 判定提到 owner 并发上限之前——queue 档本轮不 startTask，若被拦成 429 `CHAT_CONCURRENT_LIMITED`，前端不认该码会静默丢消息；②ChatPage 右键菜单发送模式项补动态 `:title`（此前静态文案在 queue 档显示错误）；③`watchAndDrain` 修正：不因本标签 `state.sending` 为真就注销守望（否则另一标签占用释放后无人出队、队列卡死），状态查询失败/仍在跑继续轮询，且只有 `last.status === "success"` 才自动出队（失败/取消/中断停下等用户）；④测试补 S5–S7，`afterEach` 清理 `/chat/stream` 内部新建的 running 任务避免并发计数泄漏；⑤设计文档 §4.6 更正「非法值被后端拒绝」为「静默忽略」，并记录 MoviePage 被外部 API 设成 queue 时无队列链的已知边界。
- **二次查缺补漏（2026-11-17）**：①每分钟限流 429 `CHAT_RATE_LIMITED` 仍先于 409——queue 档 / 无人值守占用时若同时命中每分钟限流，前端不认 429 会丢消息，改为不可抢占场景一律先回 409（新增 S8 回归测试）；②`enqueueMessage` 失败时仍谎报「已入队」并启动守望——改为返回成功标志，失败如实报错并把文本回填输入框；③`onBeforeUnmount` 只清 `bgWatch` 漏清 `queueWatch`，卸载后守望仍会触发 `drainQueue` 发消息，补清；④`watchBackgroundDone` 查询失败即放弃，与「守望 15 分钟」矛盾，改为抖动时继续轮询；⑤两处过时注释（chat-tasks「每对话最多一条」与 ChatPage「不进队列」）按方案 C / 409 入队路径更正。另：独立审查报告「Mongo 路径 `findOneAndUpdate` 返回 `ModifyResult` 导致出队失效」经 driver 源码与真实 Mongo 实测**证伪**（driver v7 默认 `includeResultMetadata=false` 返回裸文档），未改动。
- **三次复核（2026-11-17，边界项）**：①409 判定再提到每分钟限流**之前**（上一条只放进限流分支内），使排队请求不白白消耗 owner 配额、后续真实发送不被挤到 429；S8 增强为「两次 busy 409 + 第三条空闲请求 200」验证配额未消耗；②守望回调 await 状态查询期间页面可能已卸载，`clearInterval` 挡不住在途回调，加 `pageUnmounted` 标志在两个守望的 await 后拦截出队/弹提醒；③`sendQueueItemNow` 无同步派发标志，快速双击会起两个 run，加 `queueNowDispatching` 守卫；④卸载时清空 `queueSetChains`。**未动的已知边界**（风险大于收益）：drainQueue 出队响应丢失时按本地队首重发无幂等键（需协议级改动）；`memPut` 超量淘汰不排除 running（默认 500 条/30 分钟难触发，且 Mongo 可用时读侧可回源）；`loadTaskRecord` TTL 异步删除窗口内可能返回刚过期留档（影响极短）。
- **UI 调整（2026-11-17，用户要求）**：发送模式入口从「侧栏右键菜单」改为**输入框底部左下角工具条**（与 `+` 并列）也放一个快捷切换按钮（`sendmode-btn`，抢占=闪电/中性、排队=横线/强调色，点击切换）。右键菜单入口保留。`currentSendMode` 计算属性优先读当前对话 DTO；草稿态用 `draftSendMode` 临时值，创建会话时随首条消息落库。浏览器实测：按钮在左下角可见，点击 抢占↔排队 双向切换正常，样式/标题同步。
  - **样式布局修复**：初版按钮用 `queue` 作状态 class，与项目已有 `.queue`（composer 提示行：dashed 边框 / `padding:8px 10px` / `width:100%`）冲突，导致排队态出现虚线框且尺寸被撑大（抢占 62×34 vs 排队 104×35，切换时工具条跳动）。改状态 class 为 `is-queue` 避开冲突，并固定按钮尺寸 90×26px、图标槽定宽、文字区可收缩居中、focus 用贴合圆角的 box-shadow 代替 outline。实测两态均为 90×26px、padding 一致、边框 solid，切换不再跳动、虚线框消失。
  - **垂直对齐修复**：模式按钮(26px)与 `+` 工具按钮(34px)同嵌在 `.tools-menu-box`（`inline-flex` 默认 align-items:normal=顶对齐），导致模式按钮中心偏高 4px、看着没对齐。给 `.tools-menu-box` 加 `align-items:center`，实测两者中心线均为 949.7、差 0，抢占/排队两态一致。
  - **纯图标 + Tooltip（用户要求）**：按钮去掉文字，改为与 `+` 同规格的 34×34 纯图标按钮（抢占=闪电中性色、排队=横线强调色高亮）；当前档与点击效果走原生 `title` 悬停提示，随状态切换文案。实测 text 为空、仅 SVG、两态 34×34 且与 + 中心线重合、title 随档变化。
- **排队重复气泡修复（2026-11-17，用户实测「排队还是打断上次」）**：排查后端日志 + 落库消息发现——**上一轮其实完整完成**（assistant 有完整回复，非"已停止生成"），真正 bug 是：入队时 `runTurn` 已 push 的 user/reply 气泡没撤回，reply 被改成「（已加入待发队列）」假气泡并落库；上一轮完成后 `drainQueue` 再次 `runTurn` 又 push 一对并落库 → **同一条消息两组气泡 + 两次落库**（消息记录里 "1" 出现两次），用户误以为上一轮被打断 / 消息发了两次。修复：入队成功后 `state.bubbles.filter` 撤回 userBubble 与 reply、清理 `openReasoning`，改用 4s 轻量提示（复用 `settingsError`）替代假气泡；finally 的 `persist` 对 `queued` 轮走 forceFull，以本地为真相全量修正服务端，杜绝残留重复。对齐 Claude/ChatGPT 实践：待发消息只在队列面板显示一次，出队发送时才建正式气泡。
  - **同次还修复「服务未重启导致功能未生效」**：`agent-server-dev` pm2 进程 3 天未重启（tsx 无热重载、配置 `watch:false`，Windows 下 watch 会 EADDRINUSE），内存里是 sendMode 之前的旧代码，前端切档但后端一律抢占。按配置 `pm2 delete → 确认端口释放 → pm2 start ecosystem.dev.config.cjs` 彻底重启，health release=788b88e 确认加载最新代码。
- **验证（最终）**：`pnpm type-check` 通过；vitest **139 文件 / 978 用例全通过**（含增强 S8）；改动文件 lint 0 错误。

---

## 5. 关键决策与约束（重建摘要）

- **抢占语义**：同一对话正在生成时，新发送直接开新 run（R04），不进队列；多轮可并发（runCount 驱动 sending），旧轮次收到 `cancelled` 事件后其气泡显示「已停止生成」。
- **不可抢占兜底**：`unattended`（定时任务）/限流/容量不足时退回 409 `CONVERSATION_BUSY`，前端入队待发——与「可抢占直接开新 run」互补，不丢消息。
- **终态幂等口径**：`sawTerminal` 仅在 `done`/`cancelled`/`error` 分支内设置（且幂等），用途是阻止旧 run 进入 `resumeRun` 自动续传、防止 `streamChat.finally` 二次追加「已停止」；**所有增量分支不检查 `sawTerminal`**，迟到增量照常渲染（R33 规避）。
- **不撤销 C1 时序约束的替代**：保留 `cancelTask` 在 `abort()` 前同步发 `cancelled`（status 仍 running 放行），R33 规避点在前端（增量不吞），而非延后发 cancelled。
