# 对话独立化与「持久化全部后端化」设计方案

> 版本：v2（2026-09-17，追加 §13 实施状态 / §14 前端半场实施细化；§11.2 决议已冻结）
> 定位：**设计稿 + 实施追踪**。目标是把「对话（conversation）」升级为一等公民：每个对话独立并行，语言 / MCP / 模型 / 上下文各自独立；**所有状态的持久化一律落在后端，前端零持久化**。
> 相关：`docs/agent-infrastructure.md` §6（记忆与上下文）/ §9（会话与数据持久化）、`docs/mcp-guide.md`（MCP 契约）。
> **验证脚本现状（2026-09-22）**：本文提到的 `scripts/_thread-check.mjs` / `_mute-check.mjs` / `_bi-tools-check.mjs` 等验证脚本**均已随 2026-09 的调试脚本清理移除**；现行零依赖回归入口是 `pnpm test`（`apps/agent-server/tests/*.test.ts`），脚本名 → 替代回归的总表见 `docs/mcp-guide.md` §11。文中的实测结论保留作追溯，但**不要照抄其中的脚本命令**。

---

## 1. 背景与实测问题

### 1.1 实测证据

在 A 对话流式进行中点击侧栏另一个对话卡：

```json
{ "before": "新对话", "stopBefore": true, "after": "新对话",
  "switched": false, "bubbleCount": 2, "stillStreaming": true }
```

**没有切换**（`bubbleCount` 仍是原对话的 2 个气泡）—— 即"一个对话在跑，其它对话卡点不动"。

### 1.2 根因：跨对话共享的全局单例

| 维度 | 现状实现 | 位置 | 后果 |
|---|---|---|---|
| 气泡 | `bubbles` 单数组 | `apps/web/src/pages/ChatPage.vue` | 切换只能整体替换数组 |
| 进行中 / 停止 | `sending` + **单个 `controller`** | 同上 | `selectConversation()` 首行 `if (sending.value) return;` → **全局锁，无法并行** |
| 模型 | `modelId` 单 ref，**不持久化** | 同上 | A 选的模型跟到 B；刷新即丢 |
| MCP 启用集 | `session.mcpServers`（**cookie 级**） | `src/session.ts` | A 勾选，B 也启用 |
| 语言 | `uiLocale` **模块级 ref** + localStorage | `apps/web/src/ui-locale.ts` | A 改语言，全局界面文案都变 |
| 模型上下文 | `session.messages` **单线性历史** | `src/session.ts` | 与 UI 的对话完全不对应（`usage` 已暴露："新建对话仍 16 条历史"） |
| 主题 | localStorage | `apps/web/src/theme.ts` | 前端持久化 |
| 上次打开对话 | localStorage | `ChatPage.vue` | 前端持久化 |

### 1.3 由此产生的 4 类故障

1. **不能并行**：一个流在跑，其它对话卡点不动（已实测）。
2. **切走会丢 / 串写**：`selectConversation()` 里 `bubbles.value = conv.messages.map(...)` 会把旧 `reply` 对象挤出渲染数组 → 后台流无处渲染；且它结束时 `persist()` 会把"当前气泡"写进"当前 `currentId`" → **串写**。当前被第 1 条的锁掩盖，一旦解锁即暴露。
3. **设置串味**：模型 / MCP / 语言全局共享。
4. **上下文串味**：模型上下文是 cookie 级单线性历史，与 UI 对话无对应关系。

---

## 2. 目标与非目标

### 目标

- 每个对话独立持有：**上下文（thread）/ 模型 / MCP 启用集 / 语言**，互不影响。
- **N 个对话可同时流式**，互不 abort、互不串写；切换对话不中断任何流。
- 侧栏可见每个对话的进行中状态。
- **持久化 100% 在后端**：前端不再写 `localStorage`（语言、主题、上次对话全部迁到后端）。
- 服务端为唯一真相（single source of truth），前端只做视图 + 乐观更新。

### 非目标（本期不做，留作后续）

- 断线续跑 / 后台任务化（关页面后服务端继续跑完并回投结果）——需要任务队列，属 P4。
- 对话分支（fork）与版本回滚——`agent-infrastructure.md` §6 列为"生产级"能力，后续单独立项。
- 多用户 / 多租户隔离（当前是单机单用户，cookie 即身份）。

---

## 3. 最佳实践参考

