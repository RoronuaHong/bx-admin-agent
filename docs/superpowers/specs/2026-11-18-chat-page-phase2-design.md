# ChatPage.vue 阶段 2 拆分设计（P1-1 第二阶段）

- 日期：2026-11-18
- 状态：设计已审阅；**阶段 2 执行中**——C0/T0/T1 已提交，T2（SCC A 会话壳）已实现待提交（2026-11-19，详见实施计划 §0.3/§5.6）
- 对应阶段 1：`docs/superpowers/specs/2026-11-17-chat-page-refactor-design.md`、`docs/superpowers/plans/2026-11-17-chat-page-core-extraction-plan.md`
- 细化实施计划：`docs/superpowers/plans/2026-11-19-chat-page-phase2-implementation-plan.md`
- 基线提交：`5e962ca refactor(web): extract ChatPage core and harden frontend`
- 范围：`apps/web/src/composables/chat/useChatPageCore.ts`、`apps/web/src/pages/ChatPage.vue`、`apps/web/src/pages/chat-page.css`、新增 composables / UI 子组件

## 1. 目标

阶段 1 已把 `script setup` 整体原子搬迁到 `useChatPageCore.ts`，模板/CSS/行为不变。阶段 2 的目标是：

1. 把 `useChatPageCore.ts` 按**强连通分量（SCC）**拆成多个 composables，消除“单文件 6269 行”的可维护性问题。
2. 在逻辑拆分稳定后，再把模板中的独立区块抽成 UI 子组件，并下沉对应 CSS。
3. 全程行为零变化：路由重挂载、provide/inject、流式发送/续传、任务、MCP、右键菜单、队列、卸载清理全部保持现状。
4. 不顺手修 P1-3～P1-7，不做 A/B 重跑，不碰 BI，不把 P1-2 门禁混入拆分提交。

## 2. 当前基线

行号是阶段 1 提交后的快照，实施时用符号名定位。

| 文件 | 行数 / 大小 | 说明 |
|---|---:|---|
| `apps/web/src/pages/ChatPage.vue` | 2779 行 / 151,455 字节 | script 1–663、template 665–2776、style 2778 |
| `apps/web/src/composables/chat/useChatPageCore.ts` | 6269 行 / 266,245 字节 | 原 script 逻辑，653 个返回值 |
| `apps/web/src/pages/chat-page.css` | 4142 行 | 所有样式仍在页面级 |

阶段 1 已验证的不变量，阶段 2 不得破坏：

- `ChatPage.vue` 根层保留 `defineProps`、`useRouter`、`import type { ScheduleDto }`、653 个顶层同名解构。
- `App.vue:31` 的 `<RouterView :key="$route.path" />` 继续负责重挂载。
- `provide(bubbleContextKey, {…})` 41 键继续在同步 setup 调用链里组装。
- `pageUnmounted` / `unmountTimers` / `deferOnPage()` 与 4 个具名定时器继续统一清理。
- `states: reactive(Map)`、`persistedCount`、`seq`、各缓存是每页实例，不模块单例化。
- `@bx/web` 产物仍只有一份 `ChatPage-*.js` / `ChatPage-*.css`，composables 不做动态 import。

## 3. 总体架构

阶段 2 不删除 `useChatPageCore.ts`；它继续作为**协调层**存在：

```text
ChatPage.vue
  ├─ props / router / ScheduleDto type / 全量解构（UI 子组件抽取前不动）
  └─ template / style

useChatPageCore.ts（协调层）
  ├─ useChatPersistence()       前置快照归一化
  ├─ SCC C: modelSettings → threadScroll → reasoningUI
  ├─ run / 后台守望 / 中断澄清（保留在协调层或通过回调注入）
  ├─ SCC A: 会话壳 + 列表 + 右键 + 任务
  ├─ SCC B: MCP + 技能 + 工具 + 专家
  ├─ 记忆 / 工作区 / 面板状态 / 文案
  ├─ provide(bubbleContextKey, 41 键)
  └─ return 653 个模板可见绑定（随抽离逐步改为组合返回）
```

原则：**先拆逻辑，后拆模板**。逻辑未稳定前不改模板/CSS；UI 子组件抽取时，每个组件单独提交、单独截图和手测。

