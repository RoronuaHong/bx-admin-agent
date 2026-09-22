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
| 角色定义（稳定前缀） | `apps/agent-server/src/system-prompt.ts` 的 `SAFETY_GUARDRAIL` + `BASE_PROMPT`/`buildSystemPrompt()` + `src/roles.ts` 的 `MOVIE_BASE_PROMPT` | 🟢 全局安全护栏 + 按角色人设/技能/MCP；安全策略见 `docs/movie-safety-policy.md` |
| 能力插件 | `apps/agent-server/skills/<name>/SKILL.md` | ✅ 已有机制（`metric-caliber-check` 为样例），frontmatter 只载 `name/description`，模型命中后加载全文 |
| 工具接入 | 两路来源：`.data/mcp-servers.json`（可写，用户增删改）+ `.env` 的 `MCP_BUILTIN_SERVERS`（随环境、不落盘，可带 `defaultEnabled`）；连接 `src/mcp/hub.ts` | ✅ 配置驱动、命名空间隔离、`mcp__<server>__<tool>`、连接失败不阻断主流程 |
| 内置工具（引擎自带） | `src/builtins.ts`：`fs_*` / `write_todos` / `task`（子代理）/ `read_skill` / `search_tools` / **`search_knowledge`+`knowledge_sources`（知识库）** | ✅ 2026-09-17 增补后两项 —— 观影助手可把**影评/影片资料/运营文档**入本地库直接检索，无需为它单造工具 |
| 子代理（委派） | `chat.ts` `task` 工具 + `subagent_start/delta/end` 事件 + 独立取消端点 | ✅ 2026-09-17 落地 —— 观影场景「多片源并行查 + 主对话只拿结论」天然适配 |
| 写操作闸门 | 配置 `mcp/config.ts` 的 `requireConfirm` → 判定 `mcp/hub.ts` → 挂起/应答 `src/confirm.ts`（`waitForConfirmation`/`answerConfirmation`，超时默认 120s 按拒绝）→ 端点 `app.ts` `/chat/confirm` | ✅ 二次确认 + 超时按拒绝处理 |
| 越权 / 归属守卫 | `src/owner.ts` 设备 owner cookie + 对话 `ownerKey` + 按 id 端点守卫（他人/不存在统一 404） | 🟡 轻量归属隔离（方案 A，trust 域内防串台）；真登录/租户（方案 B）未做 |
| 审计留痕 | `src/audit.ts`（append-only JSONL，与 trace 用 runId 关联） | ✅ 已有（confirm_request / confirm_result / reject / gate） |
| Prompt 注入防护 | `src/untrusted.ts`（外部内容 nonce 定界 + 不可见控制符清洗 + 系统提示稳定前缀协议） | ✅ 2026-09-17 已落地（见 infra 第 5 章） |

关键推论：换角色 = 换 `BASE_PROMPT` + 对应 `skills/` + 对应 MCP 配置，**三处全在引擎之外**。

---

## 2. 三种适配模式（共存 vs 切换）

### 模式 A：部署配置共存（推荐起步）

同一份引擎代码，跑两个部署，各自一份配置：

- **部署 A（通用）**：`BASE_PROMPT`=通用 AI 助手 + 通用 `skills/` + 通用 MCP。
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
- 通用型技能（如 `schema-probe` 陌生库探查、`metric-caliber-check` 指标口径核对、`chart-visualization` 图表可视化）**不写 `roles:` 即对所有角色可见**；只有领域专属技能才用 `roles: movie` 收窄（`renderSkillIndex(role)` 已按角色过滤）。判断标准：流程里是否出现具体业务词——有业务词就该收窄，没有就保持通用。

### M1 工具接入（MCP 配置）
- 在 `mcp-servers.json` 加观影数据源（TMDB / 豆瓣 / 猫眼）。
- 命名空间 `mcp__<serverId>__<tool>` 自动隔离，不影响通用工具；连接失败只记状态、不阻断对话。

### M2 可信（复用 infra 第 10–11 章）
- Trace + 评测门禁：观影金样集（如「推荐一部诺兰的科幻片」应命中推荐 skill 并调用观影 MCP）。
- 防短路：门禁检查「是否调用了期望 skill / 工具」，而非只比对最终文本（避免模型直答骗过门禁）。
- 数据类领域额外建议：把验证过的口径固化为**已保存的查询 / 金样 SQL**，别每次靠现场探查——否则同一问题不可复现、不可回归（判据与做法见 `docs/mcp-guide.md` §10「陌生库取证」的挂账表）。

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