| 来源 | 关键结论 | 对本设计的约束 |
|---|---|---|
| **LangGraph Memory 官方文档** | 短期记忆 = **线程级（`thread_id` + checkpointer）**；长期记忆 = 跨线程（`store` + namespace）。生产环境必须换成数据库版 checkpointer/store（Postgres/Mongo/Redis），而非进程内存 | 上下文以 `conversationId` 为线程键；存储换到 Mongo |
| **OpenAI Agents SDK · Sessions** | ① Session 以 `session_id` 为键隔离历史，"为每个用户或线程分配独立 ID（`thread_abc123`），互不串扰"；② 生产级共享存储用 Redis / SQLAlchemy / **MongoDB** / Dapr；③ `MongoDBSession` 用**原子序列计数器保证顺序**；④ 用 `limit` / 合并回调控制每次取回历史量；⑤ **压缩与并发不能裸写**——压缩期间会序列化 `add_items`，不要绕过包装层；⑥ `items`（对话内容）与 `RunState`（run 中断/恢复状态）职责分离 | 并发写同一对话需要**原子序列 + 互斥**；上下文压缩（摘要）与写入要串行化 |
| **AG-UI 协议（Microsoft Learn）** | 定义 state 事件与请求字段，用于在 UI 与 agent 端点之间共享**应用状态**（线程维度） | 状态同步要有明确契约：服务端为权威、前端订阅快照 + 增量 |
| **本项目 `agent-infrastructure.md` §6 / §9** | 窗口→无损裁剪→LLM 摘要→摘要缓存；长期记忆显式写入可查可删；持久化要"按 owner 索引" | 上下文压缩分层沿用；对话即容器 |
| **反模式清单 §16** | "侧栏在窄屏直接 display:none"等 | 侧栏进行中标记不能只靠颜色 |

**结论**：把 `conversationId` 当作 LangGraph 的 `thread_id` / OpenAI 的 `session_id`；上下文与全部设置挂在对话文档上，落 Mongo（我们已有的持久化层），前端不持有真相。

---

## 4. 设计总览

```
┌─ 前端（零持久化，纯视图）──────────────────────────────┐
│  states: Map<convId, ConvState>   ← 仅运行时视图态       │
│    bubbles / sending / controller / input / pendingImages│
│  设置类（model / mcpServers / locale）从后端读，不本地存  │
└───────────────┬─────────────────────────────────────────┘
                │ HTTP（NDJSON 流式）
┌─ 服务端（唯一真相）─────────────────────────────────────┐
│  session（cookie 级，设备态）                            │
│    activeConversationId / preferences{theme}             │
│  conversation doc（Mongo，对话级）                       │
│    context[] / summary / model / mcpServers / locale      │
│  MCP 连接池（全局共享长连接，引用计数按对话）             │
└──────────────────────────────────────────────────────────┘
```

**分层原则**：
- **对话级**状态 → `conversation` 文档（`context` / `summary` / `model` / `mcpServers` / `locale`）。
- **设备级**状态（与对话无关的 UI 偏好）→ `session`（cookie）：`preferences.theme`、`activeConversationId`。
- **运行时**状态（气泡、进行中、AbortController、输入草稿、待发图片）→ 仅前端内存，不持久化。

---

## 5. 数据模型

### 5.1 `conversation`（Mongo `chat_conversations`，扩字段）

```ts
interface ConversationDoc {
  id: string;
  title: string;
  messages: StoredMessage[];      // UI 展示用（已有）
  createdAt: number;
  updatedAt: number;

  // ---- 新增：对话级设置（**所有配置都按对话独立**，全部后端持久化）----
  model?: string;                 // 该对话使用的模型；空 = 服务端默认模型
  mcpServers?: string[];          // 该对话启用的 MCP server id
  locale?: "zh" | "en" | "pt-BR" | "hi";
  // locale 一个字段承担两件事（已确认"所有配置都独立"）：
  //   ① 前端界面文案（tx() 按该对话的 locale 渲染）；
  //   ② 回复语言 —— 服务端把它转成一条通用 system 指令（如 `Respond in English.`）注入模型。

  // ---- 新增：模型上下文（thread）----
  context?: ChatTurn[];           // {role:"user"|"assistant", text, handles?}
  contextSeq?: number;            // 原子序列计数器（并发写顺序保证）
  summary?: string;               // 上下文压缩产物（跨轮复用）
  summaryAt?: number;
  summaryCovered?: number;        // 摘要水位线（已覆盖到 context 的第几条）

  // ---- 候选（取决于 §11.2 的决策）----
  pendingQueue?: Array<{ text: string; images?: string[]; at: number }>;  // 忙碌期间的待发消息

  // ---- 后续增补（本设计之后按需求陆续加入，均为对话级、后端持久化）----
  todos?: TodoItem[];             // 任务规划（write_todos 全量替换，跨轮持久化）
  skillsEnabled?: string[];       // 用户勾选的技能 → 全文注入系统提示动态后缀
  pinnedAt?: number | null;       // 置顶时间戳；null = 未置顶
  sortOrder?: number;             // 手动排序（「手动排序」模式下生效）
  archived?: boolean;             // 归档（默认列表不显示，需 includeArchived）
  muted?: boolean;                // 免打扰：静默该对话的后台完成提醒
  readGrants?: string[];          // 会话级只读授权（写闸门 P0-3）
  ownerKey?: string;              // 设备 owner 标注（轻量归属隔离，方案 A）
}
```

