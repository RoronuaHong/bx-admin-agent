# 定时任务运行会话方案：每期独立会话 + 侧栏分组

> 版本：v1（2026-09-29 立项）
> 定位：**最佳实践调研 + 数据模型设计 + 交互设计 + 实施追踪**。把「定时任务的结果去哪」从「一个任务一个会话、所有期堆在一起」升级为「每期一个会话、按任务分组成树」，对齐 ChatGPT Scheduled tasks 与 CodeBuddy 的做法。
> 相关：`docs/agent-infrastructure.md` §8（异步、长任务与定时）、`docs/conversation-list-ux-plan.md`（侧栏列表交互）、`apps/agent-server/src/schedules.ts`、`schedule-service.ts`、`conversations.ts`、`app.ts`（调度循环）、`apps/web/src/pages/ChatPage.vue`、`apps/web/src/api.ts`。
> 触发：用户对比 CodeBuddy 侧栏（「任务」桶下是用户对话，「空闲」桶下 `定时任务-xxx` 是父节点、各次运行是子节点，带状态点）提出——我们的定时任务和任务能不能这样区分。

**当前状态**

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 现状审计 + 最佳实践对比 | ✅ 已完成（§1 / §2） |
| 1 | 数据模型：`runMode` / `runs[]` / `unreadRuns` / 会话侧 `scheduleId` | ✅ 已落码（`schedules.ts` / `conversations.ts` / `schedule-service.ts`）+ 回归测试 `tests/schedule-runs.test.ts` |
| 2 | 调度循环：每期开新会话 + 落运行记录 + 并发判定修正 | ✅ 已落码（`app.ts` `schedulerTick`：`runMode` 分支 + `createRunConversation` + `recordScheduleRun`；并发判定改用 `lastStatus==="running"` 防重入，见 §3.9） |
| 3 | 保留上限（超上限归档不删除）+ 删除任务 | ✅ 超上限归档。2026-09-30 起删除任务**保留**结果会话（`deleteScheduleWithRuns` 不再删对话） |
| 4 | 侧栏：任务会话从主列表移出，按任务分组成树 + 未读角标 | ✅ 已落码（`ChatPage.vue` `taskGroups` 计算属性 + `taskConvIds` 改为含各期会话 + 模板分组区 + 折叠/未读角标/状态点；`clearTaskUnread` 打开任一期清零） |
| 5 | 任务表单：结果落点可选（每期新会话 / 同一会话） | ✅ 已落码（表单「结果落点」两段式选择；`runMode` 随建/改提交；老任务缺省按 `same` 显示以不悄悄改既有行为） |
| 6 | 老任务迁移 + 回归测试 + 端到端验证 | 🟡 回归与迁移已落码。2026-09-30 手测：暂停任务 `runMode=new` 连跑两期（立即执行，未等到点、未推送），侧栏父节点下两个子项，点开是两段不同正文。清单里并发跳过、超上限归档、未读清零、`same` 连跑仍未手测 |

> 进度注（2026-09-30）：阶段 1–5 已落码。删除任务改为保留结果会话。
> 「每期新会话」手测已过：暂停任务连跑两期，侧栏两个子项。不要为手测去打开已暂停的业务预警。

---

## 1. 立项时现状（2026-09-29 快照，不是现行行为）

下表是立项时的代码。现行行为以文首状态表和 §3 为准。

| 能力 | 现状 | 位置 | 问题 |
|---|---|---|---|
| 结果落点 | 一个任务**独占一个**会话，每一期结果都追加进同一个会话 | `app.ts` 调度循环 `startScheduleLoop` → `ensureTaskConversation` | 各期首尾相接，无法单独回溯某一期、无法横向对比；会话越长越难翻 |
| 侧栏归属 | 任务专属会话**平铺在普通对话列表里**，只多一个小闹钟图标 | `ChatPage.vue` `taskConvIds`（L2044-2051）→ 模板 L4214-4224 | 没有分组，看不出「这几条属于同一个任务」 |
| 排序 | 任务每跑一期就刷新 `updatedAt`，被顶到列表最上面 | `convRank`（`ChatPage.vue` L1861-1875） | 周期任务持续把用户自己的对话挤下去（刷屏） |
| 运行历史 | 只有 `lastRunAt` / `lastStatus` / `lastNote` 三个字段 | `ChatSchedule`（`schedules.ts` L51-55） | 只有「最近一次」，没有历史 |
| 未读 | 无 | — | 用户不知道「这一期你还没看」 |
| 清理 | 删除任务**不动**它的会话，留下孤儿 | `DELETE /chat/schedules/:id`（`app.ts` L606-610） | 每期一会话后孤儿会成倍增长 |
| 并发判定 | `isTaskRunning(schedule.conversationId)` = 「这个会话在跑就跳过本期」 | `app.ts` L1390 | 每期新会话后该判定永远为 false，会退化成「上一期没跑完也照跑下一期」 |

