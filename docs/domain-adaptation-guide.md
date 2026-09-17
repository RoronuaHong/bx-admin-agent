# 领域 Agent 适配指南（以「观影助手」为例）

> 配套文档：`agent-infrastructure.md`（通用 Agent 基建检查表，含 M0–M4 成熟度模型与反模式）。
> 本指南回答一件事：**如何在不破坏现有通用 Agent 的前提下，把它改造成某个垂直领域 Agent（如观影助手），且能共存/切换**。

---

## 0. 核心结论（先记住）

1. **引擎是角色无关的**。ReAct 循环、工具调度、skill 加载都在 `apps/agent-server/src`，不绑定任何业务。改造**只发生在「配置 / prompt / skills / MCP」层，引擎代码零改动** → 现有通用 Agent 的全部能力完整保留。
2. **角色与用法（人设 / 知识 / 工具）都能增量改**；只有「安全护栏的硬保障」（越域拦截、只读锁死、身份隔离）才必须动代码或后端。
3. **这不是"切换状态"，而是"同一引擎的不同配置实例"**。通用 Agent 与观影 Agent 天然可共存。

总纲呼应 `agent-infrastructure.md`：
- 能力能被观测，才谈得上优化（先有 trace / 评测，再谈改造）。
- 写操作必须有闸门（复用现有 `requireConfirm` 二次确认）。
- 语义判断交给模型，服务端只做护栏（不在引擎里写业务 if/else）。

---

## 1. 改造前的真实结构（本项目现状）

| 关注点 | 真实位置 | 现状 |
|---|---|---|
| 角色定义（稳定前缀） | `apps/agent-server/src/system-prompt.ts` 的 `BASE_PROMPT` + `buildSystemPrompt()` | 🟡 当前硬编码为「数据分析助手」，是 prompt caching 命中对象 |
| 能力插件 | `apps/agent-server/skills/<name>/SKILL.md` | ✅ 已有机制（`metric-caliber-check` 为样例），frontmatter 只载 `name/description`，模型命中后加载全文 |
| 工具接入 | `apps/agent-server/.data/mcp-servers.json` + `src/mcp/hub.ts` | ✅ 配置驱动、命名空间隔离、连接失败不阻断主流程 |
| 写操作闸门 | 配置 `mcp/config.ts` 的 `requireConfirm` → 判定 `mcp/hub.ts` → 挂起/应答 `src/confirm.ts`（`waitForConfirmation`/`answerConfirmation`，超时默认 120s 按拒绝）→ 端点 `app.ts` `/chat/confirm` | ✅ 二次确认 + 超时按拒绝处理 |
| 越权 / 审计 / 注入防护 | — | ❌ 缺失（见 infra 第 5 章），仅匿名 cookie 会话 |

关键推论：换角色 = 换 `BASE_PROMPT` + 对应 `skills/` + 对应 MCP 配置，**三处全在引擎之外**。

---

## 2. 三种适配模式（共存 vs 切换）

### 模式 A：部署配置共存（推荐起步）

同一份引擎代码，跑两个部署，各自一份配置：

- **部署 A（通用）**：`BASE_PROMPT`=数据分析助手 + 通用 `skills/` + 通用 MCP。
- **部署 B（观影）**：`BASE_PROMPT`=观影助手 + `skills/观影助手/` + 观影 MCP（如 TMDB / 豆瓣 / 猫眼）。

本质是**部署配置的区别，不是运行时状态机**。两者共享引擎、互不影响。换一份 `BASE_PROMPT` 即切角色。

### 模式 B：运行时角色参数（逻辑共存）

给 `buildSystemPrompt` 加一个 `role` 入参 + 一份**角色注册表**（每角色含自己的 `prompt / skills / MCP 清单`）。请求体加 `role` 字段，引擎按角色选配置。通用 Agent 只是注册表里的一项。