## 4. 强连通分量（SCC）与不可逐组抽的理由

| SCC / 前置 | 成员 | 当前证据 | 处理方式 |
|---|---|---|---|
| 前置：快照归一化 | `settleStep`、`toStored`、`bubblesFromStored`、`applyServerThread`、`syncOpenConversation`、`waitPendingPersists`、`upgradeConversationDetail` | `useChatPageCore.ts:2346–2507`；被 A 的 `selectConversation`、C 的 `runTurn`、右键清空竞态调用 | 先抽成 `useChatPersistence`，暴露完整 ComposableApi |
| SCC C | 模型设置、滚动、推理 UI、Run | `applyChatEvent` 读 `atBottomNow/queueScrollIfCurrent/thinkPhaseStart/thinkPhaseEnd/openReasoningPanel/closeReasoningPanel/lastGoodModelId`；`runTurn` 写 `failedModelIds`；`onThreadScroll` 读 `pinnedOutlineId` | 内部固定顺序 `modelSettings → threadScroll → reasoningUI`；Run 留在协调层，通过返回值注入状态 |
| SCC A | 会话壳、列表、右键、任务、删除撤销 | `removeConversation` 与 `closeCtxMenu/selectConversation/newConversation/scheduleUndoDelete` 互调；`selectConversation` 又调任务表单关闭与 MCP/技能加载 | **采用「共享状态留根后再拆」**：会话壳核心先抽，任务表单 + 飞出层留根（与 SCC B 共享 `taskDraft`）。见下方 2026-11-19 修订 |
| SCC B | MCP、技能、工具选择、专家 | `boundMcpIds` 被 `createConvFromDraft` 读（非 `newConversation`）；`taskDraft.mcpServers` 被任务飞出层与任务表单共享；`skillQuery/mcpQuery/searchAutofocus` 与 `skillAvailable/mcpAvailable/expertAgents` 互相读写 | 整体抽为一个 composable；`taskDraft`/飞出层留根供 A、B 共用。见下方 2026-11-19 修订 |

> **2026-11-19 代码核对修订**（细节见实施计划 §0.3）：上表 SCC A/B 的原始描述有几处与现行代码不符——
> ① `selectConversation` 并不调 `showSettingsError`（后者在 `openConversationById`/`commitRename`/`togglePin`/`applyConversationOrder` 处调用）；
> ② `boundMcpIds` 由 `createConvFromDraft` 读取，`newConversation` 只清 `blank.settings.mcpEnabled`；
> ③ `mcpAvailable`/`skillAvailable`/`expertAgents` 不出现在 `submitTask`，而在任务飞出层 computed（`taskSkillFiltered` 等）使用；
> ④ 删除组的 `flushPendingDelete`/`scheduleUndoDelete` 不直接用 `pageUnmounted`/`deferOnPage`，仅在 `onBeforeUnmount` 经 `flushPendingDelete()` 连接。
> 另：SCC A 实际 100+ 符号、与 SCC B 共享 `taskDraft`/飞出层，因此 T2 采用裁剪边界（只搬会话壳核心）并先补 33 个 web 行为测试；拆分已实现待提交，任务表单与飞出层继续留根。

结论：**禁止按“每个职责一个文件”逐组提交**。阶段 2 的提交单元是 SCC，不是原来的小职责组。

## 5. 共享符号与硬约束

### 5.1 必须留在协调层 / 根层

