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

## 滚动过渡（2026-09-20）

观影对话可滚高度常达数百~上千像素，「返回顶部」与发送/进入对话后的「跳到底部」都应给用户平滑的「滑动」反馈，而非瞬移。

### 问题 / 修复

| 项 | 说明 |
|---|---|
| 问题 | 长对话（>2 屏）点「返回顶部」直接瞬移，没有滑动过渡；用户明确期望平滑回顶。 |
| 影响 | 瞬移突兀，与页面其它过渡（按钮 hover / 入场动画）节奏不一致。 |
| 误判（已纠正） | 一度怀疑原生 `scrollTo({behavior:'smooth'})` 在 `.mc-scroll` 上被静默忽略，为此写了自定义 rAF 缓动工具 `smooth-scroll.ts`；后实测原生 smooth 在该容器**可用**，自写 rAF 属过度实现（且初版未做重复调用取消，二次点击会与上一段动画互相打架）。**已删除该工具**。 |
| 根因 | 原 `toTop()` 用 `behavior: distance > 2*viewport ? "auto" : "smooth"`——长距离被强制瞬移，正是用户看到的「不滑」。 |
| 修复 | `toTop()` 始终 `scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })`（去掉距离阈值）；`scrollToBottom(force)` 显式回底同样走 `scrollTo({ behavior: "smooth" })`。流式跟底（`force=false`）保留即时 `scrollTop = scrollHeight`。 |
| 关键约束 | 实测在 `scroll-behavior: smooth` 下**`scrollTop=` 属性赋值也会被动画化**（`early=9, late=3840, target=4000`）。因此**不能**给 `.mc-scroll` 加全局 `scroll-behavior: smooth`（否则流式跟底会滞后留缝），只能在「点对点 `scrollTo`」上显式传 `behavior`。 |
| 无障碍 | reduced-motion 下 `behavior: "auto"` 瞬移；并在全局 `@media (prefers-reduced-motion: reduce)` 补 `scroll-behavior: auto` 兜底（对齐 WCAG 2.3.3）。 |

### 最佳实践依据

1. **平滑滚动优先用原生 API**：`Element.scrollTo({behavior:"smooth"})` / CSS `scroll-behavior` 即可，MDN 明确其为 CSSOM 触发的滚动行为、2022 起广泛支持；自写 rAF 仅在需要自定义时长/缓动且原生不可用时才是必要兜底（MDN / web.dev）。
2. **尊重 `prefers-reduced-motion`**：vestibular 敏感用户会被滚动动画诱发眩晕，reduced-motion 下必须瞬移（WCAG 2.3.3 Animation from Interactions 的精神；web.dev `prefers-reduced-motion`）。
3. **流式跟底即时贴合**：聊天类页面的「贴底」用 `scrollTop=` 即时赋值，避免平滑动画期间内容增长导致留缝——通用做法。

### 验证（2026-09-20，浏览器实测）

- 根因 3 实例：同浏览器内普通 div / `.mc-scroll` / 给容器加 `scroll-behavior:smooth` 后，原生 `scrollTo({behavior:"smooth"})` 均 `before→after: 0`，证明原生 smooth 可用（此前「no-op」是测试假象）。
- `scrollTop=` 在 smooth 下会被动画化（`early=9, late=3840`），印证**不能**给容器全局开 smooth、只能在 `scrollTo` 上点对点传 `behavior`。
- 点击「返回顶部」：容器从 ~3900px 渐进滑动到 0（中途采样确认是动画而非瞬移）；reduced-motion 下直接到 0。
- 发送消息 / 进入对话：`scrollToBottom(true)` 平滑滚到底；流式跟底保持即时贴合、无留缝。
- Lint：涉及文件 0 新增错误；HMR 正常。

## 输入与无障碍（2026-09-21，全局审计）

把页面运行时逐项拆开对齐权威写法后，发现的问题与处理（"修复"列按外面 site 的推荐/规范落地）：

