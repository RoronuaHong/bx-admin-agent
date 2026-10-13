# 跨角色会话恢复按角色收窄（cross-role restore scoping）

> 版本：v1（2026-10-13）
> 定位：修复「跨角色会话被自动恢复拉到错误角色的页面」这一缺陷，并让多 Agent 的「上次打开的对话」按各自角色正确恢复。
> 触发：全链路审计定时任务 / 多 Agent 会话时发现；与「定时任务列表每页显示全部任务（对齐 CodeBuddy）」的决策直接相关——正是这条新暴露面让缺陷更容易被触发。
> 相关：`apps/agent-server/src/app.ts`（`/chat/stream`、`/chat/preferences`、`prefsPayload`）、`apps/agent-server/src/conversations.ts`（`resolveConversation` / 活跃槽）、`apps/web/src/api.ts`（`ConversationDto` / `ChatPreferences`）、`apps/web/src/pages/ChatPage.vue`（首屏恢复 / `reportActiveConversation`）。

---

## 1. 背景

- 多 Agent 架构（领域适配指南模式 B）：同一 `ChatPage` 组件服务所有角色，路由以 props 注入 `agentId`（`/chat`=generic、`/movie`=观影助手、`/support`=客服…）。`ChatPage.vue:1338` `AGENT_ID = agentProps.agentId || "generic"`。
- 会话**按角色分槽**：`listConversations(..., agentId)` 只返回该角色的会话（`conversations.ts:288-291`，「generic 页看不到 movie 对话，反之亦然」）。
- 定时任务会话已在更早阶段支持**跨角色打开**：点开别角色的任务 / 期次，或从 IM 通知 `?conv=` 深链进入时，用「按 id 直取」兜底（`ChatPage.vue` `openConversationById` / 首屏 `fetchConversation`），服务端只校验归属、不校验角色。这是**有意设计**，保留不动。
- 上一次决策：定时任务列表**每页显示全部任务**（对齐 CodeBuddy 单助手「一棵树」口径），不做按角色过滤。⇒ 用户在任意角色页都能点开别角色任务的期次会话。

## 2. 问题（全链路审计发现）

### 2.1 缺陷 A：跨角色会话被「自动恢复」拉到错误页面（中高）

根因：**首屏恢复没有按角色收窄**，且后端虽按角色维护活跃槽、前端却只读 generic 槽。

证据：
- 后端 `prefsPayload` 只返回 generic 槽 `activeConversationId`，**不返回 `activeByAgent`**（`app.ts:2062-2073`）；前端 `ChatPreferences` 也只有这一个字段（`api.ts:397-398`）。
- 而非 generic 角色的活跃槽后端一直在认真维护（`conversations.ts:898-900`、`app.ts:1607-1610/1861-1863`）——**写了却没有客户端读**，「半成品」信号。
- 前端首屏：`initialConversationId = prefs.activeConversationId`（`ChatPage.vue:4904`）→ `requestedConvId = linkedConvId || initialConversationId`（`ChatPage.vue:4922`）→ 只要它**不在本角色列表**，就 `fetchConversation(requestedConvId)` 按 id 直取并**优先打开**（`ChatPage.vue:4927-4932`），**且没有 `AGENT_ID` 守卫**。

两个触发场景：
1. **双角色用户**：在 /generic 聊过（`activeConversationId` = 某 generic 会话）→ 打开 /support（无 `?conv=`）→ `requestedConvId` 是那个 generic 会话、不在 /support 列表 → 被按 id 直取**拉到 /support 打开**，还塞进 /support 侧栏（`ChatPage.vue:4930`）。回复人设虽对（取会话角色），但页面 / 列表 / 技能面板全乱；刷新后它又消失回 /generic。违背「分槽互不串台」。
2. **任务窥看污染 generic 槽**（落在「每页显示全部任务」这条新面上）：在 /generic 点开一个 support 期次 → `reportActiveConversation`（`ChatPage.vue:4759` 只判 `AGENT_ID==="generic"`、不判会话自身角色）把 **support 会话 id 写成 generic 活跃槽**；或在该会话回复 → 后端 `app.ts:1601-1606` 用**页面角色** `reqAgentId` 写槽，同样把 support 会话写进 generic 槽。下次 /generic 首屏就把这个 support 会话打开。

### 2.2 缺陷 B：写活跃槽用「页面角色」而非「会话角色」（与 A 同根，耦合）

