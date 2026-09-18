# 观影助手独立 UI 方案

## 目标

`/movie` 渲染为**面向消费者的极简对话界面**：

- 没有侧栏（无会话列表、无新建对话、无归档、无定时任务 tab）；
- 不暴露模型选择器；
- 底部输入区只有输入框 + 发送按钮（生成中变停止）；
- 保留语言选择与主题切换（用户偏好，非模型/工具类控件）。

一句话：**只要对话框和输入框。**

## 最终方案：独立 `MoviePage.vue`

`/movie` 不再复用 `ChatPage.vue`，而是由**独立页面** `apps/web/src/pages/MoviePage.vue` 承载。

| 路由 | 组件 | 形态 |
|---|---|---|
| `/chat` | `ChatPage.vue` | 通用助手：侧栏 + 会话管理 + 模型选择 + 工具菜单（全功能） |
| `/movie` | `MoviePage.vue` | 观影助手：单列对话 + 输入框（极简） |

`router.ts` 相应改为 `/movie` → `MoviePage`（不再用 props 注入 agentId）。

### 为什么不用「在 ChatPage 里加 `isMovieMode` 布尔条件」

最初实现走的是布尔方案（`v-if="!isMovieMode"` 逐个隐藏模型选择器、工具菜单、定时任务 tab、缩放手柄）。问题：

1. **原页面被污染**：为另一个产品的形态在同一文件里散布大量条件分支，可读性与可维护性下降；
2. **仍带着全部包袱**：隐藏的是 DOM，`ChatPage` 的侧栏/任务/资源面板逻辑依然在跑；
3. **形态语义不清**：观影助手是独立产品形态，应有一个独立文件作为唯一事实来源。

因此**撤销全部布尔改动**（`isMovieMode` 已从全仓库移除，`ChatPage.vue` 恢复原状），改为独立页面。

## 最佳实践依据

1. **单用途助手不应暴露模型选择器**：Siri、Google Assistant、ChatGPT App 均不暴露每会话模型切换；模型属后端实现细节。观影助手已有后端默认人设与默认 MCP（`movie`），选择器只会增加认知负担。
2. **移动端输入栏应保持极简**：iMessage、WhatsApp、Telegram 的输入栏 = 文本框 + 发送按钮。图片上传、技能、连接器属低频或预配置操作，不应占据主输入栏；观影助手所需的 `movie` MCP 由后端 `defaultMcpServers` 自动注入。
3. **保留停止按钮**：生成中把发送替换为停止（ChatGPT、Claude Mobile 一致），符合行业惯例。
4. **内容列居中约束**：桌面端把顶部栏、消息列表、输入栏统一约束到 `max-width: 760px` 居中列（ChatGPT / Claude 的桌面布局）；移动端自动全宽，输入栏底部适配 `env(safe-area-inset-bottom)`。
5. **以路由划分形态**：`/movie` 与 `/chat` 是两个路由、两个组件，桌面与移动形态一致，不随视口宽度分裂。

## 页面结构（`MoviePage.vue`）

- **顶部栏**：`观影助手` 标题 + `UiLocaleSelect` + `ThemeToggle`。
- **对话区**：气泡列表——用户消息右对齐纯文本，助手消息左对齐经 `renderChatMarkdown` 渲染（支持标题/列表/表格/代码块）；生成中显示打字动画；错误行内提示。
- **输入栏**：自适应高度 textarea（Enter 发送、Shift+Enter 换行、最大 160px）+ 圆形发送/停止按钮（单行输入框与按钮同为 47px，见下「交互打磨」）。

## 复用的底层能力（不重复实现）

| 能力 | 来源 |
|---|---|
| 流式对话 | `streamChat`（`api.ts`，NDJSON 事件流） |
| Markdown 渲染 | `renderChatMarkdown`（`chat-richtext.ts`） |
| 会话持久化 | `fetchConversations` / `createConversation` / `saveConversationMessages`（`api.ts`） |
| 语言 / 主题 | `UiLocaleSelect` / `ThemeToggle` 组件、`ui-locale.ts` |
| 错误文案本地化 | `localizeToken`（`localize.ts`） |

进入页面时取 `agentId="movie"` 的最近一个会话载入历史；无会话则新建。发送后即时追加气泡并流式渲染，收束时回写消息快照。