> 整理类字段（`title` / `pinnedAt` / `archived` / `muted` / `readGrants` / `skillsEnabled`）属于
> `ACTIVITY_NEUTRAL_KEYS`：**改动它们不刷新 `updatedAt`**，否则在「按最近活动排序」下会把该对话顶到列表最前，
> 与用户预期相反（由 `conversations.ts` 的 `ACTIVITY_NEUTRAL_KEYS` 逻辑保证；历史上曾由 `_mute-check.mjs` 断言锁定，该脚本已随调试脚本清理移除）。

> `summary*` 三个字段（`summary` / `summaryAt` / `summaryCovered`，`src/conversations.ts:81-85`）原为「已存在但从未被调用」的预留字段，**现已落地**（2026-09-18 对齐）：上下文压缩真的发生时由 `chat.ts` 写回（`setConversationSummary`，`conversations.ts:293`），水位线单调前移，下一轮在此基础上增量扩展。

### 5.2 `session`（cookie 级，`src/session.ts`）

```ts
interface Session {
  id: string;
  createdAt: number;
  activeConversationId?: string;              // 原 localStorage 的"上次打开对话"
  preferences?: { theme?: "light" | "dark" }; // 原 localStorage 的主题
  // 移除：messages / mcpServers —— 改为对话级；提供一次性迁移读取
}
```

### 5.3 前端持久化清单（**全部移除**）

| 键 | 原位置 | 迁往 |
|---|---|---|
| `bx-admin-agent-ui-locale-v1` | `ui-locale.ts` | `conversation.locale`（每对话；首启读后端） |
| 主题键（`theme.ts`） | `theme.ts` | `session.preferences.theme` |
| `bx-chat-last-conversation` | `ChatPage.vue` | `session.activeConversationId` |

---

## 6. API 契约

### 6.1 变更

| 方法 + 路径 | 变更 |
|---|---|
| `POST /chat/stream` | 请求体新增 **`conversationId`（必填）**；服务端按该对话读/写 `context`、读 `model`/`mcpServers`（请求体 `model` 仍可覆盖，用于临时切换） |
| `GET /chat/mcp/servers` | 新增查询参数 `conversationId`：返回 `{ available, enabled }`（`enabled` 来自该对话文档） |
| `PUT /chat/mcp/servers` | 请求体 `{ conversationId, enabled }`：写入对话文档 + 服务端 diff 触发 connect/disconnect |
| `GET /chat/conversations` | 列表保持轻量（不带 `context`，避免大响应） |
| `DELETE /chat/conversations/:id` | 删除时：abort 该对话进行中的流 + 释放其 MCP 引用 |

### 6.2 新增

| 方法 + 路径 | 说明 |
|---|---|
| `GET /chat/conversations/:id` | 全量文档（含 `context`/`summary`/设置），供切对话时载入 |
| `PATCH /chat/conversations/:id` | 更新设置：`{ title?, model?, mcpServers?, skillsEnabled?, locale?, pendingQueue?, pinnedAt?, archived?, muted?, readGrants? }`；MCP 变更时服务端联动连接。全部经归属守卫（他人/不存在统一 404） |
| `GET /chat/preferences` | `{ activeConversationId, theme }`（设备态） |
| `PUT /chat/preferences` | 更新设备态（切换对话时上报 `activeConversationId`、主题切换时上报 `theme`） |
| `POST /chat/conversations/:id/context/clear` | 清空该对话上下文（替代现在的全局 `/chat/context/clear`） |
| *（候选，取决于 §11.2）* | 若采纳 pending queue：`PATCH /chat/conversations/:id` 增加 `pendingQueue` 字段（入队/重排/编辑/删除统一走它），出队由服务端在 turn 收束时驱动 |

### 6.3 兼容与回退

- `conversationId` 缺省时：回退到"该 cookie 的默认对话"（`session.activeConversationId` 或自动创建），保证既有直连 `chatStream` 的调用不炸（历史上由 `scripts/_chat-bi.ts` 等脚本覆盖，已随调试脚本清理移除；当前由缺省回退路径兜底）。
- 旧 `/chat/context/clear`、旧 `session.mcpServers` 保留一个版本作为兼容路径，标注 `@deprecated`。

---