`app.ts:1601-1611` 与 `ChatPage.vue:4759` 都按**页面角色**选槽。一旦把恢复改成「读 `activeByAgent[AGENT_ID]`」，这两处若不同步改成按**会话自身 `agentId`** 选槽，原本「写了没人读所以无害」的错槽会立刻变成真实串槽。故两处必须一起改。

### 2.3 次要（观感）

跨角色会话打开后，回复人设 / 模型 / 技能 / `namespace` 都对（`chat.ts:3395/3452/3636/3682` 均取 `conversation.agentId`），但页面 chrome（助手图标 / 标题 / 高亮）显示的是**页面角色**。不致命，本方案不改（避免动现有渲染逻辑）。

## 3. 目标与非目标

**目标**
- 自动恢复（首屏无 `?conv=`）**严格按角色**：只打开本角色列表里的会话，绝不把别角色会话拖进本页。
- 非 generic 页也能精确恢复「自己上次那条」（读 `activeByAgent[AGENT_ID]`），与 generic 一致。
- 活跃槽写入按**会话自身角色**归位，generic 槽只放 generic 会话。

**非目标（明确不做）**
- 不改「按 id 直取打开跨角色会话」的能力（显式 `?conv=` 深链、点任务 / 期次）——那是既有且有意的作用域。
- 不改回复人设 / 模型 / 技能的角色裁决（已正确，取 `conversation.agentId`）。
- 不改页面 chrome 与角色的一致性（次要观感）。
- 不引入按角色过滤任务列表（上次已决策：保留「每页全部任务」）。

## 4. 方案

### Fix 1 — 首屏恢复按角色收窄（止血，治缺陷 A）

`ChatPage.vue` 首屏 `onMounted`：
- **只有显式 `linkedConvId`（IM 通知 `?conv=`）才跨角色 `fetchConversation` 直取**；直取失败照旧弹「该对话已不存在或无权访问」。
- `initialConversationId`（自动恢复）**仅当它在本角色列表里才打开，否则回落 `list[0]`**；不再对它做跨角色直取。
- 同角色恢复行为完全不变（在列 → 照开）；仅去掉「把别角色会话拖进本页」这一条。

### Fix 2 — 非 generic 页按角色恢复（治缺陷 A 的恢复源）

- 后端 `prefsPayload` 增补 `activeByAgent: session.activeByAgent || {}`（`app.ts`）。
- `PUT /chat/preferences` 增补可选入参 `agentId`：把 `activeConversationId` 写进对应角色槽（generic → 旧字段；已知非 generic 角色 → `activeByAgent[agentId]`；未知 / 缺省 → generic，保持旧行为）。
- 前端 `ChatPreferences` 增补 `activeByAgent?: Record<string,string>`；`saveChatPreferences` 入参增补 `agentId?`。
- 前端首屏：`initialConversationId = AGENT_ID === "generic" ? prefs.activeConversationId : (prefs.activeByAgent?.[AGENT_ID] || "")`。

### Fix 3 — 活跃槽按会话角色归位（治缺陷 B， defense-in-depth）

- 后端 `/chat/stream`：写活跃槽前 `getConversation(conversationId)`，用**会话自身 `agentId`**（而非 `body.agentId`）选槽。（`getConversation` 已导入 `app.ts:42`。）
- 前端 `reportActiveConversation`：改为接收会话对象，仅当 `(conv.agentId || "generic") === AGENT_ID` 才上报（跨角色会话不写本角色槽）；上报时带 `agentId: AGENT_ID`。

## 5. 兼容性 / 不影响现有功能

- **同角色行为零变化**：Fix 1 对「在列的 initial / linked」仍照开；Fix 2 的 `agentId` 缺省即 generic，旧调用方（`migrateLocalPrefs` 等）写 generic 槽不变；Fix 3 对「页面角色 === 会话角色」写的是同一个槽、同一个值，与旧逻辑逐字等价。
- **仅跨角色路径改变**，且方向是「不再串槽 / 不再串页」。
- 纯 additive 的类型 / 字段扩展（`ConversationDto.agentId`、`ChatPreferences.activeByAgent`）——后端本就回传这些数据，只是补上类型声明。
- `/chat/stream` 多一次 `getConversation` 读：单文档读，chat 路径本已多次读会话，量级可忽略；`resolveConversation` 的无 id 分支早已自设槽，此处对显式 id 分支补「按角色归位」。