## 相关文档

- 个性化推荐：**已于 2026-09-18 移除**（前端面板 + 服务端管线），历史方案见 `docs/movie-personalized-plan.md`
- MCP 基建与配置字段：`docs/mcp-guide.md`
- 多 Agent 角色适配：`docs/domain-adaptation-guide.md`

## 边界（本次不做）

- **不做会话列表**：观影助手只有一条当前会话，无切换需求（历史通过「最近会话」自动恢复）。
- **不做工具步骤 / 子代理 / 待办 / 确认卡面板**：观影助手是只读消费场景，不涉及写操作确认；若后续 `movie` 角色可能出现 `confirmation_required` 或子代理事件，需要补渲染。
- **后端默认配置不动**：`movie` MCP 仍由后端 `defaultMcpServers: ["movie"]` 注入。

## 检查轮次发现并修复的问题（2026-09-18）

| 问题 | 影响 | 修复 |
|---|---|---|
| 停止被当成失败 | 点「停止」显示「出错了，请稍后重试」 | 识别 `AbortError`，标注「（已停止生成）」（与 `/chat` 一致） |
| 失败原因被吞 | 429/402 等只显示一句「出错了」 | 有服务端 token 就本地化还原，否则用原始错误信息 |
| 409 并发占用未处理 | 会话仍在生成时发送 → 报错，且留下无回答的孤儿用户消息 | 判定 `getApiErrorCode(err) === "CONVERSATION_BUSY"`（错误码读取唯一入口，见下「顺带发现」）：回滚该轮气泡、把输入还给用户、提示「上一条还在生成中」 |
| 需求已满足但无反馈 | 工具调用/长生成期（30–160s）无任何进度提示 | 正文出现后显示「生成中…」轻量提示 |
| 空气泡入库 | 失败轮的空白 assistant 会被持久化，刷新后出现空气泡 | 落库前过滤无文本且无图片的气泡（对齐 `ChatPage.toStored`） |
| 会话标题不变 | 标题一直停在创建时的「观影助手对话」 | 用首条用户消息前 24 字派生标题（对齐 `ChatPage.persist`） |
| 语言切换不落库 | `UiLocaleSelect` 只改内存，刷新后失效 | 监听 `@change` → `patchConversation(convId, { locale })` |
| 发送时会话未就绪 | 首屏会话建立失败时可能落到服务端兜底会话 | 发送前确保存在 `conversationId` |
| 停止按钮挤压多语言文案 | 「Stop / Parar / रोकें」在 42px 圆形内可能溢出 | 文案全部挪进 `title` / `aria-label`，按钮只留图标并统一几何（42px 圆角方形；2026-09-18 起随输入框一起调到 47px，见下「交互打磨」）——**不是**胶囊形自适应宽度 |
| **改代码触发 HMR 后整页白屏** | `theme.ts` 的 `useTheme()` 在注入失败时**抛错**；开发期 HMR 会让 `themeKey`（Symbol）重新求值导致注入链断裂 → `ThemeToggle` setup 抛错 → **整个页面白屏**（实测控制台 `Error: Theme is not provided`） | `theme.ts` 改为**优雅降级**：注入成功走 provide/inject，失败退化为模块级单例（切换照常生效），不再抛错打崩页面；同时按下 `useTheme(themeKey, null)` 消除注入告警 |
| **内部工具轨迹裸露** | `renderChatMarkdown` 会把 `[本轮已执行的工具]` 折成 `details.agent-tool-trace`，但其样式只写在 `ChatPage.vue` 的 scoped CSS 里；独立页没有这套样式 → 该块以浏览器默认样式裸露在回答正文里，既突兀又不低调 | 消费者页面**直接不展示**（`display: none`）；超长表折叠块保留但改为低调样式 |
| **宽表撑破气泡** | `.table-wrapper` 的横向滚动样式同样只在 `ChatPage` 里，独立页宽表会溢出气泡 | 补 `.table-wrapper { overflow-x: auto }` + `table { min-width: max-content }` |

> 教训：`renderChatMarkdown` 是「渲染 + 样式」两个部件，复用前者就必须把后者一起搬过来（`.table-wrapper`、`details.agent-tool-trace`、`details.agent-long-table`），否则折叠块与宽表会退化成浏览器默认外观。