**结论**：落点与展示两层都要改，且第二层（并发判定）是第一层改动的直接连带项，漏改会引入并发重入。

---

## 2. 最佳实践调研

### 2.1 ChatGPT 官方 Scheduled tasks（[learn.chatgpt.com/docs/automations](https://learn.chatgpt.com/docs/automations)）

| 做法 | 官方原文要点 | 对我们的启发 |
|---|---|---|
| **两种落点由用户选** | "Use a standalone scheduled task when each run should start from the saved prompt. Use a scheduled task in a chat when you want ChatGPT to return to the same chat with its existing context."；"Standalone scheduled tasks start a new chat for each scheduled run" | **不是 A/B 二选一，而是一个可选项**：独立运行 = 每期新会话（可单独回溯）；会话内任务 = 复用上下文（适合「盯一个长任务直到它完成」「延续同一条研究线」） |
| **独立的 Scheduled 视图当收件箱** | "The Scheduled view acts as your inbox… an unread indicator shows when a run needs your attention" | 任务结果要有**未读指示**，不能只在会话里躺着 |
| **列表项形态** | `Daily inbox summary · Every weekday at 8:00 AM · Next run in 16 hours`；`All / Active / Paused` 筛选 + `Mark all as read` | 任务卡片要带**下次运行的相对时间**；未读要能一键清 |
| **无人值守最小权限** | "Start with the narrowest access that lets the task succeed, grant network or broader file access only when required" | 我们已有的 `mcpServers` 任务级收窄方向正确，保持 |
| **先测后跑** | "Before you schedule a task, test its prompt manually in a regular chat first… review the first few runs" | **预警已落地**：对话试跑 →「设为数据预警」；报告型仍建议先手测 prompt（表单侧提示） |
| **运行要可整理** | "Archive scheduled runs you no longer need, and avoid pinning runs unless you intend to keep" | 运行历史必须有**保留上限与整理手段**，不能无限膨胀 |

### 2.2 CodeBuddy（用户提供的截图）

- 侧栏是**一个列表分两个桶**：`任务（3）`（用户自己发起的对话）、`空闲（1）`（自动 / 非活跃会话）。
- 定时任务的会话**不散在列表里**，而是收在 `定时任务-2026-08-25-…` 这个父节点下，每次运行是一个子节点，各带状态点。
- 顶部另有独立的「定时任务」管理入口（管配置：频率 / 开关 / 删除）。

→ 它区分的是**两层**：导航层管任务配置，列表层按来源分桶 + 按任务成树。我们导航层已有（对话 / 定时任务 两个 seg），缺的是列表层。

### 2.3 反模式（逐个规避）

1. 周期结果灌进用户自己的聊天（刷屏）——2026-09-22 已用「任务专属对话」修掉，本方案保持。
2. 每期结果互相覆盖 / 首尾相接无法回溯——本方案的主目标。
3. 运行记录无限增长——`MAX_RUNS` + 超上限归档。
4. 删任务时把历史结果一起删掉——2026-09-30 改为保留，结果会话回到对话列表（千问办公同口径）。
5. 静默删除用户数据——超上限**归档不删除**。删除任务不再删会话。
6. 「空闲」桶按活跃度分——活跃度是用户不可预测的状态（"我昨天才用的怎么跑到空闲里了"）；按**来源**分桶用户可预测。故本方案按来源分「定时任务」区，不引入「空闲」桶（"收起来不看"由已有的「归档」承担）。

### 2.4 调研结论