| 内容 | 当前证据 | 约束 |
|---|---|---|
| `agentProps` / `defineProps` | `ChatPage.vue:6`、`useChatPageCore.ts:137–140` | SFC 宏不能进 `.ts`；只经 `Readonly<{agentId?,agentLabel?}>` 传入 |
| `router` / `useRouter()` | `ChatPage.vue:7`、`useChatPageCore.ts:138` | core 不解构成普通值；深链 `?conv=` 与 agent 切换依赖它 |
| `RouterView :key="$route.path"` | `App.vue:31` | 重挂载语义不变 |
| `provide(bubbleContextKey, {…})` | `useChatPageCore.ts:5569–5611` | 41 键逐项保留；加 `satisfies BubbleContext` + `Object.keys().length === 41` |
| `pageUnmounted` / `unmountTimers` / `deferOnPage()` | `useChatPageCore.ts:4038–4048`、`:5533–5536` | 统一登记与兜底，不随 composable 拆散 |
| 全局键鼠监听 | 注册 `:5392–5421`，移除 `:5504–5521` | `onTaskFormEsc` capture、`onCtxDismiss` scroll/resize capture 的优先级不变 |
| `document.title` / theme / body overflow | `:1374–1380`、`:5432`、`:1582–1597` | 保持 setup 同步调用链 |
| 模板 refs | `threadEl`、`inputEl`、`promptBoxEl`、`stopBtnRef`、`ctxMenuEl`、`confirmPrimaryBtn`、`dtRoot/dtPanel`、`taskToolsRoot/Panel`、`resRoot`、`toolsRoot`、`setRenameInput`、`renameInputEl` 等 | UI 子组件抽取前由根同名暴露；抽取时用 `defineExpose` 暴露必要 refs |
| 每页实例状态 | `states`、`persistedCount`、`seq`、`alertMarkerCache`、`outlineCache`、`queueSetChains`、`pendingPersists/persistChains` 等 | 不模块单例化；`++seq` 统一计数器 |

### 5.2 跨组共享符号

| 符号 | 定义行 | 主要读写组 | 归属 / SCC |
|---|---:|---|---|
| `conversations` | 1339 | A、快照、C、任务 | SCC A |
| `models` / `modelsLoaded` | 1335–1336 | bootstrap、模型设置 | SCC C |
| `sortMode` | 1605 | 列表、bootstrap | SCC A |
| `showArchived` | 1423 | A、bootstrap | SCC A |
| `ctxMenu` / `undoDelete` | 1439 / 1461 | A | SCC A |
| `taskDraft` | 154 | 任务组、飞出层、SCC B | A↔B 桥接，留协调层；任务表单 + 飞出层随之留根（2026-11-19 修订） |
| `boundMcpIds` | 3948 | SCC B、`createConvFromDraft` | A↔B 桥接，留协调层注入；读点是 `createConvFromDraft`（约 2109），非 `newConversation` |
| `mcpAvailable` / `skillAvailable` / `expertAgents` | 1944 / 4132 / — | SCC B、任务飞出层 computed | SCC B；由飞出层 `taskMcpFiltered`/`taskSkillFiltered`/`taskExpertFiltered` 读（约 566–611），不在 `submitTask` |
| `skillQuery` / `mcpQuery` / `searchAutofocus` | 4834–4837 | SCC B、工具菜单 | SCC B |
| `threadWindow` / `pinnedOutlineId` | 1797 / 1869 | 告警、大纲、滚动 | SCC C↔大纲，读 getter 注入 |
| `followBottom` / `atBottomNow` / `queueScrollIfCurrent` | 2148 / 2157 / 2172 | SCC C、Run | SCC C，Run 通过 ComposableApi 使用 |
| `thinkPhaseStart/End`、`openReasoningPanel/closeReasoningPanel`、`stickThinkingToBottom` | 2214–2305 | SCC C、Run | SCC C |
| `lastGoodModelId` / `failedModelIds` | 1997–1998 | SCC C、Run | SCC C |
| `queueSetChains` | 3648 | 队列、卸载清理 | 队列组 + 协调层清理 |
| 快照归一化函数 | 2346–2507 | A、C、右键清空 | 前置组，先抽 |

## 6. 实施顺序（阶段 2）

每一步单独提交、单独验证；任何一步失败只回退该步骤。