**当前进度（2026-09-17）：M0/M1 已落地，门户已上线** —— 已交付：①门户页 `/`（Agent 卡片 → `/chat`、`/movie`）；②`src/roles.ts` 角色注册表（generic + movie，人设 / 角色默认 MCP）；③`renderSkillIndex(role)` 按角色过滤（skill frontmatter `roles:`）+ 观影示例 skill `skills/movie/`；④会话按 `agentId` 分槽（`conversation.agentId` + `session.activeByAgent`，列表按角色过滤，旧数据归 generic）；⑤观影数据源为 **TMDb**（`.env` 的 `MCP_BUILTIN_SERVERS` 里 movie 项：公共托管 MCP + `tools` 白名单放行全部 21 个只读工具（电影 + 剧集 + 榜单/多源评分等）；2026-09-18 由豆瓣换源，原自编示例数据源与豆瓣管线已删除）；⑥前端 `agents.ts` 镜像清单 + `PortalPage.vue` 门户 Agent 卡片 + `ChatPage` 输入框工具菜单「专家」项（**2026-09-20 更新：原 `ChatPage` 顶栏 `ExpertSelect.vue` 专家选择器改为输入框「+」工具菜单项，列出除观影助手、通用助手外的其他专家**；观影助手属独立项目走 `/movie`；`agents.ts` 仍为门户卡片与专家面板的展示数据源）——前端零角色判断，分流只在后端 `roles.ts`。端到端：`_movie-e2e.mjs` PASS（2026-09-18）——「推荐一部科幻片」→ `mcp__movie__movies_search` / `movies_details` → 按 TMDb 真实数据作答（中文标题/简介/评分），工具不可用时如实说明不编造；回归 `_role-check.mjs` 7/7（角色表 / 分槽 / 未知角色 400 / 技能过滤 / 活跃槽不互顶）。**（2026-09-18 复核：KB 按角色隔离 #4 落地后重跑 `_role-check.mjs` 7/7、`_movie-e2e.mjs` PASS，示例观影链路未被破坏。）** #5 身份 / #6 真实片源为**暂缓项**（当前仅单端 Web、且暂无真实片源凭证，示例数据源已可端到端验证角色链路；二者待多端接入 / 真实片源接入时再补，期间代码不引用不存在的资源）。剩余前置：

| # | 前置项 | 出处 | 状态 |
|---|---|---|---|
| 1 | `renderSkillIndex(role)` 按角色过滤 skill 索引（稳定前缀，不过滤会击穿 prompt cache） | 第 2 章 / 第 11 章 | ✅ 已落地 |
| 2 | 移动端侧栏抽屉（≤860px 侧栏原 `display:none` → 移动端两个 Agent 都没有会话入口） | 第 7.1 章 | ✅ 已修复为离屏抽屉（汉堡 + 遮罩 + Esc + 选中收起） |
| 3 | 会话按 `agentId` 分槽（否则 `/movie` 与 `/chat` 会互相顶掉活跃对话） | 第 9 章 | ✅ 已落地 |
| 4 | 知识库语料按角色隔离（否则观影语料对通用助手可见） | 第 13 章 | ✅ 已落地（`rag/store.ts` 按 `namespace` 过滤 + 检索透传角色；`build-rag-index.mjs --namespace` 入库） |
| 5 | 身份认证（仅多端接入/分享场景必需；单端 Web 可后置） | 第 12.3 章 | ⏸ 暂缓：全仓无身份机制，当前仅单端 Web 不需；多端接入时再补（观影链路不引用） |
| 6 | 观影片源接真实数据 | 第 3 章 M1 | ✅ 已接 **TMDb**（2026-09-18 由豆瓣换源）：公共托管 MCP，`transport:"http"` + `url`，配置在 `.env` 的 `MCP_BUILTIN_SERVERS`，`tools` 白名单放行 `movies_search / movies_details / movies_reviews / movies_similar / movies_trending / movies_discover`；零 key、无风控，各工具都支持 `language=zh-CN` 取中文。想直连 TMDb（`npx -y tmdb-mcp`，31 工具）只需补 `TMDB_API_TOKEN`（步骤见 `.env` 注释） |

## 7. 前端：移动端优先（实测现状 + 最佳实践）

### 7.1 实测现状（本项目 `apps/web/`）

- 布局：`<div class="chat">` = `<aside class="sidebar">`（会话列表 + 新建/删除，**实测 256px**，`ChatPage.vue:3826` 的 `.sidebar`）+ `<main class="main">`（顶栏 + 线程 + 输入区），**桌面多栏**。
- 窄屏断点（`ChatPage.vue` 末尾）：
  ```css
  @media (max-width: 860px) { .sidebar { display: none; } }
  @media (max-width: 720px) { .model-tag { display: none; } }
  ```
- **问题确认（2026-09-18 已修复）**：原 ≤860px 侧栏 `display:none` 已改为**离屏抽屉**——汉堡按钮（顶栏，仅 ≤860px 显示）切换、`.sidebar.open` 滑入、遮罩点击 / Esc 关闭、选中会话自动收起（`ChatPage.vue` 末尾 `@media (max-width: 860px)`）。这消除了 `agent-infrastructure.md` 第 14、16 章标注的 ❌ 反模式（"侧栏在窄屏直接 `display:none` → 移动端丢功能入口"），移动端两个 Agent 现在都有会话入口。
- 已具备的良好基础：`styles.css` 定义了 `--safe-bottom: env(safe-area-inset-bottom)`，且**已用于输入区**（`ChatPage.vue:6665` 的 `.composer`：`padding: 12px clamp(12px, 3vw, 28px) calc(12px + var(--safe-bottom))`）、`touch-action: manipulation`、`:focus-visible` 焦点环、`prefers-reduced-motion`；`mcp-panel` 有 `max-width: calc(100vw - 32px)`（`ChatPage.vue:5228`）；写操作确认卡（`.confirm-card`，模板 `ChatPage.vue:3381` / 样式 `:5959`）已存在。
- 其他缺口（对接 infra 第 14 章，**2026-09-17 复核**）：❌ 重新生成/编辑重发、❌ 会话搜索与分组、❌ a11y 审计（live region/焦点/对比度）、❌ 未读/结果收件箱（**部分缓解**：已有「后台任务完成」提醒，但非收件箱形态）。
- 已补齐的相关项（`conversation-list-ux-plan.md`）：✅ 会话项键盘可达（↑↓ 焦点 / F2 重命名 / `Alt+↑↓` 排序）、✅ 拖拽排序、✅ 归档 / 复制 / 导出（MD+JSON）、✅ 免打扰、✅ 延迟删除 + 5s 撤销。这些**不影响**本指南结论，但做观影页（`ChatView` 复用）时无需重做。