- 改动范围：仅 `system-prompt.ts` 的选择逻辑 + chat 入口透传 `role` 字段。
- ⚠️ **`renderSkillIndex` 必须同步按 `role` 过滤**：当前它遍历 `skills/` 下全部子目录、不区分角色（实测 `skills.ts` 的 `listSkills()` 无过滤），新增观影 skill 会让通用 Agent 的系统提示稳定段多出一行、触发 prompt cache 全量失效。改为 `renderSkillIndex(role)` 只返回该角色的 skills，通用索引保持字节级不变、缓存不被击穿。这是模式 B 落地的**必需代码改动**，不是可选项。
- 适用：同一引擎要同时服务多个领域、且需在对话中动态切角色时。

### 模式 C：硬约束（仅当越域风险真实存在时）

观影助手常要求「只聊电影」。注意：**prompt 软约束不够**（模型会越域）。真要硬拦截（tripwire / allowlist），规则必须**按 role 隔离配置**——直接把"电影关键词"写死进引擎，会污染通用 Agent。

- 推荐路径：先用 prompt + skill 软约束；越域风险高时，再按 role 加代码层护栏，**绝不硬编码业务关键词进引擎**。

---

## 3. 改造清单（最小可用 → 生产）

### M0 角色切换（改 prompt，约 5 分钟）
- 复制 `BASE_PROMPT` 为观影版：人设 + 工具守则 + 引用来源（沿用现有「只依据真实数据、注明来源」守则）。
- 不触引擎代码。

### M1 领域能力（加 skill，零引擎改动）
- 新建 `apps/agent-server/skills/观影助手/SKILL.md`：`frontmatter(name/description)` + 流程 + 输出格式。
- 可按场景拆多个 skill：选片推荐、影评写作、排片查询、对比分析。
- 模型命中 `description` 后自动加载全文，无需改引擎。

### M1 工具接入（MCP 配置）
- 在 `mcp-servers.json` 加观影数据源（TMDB / 豆瓣 / 猫眼）。
- 命名空间 `mcp__<serverId>__<tool>` 自动隔离，不影响通用工具；连接失败只记状态、不阻断对话。

### M2 可信（复用 infra 第 10–11 章）
- Trace + 评测门禁：观影金样集（如「推荐一部诺兰的科幻片」应命中推荐 skill 并调用观影 MCP）。
- 防短路：门禁检查「是否调用了期望 skill / 工具」，而非只比对最终文本（避免模型直答骗过门禁）。

### M3 写操作闸门（如观影助手有写意图：加入片单 / 标记看过）
- 复用 `requireConfirm` 二次确认；确认超时 = 拒绝，且确认请求本身零副作用。

---

## 4. 反模式（对接 infra 第 16 章）

| 反模式 | 后果 | 正解 |
|---|---|---|
| 把"电影关键词"硬编码进引擎做越域拦截 | 通用 Agent 被污染，切回需改代码 | 拦截规则按 role 配置，或先用 prompt 软约束 |
| 为每个电影子场景写 if/else 路由 | 加场景必改代码 | 交给 skill 索引，模型自选 |
| 观影工具凭据写进前端 | 泄露 | 凭据只返回键名（已具备） |
| 改 `BASE_PROMPT` 后无回滚预案 | 改坏无法快速恢复 | prompt 随代码走，git 回滚；外置则自管版本 |

---

## 5. 验收口径

- 角色切换后：prompt caching 稳定前缀仍命中（`BASE_PROMPT` 改动频率低）。
- 观影部署：问电影能命中 skill + 调用观影 MCP；问非电影走软约束、说明不擅长。
- 通用部署：行为与改造前一致（回归金样全绿）。
- 两个部署互不影响（部署级隔离）或同一引擎按 `role` 正确分流（模式 B）。

---

## 6. 建议落地顺序

1. **模式 A** 起一个观影部署（改 `BASE_PROMPT` + 加 1 个 skill + 加观影 MCP）。
2. 写观影金样，跑回归确认**通用 Agent 未受影响**。
3. 需要同引擎多角色时，升级到 **模式 B**（加 `role` 参数）。
4. 越域风险真实存在时，再补 **模式 C** 的按 role 护栏。

## 7. 前端：移动端优先（实测现状 + 最佳实践）

### 7.1 实测现状（本项目 `apps/web/`）