| 子系统 | 问题 | 修复 | 依据 |
|---|---|---|---|
| 回车发送 | `@keydown.enter.exact.prevent`：`.exact` 只管 Shift/Ctrl 修饰键，**管不了输入法状态**——中文里回车是"把候选词上屏"，却被当成发送 | 改 `@keydown="onKeydown"`：`Enter && !shiftKey && !isComposing`，并留旧浏览器回退 `keyCode===229` | MDN `KeyboardEvent.isComposing`（UI Events）：合成会话期间（`compositionstart`→`compositionend`）的按键不应触发业务提交；同仓 `ChatPage.onKeydown` 早已这么写，MoviePage 是漏网的 |
| 对话区语义 | `.mc-inner` 是裸 div：**无 `role="log"`、无 `aria-live`，整页也没有 `main` 地标** → 读屏用户完全不知道回复已经到了 | `.mc-inner` 加 `role="log" aria-live="polite"` + 本地化可访问名称；滚动容器 `div` → `main`（每页一个主地标，跳转链接才有落点） | MDN log role：角色隐含 `aria-live=polite`，典型用例就是聊天记录，且**必须有可访问名称** |
| 流式播报策略 | 光加 live region 不够：一次回复几百个增量，会让读屏逐字轰炸 | 生成期间给 log 区 `aria-busy="true"`，收束回落 `false` → 等整段完成再播报一次 | MDN `aria-busy`：live region 标 busy 可让辅助技术等更新完成再暴露内容 |
| 发言者可分辨 | 气泡没有说话人信息 | 每条气泡补视觉隐藏前缀（"我说：" / "观影助手："） | 聊天日志要能听出每条是谁说的 |
| 思考面板标题 | summary 里 `sr-only` 标签与可见标签同时存在，有推理内容时同一句被念两遍 | `sr-only` 只在"没有可见标题"时才加 | 可见文本已在无障碍树里，再挂一份同名 sr-only 就是重复 |
| 确认弹窗焦点 | 只做"打开聚焦 + 关闭归还"，**没有 Tab 陷阱**：实测按一次 Tab 焦点掉到 `body`、接着跑到弹窗背后 | 背景整体 `inert` + Tab/Shift+Tab 在弹窗首尾循环（保留 Esc、焦点归还） | WAI-ARIA APG 对话框线路；`inert`（Chrome 102+/Safari 15.5+/Firefox 112+）比手写背景屏蔽更彻底 |
| 输入框名称 | 只有 placeholder（DevTools 报 issue：`A form field element should have an id or name attribute`） | 补本地化 `aria-label`，并加 `enterkeyhint="send"`（移动端键盘显示"发送"） | placeholder 不是可靠的可访问名称 |

### 实测否决的改动（别为了优化而优化）

- **假设"每个流式 token 都重解析 markdown 会卡"——不成立**：一条 45 秒、12 条列表的长回复实测**全程 47 次 DOM 变更、0 个长任务（≥50ms）**，Vue 的异步批处理已把增量合并进同一 tick/帧，无需再加 rAF 节流。
- **移动端视口**：`.mc` 已是 `100dvh`，`env(safe-area-inset-*)` 已铺到 composer 与返回顶部，无需改。
- **XSS**：`renderChatMarkdown` 经 DOMPurify 净化后才进 `v-html`，无需改。

### 验证实例（2026-09-21，浏览器实测）

- IME 三实例（修复前后同一脚本对照）：合成态回车 修复前 `0→1` 条用户气泡且进入 busy（误发送）；修复后行数不变、`inputKept:true`、`wentBusy:false`。普通回车 `3→4` 正常发送；Shift+Enter 不发送。
- ARIA：`[role="log"]` 1 个、`aria-live=polite`、名称"对话记录"；空闲 `aria-busy=false`，流式期间 `true`，收束回落 `false`；`main` 地标 1 个；sr-only 说话人前缀 8 条按"我说：/观影助手："交替。
- 弹窗：打开→背景 `inert=true`、焦点在"清空"；Tab→"取消"（修复前掉到 body）；Shift+Tab→"清空"；Esc→弹窗关闭、焦点回到"清空对话"触发按钮、`inert` 解除、`overflow` 复位。
- 跟底：流式全程 `scrollHeight - scrollTop - clientHeight = 0`（贴合，无回归）。
- 控制台：无 JS 报错；textarea 的 form-field issue 消失。