> 落地口径：**默认每期新会话（standalone），保留「沿用同一会话」作为可选落点**；侧栏按任务分组；结果带未读；运行历史有上限、可整理。
> 这一条同时吃进 ChatGPT 与 CodeBuddy 两边的做法，也比「纯 A / 纯 B」更少后悔成本。

---

## 3. 设计

### 3.1 落点策略 `runMode`

```ts
/** 每期结果的落点（对齐 ChatGPT standalone / in-chat 两种任务）：
 *  - "new"（默认）：每期开一个新会话——各期独立、可单独回溯与对比，适合日报 / 监控 / 周期报告；
 *  - "same"：每期回投同一个会话、沿用上下文——适合「盯着一件事直到它完成」这类需要连续上下文的任务。 */
runMode?: "new" | "same";
```

- 新建任务缺省 `new`；老任务迁移为 `same`（保住既有会话与既有内容，见 §3.7）。
- 表单里可切换；切换只影响**此后**的运行，不动已有会话（与 `migrateTaskConversations` 同口径）。

### 3.2 数据模型

`ChatSchedule` 新增：

| 字段 | 类型 | 语义 |
|---|---|---|
| `runMode` | `"new" \| "same"` | §3.1；缺省 `new` |
| `runs` | `Array<{ conversationId: string; at: number; status?: ScheduleStatus }>` | 各期运行记录，**新的在前**，受 `MAX_RUNS` 限制 |
| `unreadRuns` | `number` | 未读的运行期数；用户打开任一期会话即清零 |
| `agentId` | `string` | 任务创建时记录的角色；每期建会话时用它继承角色（否则新会话会退回 generic，与老会话串不到一个入口） |

`conversationId` **语义收窄为「最近一期的会话」**（向后兼容：IM 投递 `?conv=` 链接、任务卡片「打开对话」都指向最新一期）。`ownConversation` 保留原语义。

`ConversationDoc` 新增（通用字段，与业务无关）：

| 字段 | 语义 |
|---|---|
| `scheduleId` | 该会话由哪个定时任务产出（每期会话都带） |
| `scheduleRunAt` | 该会话对应哪一期（运行时刻），标题与排序用它 |

### 3.3 每期会话的命名

- `runMode:"new"`：`${任务名} · MM-DD HH:mm`（如 `每日观看时长 · 09-29 09:00`）。
- `runMode:"same"`：`${任务名}`（沿用现有 `scheduleConversationTitle`）。

理由：侧栏分组里父节点已经是任务名，子项要能**一眼区分是哪一期**；时间比「第 3 期」更好认（跨月/暂停后「第几期」会与直觉对不上）。

### 3.4 运行记录与保留上限

- `MAX_RUNS = SCHEDULE_MAX_RUNS`（默认 50，可配）。
- 写入：`runs = [{conversationId, at: now, status}, ...prev].slice(0, MAX_RUNS)`。
- 超出上限的最旧几期：**只把会话标 `archived`，不删除**（静默删用户数据是最坏的一类行为）；它们仍可从「显示归档」里找回，只是不再挂在任务组下面。
- 状态取本轮真实结果（`success` / `failed` / `cancelled`），与 `lastStatus` 同一口径。

### 3.5 未读

- 运行结束落 `runs` 时 `unreadRuns += 1`。
- 用户打开该任务的任一期会话 → 前端 `PATCH /chat/schedules/:id { unreadRuns: 0 }`（乐观清零，失败回滚）。
- 与 ChatGPT「Scheduled 视图当收件箱 + 未读指示」同口径。

### 3.6 删除任务（2026-09-30：保留历史会话）

- `DELETE /chat/schedules/:id` 只删任务，**不删**结果会话。它们回到对话列表，仍可打开。
- 前端：任务已有运行记录时仍二次确认，文案说明这些会话会保留。
- `ownConversation` 为假的老对话本来就不碰。`manage_schedule` 的 delete 同样只删任务。

### 3.7 并发与跳过判定修正（连带项，必须一起改）

现状 `isTaskRunning(schedule.conversationId)` 在每期新会话下永远为 false。改为：

```
上一期仍在跑 → 本期跳过（排队补跑由 schedulerTick 负责）
判定对象 = 最近一期的会话 id（runs[0].conversationId ?? conversationId）
```