- 布局：`<div class="chat">` = `<aside class="sidebar">`（会话列表 + 新建/删除，**实测 256px**，`ChatPage.vue:1685`）+ `<main class="main">`（顶栏 + 线程 + 输入区），**桌面多栏**。
- 窄屏断点（`ChatPage.vue` 末尾）：
  ```css
  @media (max-width: 860px) { .sidebar { display: none; } }
  @media (max-width: 720px) { .model-tag { display: none; } }
  ```
- **问题确认**：≤860px 时侧栏直接 `display:none`，**无汉堡按钮、无抽屉、无替代入口** → 移动端无法切换/新建会话。这正是 `agent-infrastructure.md` 第 14、16 章标注的 ❌ 反模式（"侧栏在窄屏直接 `display:none` → 移动端丢功能入口"）。
- 已具备的良好基础：`styles.css` 定义了 `--safe-bottom: env(safe-area-inset-bottom)`，且**已用于输入区**（`ChatPage.vue:3265` `.composer` 的 `padding: 12px 18px calc(12px + var(--safe-bottom))`）、`touch-action: manipulation`、`:focus-visible` 焦点环、`prefers-reduced-motion`；`mcp-panel` 有 `max-width: calc(100vw - 32px)`（`ChatPage.vue:2455`）；写操作确认卡（`.confirm-card`，`ChatPage.vue:1510/2768`）已存在。
- 其他缺口（对接 infra 第 14 章）：❌ 重新生成/编辑重发、❌ 会话搜索与分组、❌ a11y 审计（live region/焦点/对比度）、❌ 未读/结果收件箱。

### 7.2 移动端最佳实践（对齐 infra 第 14 章 + 通用规范）

**布局**
- 移动端用**抽屉式侧栏**（覆盖层滑出 / 从左侧推入），不要 `display:none`；桌面保持多栏常驻。
- 单列布局：顶栏（`品牌 + 汉堡 + MCP + 模型`）→ 线程 → 底部输入区，纵向堆叠。
- 断点建议：`>860px` 双栏；`≤860px` 单栏 + 抽屉；`≤720px` 顶栏精简（`model-tag` 可隐藏，但**会话入口必须保留**为汉堡）。

**交互与触控**
- 触摸目标 ≥ 44×44px（汉堡、发送、确认/拒绝按钮）。
- 底部输入区适配安全区：`padding-bottom: calc(12px + var(--safe-bottom))`，避免被 Home 指示条遮挡（✅ **本项目已实现**，见 `ChatPage.vue:3265`；改版时勿回退）。
- 写操作确认卡窄屏**全宽、按钮纵向堆叠且够大**，拒绝/确认同等醒目。
- 工具步骤（`reasoning` / `steps`）默认折叠，展开不占满整屏；长结果可滚动而非撑高。

**可访问性（a11y）**
- 流式内容用 `aria-live="polite"` 播报；抽屉打开时 `role="dialog"` + `aria-modal`，焦点 trapped、Esc 关闭、点遮罩关闭、关闭后焦点回到汉堡。
- 状态不只靠颜色（现状已做：状态点带 `title`/`aria-label`、任务标记用字形 ✓/•/○/×）。
- 对比度达标；键盘可完成"输入→发送→停止→确认"全流程。

**MCP 面板**
- 窄屏下 `mcp-panel` 改为底部半屏或全宽弹层（现有 `max-width: calc(100vw - 32px)` 已防溢出，需确认定位不超出视口）。

### 7.3 验收口径（前端）

- ≤860px：存在汉堡入口，点击滑出会话抽屉，可切换/新建/删除会话；关闭后回到对话不丢草稿与滚动位置。
- 输入区不被移动端安全区遮挡；主要按钮 ≥44px，单手可点。
- 写确认卡窄屏全宽、按钮可点；工具步骤可折叠。
- 键盘 + 屏幕阅读器可走通核心流程；抽屉焦点可捕获与归还。

### 7.4 反模式补充