### 踩坑记录（仅开发期）

Vite 对 SFC 有自己的 transform 缓存：连续改同一文件时，最后一次模板改动可能没进 `/xxx.vue?vue&type=template` 产物——浏览器的 `ignoreCache` 管不到服务端。现象是"代码明明在磁盘上、行为却是旧的"，且控制台没有任何报错。`touch` 文件刷新 mtime 即可强制重编译。

## 复审第二轮（2026-09-21）

方法换成两条腿：**Lighthouse 快照做自动化权威核对** + **全仓同类排查**（一个页面修好了，其他地方未必）。

| # | 问题 | 修复 | 依据 |
|---|---|---|---|
| 1 | `/chat` 的"长期记忆"和"澄清补充"两个行内输入框仍写着裸 `@keydown.enter.prevent`——和观影页同一个 IME 坑 | 抽 `onInlineSubmitKeydown(event, submit)`，同样跳过合成态 | 同上一轮的 `isComposing` 依据；同仓 renaming / composer 早已这么写 |
| 2 | `<html lang>` 在 index.html 里写死 `zh-CN`，**切到英文/葡语/印地语也不变** → 读屏继续用中文语音念外文文案 | `setUiLocale` 同步 `document.documentElement.lang`（按 locale 映射到对应 BCP-47 标签） | WCAG 3.1.1 Language of Page |
| 3 | Lighthouse 报 `label-content-name-mismatch`："清空对话"按钮可见文字是"清空对话"，可访问名称却是"清空当前对话" → **语音用户说"清空对话"点不到** | 名称改成以可见文案为主干，"为什么点不了"降级为括号补充跟在后面 | WCAG 2.5.3 Label in Name：可见文本必须包含在可访问名称里 |
| 4 | `UiLocaleSelect` 的 `ul[role="listbox"]` 下**一个 `role="option"` 都没有** | 选项按钮补 `role="option"` + `aria-selected` | WAI-ARIA：`listbox` 的必需拥有元素是 `option`，缺了读屏数不出"第几项/共几项" |

### 验证（2026-09-21，第二轮实测）

- Lighthouse 快照：**Accessibility 100 / Best Practices 100**；未通过项从 4 条降到 3 条，剩下的是 `meta-description`、`robots-txt`、`llms-txt`——均属 SEO/基础设施，不是应用本身的无障碍问题，没有擅自改动。
- 切到英文界面实测：`document.documentElement.lang` 由 `zh-CN` → `en`；"清空对话"按钮的可见文字与可访问名称在中英文下都保持一致（英文 `Clear chat` == `Clear chat`）；语言菜单 4/4 选项带 `role="option"`，`aria-selected` 恰好一项为 `true`。
- 构建：`vite build` 通过；三个改动文件 lint 0 错误。

### 已知但本轮未动的非阻塞项

- ChatPage 两个行内输入框的修复**只有静态与编译验证**：资源面板在当前 UI 状态下渲染不出来（`资源` 触发按钮不在 DOM 里），没能做到浏览器实例级复核（同一模式已在观影页用实例验证过，这里只是没复现到入口）。后续若改到该面板建议补测。
## 继续修复（2026-09-21 收尾）

| 项 | 处理 | 说明 |
|---|---|---|
| 富文本 `style` 放行过宽 | 改成**属性白名单**过滤，不再整体放行 | 原先有个刻意的 hook 对 `style` 设 `forceKeepAttr = true`（保留模型输出的富文本样式），不能直接删——否则会破坏有意的行内排版。改为只保留配色/字体/排版类属性，`position` / `inset` / `z-index` / `transform` 这类能劫持页面的声明丢掉，值里含 `url()` / `javascript:` / `expression()` 也丢 |
| 跳转链接目标不是可聚焦元素 | `#app-main` 加 `tabindex="-1"` | WebAIM / WCAG 惯例：跳转目标必须能真的接住焦点，否则点了只改 hash |