`runMode:"same"` 时两者同值，行为与现状一致；`"new"` 时等价于「同一任务串行，不并发重入」。

### 3.8 老任务迁移

启动维护（幂等，扩展现有 `migrateTaskConversations`）：

- `ownConversation` 为真且还没有 `runs` → 把现有 `conversationId` 记为 `runs[0]`（`at` 取 `lastRunAt ?? createdAt`），`runMode` 置 `same`。
- 已有 `runs` → 跳过。
- 不动任何既有会话内容（与现有迁移同口径）。

### 3.9 调度循环改动要点（**隐藏的顺序坑，已按此修**）

`schedulerTick` 若在 runner 之后用**开跑前**的快照整体 `writeSchedule`，runner 刚写入的 `runs` / `unreadRuns` / `conversationId` 会被静默回退。

已修：runner 返回后先 `getSchedule(id)`，再在这份最新文档上合并 `lastRunAt` / `nextRunAt`。任务已删则不再写回；本期被暂停则保持暂停且不排下一拍。投递也必须在这次写回之前结束（`patchSchedule` 是整份文档，交错会盖掉 `nextRunAt`）。

### 3.10 侧栏交互

主列表结构（自上而下）：置顶 → 普通 → **定时任务** → 归档。

```
── 置顶 ──
  用户自己的对话…
── 定时任务 ──
  ▸ ⏱ 每日观看时长   ③   [每天 09:00]
      09-29 09:00  ✅
      09-28 09:00  ❌ 失败
      09-27 09:00  ✅
```

- **父节点**：任务名 + 折叠三角 + 未读角标（>0 才显示）+ 下次运行（相对时间，如「3 小时后」）+ 状态点（取最近一期）。点击父节点 = 展开/折叠；右侧小按钮 = 打开最近一期会话。
- **子节点**：一期一行 —— 运行时间 + 状态点 + 会话标题（省略），点击打开该期会话。默认折叠，展开状态按任务 id 记在 `localStorage`（刷新保持）。
- 任务会话**从主列表平铺区移出**（`conversationsFiltered` 过滤掉 `runs` 命中的 id + 老数据的 `conversationId`），彻底解决「每期顶到列表最上面」。
- 分组排序：按最近一期时间倒序。
- 无任务时该区**整体不渲染**（不显示空标题）。
- a11y：父节点 `role="button"` + `aria-expanded` + Enter/Space；子节点沿用 `.conv-item` 的键盘约定；状态点带 `aria-label`（沿用 `convStatusText`）。
- 多语：全部文案走 `tx(zh, en, pt, hi)` 四语。

### 3.11 任务表单

新增「结果落点」二选一（默认「每期新会话」），说明文案：

- 每期新会话：每期结果各占一个会话，可单独回看与对比（日报 / 监控 / 周期报告选这个）。
- 同一会话：每期回到同一个会话，沿用上下文（盯一件事直到完成选这个）。

表单存 `runMode`；编辑老任务时可切（只影响此后）。

---

## 4. 接口改动

| 接口 | 改动 |
|---|---|
| `POST /chat/schedules` | 入参增 `runMode`（缺省 `new`）；响应 `schedule` 带 `runMode` / `runs` / `unreadRuns` |
| `PATCH /chat/schedules/:id` | 入参增 `runMode`、`unreadRuns`（清零用） |
| `DELETE /chat/schedules/:id` | 只删任务。结果会话保留（2026-09-30） |
| `GET /chat/schedules` | 无形状变化（字段自然带出） |
| `manage_schedule` 工具 | 描述与 `create` 入参说明补一句落点语义（不给新必填项，模型默认走 `new`） |

前端类型：`ScheduleDto` 增 `runMode` / `runs` / `unreadRuns`；`ScheduleInput` 增 `runMode`（`apps/web/src/api.ts`）。

---

## 5. 实施步骤