| 反模式 | 后果 | 正解 |
|---|---|---|
| 窄屏 `.sidebar { display:none }` 无替代 | 移动端丢会话入口 | 抽屉/底部导航等替代入口 |
| 输入区不接 `safe-area-inset`（本项目已达标，改版勿回退） | 被 Home 条遮挡 | `padding-bottom: calc(... + var(--safe-bottom))`；实测 `ChatPage.vue:3265` 已如此 |
| 抽屉无焦点陷阱/Esc | 屏幕阅读器卡死、误操作 | `role=dialog` + trap + Esc + 点遮罩关 |
| 触摸目标 <44px | 误触 | 关键控件 ≥44×44px |

---

## 8. 多 Agent 路由与页面结构（门户 + 观影助手新路由）

### 8.1 现状（`apps/web/src/router.ts`）

```ts
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: () => import("./pages/ChatPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/chat" },
  ],
});
```

当前是**单页单 Agent**：`/` 直接跳 `/chat`，未知路径兜底回 `/chat`。要支撑「门户 + 多个领域 Agent」需引入新路由与新页面。

### 8.2 目标路由结构（推荐）

```ts
routes: [
  { path: "/",          component: () => import("./pages/PortalPage.vue") },        // 门户 Agent：统一入口/枢纽
  { path: "/chat",      component: () => import("./pages/ChatPage.vue") },          // 通用 Agent（现有）
  { path: "/movie",     component: () => import("./pages/MovieChatPage.vue") },     // 观影助手（新页面，role=movie）
  { path: "/:pathMatch(.*)*", redirect: "/" },
]
```

- **门户 Agent 页面（`PortalPage.vue`）**：应用根路由 `/` 的落地页，作为所有 Agent 的统一入口/枢纽。
- **观影助手页面（`MovieChatPage.vue`）**：独立路由 `/movie`，通过 `role`/`agentId` 配置后端走第 2 章「模式 B」（同一引擎、按角色选 prompt/skills/MCP），无需另起部署。

### 8.3 门户 Agent 页面设计

两种常见形态，按产品取舍：

- **枢纽型（推荐起步）**：门户展示 Agent 卡片列表（通用助手、观影助手…），每张卡含名称/简介/图标与「开始对话」→ 跳对应路由。结构清晰、易扩展新 Agent。
- **内嵌型**：门户本身就是默认通用 Agent，顶栏带 Agent 切换器，一键跳到观影助手等。适合 Agent 数量少、希望首屏即可聊的场景。

移动端衔接（对接第 7 章）：Agent 切换用**底部导航栏（bottom nav）**而非侧栏 `display:none`；门户卡片在窄屏纵向堆叠。

### 8.4 新页面实现最佳实践

- **抽离共享聊天组件，禁止复制整页**：`ChatPage.vue` 实测 **≈98KB**（99,774 字节 / 3,400+ 行；线程/流式/工具步骤/确认卡/输入区）。应把聊天内核抽成可复用 `ChatView.vue`（或 `useChat` composable），`ChatPage` 与 `MovieChatPage` 都挂载 `<ChatView :agentId="..." />`，仅传 `role` 差异，避免逻辑分叉与回归风险。
- **页面只负责"配置角色"，不改引擎**：新页面把 `agentId`/`role` 透传给后端 `buildSystemPrompt({ role })`（第 2 章模式 B）；后端按角色选 `prompt / skills / MCP`。若后端暂不支持 `role` 参数，前端页面也应只设"角色标识"，由后端补齐，而不是在前端硬编码角色逻辑。
- **会话按 agentId 隔离（关键）**：当前后端会话是「每 cookie 单线条」（见 infra 第 9 章 ❌）。多个 Agent 页面若共享同一会话，切换 Agent 会串上下文。须在会话 key 里带上 `agentId`（如 `sessionKey = cookie + agentId`），或在侧栏/门户里按 Agent 分组会话列表。把"按 Agent 隔离"作为验收项。
- **资源懒加载**：路由用 `() => import(...)` 动态加载，门户首屏不加载观影页重量逻辑。

### 8.5 验收口径（路由/页面）