## 7. 服务端设计

### 7.1 上下文（thread）读写

- 读：`getConversation(id).context` → 走现有 `buildTurns()`（窗口 + token 预算 + 首条必须 user）→ 组装请求。
- 写：本轮结束后**原子追加**两轮消息：
  ```ts
  await coll.updateOne(
    { id },
    { $push: { context: { $each: [userTurn, assistantTurn] } },
      $inc: { contextSeq: 2 },
      $set: { updatedAt: Date.now() } },
  );
  ```
  `$push` + `$inc` 是单文档原子操作，配合 `contextSeq` 可保证并发下顺序可判定（对齐 OpenAI `MongoDBSession` 的原子序列计数器）。

### 7.2 同对话并发保护（**待讨论**，见 §11.2）

**共识（无论选哪种）**：锁的作用域必须是**对话级**，不能是全局。不同对话天然并行；同一对话同一时刻只能有一条流在写 `context` 与气泡。

四种业界做法见 §11.2 的对比表，本文档暂按「A 拒绝 + 前端禁用（按对话）」为默认，待你拍板后再定 B/C/D 是否纳入。

### 7.3 MCP 引用计数

- 现状：按"会话"统计谁还在用 → 改为按**对话文档**统计（任一对话 `mcpServers` 含该 id 即视为在用）；
- 长连接仍**全局共享**（MCP 连接本身支持并发调用），避免 N 个对话开 N 份 stdio 子进程；
- `PATCH /chat/conversations/:id`（MCP 变更）与 `DELETE` 时重新计算并 connect/disconnect。

### 7.4 上下文压缩与并发（对齐最佳实践）

- 摘要（LLM 压缩）**不在流式过程中并发执行**：在"本轮收束后、下一轮开始前"的窗口内做，并与该对话的写入串行化；
- 摘要产物写 `summary` + `summaryCovered`（水位线），下次只增量扩展（对齐 LangGraph `RunningSummary`）；
- 每个对话同一时刻只允许一个"压缩任务"。

### 7.5 中断/审批状态（为 P4 留位）

按 OpenAI 的 `items` / `RunState` 分离：
- `context` = items（对话内容，已持久化）；
- 确认卡的"等待审批"属 run 级状态（`confirm.ts` 已按 `callId` 键、进程内存），P4 若要"关页面后续跑"再把它与 run 状态一起持久化。

---

## 8. 前端设计

### 8.1 状态容器（每对话一份，仅运行时）

```ts
interface ConvState {
  bubbles: Bubble[];
  sending: boolean;
  controller: AbortController | null;
  input: string;
  pendingImages: UploadResult[];
  loading: boolean;                 // 载入该对话历史中
}
const states = reactive(new Map<string, ConvState>());
const current = computed(() => states.get(currentId.value) ?? blankState(currentId.value));
```

- **模板全部改为 `current.xxx`**（`v-for="b in current.bubbles"`、`:disabled="current.sending"` 等）；
- 切换对话 = **只改 `currentId`**，不触碰任何 `ConvState` → 后台流继续写自己的 `bubbles`（`reply` 已是 `reactive`，天然支持后台更新），切回来即可看到进度；
- 删除对话：先 `states.get(id)?.controller?.abort()`，再删后端，再清理本地 state。

### 8.2 设置以后端为准（去掉 localStorage）

- 启动：`GET /chat/preferences`（设备态）+ `GET /chat/conversations` → 定位 `activeConversationId` → `GET /chat/conversations/:id`（拿到 `model`/`mcpServers`/`locale`）；
- 改动：乐观更新本地 → `PATCH /chat/conversations/:id` → 失败回滚并提示；
- 切对话：把该对话的设置填入 `current`（设置**不再**是全局 ref）；
- 三项 localStorage **一次性迁移**：首启读旧值 → PATCH/PUT 到后端 → 删除本地键（迁移完成标记也放后端，避免重复迁移）。

### 8.3 并行与可感知

- 每个对话一个 `controller`，「停止」只作用于 `current.controller`；
- 侧栏每个对话显示状态点：`生成中 ⟳ / 待确认 ⚠ / 有错误 ⚠ / 空闲`；
- 切到正在生成的对话：直接看到实时增长（本节修复的 reactivity 问题已解决）；
- 不再有任何"全局锁"，`selectConversation` 只在切换时按需 `loading` 拉取。

---

## 9. 迁移与兼容