## 6. 风险与回滚

| 风险 | 应对 |
|---|---|
| Fix 2 改了非 generic 恢复源，用户感知「刷新后打开的不是刚才那条」 | 同步启用前端非 generic 上报（Fix 3 前端），使 `activeByAgent` 跟踪「上次查看」；若仍不一致，回退 Fix 2 即回到「list[0] 最新一条」，无数据损失 |
| Fix 3 后端多一次 DB 读 | 单文档读，可接受；如介意可改为让 `conversationNotFoundFor` 顺带返回 doc（后续优化，非本次） |
| 未知角色写入 `activeByAgent` | `hasRole` 守卫，未知 / 缺省一律走 generic |

**回滚**：三处均为独立、可分别回退的小改；任一处出问题，单独 revert 不影响其余。数据层无 schema 变更（`activeByAgent` 早已存在）。

## 7. 验证

- 类型：`pnpm type-check`（web `vue-tsc --noEmit` + agent-server `tsc --noEmit`）全绿。
- 单测：`tests/cross-role-restore.test.ts`（3 例，锁前端偏好契约）——
  - [A] `saveChatPreferences({agentId:"support", activeConversationId})` 请求体透传 `agentId`，返回值解析 `activeByAgent`。
  - [B] 不带 `agentId` 时请求体不含该字段（后端按 generic，保持旧行为）。
  - [C] `fetchChatPreferences` 解析 `activeByAgent`；缺失 / 非对象归一为 `{}`。
- 后端分槽路由（`/chat/stream` 按会话角色归位、`PUT /preferences` 分槽、`GET /preferences` 回传 `activeByAgent`）**未做 app 级 HTTP 单测**：本仓 vitest 宿主是数据层 / 纯函数直测，无 Hono app + session/owner 中间件骨架，跑 stream 还需 mock 模型。该部分由 type-check + 全量回归 + 代码推理覆盖；如后续补 app 级 harness，再补这三条。
- 回归：全量 vitest **80 文件 / 537 例全绿**（含新增 3 例）。
- 手测（待办）：① 双角色用户在 /generic 聊过 → 进 /support 首屏打开的是 support 自己的会话（不再是 generic 那条）；② /generic 点开 support 期次后刷新 → 仍回到 generic 自己的会话；③ /support 打开 / 切换 / 回复后刷新 → 回到刚才那条 support 会话；④ IM `?conv=` 深链跨角色仍可打开、失效仍提示。

## 8. 实施记录（2026-10-13）

- `apps/web/src/api.ts`：`ConversationDto` 补 `agentId?`；`ChatPreferences` 补 `activeByAgent?`；`toPreferences` 归一 `activeByAgent`；`saveChatPreferences` 入参补 `agentId?`。
- `apps/agent-server/src/app.ts`：`prefsPayload` 回传 `activeByAgent`；`PUT /chat/preferences` 按 `agentId` 写对应角色槽（`hasRole` 守卫，未知/缺省 → generic）；`/chat/stream` 活跃槽改按**会话自身 `agentId`** 归位（`getConversation` 读取）；删除对话时同步清 `activeByAgent` 里指向它的槽位（不留悬空指针）。
- `apps/web/src/pages/ChatPage.vue`：首屏 `initialConversationId` 按角色取（generic 用旧槽，其余用 `activeByAgent[AGENT_ID]`）；首屏恢复按角色收窄（跨角色 `fetchConversation` 仅保留给显式 `?conv=`）；`reportActiveConversation` 只把本角色会话写进本角色槽并带 `agentId`。
- 新增 `apps/agent-server/tests/cross-role-restore.test.ts`。
- 验证：`pnpm type-check` 绿；`pnpm test` 80 文件 / 537 例全绿。

## 9. 相关文件

- `apps/agent-server/src/app.ts`：`/chat/stream` 活跃槽（~L1600）、`prefsPayload`（~L2062）、`PUT /chat/preferences`（~L2080）。
- `apps/web/src/api.ts`：`ConversationDto`（~L265）、`ChatPreferences` / `toPreferences` / `saveChatPreferences`（~L397-439）。
- `apps/web/src/pages/ChatPage.vue`：首屏 `onMounted` 恢复（~L4896-4940）、`reportActiveConversation`（~L4756）及其两处调用（~L2284 / ~L2369）。