- `/` 为门户，能进入 `/chat` 与 `/movie`；未知路径兜底回门户。
- `/movie` 与 `/chat` 行为独立：观影页只命中观影 skill/MCP，通用页行为不变（回归金样全绿）。
- 两个 Agent 的会话互不串台（按 agentId 隔离）。
- 移动端 Agent 切换走底部导航，可达且单手可操作。

### 8.6 反模式补充

| 反模式 | 后果 | 正解 |
|---|---|---|
| 复制整页 `ChatPage` 做观影页 | ≈98KB 逻辑分叉、改一处漏一处 | 抽 `ChatView` 组件，页面只传 `role` |
| 多 Agent 共享同一会话 | 切 Agent 串上下文、答案错乱 | 会话 key 带 `agentId` 隔离 |
| 门户只做跳转、无状态/无入口 | 用户迷路 | 门户作为枢纽，含 Agent 卡片/切换器 |
| 移动端 Agent 切换藏在 `display:none` 侧栏 | 窄屏找不到入口 | 底部导航栏切换 Agent |

---

## 9. 会话按 Agent 隔离的落地（接 infra 第 9 章）

### 9.1 现状（实测 `apps/agent-server/src`）

- 会话标识：`session.ts` 的 `SESSION_COOKIE = "bx_agent_sid"`，文件持久化，只接受服务端签发的 UUID（防伪造串用）。
- 会话→对话：`conversations.ts` 的 `resolveConversation(session, conversationId?)`：显式 `conversationId` 用之（不存在则建），否则用 `session.activeConversationId`，并把结果写回该字段。
- 存储：`fs-store.ts` 落盘于 `.data/fs/<conversationId>/`。
- **结论**：当前是「每 cookie 单条活跃对话」，**对话模型没有 `agentId` 字段**。多 Agent 页面若共用同一 `activeConversationId`，切到 `/movie` 会把通用对话顶掉，或把观影回复写进通用历史。

### 9.2 落地方案（零迁移、向后兼容）

- 给 `Conversation` 模型加可选 `agentId`（默认 `"generic"`），**仅作元数据标签**；存储路径 `<conversationId>/` 已是唯一键，**不改路径、不迁移历史文件**。
- 活跃对话按 Agent 分槽：把单槽 `session.activeConversationId` 升级为 `session.activeConversationIdByAgent: Record<agentId, id>`（或等价映射）；`resolveConversation` 在传入 `agentId` 时从该槽取/存。
- **向后兼容关键**：旧对话无 `agentId` → 一律当 `"generic"`，且通用路径继续读写既有 `activeConversationId` 字段（保留旧字段作为 generic 槽）。现有通用历史**完全不受影响**，只有 movie 等新增 Agent 走新槽。
- 列表隔离：门户/侧栏按当前 `agentId` 过滤对话，从 UI 层杜绝跨 Agent 串台。

### 9.3 验收

- 通用用户回流：旧对话历史完整可见（key 未变）。
- `/chat` 与 `/movie` 各自维护独立活跃对话，切换不互顶、不混写。
- 删除/导出按 Agent 隔离（接 infra 第 9 章 保留策略）。

## 10. 观影助手评测金样集（接 infra 第 11 章）

### 10.1 项目评测现状

- 已有评测产出：`.data/eval-recall-accuracy-last.json`、`.data/eval-recall-x10-last.json`（近期运行结果）。
- 历史门禁脚本 `eval-core.mjs`（G1–G6）、`eval-trace-gate.mjs` 备份于 `.data/trash-20260916/code/scripts`（infra 第 11 章）。→ 可直接复用为观影助手金样门禁，无需从零造。

### 10.2 观影助手金样示例（按"执行结果"而非字符串比对）

| 用例 | 输入 | 期望行为（门禁） |
|---|---|---|
| 选片推荐 | "推荐一部诺兰的科幻片" | 命中 `观影助手` skill + 调用观影 MCP（如 `search_movie`）；返回真实片名/年份，不编造 |
| 影评解读 | "用一句话点评《盗梦空间》结局" | 命中 skill；引用来源，不杜撰情节 |
| 排片查询 | "今天北京有哪些电影上映" | 调用排片/场次工具，返回真实数据 |
| 跨域软约束 | "帮我写一段 Python 爬虫" | 不越域执行；说明不擅长并引导回电影话题 |
| 来源合规 | 任意观影问答 | 注明数据来自哪次工具调用（呼应 `BASE_PROMPT` 守则） |