### 踩坑：DOMPurify 钩子的触发条件

第一版把过滤写在 `uponSanitizeAttribute` 上，**实测完全没生效**：因为这个钩子只处理"本来要被删掉"的属性，而 `style` 就在 DOMPurify 的 `ALLOWED_ATTR` 里。必须改挂 `afterSanitizeAttributes`，在净化完成后直接改写属性值（为空就 `removeAttribute`）。

### 验证（4 条实例 + 1 条焦点实例）

| 输入 style | 输出 |
|---|---|
| `position:fixed;inset:0;z-index:99999;background:#fff;color:#000` | 只剩 `background:#fff; color:#000`（overlay 钓鱼能力被卸掉） |
| `color:red;font-weight:700` | 保留 |
| `background:url(javascript:alert(1));width:100px` | `url()` 值丢弃，留 `width:100px` |
| 表格单元格 `text-align:right;position:fixed;top:0` | 留 `text-align:right` |

同时复测：`<script>` 删除、`onerror` 删除、链接保留 `target="_blank" rel="noopener noreferrer"`、表格正常渲染。

跳转链接：直接 focus `#app-main` 成功（`activeElement.id === "app-main"`），再按 Tab 落在主内容里第一个控件 `mc-clear`——确实是"跳过导航进入主内容"。
（附带的观察：点击跳链时因为 hash 变化会触发路由监听，焦点先被 App.vue 的 `route-focus-anchor` 接走；它排在 `#app-main` 前面，下一个 Tab 同样进入主内容，故不额外处理。）

### Lighthouse 复审

- Accessibility **100**、Best Practices **100**（未回退）；SEO **60 → 80**（补了 meta description）。
- 仍剩 2 项：`robots-txt`、`llms-txt`——都是站点基础设施层面的东西，不在应用代码里改。

### 仍未做实例验证的一项

`/chat` 两个行内输入框（长期记忆 / 澄清补充）的 IME 修复只有静态与编译验证：资源面板在当前 UI 状态下渲染不出来（`资源` 触发按钮不在 DOM 里），入口没复现到。同一模式已在观影页用实例验证过。

## 第四轮：交互细节（2026-09-21）

| 项 | 问题 | 修复 |
|---|---|---|
| 发送 ⇄ 停止按钮互换导致**焦点丢失** | 两个页面都是 `v-if` 互换：点了「发送」后原按钮从 DOM 消失，焦点掉到 `body`，键盘用户按 Tab 得从页首重新走一遍 | 切换完成后把焦点扶到"此刻该按的控件"：生成中 → 停止按钮，收束后 → 输入框。**只在焦点确实无主（`activeElement === body`）时才接管**，避免抢走用户此刻在别处的焦点 |
| 整页**一个标题都没有** | 读屏用户没法用"按标题跳转"定位，跳转链接落进来后也没有标题可念 | 顶栏标题 `span.mc-title` → `h1.mc-title`（补 `margin: 0` 抵消 h1 默认外边距） |

### 验证实例

- 焦点链路（观影页）：聚焦"发送"→点击 → 焦点落在 `mc-send--stop`；再点"停止"→ 焦点回到 `mc-input`。修复前两处都是 `body`。
- 不抢焦点（观影页）：在输入框里按 Enter 发送，生成期间焦点保持在 `mc-input`，没有被强行挪到停止按钮。
- 同一 bug 在 `/chat` 复修同样通过：点击发送 → 焦点到 `send stop`；点停止 → 回到 `.input`。
- 标题：`h1` 出现且只有 1 个；顶栏 59px 高度不变、标题仍在顶栏内（改 h1 没破坏布局）。
- 一并查过且确认没问题的：所有可见点击目标均 ≥24×24（WCAG 2.5.8）；各控件都有 `focus-visible` 焦点指示。
- Lighthouse 复审：Accessibility **100** / Best Practices **100**，失败项仍只剩 `robots-txt`、`llms-txt`（站点基础设施，不在应用代码里改）。