### 7.2 移动端最佳实践（对齐 infra 第 14 章 + 通用规范）

**布局**
- 移动端用**抽屉式侧栏**（覆盖层滑出 / 从左侧推入），不要 `display:none`；桌面保持多栏常驻。
- 单列布局：顶栏（`品牌 + 汉堡 + 模型选择 + 语言/主题`）→ 线程 → 底部输入区，纵向堆叠。（**顶栏已无 MCP 按钮**：连接器入口自 2026-09-17 起在输入框左下角「＋」工具菜单里，见 `mcp-guide.md` §9。）
- 断点建议：`>860px` 双栏；`≤860px` 单栏 + 抽屉；`≤720px` 顶栏精简（`model-tag` 可隐藏，但**会话入口必须保留**为汉堡）。

**交互与触控**
- 触摸目标 ≥ 44×44px（汉堡、发送、确认/拒绝按钮）。
- 底部输入区适配安全区：`padding-bottom: calc(12px + var(--safe-bottom))`，避免被 Home 指示条遮挡（✅ **本项目已实现**，见 `ChatPage.vue:6665` 的 `.composer`；改版时勿回退）。
- 写操作确认卡窄屏**全宽、按钮纵向堆叠且够大**，拒绝/确认同等醒目。
- 工具步骤（`reasoning` / `steps`）默认折叠，展开不占满整屏；长结果可滚动而非撑高。

**可访问性（a11y）**
- 流式内容用 `aria-live="polite"` 播报；抽屉打开时 `role="dialog"` + `aria-modal`，焦点 trapped、Esc 关闭、点遮罩关闭、关闭后焦点回到汉堡。
- 状态不只靠颜色（现状已做：状态点带 `title`/`aria-label`、任务标记用字形 ✓/•/○/×）。
- 对比度达标（**2026-09-18 实测**：`/chat` 停止按钮字色跟随主题 `var(--panel)` —— 深色 `#131312` on `#f2b386` = 10.2:1、浅色 `#fcfcf9` on `#c25c2c` = 4.2:1；**勿写死 `#fff`**，深色下只有约 1.8:1）；键盘可完成"输入→发送→停止→确认"全流程。

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
| 输入区不接 `safe-area-inset`（本项目已达标，改版勿回退） | 被 Home 条遮挡 | `padding-bottom: calc(... + var(--safe-bottom))`；实测 `ChatPage.vue:6665`（`.composer`）已如此 |
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

### 8.2 目标路由结构（✅ 已落地，2026-09-17）

```ts
// apps/web/src/router.ts（2026-09-18 复核，与代码逐行一致）
routes: [
  { path: "/",      component: () => import("./pages/PortalPage.vue") },  // 门户（Agent 卡片）
  { path: "/chat",  component: ChatPage },                                 // 通用 Agent
  { path: "/movie", component: MoviePage },                                // 观影助手（独立页）
  { path: "/:pathMatch(.*)*", redirect: "/" },
]
```

> 落地取舍（**2026-09-18 修订**）：早期方案是 `/movie` 与 `/chat` 共用 `ChatPage` + 路由 props 注入 `agentId`；**现已改为独立页面 `MoviePage.vue`**（只保留对话框 + 输入框，无侧栏 / 模型选择器 / 工具菜单，理由与验收见 `movie-mobile-ui-plan.md`）。共用的是**底层能力**（`api.ts` 的流式与会话接口、markdown/表格渲染、`UiLocaleSelect` / `ThemeToggle`），而 `agentId="movie"` 仍随每个会话级请求上行、由服务端按角色分流；跨 Agent 导航经门户中转（组件卸载重挂，天然隔离运行时状态）。

- **门户 Agent 页面（`PortalPage.vue`）**：应用根路由 `/` 的落地页，作为所有 Agent 的统一入口/枢纽。
- **观影助手页面（`MoviePage.vue`；2026-09-18 复核改名，早期设计叫 `MovieChatPage.vue`）**：独立路由 `/movie`，通过 `agentId="movie"` 让后端走第 2 章「模式 B」（同一引擎、按角色选 prompt/skills/MCP），无需另起部署。

### 8.3 门户 Agent 页面设计（✅ 已落地，2026-09-19）

两种形态：原本的「顶栏专家选择器」于 **2026-09-20 改为「输入框工具菜单（`+`）里的「专家」项」**——二级面板列出**除观影助手外的其他专家**（观影助手属独立项目、走 `/movie`），选中即 `router.push(agent.path)` 跳对应角色页；门户 `PortalPage.vue` 仍是跨 Agent 的主入口：