### 10.3 门禁要点（呼应 infra 第 11 章"诚实信号"）

- **不仅比对最终文本**：加「是否调用了期望 skill / 工具」门禁，防止模型短路直答骗过"流程收束"检查（假绿）。
- **回归门禁**：通用 Agent 金样必须全绿，作为"改造未影响现有功能"的客观证据（接第 8 章影响评估）。改 `BASE_PROMPT`/加 `role` 后先跑通用金样，再跑观影金样。
- **覆盖率**：金样应覆盖各 skill（推荐/影评/排片/对比）与越域场景。

### 10.4 验收

- 改 prompt/加 role 后，通用金样全绿（零漂移）。
- 观影金样中"应调用工具"的用例，门禁拦下了直答（假绿视为失败）。

---

## 11. 集成点核查结论（实测，供守门用）

本轮对「请求 → 会话 → prompt → 工具」全链路集成点逐一核实（均基于 `apps/agent-server/src` 真实代码）：

| 集成点 | 实测位置 | 结论 |
|---|---|---|
| 请求体解析 | `app.ts:79` `readJson = c.req.json<T>().catch(() => ({}))` | 宽松解析、无严格 schema 校验；新增 `role`/`agentId` 字段不会被拒绝，纯加性 |
| prompt 构建入口 | `chat.ts:860` `buildSystemPrompt({ locale, summary, tooling, todos })` | 当前不传 `role`；加参向后兼容；`renderSkillIndex()` 无参调用且确在稳定前缀（`system-prompt.ts:168`，cache 命中对象）内 → 印证第 2 章「按 role 过滤 skill」为必需 |
| 会话解析调用方 | `resolveConversation` 仅 `app.ts:185`(mcp put)、`app.ts:235`(stream)（定义 `conversations.ts:358`） | 改会话模型影响面局部；子代理走 `chat.ts:874` `runLoop(subCtx)`（定义 `chat.ts:407`），独立上下文、不调用它 |
| 按会话 MCP 启用 | `conversation.mcpServers` 真实字段，`app.ts:194` 持久化 | 观影 MCP 仅在该会话启用，不泄漏通用会话 |
| 活跃对话向后兼容 | `session.activeConversationId` 读取点 `conversations.ts:365` / `app.ts:173,239` | 保留为 generic 槽；新 Agent 用 `activeConversationIdByAgent` 映射，旧对话不受影响 |

**唯一阻断项**：skill 索引全局加载（`skills.ts` 的 `listSkills()` 不过滤角色）→ 已在第 2 章标注为必需代码改动（`renderSkillIndex(role)`）。

**部署侧小项（非功能破坏）**：SPA 用 `createWebHistory()`，新增 `/movie` 直链需静态服务器 fallback 到 `index.html`（与现有 `/chat` 同模式，部署时确认即可）。

**守门清单（满足则当前功能不受影响）**：① 不裸改 `BASE_PROMPT`；② `renderSkillIndex` 按 `role` 过滤；③ `ChatView` 薄封装 + 回归金样；④ 会话 key 对 generic 向后兼容。

---

---

## 12. 多端接入架构（H5 / PC / Android / iOS）

> 背景：观影助手后期要进 App，覆盖 **H5（移动网页）、PC Web、Android、iOS** 四种端。本章回答「同一套观影能力如何在四端复用，且角色逻辑不重复实现」。

### 12.1 核心原则：区分逻辑只在后端，客户端只是"不同皮肤的同一个调用方"

- 第 2 章的 `role`/`agentId` 是一个**请求字段、与传输无关**——web、H5、Android、iOS 发的都是同一个 `/chat/stream`，只是 `role` 取值不同。
- 观影助手的本质 = **「后端 `movie` role 配置 + 任意前端壳」**。四端不是"四套实现"，而是"四套壳调同一 API"。
- 推论：角色表（`prompt / skills / MCP` 注册表）**只维护在后端一份**（第 2 章模式 B 的 role registry）。任何端都不要自己实现"这是观影、那是通用"的判断——那会退化为第 16 章反模式。