| 对象 | 迁移方式 |
|---|---|
| Mongo `conversations` | 无需脚本（schemaless）；读取侧给默认值 `model=∅`、`mcpServers=[]`、`locale=∅`、`context=[]` |
| `session.messages`（旧线性历史） | 一次性：归入该 cookie 的"默认对话"的 `context`，并在日志标注；之后 `session.messages` 删除 |
| `session.mcpServers` | 一次性：归入"默认对话"的 `mcpServers` |
| 前端 3 个 localStorage 键 | 首启迁移到后端后删除（见 8.2） |
| 既有直连调用 | 调用 `chatStream` 不带 `conversationId` → 走"默认对话"回退路径（历史上 `scripts/_chat-bi.ts` 等脚本覆盖此路径，已移除） |

---

## 10. 分期与验收

> 决策 #6 = **统一实施**：下列 P1/P2 作为**同一次改动**落地（契约一次冻结，中途不接受"服务端已改、前端没改"的可用状态）。

| 期 | 内容 | 验收标准 |
|---|---|---|
| **P0（本文档）** | 设计评审 + 契约冻结 | 决策点已确认（§11.1）；§11.2 待讨论 |
| **P1+P2 统一实施** | 服务端：`conversation.context` 读写 + 设置字段 + 对话级锁/409 + MCP 引用计数改造 + session 瘦身 + 迁移；前端：`states: Map<convId, ConvState>` + 去全局锁 + 设置后端化 + 三处 localStorage 移除与迁移 + 侧栏状态点 | ① 直连脚本：两个 `conversationId` 并行请求，上下文互不污染；同 `conversationId` 并发返回 409；② 浏览器：3 个对话同时流式且互不中断；切卡不掉线；改 A 的模型/MCP/语言，B 不受影响；③ 刷新后设置与上下文保持；④ `tsc` / `vite build` 全绿（原 `_bi-tools-check.mjs` 已随 2026-09 调试脚本清理移除，现行回归入口见本文档头部口径） |
| **P3 待讨论项落地** | 若采纳 §11.2 的 B/C：`pendingQueue` 持久化 + 队列 UI（Pending(N)/上移/下移/编辑/删除/立即发送）+ 出队策略 | 忙碌时发消息进队列不丢；turn 收束后按序自动发；「立即发送」= abort + 出队 |
| **P4 收尾** | 文档同步（`mcp-guide.md` / `agent-infrastructure.md` 对照表）、回归清单、旧字段标注 deprecated | 文档与代码一致 |
| **P5（可选）** | 断线续跑（后台任务化 + run 状态持久化）——✅ 已于 2026-09-17 随异步任务底座落地（`src/chat-tasks.ts` + `/chat/cancel`、`/chat/task/status`、`/chat/task/events`；断开后任务照跑、结果回投进对话消息快照） | 发起后立刻断网/关页面，重连可见完整结果 |

**回归清单（每期都跑）**：NDJSON 流式正常、确认卡出现并可点、`usage` 数值合理、图片提示、MCP 面板选择、8 个 BI 工具全绿、`tsc --noEmit` + `vite build`。

---

## 11. 决策记录与待讨论

### 11.1 已确认（2026-09-17）

| # | 决策 | 落地含义 |
|---|---|---|
| 1 | 上下文存 **Mongo conversation doc** | `conversation.context` + `contextSeq` + `summary*`（对齐 LangGraph/OpenAI"生产用共享存储"） |
| 2 | **所有配置都按对话独立** | `model` / `mcpServers` / `locale` 全部挂对话文档；`locale` 同时决定**界面文案**与**回复语言**（§5.1 注释） |
| 3 | 主题放 `session.preferences` | 设备态，非对话态；前端不再写 localStorage |
| 4 | — | **待讨论**，见 §11.2 |
| 5 | 旧 `session.messages` **迁移** | 一次性归入该 cookie 的"默认对话"的 `context`；`session.mcpServers` 同法迁入该对话的 `mcpServers` |
| 6 | **统一实施** | 契约一次冻结，服务端与前端在**同一次改动**里统一落地，不留"半可用"的中间态（单次改动较大，靠回归清单兜底） |

### 11.2 待讨论：同一对话在生成中再次发送

**共识**：锁的作用域必须是**对话级**（不同对话并行；同一对话同时只能有一条流在写 `context`）。
**最佳实践依据**（Claude Code / Codex 官方指南，2026-04-03）：把两个诉求**刻意分开**——
「**会不会丢**」用排队解决；「**要不要改变正在发生的事**」用 steer / interrupt 解决；
并明确警告：**过度 steering 会让 agent "thrash"（反复折腾）**，默认保守策略是**排队**，因为"编辑/重排 pending 比撤销一次冲动的打断容易"。