- **枢纽型（门户 `/`，`PortalPage.vue`）**：根路由展示 Agent 卡片列表（通用助手、观影助手、客服助手…），每张卡含图标 / 名称 / 简介（四语）与「开始对话」→ 跳对应路由（`agent.path`）。结构清晰、易扩展新 Agent。
- **内嵌型（输入框工具菜单「专家」项，`ChatPage.vue` 的 `tools-menu` / `tools-flyout`）**：`ChatPage` 输入框左侧「+」工具菜单新增「专家」行，点开二级面板列出**除观影助手、通用助手外的其他专家**（观影助手属独立项目 `/movie`、通用助手是默认形态，两者都不进专家列表）；选中即 `router.push(agent.path)` 跳到该角色的路由。**切专家 = 跳路由**，会话按 `agentId` 分槽互不串台（不做单页内人设热切换）。组件 `ExpertSelect.vue` 保留在仓内但当前未被引用（入口改为内联实现）。**（2026-09-20 由顶栏选择器改为工具菜单项。）**

**术语对齐（= CodeBuddy/WorkBuddy「专家」）**：本项目的「专家」即 CodeBuddy **专家中心**（左侧栏「专家」）里的**专家（Agent 型）**——每位专家有独立人设、方法论与工具链，召唤后把通用助手切换为该领域角色（"召唤谁就像请到那个岗位的资深从业者"）。注意 CodeBuddy **没有名为「专家模式」的独立 mode**（其模式是 Ask / Craft / Plan / Agent）；「专家」是专家中心里的一类**领域角色 / Agent**，属 Agent 能力的领域化封装。对照之下：通用助手（`generic`）是**默认 / 未切换**形态、**不算专家**（对应专家中心未切换时的通用视角），观影助手、客服助手等才是真正的专家（这也正是上一轮把 `generic` 移出「专家」菜单的依据）。三层关系与 CodeBuddy 一致——`Skill（技能）= 工具能力` → `专家（Agent 型）= 能力 + 经验（封装了技能与领域人设的独立 Agent）` → `专家团（Team 型）= 多专家 + 协作流程`（本项目暂未实现专家团，门户 / 工具菜单的「专家」目前只列单 Agent 型专家）。`PortalPage` 即「专家中心」式的浏览 / 召唤入口，`ChatPage`「+」菜单的「专家」项即「切换专业角色」；专家 `id` 语义化、全局唯一，对应 CodeBuddy 专家的「专家标识」。

**前端镜像清单（`apps/web/src/agents.ts`）**：角色展示信息（`id` / `path` / `label` / `description` / `icon`，文案四语 `zh`/`en`/`pt-BR`/`hi`）的**唯一前端真相源**，与服务端 `src/roles.ts` 一一对应（`id` 必须两端一致）。新增 Agent：服务端 `roles.ts` 加角色 → 前端 `agents.ts` 加一条镜像（`id` 相同）。**前端不允许自行实现角色判断**，只做展示与路由跳转（角色分流只在后端，呼应第 2 章模式 B 与第 12 章「端只是壳」）。

移动端衔接（对接第 7 章）：门户卡片在窄屏纵向堆叠；跨 Agent 切换统一走门户（`.brand__home`（⌂）回门户），与侧栏离屏抽屉并存；`ChatPage` 输入框「+」工具菜单的「专家」项在窄屏同样可达。

### 8.4 新页面实现最佳实践

- **抽离共享聊天组件，禁止复制整页**：`ChatPage.vue` 实测 **≈98KB**（99,774 字节 / 3,400+ 行；线程/流式/工具步骤/确认卡/输入区，2026-09-18 已增至约 230KB）。应把聊天内核抽成可复用 `ChatView.vue`（或 `useChat` composable），`ChatPage` 与 `MovieChatPage` 都挂载 `<ChatView :agentId="..." />`，仅传 `role` 差异，避免逻辑分叉与回归风险。**（2026-09-18 实际落地：未抽 `ChatView`——`/movie` 走独立 `MoviePage.vue`，只复用底层能力（`api.ts` 流式/会话接口、markdown/表格渲染、`UiLocaleSelect`/`ThemeToggle`），不复制页面级结构；本建议保留为「若要复用**页面级**布局」时的参考。）**
- **页面只负责"配置角色"，不改引擎**：新页面把 `agentId`/`role` 透传给后端 `buildSystemPrompt({ role })`（第 2 章模式 B）；后端按角色选 `prompt / skills / MCP`。若后端暂不支持 `role` 参数，前端页面也应只设"角色标识"，由后端补齐，而不是在前端硬编码角色逻辑。

> **（2026-09-19 实际落地）**：`router.ts` 直接挂载 `ChatPage` / `MoviePage`（**未用路由 props 注入 `agentId`**），各页组件内部写死自己的 `agentId`（`ChatPage`=`generic`、`MoviePage`=`movie`），再随每个会话级请求（`/chat/stream` 的 `agentId` 字段）上行，由服务端 `getRole(agentId)` 分流；不要误以为 `agentId` 经路由 props 传入。前端 `agents.ts` 镜像只描述「展示与跳哪」，角色真相只在 `roles.ts`。
- **会话按 agentId 隔离（关键）**：当前后端会话是「每 cookie 单线条」（见 infra 第 9 章 ❌）。多个 Agent 页面若共享同一会话，切换 Agent 会串上下文。须在会话 key 里带上 `agentId`（如 `sessionKey = cookie + agentId`），或在侧栏/门户里按 Agent 分组会话列表。把"按 Agent 隔离"作为验收项。
- **资源懒加载**：路由用 `() => import(...)` 动态加载，门户首屏不加载观影页重量逻辑。

### 8.5 验收口径（路由/页面）