### 12.2 四种端各自的接法（统一入口 = `agent-server` 的 `/chat/stream`）

| 端 | 接法 | 复用内容 |
|---|---|---|
| **PC Web** | `apps/web`：`/chat` 通用 + `/movie` 观影路由 + 桌面双栏（第 7/8 章已覆盖） | `ChatView` 组件 + 后端 role |
| **H5（移动网页）** | 第 7 章移动端优先规范；`/movie` 做成单栏抽屉版，**可直接被原生 App 的 WebView 加载** | 同上，移动端 UI 即 H5 |
| **Android / iOS（方案 A：快）** | WebView 加载 H5 观影页（复用第 7 章移动端 UI），无需原生重写聊天 | H5 全量复用 |
| **Android / iOS（方案 B：体验最好）** | 原生 UI 直接调 `/chat/stream`（`role=movie`）；原生用 OkHttp `ResponseBody.source()` 逐行读 / URLSession `URLSessionDataDelegate` 增量收 **NDJSON chunked 流**；写确认卡由原生渲染成原生 Alert/Sheet | 后端 role + 协议，UI 原生 |

- **选 A 还是 B**：要快上线用 A（WebView 嵌 H5）；要原生体验（流畅流式、原生弹窗、系统推送）用 B，或"关键页原生 + 长尾页 WebView"混合。
- ✅ **好消息（已实测）**：client ↔ agent-server 的对话流**本来就是 HTTP Streamable（NDJSON，`Content-Type: application/x-ndjson`，chunked 分块）**，不是 SSE——后端 `app.ts:466` 的 `streamNdjson` 明确注释「不用 SSE，因 vite dev 代理会缓冲」，前端 `api.ts:82` 用 `fetch` + `res.body.getReader()` 逐行解析。MCP 侧同样是现代传输（`hub.ts:100` `StreamableHTTPClientTransport`）。因此 **H5/WebView 与原生端天然不存在 `EventSource` 兼容问题，无需为多端另做传输适配**。（注：**上游模型网关仍是 SSE**——`models.ts:255` `/v1/messages`、`models.ts:465` `/chat/completions` 是**第三方协议，由提供方决定，无法改为 NDJSON**；服务端已做 SSE→NDJSON 转换，且对不支持流式的网关有整包 JSON 回退，客户端全程无感。）
- ⚠️ **真正要守的流式注意点：别让链路上任何环节缓冲 chunked**。NDJSON 依赖 `Transfer-Encoding: chunked` 逐块下发，一旦被缓冲就会退化成"等全量再一次性显示"：
  - 生产反向代理（nginx）对该路径设 `proxy_buffering off;`（或返回 `X-Accel-Buffering: no`），并**关闭 gzip 响应缓冲**；
  - 云网关 / CDN 同理，确认未开启响应缓冲。
  - 这与服务端当初主动避开 SSE 是**同一个原因**，在多端生产部署上同样成立（客户端不是问题，中间链路才是）。

### 12.3 跨端必须统一的契约（避免每端各写一套）

1. **认证（必须先「新增」，不是复用）**：实测全仓 **无任何用户身份机制**（`x-user-id|userId|user_id` 搜索 0 命中），当前仅匿名 cookie 会话（`bx_agent_sid`，`session.ts:54`）。原生端不能依赖匿名 cookie → **多端接入的前置项是先补一套身份认证（token/JWT）**，并把「会话归属 / 写确认授权 / 审计」挂到该身份上（对应 infra 第 5 章 ❌ 缺口）。
2. **`role`/`agentId` 字段**：所有端请求体一致（第 2 章）。
3. **写确认卡协议**：后端返回 `requireConfirm`（现有 `confirm.ts`）→ 各端各自渲染（Web 用 `.confirm-card`、原生用原生弹窗），**但协议字段一致**，策略在服务端。
4. **会话隔离**：会话 key 带 `agentId`（第 9 章），**跨端通用**——用户在手机上聊过的观影会话，回到 PC 仍是同一 movie 会话（前提是后端会话共享，非纯本地）。
5. **MCP 凭据**：只返回键名、凭据留服务端（第 4 章反模式「凭据不写前端」跨端同样适用）。
6. **结果收件箱 / 推送（接 infra 第 14 章缺口）**：原生端用 **FCM / APNs** 推送观影结果（如"已为你找到 X 部诺兰电影"）；H5/PC 复用现有 **HTTP Streamable / NDJSON** 通道下发或轮询拉取（无需另引入 SSE/WebSocket）。