| 方案 | 行为 | 代表实现 | 优点 | 代价 |
|---|---|---|---|---|
| **A. 拒绝 / 禁用** | 同对话有流时禁用输入框；服务端 409 兜底 | Vercel AI SDK `useChat` 的 `status`（非 `ready` 即禁用）——注意它是**每 thread 一份** | 最简单、零串写、语义确定 | 想补一句话必须先点「停止」 |
| **B. 排队 pending queue** | 新消息进队列，当前 turn 收束后按序自动发 | Claude Code / Codex 的 **Server pending**（作者默认选它） | 不打断做对的事；消息不丢；可编辑/上移下移/删除 | 需队列 UI + 服务端"turn 收束后出队"驱动 + 出队策略（错误/待确认时是否继续） |
| **C. 打断并重发 interrupt** | 中止当前 turn，新消息作为新 turn 发出 | Claude Code 的 Interrupt / "Send now" | 立刻纠偏 | 丢掉已生成内容（我们前端已有"（已停止生成）"提示） |
| **D. 实时注入 steer** | 把新消息注入**正在运行**的 turn，不中止 | Claude Code 的 Steering；OpenAI Agents SDK 的 run/interrupt 机制 | 最贴近"边说边改" | 需改我们的模型循环（在 `runWithTools` 每轮间检查"是否有插话"）；官方警告易 thrash |

**决议（已确认，2026-09-17 冻结）**
1. **做（A）**：每对话独立锁 + 服务端 409 —— "对话独立并行"的必要条件，把全局锁收窄为对话级。
2. **做（B）**：`conversation.pendingQueue`（后端持久化，符合"持久化全后端"）+ `Pending(N)` 徽标 + 上移/下移/编辑/删除；turn 收束后自动出队。
   - **出队策略：停下等用户** —— `error` / 等待确认超时后**不再自动出队**，保留队列并提示；避免"出错还自动刷下一句"。
3. **做（C）**：队列内提供「立即发送」= abort 当前 turn + 出队并发出。
4. **不做（D）**：实时 steer 暂缓，等 A/B/C 稳定且有真实诉求再评估（要改模型循环，成本最高）。

---

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 多对话同时流式 → 前端渲染压力 | 非当前对话仍会更新 DOM；若卡顿，改为"非当前对话只累积不渲染、切换时一次性渲染" |
| 上下文写入竞争 | 单文档 `$push`+`$inc` 原子写 + 同对话 409 |
| `session` 从"唯一真相"降级 → 旧字段双写 | 迁移后立即删除旧字段，只在迁移路径读 |
| 契约变更影响既有脚本 | `conversationId` 缺省回退"默认对话" |
| 语义混淆：`conversation.messages`（UI）vs `context`（模型） | 文档中明确区分：前者为展示快照（含工具步骤摘要、图片），后者为模型上下文（含轻量句柄）；二者**不自动互相同步** |

---

## 13. 实施状态（截至 2026-09-17）

**已完成 = 服务端半场 + 上下文/记忆层**（每一行都有代码位置，可复核；**行号自 2026-09-18 锚点刷新后可能再次漂移，以函数名为准**，见 `docs/README.md` 效力约定）：

| 能力 | 落点 |
|---|---|
| 对话级上下文 `context` + 原子追加 | `conversations.ts`（`$push` + `$inc: contextSeq`） |
| 对话级设置 `model`/`mcpServers`/`locale`/`pendingQueue` | `conversation` 文档 + `PATCH /chat/conversations/:id`（`app.ts:735`） |
| 同对话并发 409 | 异步任务注册表 `chat-tasks.ts`（`isTaskRunning` / `startTask`）→ `CONVERSATION_BUSY`（`app.ts:532`） |
| 列表回传 `running` | `app.ts:664`（列表）/ `app.ts:731`（单条）；**前端已消费**：`ConversationDto.running?`（`api.ts:165`）→ `ChatPage.convStatus()` 侧栏状态点 + 排队徽标 |
| 设备态后端化 | `GET/PUT /chat/preferences`（`app.ts:854/859`）；`session.preferences`（接口 `session.ts:27-47`，字段 `session.ts:65`） |
| `session` 瘦身 | `messages`/`mcpServers` 标 `@deprecated`，仅迁移路径读取（`session.ts:56-59`） |
| 上下文三层压缩（窗口→无损裁剪→LLM 摘要） | `history.ts`（`assembleContext`，`history.ts:103`；真发生压缩时才回写 `conversation.summary` / `summaryCovered`） |
| 跨轮**轻量工具句柄**（只留"查过什么"，不留正文） | `ToolHandle` + `ChatTurn.handles`（`session.ts:8-22`） |
| 长期记忆（显式写入、可查可删、注入 system） | `memory.ts` |
| 上下文用量透明 | `usage` 事件（字段定义 `packages/shared/src/index.ts:69-102`）：`tokens` / `budget` / `window` / `turns` / `dropped` / `summarized` / `toolResultsCleared` / `toolResultsOffloaded` / `rounds` / `toolCalls` / `modelRetries` / `modelFallbacks` / `toolFusions` / `pseudoCallRetries` / `costTokens` |
| 新对话默认不选 MCP | 前端按对话带 `conversationId` 读取 + `POST /chat/conversations` 即时置为活跃 |