- `/` 为门户，能进入 `/chat` 与 `/movie`；未知路径兜底回门户。
- `/movie` 与 `/chat` 行为独立：观影页只命中观影 skill/MCP，通用页行为不变（回归金样全绿）。
- 两个 Agent 的会话互不串台（按 agentId 隔离）。
- 移动端 Agent 切换走底部导航，可达且单手可操作。**（2026-09-18 实际落地：未采用底部导航**——改为「门户枢纽 + 侧栏回门户」：入口是 `PortalPage.vue` 的 Agent 卡片，`ChatPage.vue:2692` 的 `.brand__home`（⌂）回门户；移动端侧栏是离屏抽屉 + 汉堡入口。）
- 输入框工具菜单「专家」项（`ChatPage.vue`）：列出**除观影助手、通用助手外的其他专家**、键盘可达（Tab / Enter / Esc，焦点可见）、当前项高亮；选中跳对应路由且会话按 agentId 分槽、不串台。**（2026-09-20 由顶栏选择器改为工具菜单项，复用同一份 `agents.ts` 镜像数据源；观影助手、通用助手不在此列表。）**
- 前端 `agents.ts` 镜像与服务端 `roles.ts` 的 `id` 一一对应；新增 Agent 两端同步、前端不重复角色逻辑。

### 8.6 反模式补充

| 反模式 | 后果 | 正解 |
|---|---|---|
| 复制整页 `ChatPage` 做观影页 | ≈98KB 逻辑分叉、改一处漏一处 | 抽 `ChatView` 组件，页面只传 `role`。**（2026-09-18 实际落地：改成独立 `MoviePage.vue`——不复用页面级结构，只复用底层能力；见 `movie-mobile-ui-plan.md`。）** |
| 多 Agent 共享同一会话 | 切 Agent 串上下文、答案错乱 | 会话 key 带 `agentId` 隔离 |
| 门户只做跳转、无状态/无入口 | 用户迷路 | 门户作为枢纽，含 Agent 卡片/切换器 |
| 移动端 Agent 切换藏在 `display:none` 侧栏 | 窄屏找不到入口 | 底部导航栏切换 Agent（**2026-09-18 实际落地：侧栏改离屏抽屉 + 汉堡入口，Agent 切换走门户枢纽**） |

### 8.7 专家中心：对齐 CodeBuddy 的优化设计（2026-09-20）

> 目标：把本项目的多 Agent 门户 / 专家入口，对齐到 CodeBuddy/WorkBuddy 的「专家中心」模型（术语见 §8.3「术语对齐」）。2026-09-20 四项决策已落定并落地（见 §8.7.4），本文档同步记录最终设计。

#### 8.7.1 概念映射（CodeBuddy ↔ 本项目）

| CodeBuddy 概念 | 本项目对应 | 状态 |
|---|---|---|
| 专家中心（左侧栏「专家」入口，浏览 / 召唤专家） | `PortalPage.vue`：默认助手单独呈现 + 专家网格只列真·专家 + 「开始对话」 | ✅ 已落地（默认助手非专家卡；专家卡含图标 / 名称 / 简介四语 + 跳 `agent.path`） |
| 专家（Agent 型）：独立人设 + 方法论 + 工具链的领域角色 | `agents.ts` 中**非 generic、非 movie** 的条目（如 `support` 客服助手）；人设由后端 `roles.ts` 提供 | ✅ 已落地；`support` 后端角色已补（见 §8.7.4-Q3） |
| 通用助手（未切换专家时的默认形态，**非专家**） | `generic`（走 `/chat`，即 `ChatPage` 本身） | ✅ 已落地；已从「专家」菜单与门户专家网格排除，仅作默认态单独呈现 |
| 切换专业角色 | `ChatPage`「+」工具菜单「专家」项（二级面板列专家、跳 `agent.path`） | ✅ 已落地（排除 movie + generic） |
| 召唤专家 / 专家团 → 进入对话 | 点卡片「开始对话」/ 菜单项 → `router.push(agent.path)` | ✅ 已落地 |
| 技能（Skill = 工具能力） | 既有 `Skills` 系统（`.codebuddy/skills/`） | ✅ 已落地 |
| 专家标识（语义化、全局唯一，如 `frontend-expert`） | `agents.ts` 的 `id`（须与后端 `roles.ts` 一致） | ✅ 已落地 |
| 分类（专家按分类目录组织检索） | —— | 🗺️ 本次不加（见 8.7.4-Q2） |
| 专家团（Team 型：团长拆解、多专家并行、整合交付） | —— | 🗺️ 路线图（本次不做，见 8.7.4-Q4） |
| 企业自建 / 内置市场、权限控制 | —— | 🗺️ 路线图（本项目为单租户前端镜像，暂不涉及） |

#### 8.7.2 专家数据模型（对齐 CodeBuddy 专家字段）

`apps/web/src/agents.ts` 的 `AgentEntry` 当前字段：`id` / `path` / `label`(四语) / `description`(四语) / `icon`。对照 CodeBuddy 专家（标识、显示名称、分类、描述、头像、权限），建议：

- **保留**：`id`（= 专家标识，语义化、全局唯一）、`label`（= 显示名称，四语）、`description`（= 描述，四语）、`icon`（= 头像占位符）。
- **`category`（本次不加）**：对应 CodeBuddy 的「分类」，便于门户按领域分组浏览（如「办公 / 影音 / 客服」）。Q2 决策为暂不引入——门户暂以单列专家网格呈现，不按分类分组（见 8.7.4）。
- **人设（persona）/ 方法论 / 工具链**：**只在后端 `roles.ts`**，前端不持有（呼应「端只是壳」）。新增专家必须两端同步：`roles.ts` 加角色 → `agents.ts` 加镜像（`id` 一致）。