## 第五轮：硬核实测 + 对比度（2026-09-21）

这一轮不新开大改，而是**把前几轮"声称已修"的关键项用实例坐实**，并补齐 Lighthouse 算不准的一类：真实对比度。

### 实测确认（之前只声称过，本轮用实例验证成立）

| 项 | 实测结果 |
|---|---|
| 确认弹窗焦点陷阱 | 打开 → 焦点落在"清空"按钮、`pageRoot` 变 `inert`、弹窗自身**未被 inert**；Tab 在首尾按钮间循环；Esc 关闭并焦点归还"清空"、关闭后 `inert` 撤销。完整跑通 |
| 弹窗为何没被自己的 `inert` 误伤 | 关键在 `<Teleport to="body">`：弹窗渲染到 `body` 层级，不在 `pageRoot` 子树内，`pageRoot.inert=true` 只会禁掉背景。最初怀疑过"弹窗被自己 inert 掉"，实测排除 |
| `<form>` 不会整页刷新 | composer 是 `<form @submit.prevent="send">`，发送按钮 `type="submit"` 不会触发浏览器原生提交导致跳转 |
| `prefers-reduced-motion` | 全局 `@media (prefers-reduced-motion: reduce)` 关动画 + `scroll-behavior:auto`；JS 平滑滚动也按 `reduceMotion` 切瞬移（WCAG 2.3.3） |
| 控件基础项 | 输入框有 `aria-label`、发送/清空按钮名实一致、所有可见点击目标 ≥24×24、各控件 `focus-visible` 齐全 |

### 新发现并修复：渐变标题橙端对比度不达标

- Lighthouse 的对比度检查对**渐变文字 / 半透明背景**经常漏判，所以这一轮在浏览器里**直接算真实 WCAG 对比度**。
- 标题 17px 粗体属「大字」，AA 要求 ≥3:1。渐变蓝→橘里：蓝端 `#2f6fed` 在浅底 4.25:1（达标），**橙端 `#ef8a3c` 只有 2.35:1（挂）**。
- 压深橙停靠色 `#ef8a3c → #d2691e`，复测橙端 **3.4:1** ✓；蓝端未动。
- 顺带核过：placeholder 4.61:1、清空按钮 4.86:1、发送按钮都过 AA（placeholder 仅压线，暂不调整以免改观感）。

### 收尾

构建通过、lint 0 错误；Lighthouse 复审 Accessibility **100** / Best Practices **100**，失败项仍只剩 `robots-txt`、`llms-txt`（站点基础设施，不在应用代码里改）。

## 第六轮：对比度收口 + 表格表头 + 语言下拉键盘（2026-09-21）

这一轮把上轮对比度审计里**漏掉的同款渐变 bug**、以及两个通用的渲染层可访问性缺口补齐。

### 1. 欢迎卡标题同款渐变橙端（漏网）

- 上轮只修了 `.mc-title`（h1）的橙端 `#ef8a3c → #d2691e`，但**空态欢迎卡标题 `.mc-welcome__title` 用了完全相同的渐变停靠色** `#ef8a3c`，同样 2.35:1 挂 AA（20px 粗体属大字）。
- 一并压到 `#d2691e`，与 h1 保持一致。

### 2. Markdown 渲染表格缺 `scope`（WCAG 1.3.1，全局影响 `/movie` + `/chat`）

- `MarkdownIt` 渲染出的 `<th>` **默认不带 `scope`**，列数一多读屏只会逐格念、分不清「这一格属于哪一列」。
- 在 `chat-richtext.ts` 的 `foldAgentBlocks` 里补：表头行 `thead th` → `scope="col"`，`tbody` 内若出现行表头 `th` → `scope="row"`。
- 同时把 `"scope"` 加进 `DOMPurify` 的 `ALLOWED_ATTR`，否则会被净化器剥掉。
- 浏览器内动态 `import` 渲染器喂一张 2×2 表验证：输出已含 `<th scope="col">电影</th>` 等 ✓。