> **锚点对齐（2026-09-18）**：上表行号按当前代码刷新过一遍，其中四条不只是行号漂移：
> ①「同对话并发 409」的判据从旧的 `runningStreams` 迁到异步任务注册表 `chat-tasks.ts`（执行与推送解耦后，该注册表是运行态的唯一真相，`app.ts` 只做 `isTaskRunning()` 判定与 409 出口）；
> ②`running` 前端**已经消费**（`ChatPage.convStatus()`：待确认 > 出错 > 生成中 ∪ 服务端 `running`，另加排队徽标），不再是「前端未消费字段」；
> ③上下文组装入口改名为 `assembleContext`（原 `buildContext`）；
> ④`usage` 事件字段已扩展（新增 `summarized` / `toolResultsOffloaded` / `rounds` / `toolCalls` / `modelRetries` / `modelFallbacks` / `toolFusions` / `pseudoCallRetries` / `costTokens`）。

**前端半场 + P3 队列：已于 2026-09-17 落地**（实现与实测证据）：

| # | 项 | 落点 | 实测 |
|---|---|---|---|
| F1 | 每对话状态容器 `ConvState` | `states: Map<convId, ConvState>`（bubbles / input / sending / controller / pendingImages / settings / queue / error）；模板统一 `current.xxx` | ✓ |
| F2 | 去全局锁 | `selectConversation` 只改指针；`persist(convId, bubbles)` 显式带对话 id，后台流不会串写 | 两对话同时流式（侧栏双点闪烁）；切走后 A 照常跑完并落库；草稿按对话保留 |
| F3 | 设置按对话 | model / locale / MCP 全部镜像进 `ConvState.settings`，写 = 乐观更新 + `PATCH` + 失败回滚（TanStack 三段式） | A 选模型 hyvision、B 仍默认；A 改英文、B 仍中文；刷新后保持 |
| F4 | 去 localStorage | `ui-locale.ts` / `theme.ts` / `LAST_CONV_KEY` 只剩迁移读取；迁移标记 `preferences.migratedAt`（服务端首次 PUT 自动落） | 塞入旧值 → 迁移后本地键清空、后端收到 theme / locale / activeConversationId |
| F5 | 侧栏状态点 | `convStatus()`：待确认 > 出错 > 生成中（本地 `sending` ∪ 服务端 `running`）+ 排队数徽标 | 并行流式时两点同闪 |
| F6 | 待发队列 | 忙时 Enter 入队（上限 20）；**成功**收束自动按序出队；出错 / 停止 / 待确认 → **停下等用户**；「立即发送」= 中断 + 出队 | 队列持久化、自动出队 2 条、停止后不出队、立即发送即发 |

**实现期决定（补充）**：
- **新对话继承当前界面语言**并写成该对话自己的 `locale`：语言是 UI 偏好，不应每个对话都重设一次；写成对话自己的 locale 后，改 A 仍不影响 B。模型 / MCP 新对话仍为空（干净起点）。
- **后台出队用「该对话」的模型设置**，而不是当前展示的对话（`runTurn(convId, …)` 内取 `stateOf(convId).settings.modelId`）——否则队列在别的对话后台触发时会用错模型。

**回归**：`tsc --noEmit` ✓、`vite build` ✓、`pnpm test` 全绿 ✓、NDJSON 流式 / usage 行 / 新对话默认无 MCP ✓。

**遗留观察（待查）**：2026-09-17 发现 Mongo `bx_agent.chat_conversations` 只剩 1–2 条（此前 15+）。已排除：前端 DELETE（网络面板无该请求）、TTL 索引（集合只有 `_id_` 索引）、`resolveConversation` / `clearConversation`（无删除路径）；`_thread-check.mjs` 的 DELETE 均限定在自建 id。待排查是否有外部清理脚本或人工操作。

---

## 14. 本期实施细化（前端半场 + P3）

### 14.1 最佳实践依据（本轮复核）