#### 8.7.3 已实现 vs 待优化（状态）

- ✅ 门户 = 专家中心形态：默认助手单独呈现，专家网格只列真·专家（卡片浏览 + 召唤）。
- ✅ 通用助手明确不算专家，不出现在「专家」菜单与门户专家网格，仅作默认态单独呈现。
- ✅ 专家入口在输入框「+」工具菜单，跳路由、会话按 `agentId` 分槽隔离。
- ✅ 四语文案、键盘可达（Tab / Enter / Esc，焦点可见）、当前项高亮。
- ✅ `support` 客服助手成为真·专家：前端路由（`/support`）+ 后端 `roles.ts` 角色（人设 / 服务守则）已补。
- 🗺️ 路线图：专家团（Team）、分类检索、企业权限。

#### 8.7.4 决策记录（2026-09-20 已决并落地）

- **Q1（门户剔除 generic 卡片）**：✅ 已决——`PortalPage` 不再把 `generic` 当「专家」卡片，改为默认态单独呈现（专家网格只列 movie / support 等真专家），对齐 CodeBuddy「专家中心不列默认助手」的最佳实践。
- **Q2（加 `category` 分类字段）**：❌ 暂不做——本次不加 `category`，门户以单列专家网格呈现，不按分类分组。
- **Q3（客服后端角色）**：✅ 已决——在 `apps/agent-server/src/roles.ts` 加 `support` 角色（`basePrompt` 客服人设 + 服务守则），复用通用工具能力，暂无专属 MCP/技能（需订单/工单系统时再补 `defaultMcpServers` + 强制工具开关）。
- **Q4（专家团范围）**：❌ 本次不做——专家团（Team 型）仅作路线图记录，暂不实现。

---

## 9. 会话按 Agent 隔离的落地（接 infra 第 9 章）

### 9.1 现状（实测 `apps/agent-server/src`）

- 会话标识：`session.ts` 的 `SESSION_COOKIE = "bx_agent_sid"`，文件持久化，只接受服务端签发的 UUID（防伪造串用）。
- 会话→对话：`conversations.ts` 的 `resolveConversation(session, conversationId?)`：显式 `conversationId` 用之（不存在则建），否则用 `session.activeConversationId`，并把结果写回该字段。
- 存储：`fs-store.ts` 落盘于 `.data/fs/<conversationId>/`。
- **结论（2026-09-17 当时实测）**：那时是「每 cookie 单条活跃对话」，**对话模型没有 `agentId` 字段**；多 Agent 页面共用同一 `activeConversationId` 会互相顶掉、串上下文。**（2026-09-18 对齐：该缺口已按 §9.2 落地——`conversation.agentId`（`conversations.ts:71-74`）+ 活跃对话按角色分槽 `session.activeByAgent`，列表按角色过滤；见下节与 §11 集成点表。）**

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
| 选片推荐 | "推荐一部诺兰的科幻片" | 命中 `观影助手` skill + 调用观影 MCP（如 `movies_search` / `movies_details`，带 `language=zh-CN`）；返回真实片名/年份/简介，不编造 |
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

| 集成点 | 实测位置（2026-09-17 复核；**2026-09-18 更新**，改动处已标注） | 结论 |
|---|---|---|
| 请求体解析 | `app.ts` `readJson = c.req.json<T>().catch(() => ({}))` | 宽松解析、无严格 schema 校验；新增 `role`/`agentId` 字段不会被拒绝，纯加性 |
| prompt 构建入口 | `chat.ts:1236` `buildSystemPrompt({ locale, summary, tooling, todos, enabledSkills, role, ownerKey })` | **（2026-09-18 更新：已传 `role: conversation?.agentId`，「当前不传 role」已过期）**。稳定前缀 = `SAFETY_GUARDRAIL` + `role.basePrompt`（缺省回退 `BASE_PROMPT`）+ `TOOLING_RULES` + `renderSkillIndex(role.id)`（`system-prompt.ts:210`）→ 第 2 章「按 role 过滤 skill」已落地 |
| skill 索引渲染 | `skills.ts:94` `renderSkillIndex(role?)`（**2026-09-18 更新：已支持按角色过滤**）+ `chat.ts` 注入 `enabledSkills` 到**动态**后缀 | 索引在稳定段（cache 命中对象）、勾选全文在动态段；「按角色过滤」已由 `system-prompt.ts:210` 传 `role.id` 落地，新增其它角色的 skill 不再互相击穿缓存 |
| 会话解析调用方 | `resolveConversation`（用于 mcp put / stream / context 等端点） | 改会话模型影响面局部；子代理走 `runLoop(subCtx)`，独立上下文、不调用它 |
| 按**对话** MCP 启用 | `conversation.mcpServers` 真实字段，`app.ts` `PUT /chat/mcp/servers` 内 `patchConversation(conversationId, { mcpServers })` 持久化；断开按 `listEnabledMcpServers()` **跨对话**引用计数 | 观影 MCP 仅在该对话启用，不泄漏通用对话 |
| 活跃对话向后兼容 | `session.activeConversationId` | 保留为 generic 槽；新 Agent 用 `activeConversationIdByAgent` 映射，旧对话不受影响 |
| 对话模型是否有 `agentId` | **（2026-09-18 更新：已有）** `conversations.ts:71-74` 的 `ConversationDoc.agentId?`（缺省 generic、旧数据兼容）；`listConversations(owner, includeArchived, agentId)` 按角色过滤 | 第 9 章「会话按 agentId 隔离」**已落地**（旧记录「全仓 0 命中」已过期） |
| 身份认证 | 全仓无 `x-user-id / userId` 等；仅匿名 cookie（`bx_agent_sid` `session.ts:69`、owner cookie `bx_agent_oid` `owner.ts:9`） | 第 12.3 章「多端接入前先补认证」仍是前置项 |
| 传输层 | `app.ts` `streamNdjson`（定义 `app.ts:958`，`/chat/stream` 调用 `app.ts:553`）；前端 `api.ts:114` `res.body.getReader()` 逐行解析 | NDJSON 非 SSE，多端可直接复用（详见第 12.2 章） |