### 3. 语言下拉升级为 APG listbox（键盘可达）

- 原实现：按钮 + `role="listbox"` + 选项，但**选项用 `<button role="option">`**、无方向键导航、打开后焦点不进菜单——只能靠 Tab 硬走，不是真正的 listbox。
- 重写为合规 APG listbox：
  - `role="option"` 直接落在 `<li>` 上（去掉内嵌 button）；
  - **roving tabindex**：仅当前选中项 `tabindex=0`，其余 `-1`；
  - 触发器方向键/回车/空格打开并把焦点送进菜单；
  - 菜单内 `ArrowUp/Down`、`Home/End` 移动、`Enter/Space` 选中、`Esc` 关闭并归还焦点、`Tab` 正常离场。
- 浏览器实测：方向键打开 → 焦点落在 "English✓"；roving tabindex 为 `["-1","0","-1","-1"]`；↓ 移到 "Português (Brasil)"；回车选中、菜单关闭、**焦点归还触发器** ✓。

### 4. 全量对比度复核（浏览器实算，light + dark）

- 写了遍历所有文字叶节点、按「有效背景」算 WCAG 对比度的脚本（修掉了 `rgba(0,0,0,0)` 被当成纯黑导致渐变底元素全部误报的 bug）。
- **浅色 0 失败、深色 0 失败**（实心底文字；渐变底的气泡/标题由手算确认达标：用户气泡 `#123a66` 在浅蓝渐变上 ≈8.6:1、助手气泡 `--ink` 在白底极高、标题橙端 3.4:1）。
- 注意：首轮那次 `4.21:1` 的「清空按钮」是误报（同透明黑 bug），真实值 4.86:1 过 AA。

### 5. 并行核对 ChatPage 本轮改动

`ChatPage.vue` 本轮 +33 行，与观影页对齐：补 `stopBtnRef` + `sending` 焦点交接 watch（生成中→停止、收束后→输入框）、以及 `onInlineSubmitKeydown`（IME 合成态跳过，替换内存/澄清输入框的 `@keydown.enter.prevent`）。经核对均正确、无回归。

### 收尾

Lighthouse（移动端）Accessibility **100** / Best Practices **100**；构建通过、lint 0 错误。失败项仍只剩 `robots-txt`、`llms-txt`（站点基础设施）。

## 第七轮：标题层级 + 高对比模式（2026-09-21）

这一轮查结构语义与环境适配两处。

### 1. 气泡内 Markdown 标题层级下沉（WCAG 1.3.1 / 2.4.6，影响 /movie + /chat）

- 整页唯一的 `<h1>` 是助手名（`.mc-title`），但模型在气泡里写的 `#`/`##` 经 MarkdownIt 渲染成 `<h1>`/`<h2>`，会与页面 h1 撞车、并出现「h1 之后直接 h3」的跳级，破坏文档大纲。
- 在 `chat-richtext.ts` 的 `foldAgentBlocks` 开头加一道标题下沉：所有 `h1→h2 … h5→h6`，`h6` 封顶。结果：整页只剩一个 h1、气泡内容从 h2 起、相对层级不丢、不产生跳级。
- 浏览器内动态渲染 `# Top / ## Section / ### Sub / #### Deep / ##### Deeper / ###### Deepest` 验证：输出变为 `[h2,h3,h4,h5,h6,h6]`，`hasH1=false` ✓。

### 2. Windows 高对比模式（forced-colors）焦点/边界兜底