### 顺带发现（`ChatPage` 409 分支）——已修复并实测（2026-09-18）

原问题：`ChatPage` 用 `getApiErrorToken(err) === "CONVERSATION_BUSY"` 把 `LocalizedToken` **对象**当字符串比，恒为 false，该「409 转待发队列」分支是死代码。修法不是就地改一处比较，而是把「错误码读取」收敛成唯一入口：

- `api.ts` 新增 `getApiErrorCode(error)`：优先取 `error.code`，回退 `getApiErrorToken(error)?.code`（`ApiError` 构造时已用 `token.code` 兜底）；
- `ChatPage.vue` 的 409 分支改用 `getApiErrorCode(err) === "CONVERSATION_BUSY"`，`MoviePage.vue` 的 `isBusyError` 同口径。

实测（真实网络，非打桩）：

1. 服务端：对同一会话并发两次 `POST /agent/chat/stream`，第二次返回 `409`，响应体 `{ error: { code: "CONVERSATION_BUSY" }, code: "CONVERSATION_BUSY", message: … }`；
2. 前端：该会话有后台任务时从输入框真实发送 → 气泡显示「（该对话正在生成中，此消息已加入待发队列）」，队列面板出现「排队中 · 1 / 生成结束后按序自动发送」+ 该条消息，输入框清空、无错误提示 —— 分支确实生效。

> 验证用的临时会话与后台任务已 `cancel` + 删除，无残留（列表复核：剩余会话待发队列均为 0）。

### 交互打磨（2026-09-18，三个可选后续一并落地）

| 项 | 改法 | 实测 |
|---|---|---|
| 输入框与按钮等高 | 取「都 47px」：`.mc-input` 行高写定值 `23px`（+ 内边距 `11×2` + 2px 边框 = 47），`.mc-send` `42px → 47px`，图标随比例放大（发送 18→20、停止 15→17）；不再依赖「字体度量凑出来」的 46.5px，换字体/语言也不会错位 | `/movie` 实测 `.mc-input` 与 `.mc-send` 均为 `47px`、`top` 一致；多行自适应与 160px 上限不变 |
| `/chat` 停止按钮字色 | `.send.stop` 的 `color: #fff` → `color: var(--panel)`（与独立页同一套语义色思路）：浅色主题取近白、深色主题取近黑 | 浅色 `#fcfcf9` on `#c25c2c` = 4.2:1（改动前 4.3:1，基本持平）；深色 `#131312` on `#f2b386` = **10.2:1**（改动前白字约 1.8:1，图形几乎糊在一起） |
| hover/active 力度 | 取「更明显」一档：hover `translateY(-1px) → -2px` 且阴影加深，active `0 → translateY(1px)` 反向压一下（按下有明确位移）；`/movie` 与 `/chat` 两页同一口径 | 纯 CSS 三态位移，与 `prefers-reduced-motion` 兼容（全局已禁用过渡） |

> 另：`.mc-*` 的 CSS 注释与模板注释里的「42px」已同步为「47px」，避免注释与样式脱节；**文档**里那条 42px 的历史问题记录（上表「停止按钮挤压多语言文案」）保留原始描述，只补注最新尺寸，不做改写。

## 验证（2026-09-18）

- 移动端 390×844：顶部仅「观影助手 + 语言/主题」，中部对话气泡，底部输入框 + 发送按钮，无侧栏。
- 桌面端：三块区域（顶部栏 / 消息列表 / 输入栏）量测边界一致——`left=474, right=1234, width=760`，确认对齐同一居中列。
- 端到端发送“推荐几部高分电影”：流式返回并正确渲染有序列表、加粗标题与评分说明；历史在刷新后从服务端恢复。
- 停止实测：出现停止按钮 → 点击后 `hasStopMarker: true`、`hasErrorText: false`。
- 服务端数据核对：`agentId=movie` 会话恰好 1 条（无空会话孤儿），消息持久化正确。
- 构建：`vite build` 通过（75 modules，exit 0）；`read_lints` 三个文件均无新增错误。
- `/chat` 未受影响：`ChatPage.vue` 恢复原状（`isMovieMode` 全仓库 0 处残留）；运行时核对侧栏、两个 nav tab、汉堡、`#chat-model`、工具菜单、输入提示、缩放手柄均在。