| 步骤 | 内容 | 主要文件 | 验证重点 | 状态（2026-11-19） |
|---:|---|---|---|---|
| 0 | 抽 `useChatPersistence` | 新增 `composables/chat/useChatPersistence.ts`；改 `useChatPageCore.ts` | 首屏恢复、刷新/续传、并发落库、清空竞态 | ✅ `37d8663`，回滚：单提交 revert |
| 1 | 拆 SCC C：`modelSettings → threadScroll → reasoningUI` | 新增 3 个 composables；Run 保留协调层 | 发送/停止焦点、跟底、思考计时、模型 auto 黑名单 | ✅ `3f6d81c`，回滚：单提交 revert |
| 2 | 拆 SCC A：会话壳 + 列表 + 右键 + 任务 | 新增 1 个 SCC composable，共享状态留根后拆（裁剪边界见实施计划 §5.3） | 任务表单、拖拽排序、右键键盘、删除撤销 5s、归档/免打扰/发送模式 | ⏸ 暂停：偏差修订 + 待补行为测试；回滚：单提交 revert |
| 3 | 拆 SCC B：MCP + 技能 + 工具 + 专家 | 新增 1 个 SCC composable | 勾选/重连、拼音搜索、专家 chip、任务表单复用可用集 | ⏳ 依赖步骤 2 的 `taskDraft` 边界 |
| 4 | provide 契约加固 | `useChatPageCore.ts`、`bubble-context.ts` | 41 键齐全，气泡复制/编辑/工具确认/澄清可用 | 单提交 revert |
| 5 | UI 子组件（低风险）：`DoneToast` → `ArtifactPreviewModal` → `ConfirmDialog` → `ChatThread` | 新增 `components/chat/*.vue`；改 `ChatPage.vue` template | Teleport 顺序、focus trap、`threadEl` expose、`v-model:outlineOpen` | 每组件单提交 revert |
| 6 | UI 子组件（高风险）：`ContextMenuHost` → `ChatSidebarList` → `MessageComposer` → `ChatTaskPanel` | 同上 | `@click.stop`、Esc capture、`#task-panel-host` 顺序、`v-model="current.input"`、provide 链 | 每组件单提交 revert |
| 7 | CSS 下沉 | 新增对应 `components/chat/*.css`；改 `chat-page.css` | 截图对比侧栏/任务表单/弹窗/气泡/输入区 | 每块单提交 revert |