- 系统在高对比模式下会强制重映射颜色，半透明/阴影类焦点环被抹掉，控件边界可能消失。
- 在 `styles.css` 末尾加 `@media (forced-colors: active)` 块：为发送/清空/输入框/主题/语言控件/弹窗/危险按钮补 `outline: 2px solid Highlight`（focus-visible 时），并为这些控件补 `border: 1px solid ButtonBorder`。
- 仅在该模式下生效，正常渲染零影响；同时顺带加固了 App.vue 里那份全局跳转链接的焦点环。

### 3. 跳转链接：发现已有全局一份，回退冗余改动

- 自查时发现 `App.vue` 早已有一份全局跳转链接（`href="#app-main"`，路由容器 `id="app-main"` tabindex=-1）。
- 本轮一度在 MoviePage 里又加了一份（`#mc-main`）——会形成 Tab 序列里连续两个跳转链接、相互冗余。已回退 MoviePage 的跳转链接与 `#mc-main` id，保留全局唯一一份（Lighthouse 的 bypass 审计也本就靠它 + `<main>` 地标通过）。

### 收尾

Lighthouse（移动端）Accessibility **100** / Best Practices **100**；构建通过、lint 0 错误。失败项仍只剩 `robots-txt`、`llms-txt`（站点基础设施）。

## 第八轮：把可访问性审计对齐到 /chat（2026-09-21）

`/movie` 修到 100 后，按同一套审计对 `/chat` 跑 Lighthouse，发现它原本 **Accessibility 96**（其余失败项 `robots-txt`/`llms-txt` 与 `/movie` 同属站点基建，不计入 a11y）。实测定位并修复 4 项真实缺陷：

### 1. 对比度不达标（`color-contrast`，4 处）

根因：亮色主题 `--muted: #707068` 在浅底 `#eeece8` 上只有 4.23:1（需 ≥4.5）；`reasoning__time` 还额外 `color-mix(--muted 85%, transparent)` 更浅（3.41）；`composer-hint` 是 `--muted` 再叠 `opacity: 0.75`（合成后 `#94948e`，3.04）。

- `apps/web/src/styles.css` 亮色主题 `--muted: #707068 → #686868`（仅亮色主题，深色主题 `--muted` 不变）：`nav-seg`/`stopped-tag` 在 `#eeece8` 上 4.23 → 约 4.73，全站 muted 文字一并受益。
- `ChatPage.vue` `reasoning__time`：去掉 `color-mix(85%, transparent)`，改实色 `var(--muted)` → 在 `#f4f4f1` 上约 5.07。
- `ChatPage.vue` `composer-hint`：去掉 `opacity: 0.75`，改实色 `var(--muted)` → 在 `#ffffff` 上约 5.57。

### 2. 无障碍名称与可见文字不匹配（`label-content-name-mismatch`）

`button#chat-model` 可见文字为 `TokenHub` + `Kimi-K2.7-HS`，但 `aria-label="模型 Kimi-K2.7-HS"` 漏了可见的 `TokenHub`，触发 mismatch。

- `components/ModelSelect.vue`：`aria-label` 补上来源徽标（`${currentSource ? ' ' + currentSource : ''}`）；来源徽标 `msel__source` 加 `aria-hidden="true"`（读屏只经 aria-label 念一次，不重复）。
- 实测 `aria-label` 变为 `模型 TokenHub Kimi-K2.7-HS`，可见文字全部包含在内。

### 3. 整页缺 `<h1>`（与 `/movie` 对齐）

`/chat` 顶栏标题原为 `span.brand__name`，整页 `<h1>` 数量为 0（观影页那轮已把 `.mc-title` 升为 `h1`）。

- `ChatPage.vue`：`span.brand__name → h1.brand__name`，CSS 补 `margin: 0` 抵消 h1 默认外边距（布局不变）。

### 收尾

`/chat` Lighthouse（移动端）Accessibility **100** / Best Practices **100**；`pageH1Count = 1`（`brand__name:小助手`）；模型按钮无障碍名称已含来源。构建通过、lint 0 错误。失败项仍只剩 `robots-txt`、`llms-txt`（站点基础设施）。两页（/movie、/chat）a11y 审计现已对齐至 100。