**唯一阻断项（2026-09-17）**：skill 索引全局加载（`skills.ts` 的 `listSkills()` 不过滤角色）→ 已在第 2 章标注为必需代码改动（`renderSkillIndex(role)`）。

> **（2026-09-18 对齐：该阻断项已解除）** `renderSkillIndex(role?)` 已按角色过滤（`skills.ts:94`，内部走 `listSkillMetas(role)`），`system-prompt.ts:210` 传入 `role.id`；角色注册表见 `src/roles.ts`。

> **行号会漂移**：表中行号为复核当时值，若对不上请以符号名（`buildSystemPrompt` / `renderSkillIndex` / `resolveConversation` / `streamNdjson`）为准 —— 这些是稳定锚点。

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
- ✅ **好消息（已实测）**：client ↔ agent-server 的对话流**本来就是 HTTP Streamable（NDJSON，`Content-Type: application/x-ndjson`，chunked 分块）**，不是 SSE——后端 `app.ts:957` 的 `streamNdjson` 注释明确写着「不用 SSE，因 vite dev 代理会缓冲」，前端 `api.ts:98`（`streamChat` 的 `fetch`）+ `api.ts:114`（`res.body.getReader()`）逐行解析。MCP 侧同样是现代传输（`hub.ts:98` `StreamableHTTPClientTransport`（导入在 `hub.ts:9`））。因此 **H5/WebView 与原生端天然不存在 `EventSource` 兼容问题，无需为多端另做传输适配**。（注：**上游模型网关仍是 SSE**——`models.ts:256` `/v1/messages`、`models.ts:466` `/chat/completions` 是**第三方协议，由提供方决定，无法改为 NDJSON**；服务端已做 SSE→NDJSON 转换，且对不支持流式的网关有整包 JSON 回退，客户端全程无感。）
- ⚠️ **真正要守的流式注意点：别让链路上任何环节缓冲 chunked**。NDJSON 依赖 `Transfer-Encoding: chunked` 逐块下发，一旦被缓冲就会退化成"等全量再一次性显示"：
  - 生产反向代理（nginx）对该路径设 `proxy_buffering off;`（或返回 `X-Accel-Buffering: no`），并**关闭 gzip 响应缓冲**；
  - 云网关 / CDN 同理，确认未开启响应缓冲。
  - 这与服务端当初主动避开 SSE 是**同一个原因**，在多端生产部署上同样成立（客户端不是问题，中间链路才是）。

### 12.3 跨端必须统一的契约（避免每端各写一套）

1. **认证（必须先「新增」，不是复用）**：实测全仓 **无任何用户身份机制**（`x-user-id|userId|user_id` 搜索 0 命中），当前仅匿名 cookie 会话（`bx_agent_sid`，`session.ts:69`）。原生端不能依赖匿名 cookie → **多端接入的前置项是先补一套身份认证（token/JWT）**，并把「会话归属 / 写确认授权 / 审计」挂到该身份上（对应 infra 第 5 章 ❌ 缺口）。
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
| 误以为客户端用 `EventSource`/SSE，为多端另做传输适配 | 白做工、引入多余方案 | 实测对话流已是 HTTP Streamable/NDJSON + `fetch` 流式（`streamNdjson` `app.ts:958`、`api.ts:114` `getReader()`），直接复用 |
| 生产反代 / CDN 缓冲 chunked 响应 | 流式退化为整包、体验像卡死 | `proxy_buffering off` / `X-Accel-Buffering: no`，关闭 gzip 缓冲 |
| 原生端沿用匿名 cookie | 无用户身份、会话无法跨端、无法审计 | 先**新增** token/JWT 身份体系（当前项目尚无，需新建而非复用） |

---

## 13. 2026-09-17 通用能力升级：观影助手能直接复用什么、要注意什么

本轮引擎侧新增了四项通用能力。它们**都不是观影专属**，但会改变观影助手的落地方式与成本，故单列一章。