### 6.1 每步验收命令

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm type-check
pnpm test && pnpm --filter @bx/web test
git diff --check
```

Chrome 手工清单：

- `/chat → /support → /movie → /chat`：标题、Agent、输入框占位符正确，每次 path 变化重挂载。
- 发送普通消息、停止、续传；焦点与跟底正常。
- 任务表单新建/编辑/打开结果会话；通知通道与 cron 面板正常。
- MCP 勾选/重连、技能面板、工具搜索、专家入口正常。
- 右键菜单、删除撤销、归档/免打扰/发送模式、大纲、队列、复制气泡、记忆/工作区面板正常。
- Console 无 error；`apps/web/dist/assets/ChatPage-*` 仍只有一份 JS/CSS。

## 7. UI 子组件边界草案

行号基于当前 `ChatPage.vue` template（665–2776），实施时以符号定位。

| 子组件 | 当前 template 行号 | props / emits 要点 | 风险 |
|---|---:|---|---|
| `DoneToast` | 1138–1155 | `doneToast` / `view,close` | 低：Teleport to body，定时器留协调层 |
| `ArtifactPreviewModal` | 1205–1225 | `previewHtml,previewLoading` / `close` | 低：纯展示 |
| `ConfirmDialog` | 1158–1203 | `confirmDialog` / `confirm,cancel` | 中：focus trap、`confirmDialogEl`/`confirmPrimaryBtn` expose、body overflow 留根 |
| `ChatThread` | 2210–2280 | `visibleBubbles,booting,showSkeleton,outline...` / `jump,earlier,active` | 中：`threadEl` expose、`onThreadScroll`、`v-model:outlineOpen` |
| `ContextMenuHost` | 1009–1135 | `ctxMenu,ctxTarget,ctxConfirm` / `action,close` | 高：`@click.stop`、焦点归还、全局 Esc/scroll capture |
| `ChatSidebarList` | 667–1001 | 列表/任务分组/侧栏状态 / `select,new,ctx,drag,drop,reorder` | 高：ctx 状态、`convListEl`、大量列表交互 |
| `MessageComposer` | 2282–2770 | `current.input`、面板状态 / `send,stop,pickFiles,toggleTools...` | 高：`v-model="current.input"`、refs、Esc、Teleport 飞出 |
| `ChatTaskPanel` | 1230–1965 | `taskDraft,editingTaskId,notifyChannels...` / `submit,cancel,run,toggle...` | 高：Teleport 宿主顺序、多层 Teleport、Esc capture |

## 8. CSS 下沉边界

可下沉块按 `chat-page.css` 注释锚点处理：

| 块 | 当前行号 | 归属 |
|---|---:|---|
| 侧栏品牌/助手切换 | 31–217 | `ChatSidebarList` |
| 定时任务分组/任务卡片 | 218–252、653–845 | `ChatSidebarList` / `ChatTaskPanel` |
| 通知通道管理 | 253–489 | `NotifyChannelPanel` |
| 任务表单 | 490–1064、1073–1381 | `ChatTaskPanel` |
| 任务时间选择器 | 1382–1594 | `TaskDatePicker` |
| 快捷操作导航 | 1595–1645 | `ChatSidebarList` |
| 骨架/拖拽/状态点 | 1646–1750 | 对应列表组件 |
| 删除确认弹窗 | 970–1014 | `ConfirmDialog` |

必须留根 `chat-page.css`：

- `.chat` / `.sidebar` / `.main` 布局骨架（1–30）。
- `.group-head` 及 `__label/__count/__caret`（1754–1803）；注释明确记录过拆分回归。
- `.modal-mask` / `.modal` / `.modal__head` / `.modal__body` / `.modal__foot`（491–560、952–969）。
- `.task-groups` / `.task-groups-empty`（1806–1819）。
- `.conv-dot` / `.chip` / `.warn-line` 等通用修饰类。

## 9. 风险与控制

| 风险 | 证据 / 触发 | 控制 |
|---|---|---|
| 按职责逐组抽导致 setup 期 undefined | SCC A/B/C 已确认成环 | 只按 SCC 提交，不按小职责组提交 |
| Run 反向依赖 UI 状态 | `applyChatEvent` 读滚动/推理/模型符号 | SCC C 先抽，Run 留在协调层通过 ComposableApi 使用 |
| provide 41 键断裂 | 7 个裸 import、约 37 个 inject-only 键 | `satisfies BubbleContext` + 长度断言；气泡功能手测 |
| 卸载清理双重/遗漏 | `effectScope.stop()` 不停原始 `setTimeout` | `pageUnmounted` + 显式定时器清理，同一资源只一套机制 |
| 模板 ref 丢失 | `threadEl/inputEl/confirmPrimaryBtn` 等 | 根层同名暴露；子组件 `defineExpose`；Chrome 手测 |
| v-model 契约断裂 | `current.input`、`outlineOpen`、`taskDraft.*` | 每个子组件显式定义 emits；不复制 ref，不转普通值 |
| 事件冒泡 / Esc 优先级 | `@click.stop`、Esc capture、Teleport | 保持原生 DOM 层级；UI 抽取逐组件手测 |
| CSS 作用域回归 | `.group-head` 曾因 scoped 下沉导致裸奔 | 共享基类留根；每块 CSS 下沉后截图对比 |
| chunk 边界变化 | composables 若动态 import 会多 chunk | 所有 composables 同步 import；构建确认 `ChatPage-*` 唯一 |
| 范围蔓延 | 顺手修 P1-3～P1-7 | 明确不做；每 SCC / 每组件单提交 |

## 10. 明确不做

- 不做 P1-2（CI 恢复 `vue-tsc` 阻断）；它必须在阶段 2 全绿且 `vue-tsc` 连续稳定后单独做。
- 不做 P1-3～P1-7、A/B 重跑、BI 治理、后端/API 变更。
- 不改路由语义、不改 `App.vue` 的 `:key="$route.path"`。
- 不把 composables 做成动态 import。
- 不为“顺手优化”改 `.catch` 静默行为；错误处理归 P1-4。
- 不在本设计批准前改代码。

## 11. 交付物与下一步

本文档只定义阶段 2 的设计边界、SCC、UI/CSS 边界、风险与验收。用户审阅确认后，再写细化实施计划（逐文件、逐命令、逐回滚点）。阶段 2 当前状态：**仅设计，未实施**。