### 12.4 各端特有注意点

- **iOS**：`WKWebView` 配置 `allowsInlineMediaPlayback`；ATS 要求后端 HTTPS；通用链接 `https://host/movie` 做深链；安全区原生用 `additionalSafeAreaInsets`（H5 用 `safe-area-inset`，见第 7 章）。
- **Android**：深链 `app://movie` 或 `https://host/movie`；`allowBackup=false` 避免 token 落盘；混合内容（HTTP 资源）需显式允许或全 HTTPS。
- **H5 / 移动 web**：第 7 章全部要点（抽屉、44px 触控、safe-area、a11y、`aria-live`）。
- **PC Web**：桌面多栏 + 门户 `/` + 路由（第 8 章）。

### 12.5 验收口径（多端）

- 同一 `role=movie` 请求，PC / H5 / Android / iOS 四端返回的**能力一致**（命中同一 movie skill / MCP 集，不因客户端而漂移）。
- 原生端写确认流程走**原生弹窗且协议字段与 Web 一致**。
- 跨端会话按 `agentId` 隔离、互不串台；同一 movie 会话在多端可见（若启用后端会话共享）。
- 原生端推送 / 结果收件箱接通信（若启用）。

### 12.6 反模式补充（多端）

| 反模式 | 后果 | 正解 |
|---|---|---|
| 每端各写一套角色 / prompt 判断 | 维护灾难、四端行为分裂 | 角色表只在后端维护一份（role registry） |
| 原生 App 把"电影关键词"硬编码进端侧 | 与第 16 章同错，且无法热更 | 角色判断后端做，端侧只传 `role` |
| 误以为客户端用 `EventSource`/SSE，为多端另做传输适配 | 白做工、引入多余方案 | 实测对话流已是 HTTP Streamable/NDJSON + `fetch` 流式（`app.ts:466`、`api.ts:82`），直接复用 |
| 生产反代 / CDN 缓冲 chunked 响应 | 流式退化为整包、体验像卡死 | `proxy_buffering off` / `X-Accel-Buffering: no`，关闭 gzip 缓冲 |
| 原生端沿用匿名 cookie | 无用户身份、会话无法跨端、无法审计 | 先**新增** token/JWT 身份体系（当前项目尚无，需新建而非复用） |

---

> 一句话：**现有 Agent 不会被影响——它只是同一引擎下的一个配置变体；观影助手是另一个变体，两者可共存、可切换、可独立回滚。前端需把 ≤860px 的 `display:none` 侧栏改为抽屉；用「门户页 `/` + 观影新路由 `/movie`（复用 `ChatView`、按 agentId 隔离会话）」构成多 Agent 移动端结构；并以「会话按 agentId 分槽（旧对话向后兼容）+ 复用项目评测底座挂观影金样门禁」守住两个中风险点。全链路集成点已实测核实为安全，唯一必需代码改动是 `renderSkillIndex(role)` 按角色过滤 skill 索引。观影助手进 App（H5 / PC / Android / iOS）时，角色区分仍只在后端 `role` 字段，四端只是同一 API 的不同壳，契约（认证 / role / 写确认协议 / 会话隔离 / 凭据）统一；客户端对话流本就是 **HTTP Streamable / NDJSON**（非 SSE，`app.ts:466` + `api.ts:82`），四端可直接复用、无需传输层适配，生产只需确保反代 / CDN **不缓冲 chunked**，原生端再接系统推送即可。**