| 来源 | 关键结论 | 对本期的约束 |
|---|---|---|
| **Vercel AI SDK `useChat`** | 状态绑定到**显式 Chat 实例**（`CHAT?`）而非隐式单例；`stop()` 是**实例级方法**（非全局中断）；持久化标准落点是 `onFinish` | 每对话一个 `ConvState`（自带 `controller`）；`stop()` 只作用于 `current.controller`；落库在 turn 收束时 |
| **TanStack Query · Optimistic Updates** | 三段式：`onMutate` **先快照再写入** → `onError` 回滚（必须带 context）→ `onSettled` 与服务器重新对齐；能重取就**优先重取**，纯回滚只在不可达时用 | 设置写失败必须回滚；成功后以服务端返回值为准 |
| **Claude Code / Codex 队列语义**（guides.happier.dev，2026-04-03） | 「会不会丢」→ 排队；「要不要改变正在发生的事」→ steer/interrupt；默认保守 = 排队 | 本期做排队 + 立即发送，不做 steer |
| 本方案 §11.2 决议 | A/B/C 做，D 不做；出错/待确认**停下等用户** | 队列出队条件 = 上一 turn **成功**收束 |

### 14.2 前端状态容器契约（F1/F2/F5）

```ts
interface ConvState {
  bubbles: Bubble[];
  sending: boolean;
  controller: AbortController | null;   // 每对话唯一，禁止跨对话复用
  input: string;
  pendingImages: UploadResult[];
  settings: { modelId: string; locale: string; mcpEnabled: string[] };  // 按对话
  queue: PendingMessage[];              // 镜像服务端 pendingQueue
  hydrated: boolean;                    // 是否已从后端载入过 messages/settings
  error: string;
}
const states = reactive(new Map<string, ConvState>());
const current = computed(() => stateOf(currentId.value));   // 模板统一改 current.xxx
```

**不变式**：
1. 全局只剩"视图骨架"：`currentId` / `models` / `conversations` / UI 开关（`mcpOpen` 等）；
2. 切换对话**只改 `currentId`** —— 不 abort、不覆盖任何 `ConvState`（后台流继续写自己的 `bubbles`）；
3. 删除对话：先 `states.get(id)?.controller?.abort()` → 删后端 → 清理本地 state；
4. 侧栏状态点数据源 = 服务端 `running` ∪ 本地 `sending` ∪ `pending.length`（切卡不掉线时才准）。

### 14.3 设置同步协议（F3）

- **读**：`hydrate(convId)` = `GET /chat/conversations/:id` → 填 `bubbles`（由 `messages` 映射）+ `settings`；
- **写**：乐观更新本地 → `PATCH /chat/conversations/:id` → 失败回滚 + 提示（三段式）；
- **MCP**：沿用 `GET/PUT /chat/mcp/servers?conversationId=`（本轮已修，按对话读写）；
- **主题（设备态）**：乐观 → `PUT /chat/preferences { theme }`；
- **`activeConversationId`**：切换时 `PUT /chat/preferences`（节流 ~500ms，避免连点刷写）。

### 14.4 客户端持久化迁移（F4）

```
启动 → GET /chat/preferences
  ├─ preferences.migratedAt 存在 → 跳过（不再读 localStorage）
  └─ 不存在 → 读 3 个旧键 → PUT /chat/preferences { theme, locale, activeConversationId }
              + PATCH /chat/conversations/:id { locale }（若已有对话）
              → 删除 3 个本地键 → 服务端落 migratedAt
```
迁移标记**存后端**（`session.preferences.migratedAt`），避免换设备/清缓存后重复迁移。

### 14.5 队列状态机（F6）

```
发送 → POST /chat/stream
  ├─ 200 → 正常流式
  └─ 409 CONVERSATION_BUSY → PATCH pendingQueue 追加 → 徽标 Pending(N)
turn 成功收束 → 出队首条 → 自动发起
turn 失败 / 待确认超时 → 停止出队 + 保留队列 + 提示（"停下等用户"）
「立即发送」→ abort current.controller → 出队首条 → 立即发起（C）
```
- 队列为**后端真相**（`conversation.pendingQueue`），刷新/换设备不丢；
- 容量上限 20，超出拒绝并提示；
- 队列 UI：`Pending(N)` 徽标 + 展开列表（上移/下移/编辑/删除/立即发送）。

### 14.6 本期验收

| # | 验收项 |
|---|---|
| 1 | 3 个对话同时流式，互不中断；生成中切卡不掉线、切回可见进度 |
| 2 | 改 A 的模型/MCP/语言，B 不受影响；刷新后三者的设置与上下文都保持 |
| 3 | 同 `conversationId` 并发 → 409 → 消息入队（不丢）；正常收束后自动出队依次发送 |
| 4 | turn 失败/待确认 → 队列**停住**并提示；「立即发送」= 中断 + 出队 |
| 5 | 清空 localStorage 后首启，主题/语言/上次对话仍从后端恢复 |
| 6 | `tsc --noEmit` + `vite build` + BI 工具回归全绿 |