1. `schedules.ts`：`runMode` / `runs` / `unreadRuns` / `agentId` 字段 + `SchedulePatch` 扩字段 + `MAX_RUNS` 截断 + `schedulerTick` 合并写回（§3.9）。
2. `conversations.ts`：`ConversationDoc` 增 `scheduleId` / `scheduleRunAt`，`createConversation` 透传。
3. `schedule-service.ts`：`createTaskConversation` 支持 `scheduleId` / `scheduleRunAt` / `agentId`；新增 `scheduleRunTitle`；`createScheduleTask` 收 `runMode` 并落 `agentId`。
4. `app.ts`：调度循环改 `ensureRunConversation` + 落 `runs` + 并发判定修正；DELETE 只删任务、保留结果会话；PATCH/POST 透传新字段；`migrateTaskConversations` 扩展。
5. `builtins.ts`：`manage_schedule` 描述补落点语义。
6. `apps/web/src/api.ts`：类型同步。
7. `ChatPage.vue`：侧栏定时任务分组区 + 未读清零 + 表单落点选择 + 删除二次确认。
8. 测试 `tests/schedule-runs.test.ts` + 回归。

---

## 6. 验收清单

- [x] `runMode:"new"` 的任务连跑两期 → 产生**两个**会话，标题带各自运行时间，都在 `runs` 里。（2026-09-30，暂停任务上立即执行两期；未推送到通道）
- [ ] `runMode:"same"` 的任务连跑两期 → 仍是**同一个**会话，行为与改动前一致。
- [ ] 上一期还在跑时到点 → 本期 `skipped`，不并发重入。
- [ ] `runs` 超过 `MAX_RUNS` → 最旧的会话被**归档**（仍存在、可找回），不被删除。
- [ ] 每期结束 `unreadRuns +1`；打开任一期会话后清零。
- [x] 删除任务 → 结果会话保留并回到对话列表；`ownConversation` 为假的老任务会话也不受影响。（2026-09-30）
- [ ] 侧栏：任务会话不在主列表平铺区；定时任务区按任务分组、可折叠、未读角标正确、点击子项打开对应一期。
- [ ] 老任务迁移后 `runMode="same"` 且 `runs[0]` = 原会话，内容不变。
- [ ] `tsc --noEmit` / `vue-tsc --noEmit` / 全量测试全绿。
- [x] 端到端：真实服务建任务 → 连跑两期 → 侧栏出现两个子项，点开各自正文。（2026-09-30。用立即执行，不是等到点；任务保持暂停）

## 7. 风险与回滚

| 风险 | 应对 |
|---|---|
| `schedulerTick` 快照覆盖导致 `runs` 丢失 | §3.9 显式重读合并；用测试钉住「runner 内写入不被回退」 |
| 每期建会话放大存储 | `MAX_RUNS` 上限 + 超上限归档（不删） |
| 删除任务误伤用户自己的对话 | 不删任何会话；只删任务记录 |
| 老任务行为变化 | 迁移统一置 `runMode="same"`，行为与现状逐字一致 |
| 并发判定改动引入重入 | 测试覆盖「上一期在跑 → 本期 skipped」 |
| 回滚 | 全部改动由 `runMode` 缺省 + 迁移兜底；出问题把默认改回 `same` 即回到旧行为，数据无需回滚 |

---

## 8. 实施与验证记录

- 阶段 1–5 已落码：`runMode` / `runs` / 侧栏分组 / 删除任务保留会话。
- §3.9 的重读合并、忙时窗口内补跑、立即执行不改原周期，都在 `schedulerTick`。
- 2026-09-30 全量 vitest：43 文件 / 251 例通过。
- 2026-09-30 手测：暂停任务「侧栏两期试跑」（`runMode=new`，仅异常通知，未推送）立即执行两期。`runs` 两条、两个会话。侧栏展开后是 `09-30 13:36` 与 `09-30 13:37` 两个子项；点开分别是「没有实际取数」和「未进行实际取数」。印度预警保持暂停。
- 仍未手测：`same` 连跑仍是同一会话、上一期未完则本期跳过、超上限归档、未读清零。

---

## 9. 参考来源

- ChatGPT Scheduled tasks 官方文档：<https://learn.chatgpt.com/docs/automations>（standalone vs in-chat、Scheduled 视图作收件箱 + 未读、下次运行相对时间、最小权限、先测后跑、归档不需要的 run）
- CodeBuddy 侧栏（用户提供截图）：任务 / 空闲分桶 + 定时任务成树
- 本项目：`docs/agent-infrastructure.md` §8、`docs/conversation-list-ux-plan.md` §2.5