| 能力 | 对观影助手的复用 | 注意事项 |
|---|---|---|
| **本地知识库检索**（`search_knowledge` / `knowledge_sources`，语料 `docs/knowledge/**`，`build-rag-index.mjs --namespace` 指纹增量入库） | 影评合集、影片资料、运营规则、宣发口径可直接入库检索，**不必为每个数据源造 MCP 工具**；结果带 `source` 便于「注明来源」守则落地 | ✅ **已按角色隔离（`namespace`）**：`rag/store.ts` 的 `search` / `listSources` / `sourceHashes` / `ingest` 均按 `namespace` 过滤，检索由 `chat.ts` 按当前会话角色（`conversation.agentId`，默认 `generic`）透传；观影语料用 `--namespace movie` 入库后，对通用助手不可见、反之同理。历史未打标文档兜底归 `generic`（向后兼容，无需重建即生效）。infra §7 的「按用户 ACL 权限过滤」是更细粒度，仍属挂账 |
| **子代理委派**（`task`） | 「同时查多个片源 / 一次问多部影片」可并行委派，主对话只拿结论，天然解决观影场景的上下文膨胀；`subagent_*` 事件可给前端做实时进度 | 子代理**按作用域限权**（2026-09-22 细化）：**需要用户确认**的写操作（如「加入片单 / 标记看过」这类外部副作用）不能委派，会被闸门立即拒绝并回喂明确错误（模型会自行改为主对话发起 → 走确认卡）；免确认的工作区写（落盘中间结果）可以委派 |
| **Prompt 注入防护**（`src/untrusted.ts`） | 第三方影评、网页抓取、榜单文本都是**攻击者可控输入**，回灌模型前已被 nonce 定界 + 来源标注；写操作授权仍只来自确认卡 | 这是「降低概率」而非绝对阻断；对观影助手尤其重要（外部文本来源多），但**真正的兜底仍是写确认闸门** |
| **后台完成提醒 + 免打扰** | 批量查片这类长任务，切走的对话跑完会提醒一次；观影页复用 `ChatView` 即自动获得 | 提醒是前端轮询 `/chat/task/status`（5s、最长 15 分钟），非服务端推送；更省的做法是任务收束时推事件，属挂账 |

**对接 role 的完整清单（不止 skill）**：第 2 章指出「按 role 过滤 skill 索引」是必需代码改动。补完本节后，需要按角色隔离的对象应扩展为四项：

（2026-09-18 追加）**第五项通用能力：陌生库取证（工具 + 技能）**。BI 适配器补齐了元数据映射（描述 / 语义类型 / 外键指向 / 去重值个数）并新增取值域工具 `get_field_values`，配套通用技能 `schema-probe`（先找存量口径 → 取值域取证 → 单表口径优先 → 主键用去重数验证 → 结论写清口径）。对领域 Agent 的意义：**接入任何新数据源时，「问数据」的成本都应低于「猜语义」的成本**——这类取证能力与领域无关，换库、换 MCP、换角色都成立；实现细节与一次误判复盘（通用规律 vs 缺陷）见 `docs/mcp-guide.md` §10「陌生库取证」。

| 对象 | 当前是否按 role 隔离 | 现状 |
|---|---|---|
| `BASE_PROMPT`（角色人设） | 否（硬编码） | 模式 A/B 的改造对象 |
| skill 索引 `renderSkillIndex()` | ❌ 否 | **必需改动**（稳定前缀，影响 cache） |
| MCP 启用集 | ✅ 是（已按**对话**持久化） | 观影 MCP 只在观影对话启用，天然隔离 |
| 知识库语料 | ✅ 是（`namespace` 过滤） | `rag/store.ts` 按角色隔离，检索透传会话角色；观影语料 `--namespace movie` 入库即与 `generic` 隔离（历史索引按 `undefined→generic` 兜底兼容） |

---

> 一句话：**现有 Agent 不会被影响——它只是同一引擎下的一个配置变体；观影助手是另一个变体，两者可共存、可切换、可独立回滚。前端需把 ≤860px 的 `display:none` 侧栏改为抽屉；用「门户页 `/` + 观影新路由 `/movie`（复用 `ChatView`、按 agentId 隔离会话）」构成多 Agent 移动端结构；并以「会话按 agentId 分槽（旧对话向后兼容）+ 复用项目评测底座挂观影金样门禁」守住两个中风险点。全链路集成点已实测核实为安全，唯一必需代码改动是 `renderSkillIndex(role)` 按角色过滤 skill 索引（2026-09-17 复核：仍然成立；知识库语料已按 `namespace` 隔离（见第 13 章））。观影助手进 App（H5 / PC / Android / iOS）时，角色区分仍只在后端 `role` 字段，四端只是同一 API 的不同壳，契约（认证 / role / 写确认协议 / 会话隔离 / 凭据）统一；客户端对话流本就是 **HTTP Streamable / NDJSON**（非 SSE），四端可直接复用、无需传输层适配，生产只需确保反代 / CDN **不缓冲 chunked**，原生端再接系统推送即可。**
>
> **2026-09-18 补充**：引擎侧新增的知识库检索、子代理委派、注入防护、后台完成提醒四项能力均为通用件，观影助手可直接复用（详见第 13 章），其中「子代理并行查多片源」与「知识库承载影评/资料」能显著降低观影助手的落地成本；知识库已按 `namespace` 隔离、skill 索引已完成按 role 过滤，两者均不再是缺口。
>
> **2026-09-18 二次补充（陌生库取证）**：新增「元数据映射 + 取值域工具 `get_field_values` + 通用技能 `schema-probe`」这一组取证能力，接任何数据源的领域 Agent 都能直接复用。判据：**凡能靠一次最小查询证明的事实，都属于工程缺陷而不是模型运气**——把「先入为主地排除某个取值」「过度关联维表」这类错误，从「下次更谨慎」变成可复现地消除。复盘与挂账见 `docs/mcp-guide.md` §10「陌生库取证」。
