# 实现计划：ChatPage 阶段 2 细化实施（SCC 拆分 + UI 子组件 + CSS 下沉）

- 日期：2026-11-19
- 状态：**执行中｜C0/T0/T1/T2/T3/T4/T5（C6–C9）已提交，T6 C10 `58bd836`、C11 `383630e`、C12 `5de59a9`、C13 `f9e8ac8` 已提交，CSS 作用域修复 `f702e85`、UiSelect 注册修复 `1d441cd` 已提交**（2026-11-19 复核）
- 用户指令依据：2026-11-19「写细化计划吧」——按 `docs/superpowers/specs/2026-11-18-chat-page-phase2-design.md` 已被审阅确认处理。
- 执行记录（2026-11-19）：
  - C0 文档提交 `6709f4a`。
  - T0 `useChatPersistence` + `chat-page-types.ts` 提交 `37d8663`（`useChatPageCore.ts` 6269→5959 行）。门禁全绿：build / type-check / web test / server test / diff / 单 chunk。
  - T1 SCC C 拆三件（`useChatModelSettings` / `useChatThreadScroll` / `useChatReasoningUI`）提交 `3f6d81c`（协调层再降约 340 行）。门禁全绿。
  - T2（SCC A）**已提交 `23c9d28`**：先补齐 33 个 web 行为测试与 AST 依赖/TDZ 审计，再按裁剪边界把会话壳（排序/切换/草稿建会话/右键/删除撤销）迁入 `useChatConversationShell.ts`；`useChatPageCore.ts` 降到 5345 行。拆分后 33 个 web 测试、全仓 type-check、build、978 个 server 测试全绿；provide 41 键契约加固仍留 T4。
  - T3（SCC B）已提交 `1bbf757`：先补 `apps/web/tests/chat-tool-panels.test.ts`（9 个特征测试）锁定三飞出互斥/query 重置、MCP 逐行 busy 与回滚、fuzzy 搜索、专家 chip/starter、任务飞出层共享引用、bound MCP 合并落库；再按 37 个跨组依赖注入拆出 `useChatToolPanels.ts`（603 行），协调层降到 4918 行。AST 对比 50 个声明全部行为等价（无 DIFF），42 web 测试、全仓 type-check、build、978 server 测试全绿，仍为单个 ChatPage chunk。
  - T4（provide 契约加固）已提交 `dab6470`：新增 `apps/web/tests/bubble-context-contract.test.ts`（3 个契约测试）锁 provide/interface/ChatBubble 三者 41 键顺序与 guard 存在；`useChatPageCore.ts` 原位抽 `bubbleContext`，加 `satisfies BubbleContext` 与 DEV 数量断言，`bubble-context.ts` 无需改动。web 测试 42→45，全仓 type-check、连续 3 次 web type-check、build、978 server 测试全绿，仍是单个 ChatPage chunk。
  - T5 C6（DoneToast）已提交 `8631510`：新增 `components/chat/DoneToast.vue`，Teleport 与 done-toast DOM 原样搬入，props `doneToast` + emits `view/close`；根层保留 `doneToast` ref、`doneToastTimer`、`openDoneToast` 与关闭清理。web 45/45、web type-check、build 全绿，仍是单个 ChatPage chunk。
  - T5 C7（ArtifactPreviewModal）已提交 `aa556d0`：新增 `components/chat/ArtifactPreviewModal.vue`，props `previewHtml/previewLoading/downloadUrl` + emits `close`；下载 URL 由根层基于 `workspaceDownloadUrl(currentId, previewHtml.path)` 计算后传入，iframe `sandbox="allow-scripts"` 不变。web 45/45、web type-check、build 全绿，仍是单个 ChatPage chunk。
  - T5 C8（ConfirmDialog）已提交 `dbb4569`：新增 `components/chat/ConfirmDialog.vue`，Teleport/DOM 与 Esc、Tab handler 原样搬入；props `confirmDialog`，emits `confirm/cancel/trap`。子组件 `defineExpose` 暴露 `confirmDialogEl`/`confirmPrimaryBtn`，根层用函数 ref 桥接回协调层，`trapConfirmFocus` 与 body overflow watch 仍留根。web 45/45、web type-check、build 全绿，仍是单个 ChatPage chunk。
  - T5 C9（ChatThread）已提交 `e87c4b0`：新增 `components/chat/ChatThread.vue`，整段 `.thread` 容器搬入；根层通过 props 传 visible/bubbleCount/outline 等状态，通过 emits 接回 scroll/showEarlier/askStarter/jump/active/v-model:open；`threadEl` 由子组件 `defineExpose`，根层函数 ref 桥接。web 45/45、web type-check、build 全绿，仍是单个 ChatPage chunk。
  - C10 前置方案校准文档提交 `0064d33`：修正旧计划中 `locations`、Esc capture、Shift+F10 三处与当前代码不符的描述，并锁定 19 个动作 emit + 1 个 keydown 转发、5 个 props、`ctxMenuEl` expose/ref 桥接、红测先行和 11 步交互推演（见 §9.1）。
  - T6 C10（`ContextMenuHost`）**已提交 `58bd836`**：新增 `components/chat/ContextMenuHost.vue` 与 `tests/context-menu-host-contract.test.ts`（4 个源码契约用例），Teleport/DOM/`role`/`data-ctx-confirm` 原样搬入；19 个动作 emit + keydown 转发接回根层，全局监听与焦点归还继续留根，`ctxMenuEl` 用 expose/函数 ref 桥接；根解构 654→655。web 49/49、web type-check、全仓 type-check、build、978 server 测试全绿，仍是单个 ChatPage chunk。
  - C11 前置方案校准文档提交 `e2a1818`：锁定 39 props / 29 emits、3 处 aside 右键入口、`agentMenuEl`/`convListEl` 双 ref 桥接、遮罩留根与 13 步推演；实施时修正 `TaskGroupRun.conv` 类型与右键入口计数。
  - T6 C11（`ChatSidebarList`）**已提交 `383630e`**：新增 `components/chat/ChatSidebarList.vue` 与 `tests/chat-sidebar-list-contract.test.ts`（4 个源码契约用例），aside DOM 原样搬入；39 props / 29 emits 接回根层，三处 `v-model` 契约与 `setRenameInput` 函数 prop 保持，双 DOM ref 桥接；遮罩、全局监听、localStorage 折叠、拖拽/右键/删除/清空状态全留根。根解构 655→656；C10 契约的根解构断言改下界 655。web 53/53、web type-check、全仓 type-check、build、978 server 测试全绿，仍是单个 ChatPage chunk。
  - C12 前置方案校准文档提交 `89b8c17`：修正源块行号、Teleport/工具飞出、`onInlineSubmitKeydown` 与 `inputEl` 四处旧描述，锁定 39 props / 38 emits、四 DOM ref 桥接和 14 步推演。
  - T6 C12（`MessageComposer`）**已提交 `5de59a9`**：新增 `components/chat/MessageComposer.vue` 与 `tests/message-composer-contract.test.ts`（5 个源码契约用例），footer DOM / PromptBox 三 slot / 工具飞出原样搬入；39 props / 38 emits 接回根层，`current.input` 走 `modelValue`，三处查询 v-model 与四个 DOM ref 桥接保持；全局监听、发送/停止、队列/附件/resize 全留根。根解构 656→657；C11 契约的根解构断言改下界 656。实施中修正 `move-queue-item` 方向类型、`skill-created(dir)` / `mcp-created(id)` 载荷与 SFC 顶层 `</template>`。web 58/58、web type-check、全仓 type-check、build、978 server 测试全绿，仍是单个 ChatPage chunk。
  - C13 前置方案校准文档提交 `e9d56f9`：锁定 63 props / 40 emits、外层 Teleport 上的 `v-if`、四个 expose、三类 patch 桥与 14 步推演；实施中修正 props 计数（61→63，补 `isDtToday` / `isDtPicked`）与日期 prop 类型（`dtHours` / `dtMinutes` 为 `string[]`）。
  - T6 C13（`ChatTaskPanel`）**已提交 `f9e8ac8`**：新增 `components/chat/ChatTaskPanel.vue` 与 `tests/chat-task-panel-contract.test.ts`（5 个源码契约用例），任务表单外层 Teleport 与两个内部 `to="body"` 原样搬入；63 props / 40 emits 接回根层，`taskDraft` / `taskRepeat` / `channelDraft` 通过三类 patch emit 回写，根层三个 `Object.assign` 桥接函数与四个 DOM ref 桥接保持；Esc capture、outside/scroll/resize、body overflow、提交/通道 CRUD 全留根。根解构 657→658。实施中修正 props 计数与日期 prop 类型。web 63/63、web type-check、全仓 type-check、build、978 server 测试全绿，仍是单个 ChatPage chunk。
  - **CSS 作用域回归修复 `f702e85`**：C6–C13 抽出的组件与 Teleport 内容不再带 ChatPage 的 scoped 属性，导致 `chat-page.css` 的 `.task-panel[data-v-…]` 等规则全部失配。去掉 `ChatPage.vue` 的 `scoped`，把 5 处 `:deep()` 转为普通后代选择器，并在 C13 契约里锁死该约束；Chrome 实测任务表单、`sidebar`、`composer` 计算样式恢复。web 63/63、全仓 type-check/build/978 server 测试全绿，单 ChatPage chunk。
  - **UiSelect 注册修复 `1d441cd`**：`ChatTaskPanel.vue` 模板中两处 `<UiSelect>` 只依赖 ChatPage core 的返回值，子组件作用域无法解析；补 `import UiSelect from "../UiSelect.vue"` 并在契约里锁定 import 与两处使用。逐个审计 8 个抽取组件的大写标签，无其它未注册组件；Chrome 打开频率/通知弹窗后两个 `UiSelect` 正常渲染，warn/error 为零。全门禁全绿。
- 对应设计：
  - `docs/superpowers/specs/2026-11-17-chat-page-refactor-design.md`
  - `docs/superpowers/specs/2026-11-18-chat-page-phase2-design.md`
  - `docs/superpowers/plans/2026-11-17-chat-page-core-extraction-plan.md`
- 基线提交：`5e962ca refactor(web): extract ChatPage core and harden frontend`
- 范围：`apps/web/src/composables/chat/useChatPageCore.ts`、`apps/web/src/pages/ChatPage.vue`、`apps/web/src/pages/chat-page.css`、新增 composables / UI 子组件 / 对应 CSS。

## 0. 开工前必须确认的事实

### 0.1 基线快照

> 原基线（阶段 1 提交 `5e962ca`）：`useChatPageCore.ts` 6269 行 / 266,245 字节。
> 本文记录时（T1 提交 `3f6d81c` 后）实测：协调层已降到约 5600 行；`ChatPage.vue` 2779 行、`chat-page.css` 4142 行未变。
> 下方表格保留原基线作历史对照；T2+ 若开工，须以当时 `git status` + 行数实测为准，不照抄此表。

| 文件 | 原基线行数 / 大小 | 说明 |
|---|---:|---|
| `apps/web/src/composables/chat/useChatPageCore.ts` | 6269 行 / 266,245 字节 | 协调层，原 return 块 5614–6269，653 个返回值；T0/T1 后已降至约 5600 行 |
| `apps/web/src/pages/ChatPage.vue` | 2779 行 / 151,455 字节 | script 1–663、template 665–2776、style 2778（未动） |
| `apps/web/src/pages/chat-page.css` | 4142 行 / 92,705 字节 | 所有样式仍在页面级（未动） |

开工前执行：

```powershell
git -C d:/Code/bx-admin-agent rev-parse --short HEAD
git -C d:/Code/bx-admin-agent status --short
(get-content d:/Code/bx-admin-agent/apps/web/src/composables/chat/useChatPageCore.ts).Count
(get-content d:/Code/bx-admin-agent/apps/web/src/pages/ChatPage.vue).Count
(get-content d:/Code/bx-admin-agent/apps/web/src/pages/chat-page.css).Count
git -C d:/Code/bx-admin-agent diff --check
```

判定：

- HEAD 必须是 `5e962ca`（除非后续文档提交已入库，此时以最新提交为准，但三个代码文件必须无未提交改动）。
- 三个代码文件不得出现在 `git status --short` 中；若存在改动，先停止并查清来源。
- 行数与大小若与设计基线不符，先回写基线再实施，禁止带着未知漂移开工。

### 0.2 文档提交（已完成）

**C0 文档提交 `6709f4a`** 已入库：

```text
docs(web): record ChatPage phase2 design and implementation plan
```

包含：`docs/README.md`、`docs/engineering-optimization-review.md`、
`docs/superpowers/specs/2026-11-18-chat-page-phase2-design.md`、本计划文件。

本次「文档对齐」的修订（进度回写 + §0.3 偏差表 + §5 边界修正）作为 C0 增补独立提交，仍与代码提交分离。

### 0.3 设计文档与代码快照的偏差（以代码符号为准）

实施时不得照抄设计文档中的旧行号/伪符号；已核对的偏差如下：

| 设计文档说法 | 代码实际 | 处理 |
|---|---|---|
| 快照归一化组 `2346–2507` | 实际 `chartsOf` 起于 2346，核心组 2357–2524，且 `persist`/`persistNow` 紧随其后 | 按符号搬迁，扩展为完整持久化组 |
| `modelSettings` / `applyModel` | 不是真实符号 | 用 `modelId` / `resolveModel` / `saveModelChoice` / `onLocaleChange` / `resolvedModelId` 等真实符号 |
| `openCloseReasoningPanel` | 不存在 | 用 `openReasoningPanel` / `closeReasoningPanel` |
| `v-model:outlineOpen` | 实际 `v-model:open`（`ChatPage.vue:2271`） | 子组件 props 名用 `open` |
| `#task-panel-host` 旧行号 | 当前在 `ChatPage.vue:2073` | 只按 id 定位，不按行号 |
| `ChatThread` 等 UI 子组件 | 当前不存在对应 `.vue` 文件 | 它们是本计划要新建的抽取边界，不是既有组件 |
| 根 `pnpm test` | 只跑 `@bx/agent-server` | 每步必须额外跑 `pnpm --filter @bx/web test` |

**T2（SCC A）专项偏差（2026-11-19 代码核对，§5 与 §设计 4 节据此修正）**：

| 计划/设计说法 | 代码实际（T1 后现文件、按符号） | 处理 |
|---|---|---|
| `selectConversation → showSettingsError` | 不存在。`showSettingsError`（现由 `useChatModelSettings` 解构）在 `openConversationById`、`commitRename`、`togglePin`、`applyConversationOrder` 等处调用，`selectConversation` 函数体内 0 次 | T2 搬迁清单不列此调用边；`selectConversation` 只保留真实的跨组边（见 §5.3） |
| `newConversation → boundMcpIds（读写）` | 不成立。`newConversation` 只清 `blank.settings.mcpEnabled = []`；读 `boundMcpIds.value` 的是 `createConvFromDraft`（合并进草稿 MCP 集） | `boundMcpIds` 作为 option 注入，边界落在 `createConvFromDraft` |
| `submitTask` 用到 `mcpAvailable`/`skillAvailable`/`expertAgents` | 不直接用。`submitTask` 只 slice `taskDraft.mcpServers` / `taskDraft.skills`；三个可用集被**任务飞出层 computed**（`taskSkillFiltered`/`taskMcpFiltered`/`taskExpertFiltered`/`taskMcpCount`/`taskAgentLabel`）使用，函数定义在任务表单区（现约 566–611） | 飞出层 computed 与 `taskDraft` 一起留协调层，不随会话壳搬走；SCC B 仍通过 `taskDraft` 引用 |
| `flushPendingDelete`/`scheduleUndoDelete` 用 `pageUnmounted`/`deferOnPage` | 不直接用。二者只碰 `undoDeleteTimer`/`undoDelete`/`UNDO_DELETE_MS`/`deleteConversationOnServer`；与生命周期的唯一连接是 `onBeforeUnmount` 调 `flushPendingDelete()` | 删除组搬入 composable；内部 `let` 不导出，协调层 `onBeforeUnmount` 仍转调 `flushPendingDelete()`（不额外造 `dispose()`） |
| `sortMode` 被列为「排序动作」 | `sortMode` 是 `ref<ConvSortMode>`（约 1491），不是动作；动作是 `resortConversations`/`applyConversationOrder`/`restoreRecentSort`/`reloadConversations` | 状态留根按引用注入，动作随会话壳搬 |
| SCC A 规模被低估（计划列约 40 符号） | 实际 100+ 符号，散落约 154–2987 行，横跨任务表单/飞出层/日期选择器、会话动作、拖拽键盘、右键删除、确认弹窗、重命名，且与 SCC B 共享 `taskDraft`/飞出层 | **按 §5.4 裁剪边界落地**：只搬会话壳核心（30 个跨组依赖已 AST 盘点），任务表单与飞出层留根；T2 已提交 `23c9d28` |

**规模/安全网提示**：T0/T1 的门禁主要覆盖类型/构建/后端；SCC A 是 UI 交互密集区，机械搬迁可能产生「编译通过但交互静默回归」。因此 T2 开工前已补 `chat-composables.test.ts` + `chat-shell.test.ts`（共 33 用例），并以 AST 依赖清单/TDZ 注入规则约束拆分；Chrome 冒烟因浏览器实例冲突仍为非阻塞后续项。

## 1. 全局约束与统一迁移手法

### 1.1 不变量（每步都要守住）

1. `ChatPage.vue` 根层保留 `defineProps`、`useRouter`、`import type { ScheduleDto }`；顶层同名解构原为 653，T5 后 654，C10 后 655，C11 后 656，C12 后 657，C13 后 658。
2. `useChatPageCore.ts` 继续是同步 setup 协调层；`provide`、`onMounted`、`onBeforeUnmount`、`watch`、全局键鼠监听的同步调用链不得被 `await` 打断。
3. `RouterView :key="$route.path"` 重挂载语义不变（`App.vue`）。
4. `provide(bubbleContextKey, {...})` 的 41 键逐项保留、顺序不变；在 T4 做类型与数量加固。
5. `pageUnmounted` / `unmountTimers` / `deferOnPage()` 与 4 个具名定时器继续统一在协调层清理：
   - `settingsErrorTimer`
   - `clearArmTimer`
   - `copyToastTimer`
   - `activeReportTimer`
6. 每页实例状态不得模块单例化：`states`、`persistedCount`、`seq`、`conversations`、`currentId`、`ctxMenu`、`undoDelete`、`queueSetChains`、`pendingPersists` / `persistChains` 等必须留在实例内，通过 options/getter 传递。
7. 所有 composables 同步 `import`；禁止动态 import，构建产物仍必须只有一份 `ChatPage-*.js` / `ChatPage-*.css`。
8. 模板、CSS、函数体、watch/timer/provide 内容在逻辑拆分阶段一律不改；UI 阶段只做结构等价替换。
9. 不顺手修 P1-3～P1-7、不碰 BI、不改后端/API、不做 A/B 重跑。
10. P1-2（`vue-tsc` CI 阻断）在本计划全部步骤全绿且连续稳定后单独变更，不混入任何拆分提交。

### 1.2 统一迁移手法

每个 SCC 步骤都用同一套机械操作：

1. 在新文件中原样搬入选定符号的声明与函数体，只改 import 路径与必要的类型引用。
2. 在协调层用 `const { ... } = useXxx({ ... })` 接住返回值；名字必须与搬迁前完全一致。
3. 协调层和模板的调用点保持原名、原调用形式，不改成 `core.xxx` / `persistence.xxx`。
4. 新 composable 的 options 只传引用/回调/getter，不传 `ref.value` 快照；对 `let` 原始值（`conversationSyncing`、`pendingSyncId`、`followBottom` 等）把读写留在 composable 内部，协调层仅保留同名只读快照以满足 653 返回表。
5. 对“定义位置在后、调用位置在前”的函数（`syncOpenConversation`、`queueScroll`、`stickThinkingToBottom`、`ensureRunPrompt` 等），在协调层用 **函数声明薄代理** + 回调注入解决引用提前问题；薄代理在 setup 同步阶段不得被调用，搬迁后用搜索确认。
6. 每步提交前执行符号搜索：被搬走的符号不得在 `useChatPageCore.ts` 中残留同名声明；新 composable 中不得引用未注入的根状态。
7. 每步单独提交、单独验证、单独回滚；失败只回退该步。

### 1.3 通用验证命令（每步提交前执行）

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm type-check
pnpm test
pnpm --filter @bx/web test
git diff --check
Get-ChildItem -Name apps/web/dist/assets/ChatPage-*
```

判定：

- 前 6 个命令退出码必须为 0。
- `apps/web/dist/assets/ChatPage-*` 仍只有一份 JS / CSS。
- `pnpm test` 与 `pnpm --filter @bx/web test` 都必须跑，原因见 0.3。

### 1.4 通用 Chrome 手工清单（每步至少跑一次）

- `/chat -> /support -> /movie -> /chat`：标题、Agent 身份、输入框占位符正确，每次 path 变化重挂载。
- 发送普通消息并收到流式回复；停止、续传、刷新恢复正常。
- 任务表单、MCP 面板、技能面板、工具搜索、专家入口正常。
- 右键菜单、删除撤销、归档/免打扰/发送模式、大纲、队列、复制气泡、记忆/工作区面板正常。
- Console 无 error。

## 2. 提交粒度总表

| 提交 | 内容 | 主要文件 | 状态（2026-11-19） |
|---|---|---|---|
| C0 | 文档状态回写 + 本计划 | `docs/**` | ✅ `6709f4a`（本次对齐为 C0 增补） |
| C1 | T0 `useChatPersistence` | 新增 composable + `useChatPageCore.ts` | ✅ `37d8663` |
| C2 | T1 SCC C | 新增 3 个 composable + `useChatPageCore.ts` | ✅ `3f6d81c` |
| C3 | T2 SCC A（裁剪边界，见 §5.3） | 新增 `useChatConversationShell.ts` + `useChatPageCore.ts` + `ChatPage.vue` | ✅ 已提交 `23c9d28`：33 web 测试 + 全门禁绿 |
| C4 | T3 SCC B | 新增 `useChatToolPanels.ts` + `useChatPageCore.ts` + `chat-tool-panels.test.ts` | ✅ 已提交 `1bbf757`：50 声明 AST 无 DIFF，web 42/42 + 全门禁绿 |
| C5 | T4 provide 契约加固 | `useChatPageCore.ts`、新增 `tests/bubble-context-contract.test.ts` | ✅ 已提交 `dab6470`：web 45/45 + 全门禁绿，bubble-context.ts 无需改动 |
| C6 | T5 `DoneToast.vue` | 新增 `components/chat/DoneToast.vue` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `8631510`：Teleport/DOM 原样搬入，web 45/45 + 单 chunk |
| C7 | T5 `ArtifactPreviewModal.vue` | 新增 `components/chat/ArtifactPreviewModal.vue` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `aa556d0`：sandbox 不变，downloadUrl 根层计算，web 45/45 + 单 chunk |
| C8 | T5 `ConfirmDialog.vue` | 新增 `components/chat/ConfirmDialog.vue` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `dbb4569`：expose ref 桥接，focus trap/overflow 留根，web 45/45 + 单 chunk |
| C9 | T5 `ChatThread.vue` | 新增 `components/chat/ChatThread.vue` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `e87c4b0`：threadEl bridge + outline v-model，web 45/45 + 单 chunk |
| C10 | T6 `ContextMenuHost.vue` | 新增 `components/chat/ContextMenuHost.vue` + `tests/context-menu-host-contract.test.ts` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `58bd836`：19 动作 + keydown emit，expose/ref 桥接，web 49/49 + 全门禁绿 |
| C11 | T6 `ChatSidebarList.vue` | 新增 `components/chat/ChatSidebarList.vue` + `tests/chat-sidebar-list-contract.test.ts` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `383630e`：39 props / 29 emits、双 ref 桥接、遮罩留根，web 53/53 + 全门禁绿 |
| C12 | T6 `MessageComposer.vue` | 新增 `components/chat/MessageComposer.vue` + `tests/message-composer-contract.test.ts` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已提交 `5de59a9`：39 props / 38 emits、四 ref 桥接、全局监听留根，web 58/58 + 全门禁绿 |
| C13 | T6 其余高风险 UI | 同上 | ✅ 已提交 `f9e8ac8`：63 props / 40 emits、四 ref 桥接、三类 patch 留根，web 63/63 + 全门禁绿 |
| C14+ | T7 CSS 下沉（按注释块逐块提交） | 新增 `components/chat/*.css` + `chat-page.css` | ⏳ 依赖 UI 子组件就位 |

任何一步失败：未提交则 `git restore` 该步文件；已提交则 `git revert <sha>`。禁止把多步合并成一次提交。

## 3. T0：抽 `useChatPersistence`

### 3.1 目标

把快照归一化、服务端快照铺回、落库串行化与清空竞态等待集中到一个 composable，消除协调层里最大的前置依赖块。行为零变化。

### 3.2 搬迁符号（以符号名定位，不按行号）

新增 `apps/web/src/composables/chat/useChatPersistence.ts`，搬入：

- 常量/工具：`SNAPSHOT_DETAIL_TAIL`、`SNAPSHOT_THINKING_CAP`、`SNAPSHOT_STEP_RESULT_CAP`、`capTail`、`chartsOf`、`settleStep`、`toStored`、`bubblesFromStored`、`tailSig`、`serverThreadAhead`
- 快照应用：`applyServerThread`、`upgradeConversationDetail`、`syncOpenConversation`
- 落库状态机：`conversationSyncing`、`pendingSyncId`、`pendingPersists`、`persistChains`、`waitPendingPersists`、`persist`、`persistNow`

说明：设计文档只列到 `waitPendingPersists`，但 `pendingPersists` / `persistChains` 的写入方是 `persist`，`persistNow` 又调用 `toStored` 并写 `persistedCount` / `conversations`；为避免再次跨文件拆同一状态机，本步一并搬迁。

### 3.3 Options 契约

`useChatPersistence(options)` 至少包含：

| 字段 | 来源 | 用途 |
|---|---|---|
| `states` | 根 `reactive(Map)` | `applyServerThread` / `syncOpenConversation` 读写每页会话状态 |
| `currentId` | 根 `Ref<string>` | 判断“是否当前对话”、是否允许跟底 |
| `conversations` | 根 `Ref<ConversationDto[]>` | `persistNow` 读服务端快照长度、回写标题 |
| `persistedCount` | 根 `Map<string, number>` | 增量落库水位，必须保持实例级 |
| `nextSeq` | `() => ++seq` | `bubblesFromStored` 生成气泡 id，统一使用根计数器 |
| `atBottomNow` | `() => boolean` | `applyServerThread` 在内容变高前量“用户是否贴底” |
| `queueScroll` | `(force?: boolean) => void` | 强制回底 |
| `ensureRunPrompt` | `(state, userText, startedAt) => void` | 正在跟流时补齐本期提问 |
| `attachRunningTask` | `(convId) => Promise<void>` | 服务端仍在跑时接事件流 |
| `messageTimes` | 根纯函数 | 由服务端消息生成时间戳；本步留在根，回调注入 |

返回值：上节所有搬迁符号同名返回；`conversationSyncing` / `pendingSyncId` 也返回同名只读快照，满足 653 返回表（模板未用，但根解构包含它们）。

### 3.4 协调层改动

1. 删除上述符号在 `useChatPageCore.ts` 中的声明/定义。
2. 在原 `chartsOf` 位置附近插入 `const { ... } = useChatPersistence({ ... })`；回调用函数声明或 arrow 包装，避免 TDZ。
3. 搜索确认 `syncOpenConversation` 在 `tasksPoll`（约 202 行）中的调用仍可解析；`startTasksPoll()` 只在 `onMounted`（约 5452 行）调用，因此 destructuring 初始化晚于函数定义是安全的。
4. `useChatPageCore.ts` 的 `return { ... }` 不改，`ChatPage.vue` 根解构不改。

### 3.5 验证重点

- 首屏恢复、刷新/续传、并发多 run 收束。
- 切对话后后台流不写错会话。
- 清空对话竞态：`waitPendingPersists` 必须在 `/clear` 前等完在途落库。
- `persistedCount` 水位不回退、不重复全量上传。
- 通用验证命令 + Chrome 清单。

### 3.6 提交信息

```text
refactor(web): extract chat persistence composable
```

## 4. T1：拆 SCC C（模型设置 → 滚动 → 推理 UI）

### 4.1 目标

把 UI 状态三元组按固定顺序拆成 3 个 composables，保持 Run 层通过回调/ComposableApi 使用它们。

### 4.2 新增文件与搬迁符号

**`useChatModelSettings.ts`**

- `models`、`modelsLoaded`、`modelId`、`lastGoodModelId`、`failedModelIds`、`resolveModel`、`settingsErrorTimer`、`showSettingsError`、`syncConvLocal`、`applyConversationLocale`、`modelChoiceLabel`、`modelSwitchHint`、`saveModelChoice`、`onLocaleChange`、`resolvedModelId`、`modelSupportsImages`、`imagesUnsupported`

**`useChatThreadScroll.ts`**

- `scrollQueued`、`scrollForce`、`queueScrollIfCurrent`、`followBottom`、`nearBottom`、`atBottomNow`、`onThreadScroll`、`queueScroll`

**`useChatReasoningUI.ts`**

- `openReasoning`、`reasoningCollapsedByUser`、`toggleReasoning`、`openReasoningPanel`、`closeReasoningPanel`、`openSteps`、`stepKey`、`toggleStep`、`stepSummary`、`hasRunningStep`、`hasThinking`、`INTENT_RE`、`intentOf`、`thinkingDisplay`、`thinkStarts`、`thinkPhaseStart`、`thinkPhaseEnd`、`thinkLabel`、`thinkStickQueued`、`stickThinkingToBottom`、`reasoningTitle`

`seq`、`threadEl`、`currentId`、`current`、`conversations`、`states`、`pinnedOutlineId` 等继续留根，作为 options/getter 传入。

### 4.3 调用边与处理

| 边 | 证据 | 处理 |
|---|---|---|
| `saveModelChoice -> queueScroll(true)` | 约 2071 行 | 根层保持 `function queueScroll` 薄代理，转发到 threadScroll composable；modelSettings 通过 option 拿到该代理 |
| `toggleReasoning -> stickThinkingToBottom()` | 约 2209 行 | 根层保持 `function stickThinkingToBottom` 薄代理，转发到 reasoningUI composable |
| `applyChatEvent -> atBottomNow/queueScrollIfCurrent/thinkPhase*/openReasoningPanel/closeReasoningPanel/lastGoodModelId` | 约 3813–3833 行 | Run 留在协调层，直接用同名解构调用，不改调用形式 |
| `runTurn -> failedModelIds/thinkPhaseEnd/queueScrollIfCurrent` | 约 4001–4015 行 | 同上 |
| `onThreadScroll -> releaseOutlinePin` | 约 2165 行 | 注入回调，不把大纲组提前拆进来 |
| `applyServerThread -> atBottomNow/queueScroll` | 约 2441/2448 行 | T0 composable 的 option 指向根层同名代理 |

内部初始化顺序固定为 `useChatModelSettings` → `useChatThreadScroll` → `useChatReasoningUI`。薄代理只在事件/异步回调中被调用；实施后用搜索确认没有 setup 同步调用发生在初始化前。

### 4.4 最小返回面

- modelSettings：`modelId`、`resolveModel`、`resolvedModelId`、`lastGoodModelId`、`failedModelIds`、`saveModelChoice`、`onLocaleChange`、`applyConversationLocale`、`models`、`modelsLoaded`、`modelSupportsImages`、`imagesUnsupported`、`showSettingsError`
- threadScroll：`atBottomNow`、`queueScroll`、`queueScrollIfCurrent`、`onThreadScroll`、`followBottom` 的 getter（不得复制普通值）
- reasoningUI：`thinkPhaseStart`、`thinkPhaseEnd`、`stickThinkingToBottom`、`openReasoningPanel`、`closeReasoningPanel`、`openReasoning`、`toggleReasoning`、`openSteps`、`toggleStep`、`reasoningTitle`、`thinkLabel`、`hasThinking`、`intentOf`、`thinkingDisplay`、`stepKey`、`stepSummary`

返回值仍要在 `useChatPageCore.ts` 的 653 表中保留原名。

### 4.5 验证重点

- 发送/停止后焦点接管正确。
- 生成中上滚不被增量拉回；用户主动发送强制回底。
- 思考计时、推理面板展开/收起、步骤展开正常。
- 模型 auto 模式、失败黑名单、切模型提示与回滚正常。
- 通用验证命令 + Chrome 清单。

### 4.6 提交信息

```text
refactor(web): split chat settings scroll and reasoning composables
```

## 5. T2：拆 SCC A（会话壳 / 列表 / 右键 / 任务 / 删除撤销）

### 5.1 目标（已修订）

把互相成环的会话动作抽为 composable；共享状态留根避免单例化。
**但字面量搬迁整个 §5.3 原始清单不可行**：实际符号 100+、与 SCC B 共享 `taskDraft`/飞出层，且 §0.3 列出 4 处事实偏差。
因此采用设计文档 §4 允许的「共享状态留根后再拆」裁剪边界：**会话壳核心先搬，任务表单与飞出层留根**。

### 5.2 新增文件

`apps/web/src/composables/chat/useChatConversationShell.ts`

### 5.3 搬迁符号（修订后的裁剪边界）

**第一批搬入 composable（会话壳核心，内部成环、跨组依赖可注入）**：
- 列表/排序动作：`refreshConversationsQuiet`、`resortConversations`、`convRank`、`CONV_ORDER_STEP`、`applyConversationOrder`、`restoreRecentSort`、`reloadConversations`
- 会话动作：`selectConversation`、`newConversation`、`createConvFromDraft`
- 右键/删除：`ctxMenu`、`ctxConfirm`、`ctxTarget`、`ctxAnchorPos`、`placeCtxMenu`、`openCtxMenu`、`openTaskCtxMenu`、`closeCtxMenu`、`armCtxConfirm`、`askDeleteFromCtx`、`askCloseOthers`、`removeConversation`、`deleteConversationOnServer`、`flushPendingDelete`、`scheduleUndoDelete`、`undoRemoveConversation`、`undoDelete`、`undoDeleteTimer`、`UNDO_DELETE_MS`

**留根（不随会话壳搬，注释原因）**：
- 任务表单全组：`tasks`、`showTaskForm`、`showTaskList`、`taskError`、`taskDraft`、`editingTaskId`、`cronUnparsed`、`freqDialogOpen`、`notifyDialogOpen`、`loadTasks`、`openTaskForm`、`closeTaskForm`、`submitTask` 及全部 `task*Of` 别名与飞出层 computed（`taskSkillFiltered`/`taskMcpFiltered`/`taskExpertFiltered`/`taskMcpCount`/`taskAgentLabel`）——`taskDraft` 是 A↔B 桥接状态，飞出层与 MCP/Skills 组深度耦合（§0.3）；留根后 T3 无需跨文件访问。
- 会话 toggle 与批量操作：`togglePin`、`toggleArchive`、`toggleMute`、`toggleFullAccess`、`toggleSendMode`、`duplicateCurrent`、`exportConversation`、`closeOtherConversations`、`clearConversationById`——仅调用 `closeCtxMenu`/`selectConversation`/`resortConversations`，它们从 composable 解构回协调层后同名自动解析，无需搬函数体。
- 二次确认与重命名：`confirmDialog` 系列、`trapConfirmFocus`、`clearArmTimer`/`clearArmFor`、`onClearCurrentClick`、重命名 5 函数——与模板 refs 强绑定，UI 阶段（T5/T6）再处理。
- 拖拽/键盘：`onConvDrag*`、`onConvKeydown`、`onConvDrop`、`moveConversation` 等——依赖 `convListEl`、`draggingId` 等模板/UI 状态。

**模板 refs 留根按引用注入**：`ctxMenuEl`、`convListEl`、`confirmDialogEl`、`confirmPrimaryBtn`、`renameInputEl`、`setRenameInput`。

### 5.4 必须留根/注入（修订）

| 内容 | 原因 |
|---|---|
| `states`、`currentId`、`current`、`stateOf`、`persistedCount`、`seq`、`blank` | 每页实例状态，快照组/C 组/bootstrap/卸载清理共用；按引用注入，禁止解包 |
| `AGENT_ID` | 页面实例常量（非 api 导出），以 `agentId: string` 注入 |
| `conversations`、`showArchived`、`sortMode` | bootstrap 与列表共用；`sortMode` 是 `ref` 不是动作（§0.3），按引用注入 |
| `ctxMenu`、`ctxMenuEl`、`ctxConfirm`、`undoDelete` | 模板与根层共享的响应式状态，留在协调层并按引用注入；`ctxTriggerEl` 是 composable 内部 let，不导出 |
| `boundMcpIds` | A↔B 桥接，留根；`createConvFromDraft` 通过 getter 注入读取（非 Ref、非 `newConversation`，§0.3） |
| `taskDraft` + 飞出层可用集 getter | 留根；T3 的 MCP/Skills 组仍直接读写同一份状态 |
| `closeTaskForm`、`showTaskList`、`loadTasks`、`watchBackgroundDone`、`reportActiveConversation`、`clearTaskUnread` | `selectConversation`/`newConversation` 反向依赖（按回调注入） |
| `loadMcp`、`loadSkills`、`queueScroll`、`syncOpenConversation`、`upgradeConversationDetail`、`applyConversationLocale` | 跨组回调/T1 返回值；注入箭头回调延迟求值 |
| `messageTimes`、`bubblesFromStored`、`toStored` | T0 返回值，直接注入；未注入 `waitPendingPersists`（原函数体不用） |
| `showSettingsError`、`localizeToken`、`getApiErrorToken`、`syncConvLocal`、`uiLocale`、`tx`、`isUiLocale` | T1 返回值 + 根文案工具，直接注入 |
| 定时器出口 | `undoDeleteTimer`/`UNDO_DELETE_MS`/`ctxTriggerEl` 留在 composable 内部；协调层 `onBeforeUnmount` 转调 `flushPendingDelete()`，留根的 `clearArmTimer` 仍自行清理；不引 `pageUnmounted`/`deferOnPage` |

**AST 精确依赖清单（2026-11-19 实测，权威）**：对 §5.3 搬入的 23 个符号做 TypeScript AST 分析，剔除局部变量后得到跨组依赖共 **30 个**（去重）：
`AGENT_ID`、`blank`、`boundMcpIds`、`clearTaskUnread`、`closeTaskForm`、`conversations`、`ctxConfirm`、`ctxMenu`、`ctxMenuEl`、`ctxTriggerEl`、`current`、`currentId`、`draftSendMode`、`loadMcp`、`loadSkills`、`loadTasks`、`messageTimes`、`persistedCount`、`reportActiveConversation`、`showArchived`、`showTaskForm`、`showTaskList`、`sidebarOpen`、`sortMode`、`stateOf`、`states`、`tx`、`uiLocale`、`undoDelete`、`watchBackgroundDone`。
其中 `ctxMenu`/`ctxConfirm`/`ctxMenuEl`/`undoDelete` 留在协调层并按引用注入（模板仍需共享），`ctxTriggerEl` 只存在于 composable 内部；其余为注入/留根项。

**注入方式规则（TDZ 实测）**：以下 8 个依赖定义在注入调用点之后，必须按对应方式传，禁止直接按值传：
- `function` 声明（提升安全，但统一用箭头回调更稳）：`clearTaskUnread`、`loadMcp`、`loadSkills`、`messageTimes`、`reportActiveConversation`、`watchBackgroundDone` → 注入 `(...args) => fn(...args)`。
- `const` 响应式引用：`boundMcpIds`（computed）与 `draftSendMode`（ref）本次均注入 getter：`() => boundMcpIds.value` / `() => draftSendMode.value`，避免直接持有稍后声明的 ref。
其余 22 个定义在注入点之前，可按引用/值直接注入。

### 5.5 成环调用的处理（修订）

搬入组内部互调：`removeConversation -> closeCtxMenu / scheduleUndoDelete / selectConversation / newConversation`、`undoRemoveConversation -> selectConversation`、`applyConversationOrder -> resortConversations / closeCtxMenu(经 restoreRecentSort)` 全部保留为 composable 内互调。
跨到根/T0/T1 的调用（`closeTaskForm`/`loadMcp`/`loadSkills`/`syncOpenConversation`/`upgradeConversationDetail`/`applyConversationLocale`/`queueScroll`/`watchBackgroundDone`/`reportActiveConversation`）只通过 options 注入回调。
留根函数（`togglePin` 等）调用搬入函数时，靠协调层同名解构自动解析，不另建薄代理。
禁止把 `selectConversation`/`newConversation` 等成环成员单独再抽一次。

### 5.6 验证重点（开工前置条件）

- **前置已完成并已用于拆分后校验（2026-11-19）**：会话壳行为安全网已建立——`apps/web/tests/chat-shell.test.ts`（13 个特征测试，通过 mock 实例化真实 `useChatPageCore`）锁定：会话切换/流式保护、草稿创建设置继承与落库、删除撤销 5s 窗口与定时器、右键菜单状态机；并用 api spy「调用链探针」断言 `selectConversation` 触发 loadMcp/loadSkills/syncOpenConversation/upgradeConversationDetail/reportActiveConversation 的下游 api 调用，防拆分漏注入。连同 T0/T1 测试与注入引用契约测试共 33 用例，**T2 拆分后已重跑并全部通过**（相关提交 `4958a53`/`f06712e`/`b80e7db`/`f96fc24`）。
- Chrome 冒烟仍需先解决 MCP 浏览器实例冲突并起 dev server（非阻塞项）。
- 会话切换后台流不中断；`selectConversation` 不写错对话；草稿创建带入 MCP/技能/发送模式。
- 删除撤销 5s 计时与 `onBeforeUnmount → flushPendingDelete()` 清理（已补主动 flush 测试，确认立即落库且 timer 不重复删）；清空竞态；切对话后后台流继续写原状态。
- 列表排序、置顶分组、归档/免打扰/发送模式切换（这些留根但依赖解构回的会话壳函数）。
- 右键菜单键盘路径（当前为 F2 直接重命名、菜单内 ↑/↓/Home/End/Tab）、chat 根区域点击关闭、Esc 优先级。
- 每页实例状态不跨路由复用。
- 通用验证命令 + Chrome 清单。

### 5.7 执行细节检查（2026-11-19 AST 审计，避免拆分出错）

对协调层做第二次 AST 审计，查清三类隐藏引用，结论如下：

**① 顶层初始化式 TDZ（无崩溃点）**：搬入符号在协调层顶层代码中只被两处生命周期回调引用——`onMounted`(4803) 用 `resortConversations`/`selectConversation`/`newConversation`，`onBeforeUnmount`(4915) 用 `flushPendingDelete`。二者都是 setup 之后才执行的延迟回调，且注册行在解构点（约 1980）之后，安全。无顶层 `const x = <搬入符号>` 的同步引用。

**② 高频被调枢纽（拆分后必须靠同名解构暴露，不能漏）**：以下搬入符号被大量**留根函数**调用，靠协调层 `const {...} = useChatConversationShell()` 同名解构解析：
- `closeCtxMenu` ← 21 处（所有 toggle*、ctx* 任务动作、rename、键盘 dismiss/escape/keydown 等）——**最高频枢纽，务必保留同名**。
- `selectConversation` ← `closeOtherConversations`/`onConvKeydown`/`openConversationById`/`openDoneToast`/`toggleArchive`。
- `resortConversations` ← `duplicateCurrent`/`openConversationById`/`submitTask`/`toggleArchive`/`togglePin`。
- `applyConversationOrder` ← `moveConversation`/`onConvDrop`（拖拽/键盘排序，留根）。
- 其余单点：`createConvFromDraft`←`send`；`flushPendingDelete`←`closeOtherConversations`；`removeConversation`←`askDeleteConversation`；`refreshConversationsQuiet`←`startTasksPoll`。
这些调用点全部不改（函数体内运行时调用，解构在 setup 阶段已完成）。

**③ 内部 let 的返回表暴露**：`ctxTriggerEl`、`undoDeleteTimer`、`UNDO_DELETE_MS` 原被 return 表暴露，但模板 `ChatPage.vue` 只在 script 解构区列出、template 段未实际使用。T2 实测确认后从 composable 返回表、`useChatPageCore` 返回表与 `ChatPage.vue` 解构区一并移除（653→650），避免导出陈旧快照；无模板行为变化。

**④ provide / watch**：`provide(bubbleContextKey, {...})`(4981) 只注入 reasoning 与留根函数，不含会话壳符号；`watch` 顶层调用未引用搬入符号。均无影响。

**执行顺序建议**：搬入组内部按依赖顺序声明（`convRank`/`CONV_ORDER_STEP` → `resortConversations` → `refreshConversationsQuiet`/`reloadConversations` → 会话动作 → 右键 → 删除撤销），与 T1 同构；options 契约用显式 interface + `satisfies` 校验，注入方式按 §5.4 的 TDZ 规则。

### 5.8 最佳实践对齐审查（2026-11-19）

基准：`docs/superpowers/specs/2026-11-17-chat-page-refactor-design.md` §9–§10 的前端工程约定。对 T0/T1 已落地代码逐条审查：

| 约定 | 结论 |
|---|---|
| ref/computed 以对象返回，不 `toValue()` 成快照 | ✅ 对齐（`toValue`/`unref` 命中 0；`let` 原始值快照属计划允许） |
| 每页实例状态不做模块单例 | ✅ 对齐（composable 状态均在函数体内；模块级仅 `AGENTS`/theme/`uiLocale`） |
| options 注入传引用/回调，不传 `.value` 快照 | ✅ 对齐（8 个定义在后符号用箭头/getter，符合 §5.4 TDZ 规则） |
| 无第三方真源分叉 | ✅ 对齐（`followBottom` 走 setter、`settingsErrorTimer` 走 dispose、`nextSeq` 共享根计数器） |
| composable 无动态 import，保持单 chunk | ✅ 对齐 |
| 卸载清理 composable 自清原始定时器 | ✅ 对齐（4 具名定时器 + 删除组 flushPendingDelete） |
| 测试覆盖响应式契约 | 🟡→✅ 已修：新增「注入引用连通」测试——composable 写 `settingsError`/`syncConvLocal` 同步到外部 ref，防传 `.value` 快照回归 |
| provide 41 键 `satisfies` + 长度断言 | 🟡 未落地：41 键完整无丢键，但无门禁；属 C5（T4）范围，拆 SCC 时不夹带 |
| 注释与实例级约定一致 | 🟡→✅ 已修：`useChatReasoningUI.ts` 的 `thinkStarts` 注释原误写「模块级 Map」，实为实例级，已更正 |

**结论**：T0/T1/T2 实现与阶段1 前端工程最佳实践对齐；审查发现的 2 处可修偏离（注释、测试引用契约）已修复并提交，T2 拆分后 web 测试 33 例全绿。provide 断断言留 T4 专项处理。T3 沿用同一套约定（显式 interface + `satisfies`、引用注入、实例级状态、单 chunk），开工前已补 9 个特征测试（web 42/42）。

### 5.9 提交信息

```text
refactor(web): split chat conversation shell composable
```

## 6. T3：拆 SCC B（MCP / 技能 / 工具 / 专家）

### 6.1 目标

把工具面板相关状态与动作整体抽为一个 composable，A↔B 桥接继续通过协调层注入。

### 6.2 新增文件

`apps/web/src/composables/chat/useChatToolPanels.ts`

### 6.3 搬迁符号

- MCP：`mcpOpen`、`mcpBusy`、`mcpReconnecting`、`mcpError`、`patchMcpRow`、`loadMcp`、`openMcpPanel`、`isBoundMcp`、`bindingBoundMcp`、`ensureBoundMcp`、`toggleMcp`、`clearMcpSelection`、`reconnectMcp`
- 技能：`skillOpen`、`skillAddOpen`、`mcpAddOpen`、`skillBusy`、`skillError`、`loadSkills`、`onChatSkillCreated`、`onTaskSkillCreated`、`onChatMcpCreated`、`onTaskMcpCreated`、`openSkillPanel`、`toggleSkill`、`clearSkillSelection`
- 搜索/工具入口：`toolsMenuOpen`、`skillQuery`、`mcpQuery`、`searchAutofocus`、`skillFiltered`、`mcpFiltered`、`mcpBoundRows`、`mcpOptionalRows`、`mcpPanelRows`、`canClearOptionalMcp`、`enabledMcpCount`、`toggleToolsMenu`、`mcpDescText`
- 专家：`expertOpen`、`expertStarters`、`currentExpert`、`composerPlaceholder`、`askStarter`、`expertQuery`、`expertFiltered`、`openExpertPanel`、`closeToolsPanels`、`onPickExpert`、`onClearExpert`

`mcpAvailable`、`skillAvailable`、`expertAgents`、`boundMcpIds` 按设计留协调层：

- `boundMcpIds`：T2 已作为根 computed 的 getter（`() => boundMcpIds.value`）注入 A；本步由 B 读写，不移动声明位置。
- `mcpAvailable` / `skillAvailable` / `expertAgents`：保留为根同名 ref，B 通过 options 读写；T2 的任务表单 getter 指向同一批 ref。

### 6.4 必须保留的行为

- 三个 `open*Panel` 互斥切换 `mcpOpen` / `skillOpen` / `expertOpen`，重置对应 query 与 `searchAutofocus`，并触发 `loadPinyin()`。
- `toggleToolsMenu` 预取 `loadSkills` / `loadMcp`。
- `reconnectMcp` 使用逐行重连集合 `mcpReconnecting`；`connectTaskMcp` / `toggleMcp` 的成功路径用 `deferOnPage()` 延迟刷新，失败回滚在各自 catch 内完成（2026-11-19 实测校正）。
- 任务表单复用可用集：`taskRowState` 读 `taskDraft.mcpServers`，新增 MCP/技能后同时刷新聊天与任务可用集。
- 全局 Esc / outside 监听仍在协调层，不随本步移动。

**AST 依赖盘点（2026-11-19 实测）**：T3 目标共 50 个顶层声明；把注入点放在最后一个 T3 声明之后（当前行 4120），跨组依赖 37 个，全部声明在注入点之前，**无 TDZ 敏感项**。注入点前没有 setup 同步值引用这些符号（声明名/属性名除外），watch/onMounted 回调均在 setup 后执行。关键共享引用：`mcpAvailable`、`skillAvailable`、`expertAgents`、`boundMcpIds`、`taskDraft`、`taskSkillAddOpen`、`taskMcpAddOpen`、`mcpRowState`、`deferOnPage`、`send`、`router`、`uiLocale`/`tx`；其中前 7 项保持同一实例，禁止解包或复制。`mcpReconnecting` 是 composable 内部 reactive Set，返回同一实例即可。

### 6.5 验证重点

- **前置已完成**：`chat-tool-panels.test.ts`（9 个特征测试）已锁定本节六类行为；拆分后必须重跑，连同既有测试共 42 用例全绿才算行为守恒。
- MCP 勾选/取消、重连、逐行 busy；技能面板、拼音搜索、专家 chip 与 starter。
- 任务表单复用 MCP/技能可用集；新建会话带入 bound MCP。
- `loadPinyin()` / `pinyinReady` 不被动态 import 拆出额外 chunk。
- 通用验证命令 + Chrome 清单。

### 6.6 提交信息

```text
refactor(web): split chat tool panels composable
```

## 7. T4：provide 契约加固

### 7.1 目标与边界

在不改 41 键内容与顺序的前提下，给 `provide(bubbleContextKey, ...)` 加类型和数量门禁，防止后续 UI 抽取把 inject 链弄断。

**2026-11-19 AST 基线已实测**：`provide` 对象 41 键、`BubbleContext` 接口 41 字段、`ChatBubble.vue` 解构 41 项，三者顺序完全一致；`ChatBubble.vue` 没有 `ctx.xxx` 动态访问，只有 `inject(...)` + 一次性解构。

不做：不改键名/顺序、不改运行时行为、不改模板/CSS、不把 `BubbleContext` 改 optional / `any`、不新增动态 import。

### 7.2 文件与改动

1. 新增 `apps/web/tests/bubble-context-contract.test.ts`
   - 源码级 AST 锁：provide 键数量/顺序、接口字段数量/顺序、ChatBubble 解构数量/顺序三者一致。
   - 源码级文本锁：`satisfies BubbleContext` 和 `Object.keys(bubbleContext).length !== 41` 断言存在。
   - 这是必要补口：现有 web 测试 mock 掉 `provide`，运行时 DEV 断言不会在单测里实际执行。
2. 改 `apps/web/src/composables/chat/useChatPageCore.ts`
   - import `type BubbleContext`。
   - 原位把内联对象字面量抽成 `const bubbleContext = { ... } satisfies BubbleContext`。
   - 紧随其后加 DEV 数量断言，再 `provide(bubbleContextKey, bubbleContext)`。
   - `provide` 仍在同步 setup 链上，不进 async / `onMounted`。
3. 改 `apps/web/src/components/bubble-context.ts`
   - 预期无需改动；仅当 `satisfies` 暴露既有类型偏差时，做与现有 41 键一一对应的最小类型修正，不改 key、不改顺序。
4. 不改 `apps/web/src/components/ChatBubble.vue` 的解构顺序。

DEV 断言形态：

```ts
if (import.meta.env.DEV && Object.keys(bubbleContext).length !== 41) {
  throw new Error(`bubbleContext key count changed: ${Object.keys(bubbleContext).length}`);
}
```

### 7.3 执行顺序

1. 固化 41 键基线（已完成，见 §7.1）。
2. 先新增契约测试并跑绿，确保当前源码满足顺序锁。
3. 再改 `useChatPageCore.ts`：抽 `bubbleContext`、`satisfies`、DEV 断言、原位 `provide`。
4. 若 type-check 报类型差异，逐项核对，只允许在 `bubble-context.ts` 做最小类型修正；禁止用 `any` / optional 掩盖。
5. 跑 web 测试、type-check 连续 3 次、build、server 测试、`diff --check`。
6. 确认 build 仍是单个 `ChatPage-*.js` / `.css`。
7. 单提交代码与契约测试；再单提交回写提交号到文档。

### 7.4 风险评估

| 风险 | 等级 | 控制措施 | 残余风险 |
|---|---|---|---|
| 抽取对象改变 `provide` 时机 | 低 | const 与 `provide` 留在原位置；不进 async / `onMounted` | 很低 |
| 41 键顺序漂移 | 中 | AST 契约测试锁 provide / interface / ChatBubble 三者顺序 | 很低 |
| `satisfies` 暴露既有类型偏差 | 中 | 逐项核对；只做最小类型修正，不改运行时、不放宽契约 | 中低 |
| 数量断言只锁数量不锁 key | 中 | AST 测试锁完整名单与顺序；`satisfies` 锁字段类型 | 很低 |
| web 测试 mock 掉 `provide` | 中 | 新增源码级契约测试，运行时断言不依赖单测触发 | 很低 |
| 为过 type-check 放宽 `BubbleContext` | 中 | 禁止 `any` / optional；差异必须逐项解释 | 低 |
| 单 chunk 被破坏 | 低 | 只加 type import 与常量；build 后检查 chunk | 很低 |
| 交互回归未被自动化覆盖 | 中 | 全门禁 + Chrome 清单；浏览器实例冲突仍是已知非阻塞项 | 中，需人工冒烟兜底 |

### 7.5 验证命令

```bash
pnpm --filter @bx/web exec vitest run tests/bubble-context-contract.test.ts
pnpm --filter @bx/web test
pnpm --filter @bx/web type-check
pnpm --filter @bx/web type-check
pnpm --filter @bx/web type-check
pnpm type-check
pnpm build
pnpm test
git --no-pager diff --check
```

验收点：

- web / server 测试全绿；
- type-check 连续 3 次稳定；
- build 成功且仍是单个 `ChatPage-*.js` / `.css`；
- 41 键断言未被触发；
- 气泡复制/编辑、工具确认、澄清输入、推理面板、产物预览、告警标记在 Chrome 清单中无 error。

### 7.6 回滚与提交

- 失败且未提交：`git restore` 该步文件。
- 已提交：`git revert <sha>`，单提交回滚。
- 提交信息：
  ```text
  refactor(web): harden bubble context contract
  ```
- 文档 hash 回写提交：`docs(web): record T4 commit hash`。

## 8. T5：抽低风险 UI 子组件

原则：每个组件单独提交；本阶段只搬模板结构与必要 props/emits，CSS 下沉留到 T7。组件文件放 `apps/web/src/components/chat/`。

### 8.1 C6 `DoneToast.vue`

- 源块：`ChatPage.vue` 约 1138–1155 的 `Teleport to="body"`。
- props：`doneToast`；emits：`view`、`close`。
- 定时器 `doneToastTimer` 与 `openDoneToast` 留根；子组件只展示和发事件。
- 验证：后台任务完成提示、免打扰不提示、查看跳转、自动消失。

### 8.2 C7 `ArtifactPreviewModal.vue`

- 源块：约 1205–1225 的 `Teleport to="body"`。
- props：`previewHtml`、`previewLoading`、`downloadUrl`；emits：`close`。
- `workspaceDownloadUrl(currentId, previewHtml.path)` 在根计算后传入；iframe `sandbox="allow-scripts"` 不变。
- 验证：HTML 产物预览、加载态、下载链接、关闭。

### 8.3 C8 `ConfirmDialog.vue`

- 源块：约 1158–1203 的 `Teleport to="body"`。
- props：`confirmDialog`；emits：`confirm`、`cancel`、`trap`（Tab 事件转发给根层 `trapConfirmFocus`）。
- `confirmDialogEl` / `confirmPrimaryBtn` 通过 `defineExpose` 暴露；根层用函数 ref 桥接回协调层的同名 ref，`trapConfirmFocus` 与 body overflow 仍由根控制。
- 验证：删除确认、取消、Esc、Tab focus trap、危险按钮样式、确认后删除与撤销条。

### 8.4 C9 `ChatThread.vue`

- 源块：约 2211–2280 的 `.thread` 容器。
- props：`visible`、`booting`、`showSkeleton`、`bubbleCount`、`visibleBubbles`、`modelSwitchHint`、`currentExpert`、`expertStarters`、`latestAlertMarkerId`、`open`、`outlineItems`、`activeOutlineId`、`outlineBand`、`pinnedOutlineId`、`isMobile`、`sidebarOpen`。
- emits：`scroll`、`outlineUserScrollIntent`、`showEarlier`、`dismissModelHint`、`askStarter`、`jump`、`active`、`update:open`。
- `threadEl` 通过 `defineExpose` 暴露，根层函数 ref 桥接回协调层同名 ref；`onThreadScroll` 等 handler 仍在根，作为 emit 回调传入。大纲通过 `open` prop + `update:open` emit 保持 v-model 契约。
- 验证：骨架/空态、长对话“显示更早”、BackToTop、大纲浮层与跳转高亮、滚动跟底、移动端抽屉遮挡逻辑。

### 8.5 T5 通用提交信息

```text
refactor(web): extract <ComponentName> from ChatPage
```

## 9. T6：抽高风险 UI 子组件

每个组件仍单独提交。全局键鼠监听、Teleport 宿主顺序、`v-model` 契约、provide 链是本阶段红线。

### 9.1 C10 `ContextMenuHost.vue`

#### 9.1.1 目标与边界

- 目标：只把 `ChatPage.vue:1010–1136` 的右键菜单 DOM 搬进新组件，**状态、动作函数、全局监听、焦点归还全部留根/留 `useChatConversationShell.ts`**，实现「组件只渲染 + 转发事件」。
- 源块以符号定位，不按行号死守：`<Teleport to="body">` 内的 `.ctx-menu` 节点，包含 `ctxTargetTask` 任务菜单和 `else` 对话菜单两套模板。
- 与 T5 一致，本步**不动 CSS**；`.ctx-*` 规则继续留在 `chat-page.css`，T7 再下沉。
- 修正旧计划三处偏差（按当前代码为准）：
  1. 不存在 `locations` 状态/prop，C10 不传。
  2. `onCtxEscape` 是 `window.addEventListener("keydown", onCtxEscape)` 的**冒泡阶段**，不是 capture；`scroll` 才是 capture。
  3. 当前没有 Shift+F10 入口；键盘验证用 `F2`（菜单打开时全局 F2 → `startRename`）和菜单内 ↑/↓/Home/End/Tab。

#### 9.1.2 当前依赖基线（实施前已核对）

| 位置 | 现状 | C10 处理 |
|---|---|---|
| `ChatPage.vue` 根解构 | 654 个同名解构；含 `ctxMenu`/`ctxMenuEl`/`ctxConfirm`/`ctxTarget`/`ctxTargetTask`/`armCtxConfirm`/`onCtxMenuKeydown`/`onCtxEscape`/`onCtxDismiss` | 新增 `ContextMenuHost` 解构，654 → 655；其余解构保留 |
| `ChatPage.vue` 模板 | `.chat @click="closeCtxMenu()"` + 四处 `@contextmenu.prevent` 打开菜单（任务头两处、运行记录一处、会话项一处），另有菜单根节点 `@contextmenu.prevent` 阻止原生菜单 | 全部保留，只替换 Teleport 菜单块 |
| `useChatConversationShell.ts` | `ctxTriggerEl`（内部 let）、`ctxTarget`、`openCtxMenu`、`openTaskCtxMenu`、`closeCtxMenu(restoreFocus)`、`armCtxConfirm(kind)` | 不搬；继续由根层同名解构调用 |
| `useChatPageCore.ts` | `onCtxMenuKeydown` 依赖 `ctxMenuEl.value.querySelectorAll('[role="menuitem"]')`；`onCtxEscape` 处理 Esc/F2；`onCtxDismiss` 处理 scroll/resize | 不搬；全局监听注册/移除时机不变 |
| DOM ref | 根 `ctxMenuEl: Ref<HTMLElement \| null>` 被 `placeCtxMenu()` 与 `armCtxConfirm()` 读取 | 子组件 `defineExpose({ ctxMenuEl })`，根层函数 ref 桥接回同一 ref |

#### 9.1.3 组件契约

**新增 `apps/web/src/components/chat/ContextMenuHost.vue`**

Props（全部按引用/响应式传入，禁止解包成普通值）：

| prop | 类型 | 用途 |
|---|---|---|
| `ctxMenu` | `{ open: boolean; x: number; y: number; targetId: string; taskId: string }` | 控制 `v-if`、定位、清空目标 id |
| `ctxTarget` | `ConversationDto \| null` | 对话菜单标题/状态文案、重命名与置顶载荷 |
| `ctxTargetTask` | `ScheduleDto \| null` | 任务菜单 `v-if` 与禁用/已读/启用文案 |
| `ctxConfirm` | `"" \| "clear"` | 清空对话二段确认分支 |
| `sortMode` | `ConvSortMode` | `manual` 时显示「恢复自动排序」 |

Emits（19 个动作 + 1 个键盘转发；**不新增 `close`**，关闭仍由根层动作函数和全局监听完成）：

| emit | 载荷 | 根层绑定 |
|---|---|---|
| `keydown` | `KeyboardEvent` | `onCtxMenuKeydown` |
| `run-task-now` | — | `ctxRunTaskNow` |
| `open-task-conv` | — | `ctxOpenTaskConv` |
| `edit-task` | — | `ctxEditTask` |
| `toggle-task-enabled` | — | `ctxToggleTaskEnabled` |
| `mark-task-read` | — | `ctxMarkTaskRead` |
| `remove-task` | — | `ctxRemoveTask` |
| `rename` | `ConversationDto \| null` | `conv => conv && startRename(conv)` |
| `toggle-pin` | `ConversationDto \| null` | `conv => conv && togglePin(conv)` |
| `restore-recent-sort` | — | `restoreRecentSort` |
| `arm-clear` | — | `armCtxConfirm('clear')` |
| `confirm-clear` | `id: string` | `clearConversationById` |
| `ask-close-others` | — | `askCloseOthers()` |
| `toggle-archive` | `id: string` | `toggleArchive` |
| `toggle-mute` | `id: string` | `toggleMute` |
| `toggle-full-access` | `id: string` | `toggleFullAccess` |
| `toggle-send-mode` | `id: string` | `toggleSendMode` |
| `duplicate` | `id: string` | `duplicateCurrent` |
| `export` | `id: string, format: "md" \| "json"` | `(id, format) => exportConversation(id, format)` |
| `ask-delete` | — | `askDeleteFromCtx()` |

模板不变量：

- `<Teleport to="body">` 保留；`v-if="ctxMenu.open"` 继续挂在**内部 `.ctx-menu` div** 上，不移到 Teleport，避免宿主挂载顺序变化。
- 菜单根节点保留 `ref="ctxMenuEl"`、`role="menu"`、`:style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"`、`@click.stop`、`@contextmenu.prevent`。
- `@keydown="emit('keydown', $event)"` 只转发自定义事件；**不加 `.stop` / `.prevent`**，原生 keydown 仍要冒泡到 window，才能触发 `onCtxEscape` 的 Esc/F2。
- `role="menuitem"`、`class="ctx-item"`、`class="ctx-sep"`、`kbd.ctx-kbd`、`data-ctx-confirm`、`:disabled="!!ctxTargetTask.runRequestedAt"` 全部原样保留。
- `tx()` 用 `getUiLocale()` 在子组件内本地生成，模式与 T5 四个组件一致。
- `defineExpose({ ctxMenuEl })`；根层使用与 C8/C9 相同的函数 ref 桥接：
  ```vue
  :ref="(el: any) => { ctxMenuEl = el?.ctxMenuEl ?? null; }"
  ```

#### 9.1.4 执行顺序

1. 开工前核对 `HEAD`、`git status`，实测 `ChatPage.vue` 根解构仍为 654；确认 `ContextMenuHost.vue` 不存在。
2. **先加红测** `apps/web/tests/context-menu-host-contract.test.ts`（4 个源码级契约用例，45 → 49）：
   - 结构锁：Teleport / `v-if="ctxMenu.open"` / `ref="ctxMenuEl"` / `role="menu"` / `@click.stop` / `@contextmenu.prevent` / `@keydown="emit('keydown', $event)"` / `data-ctx-confirm` / `defineExpose({ ctxMenuEl })`。
   - 事件锁：显式 emits 恰好包含 9.1.3 的 20 个名字；不含 `close`、不含 `locations`。
   - 副作用锁：组件内无 `window.addEventListener` / `removeEventListener`；core 内仍同时存在 `onCtxEscape` 的 keydown 注册、`onCtxDismiss` 的 scroll(capture)/resize 注册与对称移除。
   - 接线锁：core 返回并 ChatPage 解构 `ContextMenuHost`；根解构计数为 655；ChatPage 不再出现裸 `.ctx-menu` Teleport 块，且保留函数 ref 桥接。
3. 新增组件，只搬 DOM 与文案；按 9.1.3 把 19 个动作换成 `emit(...)`，不复制任何函数体。
4. `useChatPageCore.ts` 在 UI 组件 import/return 区加入 `ContextMenuHost`；`ChatPage.vue` 解构加入同名项，替换 1010–1136 原始块。
5. 跑 9.1.6 门禁；红测转绿后再看 diff，确认 CSS、全局监听、composable 函数体零改动。
6. 代码单独提交；再用独立文档提交把 commit hash 回写到本计划和设计/索引文档。

#### 9.1.5 风险表

| 风险 | 影响 | 概率 | 缓解/判定 |
|---|---|---|---|
| `ctxMenuEl` 桥接拿到 `null` 或旧节点 | `placeCtxMenu` 不能定位/聚焦首项；`armCtxConfirm` 不能聚焦确认按钮；键盘导航失效 | 中 | 组件 `defineExpose` + 根函数 ref；契约测试锁 expose；实测「打开菜单→二次确认→Esc→再打开」连续两次 |
| emit 名称/载荷漏配 | 菜单项点击无反应或 id 错位（尤其导出/发送模式/清空） | 中 | 20 个 emit 显式列出并逐一绑定；契约测试锁名字集合；人工对照两套菜单 19 个动作 |
| 自定义 `keydown` 误加 `.stop` 或被当作原生监听重复触发 | Esc 焦点归还、F2 重命名、Tab 关闭回归 | 中 | 不写修饰符；声明 `keydown` emit 避免 fallthrough 双绑；契约测试锁字符串；模拟 F2/Esc |
| 丢失 `@click.stop` / `@contextmenu.prevent` | 浏览器原生右键菜单弹出，或外部 mousedown 处理器误触发 | 中 | 契约测试锁两个修饰符；右键任务头/会话项实测 |
| 把 `v-if` 移到 Teleport | 挂载顺序变化，可能重演 `#task-panel-host` 的宿主未就位问题 | 低 | 明确禁止；契约测试锁 `v-if="ctxMenu.open"` 在 Teleport 内部 div |
| 子组件里重复注册全局监听 | 双次关闭、焦点被抢、卸载残留 | 低 | 契约测试锁子组件零 `addEventListener`，core 注册/移除数量不变 |
| 根解构漏加/重复加 | 模板未定义变量或返回表漂移 | 中 | 与 core return 同提交；契约测试锁 655 |
| 任务菜单禁用项仍被 `querySelector` 选中 | 首项 focus 无效（当前既有行为） | 低 | 保持原选择器，不改 `[role="menuitem"]`；不借机修行为 |
| 视觉/CSS 意外变化 | 菜单位移、层级变化 | 低 | 本步不碰 CSS/Teleport 目标；T7 再按 `.ctx-*` 块下沉 |

#### 9.1.6 验证与模拟推演

门禁命令：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @bx/web test
pnpm --filter @bx/web type-check
pnpm type-check
pnpm build
pnpm test
git diff --check
Get-ChildItem -Name apps/web/dist/assets/ChatPage-*
```

判定：web 49/49、全仓 type-check、build、server 978/978 全绿；`ChatPage-*.js` / `ChatPage-*.css` 仍各一份；Chrome 全清单因已知实例冲突为非阻塞项，可做时按下面路径冒烟。

模拟推演（按顺序验证，任一步状态/焦点不符即停止）：

| # | 操作 | 期望状态链路 |
|---|---|---|
| 1 | 右键会话项 | `openCtxMenu` 设 `ctxMenu={open:true,targetId:conv.id,taskId:""}` 并记 `ctxTriggerEl` → 组件渲染 `.ctx-menu` → 函数 ref 把 DOM 写回根 `ctxMenuEl` → `placeCtxMenu` 在 nextTick 后量尺寸、夹边、focus 首个 `[role="menuitem"]`；无浏览器原生菜单 |
| 2 | 右键任务分组头 | 同样链路，但 `taskId` 非空、`ctxTargetTask` 命中 → 只出现 6 个任务项；`runRequestedAt` 存在时「立即执行」disabled |
| 3 | 菜单内按 ↓ / ↑ / Home / End | 子组件 `keydown` emit → 根 `onCtxMenuKeydown` 用桥接后的 `ctxMenuEl` 查询 menuitem，循环移动焦点；无 console error |
| 4 | 按 Tab | `closeCtxMenu()` 关闭，`ctxConfirm` 清空，`ctxTriggerEl` 不归还焦点（与现行行为一致） |
| 5 | 按 Esc | 原生事件继续冒泡到 window → `onCtxEscape` → `closeCtxMenu(true)` → 原触发项重获焦点；菜单 DOM 移除 |
| 6 | 菜单打开时按 F2 | 原生事件冒泡到 window → `startRename(ctxTarget)`；内部先 `closeCtxMenu()`，随后重命名输入框聚焦/全选；不能同时保留菜单 |
| 7 | 点「清空对话」 | `arm-clear` → 根 `armCtxConfirm('clear')` → nextTick 后 `[data-ctx-confirm]` 出现并被 focus；菜单不关闭 |
| 8 | 再点「确认清空」 | `confirm-clear(id)` → `clearConversationById` 收菜单并执行；无二次确认残留 |
| 9 | 点任务项/导出/发送模式 | 对应 emit 载荷为当前 `ctxTargetTask` 或 `ctxMenu.targetId`；根函数执行后 `ctxMenu.open=false`；无 id 串台 |
| 10 | 菜单打开后滚动会话列表 / 缩放窗口 | window scroll(capture) / resize → `onCtxDismiss` → `closeCtxMenu()`；子组件不参与监听，卸载后无残留 |
| 11 | 连续开关菜单两次 | 第二次 `placeCtxMenu` 仍能拿到新 DOM ref，聚焦正常；桥接不持有第一次的旧节点 |

#### 9.1.7 回滚

- 未提交：`git restore` 新增组件/测试与三个修改文件（或删除新增文件后恢复 `ChatPage.vue`、`useChatPageCore.ts`）。
- 已提交：先 `git revert <C10 code sha>`，再单独 revert 回写 hash 的文档提交；禁止把 C10 与 C11 合并提交。
- 若仅桥接失败，优先改成子组件在 `ctxMenuEl` ref 变化时 emit 一个 `element` 事件由根层直接赋值，再补契约测试；不把全局监听搬进子组件。

#### 9.1.8 提交信息

```text
refactor(web): extract ContextMenuHost from ChatPage
```

- 实际代码提交：`58bd836`；前置方案文档提交：`0064d33`。

### 9.2 C11 `ChatSidebarList.vue`

#### 9.2.1 目标与边界

- 目标：只把 `ChatPage.vue:669–1003` 的 `<aside class="sidebar">` 整段搬进新组件，**根层状态机、localStorage 折叠偏好、拖拽自动滚动、右键菜单宿主、删除/清空确认全部留根**。
- 移动端遮罩 `.sidebar-backdrop`（`1004–1009`）**继续留根**：它和 `<aside>` 是兄弟节点，若包装成单一 div 会改 CSS 布局；若 Teleport 会改 DOM 顺序。组件只暴露 `sidebarOpen` 状态用于 aside 的 `open` class，遮罩仍由根模板按 `v-if="sidebarOpen"` 渲染。
- 本步**不动 CSS**；`.brand` / `.side-nav` / `.conv-list` / `.task-group*` / `.conv-item` 规则继续留在 `chat-page.css`，T7 再下沉。
- 修正旧计划偏差：当前 aside 模板没有直接使用 `sortMode`、`ctxMenu`、`pinnedAt`；这三个不传。右键通过 `openCtxMenu` / `openTaskCtxMenu` 动作 emit 接回根层，菜单本体由 C10 的 `ContextMenuHost` 渲染。

#### 9.2.2 当前依赖基线（实施前已核对）

| 位置 | 现状 | C11 处理 |
|---|---|---|
| DOM 源块 | `<aside>` 单根节点，`669–1003`；内部有 brand 助手菜单、快捷导航、搜索、归档勾选、任务分组、对话列表、清空按钮 | 整段原样搬入，根节点仍是 `<aside class="sidebar">` |
| DOM refs | `agentMenuEl`（助手菜单外部点击）、`convListEl`（拖拽边缘自动滚动）、`setRenameInput`（内联重命名函数 ref） | `agentMenuEl` / `convListEl` 由子组件 `defineExpose`，根层一个函数 ref 同时桥接；`setRenameInput` 作为函数 prop 直接传给 `:ref`，不再另造 ref |
| 根状态机 | `agentMenuOpen`、`convQuery`、`showArchived`、`taskSectionOpen`、`expandedTasks`、`convSectionOpen`、`draggingId`、`dropTarget`、`renaming`、`clearArmed` | 全部留根，通过 props + emits 双向交互；折叠偏好 localStorage 写入函数也留根 |
| 纯展示 helper | `agentText`、`taskDotClass`、`taskCardTip`、`taskHealthShort`、`taskRightShort`、`taskMarkerText`、`taskStatusText`、`filteredRuns`、`runTimeText`、`runMetaText`、`convStatus`、`convStatusText`、`queueCount` | `agentText` 子组件直接 import；其余作为函数 props 传入，不在子组件复制函数体或本地状态 |
| 全局监听 | `onAgentMenuOutside`、`onAgentMenuEsc`、`onSidebarEsc` 在 core 的 `onMounted/onBeforeUnmount` 对称注册 | 不搬；子组件不得注册任何全局监听 |
| 右键菜单 | aside 内 3 个 `@contextmenu.prevent` 入口（任务头、运行记录、会话项；主区任务头一处和菜单根节点一处留根） | 只 emit 事件；`ContextMenuHost` 与 `ctxMenu` 状态继续由根层/C10 管 |
| 根解构 | C10 后 655 个同名解构 | 新增 `ChatSidebarList`，655 → 656 |

#### 9.2.3 组件契约

**新增 `apps/web/src/components/chat/ChatSidebarList.vue`**

本地结构类型（与 core 的 `TaskGroupRun` / `dropTarget` / `renaming` 形状一致，字段不得增删）：

```ts
type TaskGroupRun = {
  conversationId: string;
  at: number;
  status?: string;
  marker?: string;
  trigger?: "schedule" | "manual" | "wake";
  durationMs?: number;
  conv?: ConversationDto;
};
```

Props（39 个，全部保持引用/函数身份，不解包）：

| 分组 | props |
|---|---|
| 布局/角色 | `sidebarOpen`、`sidebarCollapsed`、`isMobile`、`agentMenuOpen`、`currentAgent`、`agents`、`agentId`、`agentLabel`、`uiLocale` |
| 搜索/列表状态 | `convQuery`、`showArchived`、`currentId`、`conversationsFiltered`、`showSkeleton`、`convSectionOpen`、`pinnedCount`、`archivedCount`、`firstArchivedIndex` |
| 任务分组 | `taskSectionOpen`、`taskGroups`、`expandedTasks` |
| 拖拽/重命名/清空 | `draggingId`、`dropTarget`、`renaming`、`renameMax`、`clearArmed`、`setRenameInput` |
| 展示 helper | `taskDotClass`、`taskCardTip`、`taskHealthShort`、`taskRightShort`、`taskMarkerText`、`taskStatusText`、`filteredRuns`、`runTimeText`、`runMetaText`、`convStatus`、`convStatusText`、`queueCount` |

`renameMax` 对应 `RENAME_MAX`；`conversationsFiltered` / `taskGroups` 是 computed 拆包后的数组，按 prop 传入即可。`setRenameInput` 是函数 prop，子组件模板继续写 `:ref="setRenameInput"`。

Emits（29 个，动作全部转发，不在子组件执行状态变更）：

| 类别 | emits |
|---|---|
| 顶部 | `toggle-agent-menu`、`pick-agent(agent)`、`toggle-sidebar`、`new-conversation`、`open-task-list` |
| 搜索/归档 | `update:convQuery`、`conv-search-input`、`update:showArchived`、`archived-change` |
| 任务分组 | `toggle-task-section`、`toggle-task-group(id)`、`task-group-keydown(event, id)`、`open-task-ctx(event, schedule)`、`open-task-conversation(schedule)`、`open-run-conversation(run)`、`run-keydown(event, run)` |
| 对话列表 | `toggle-conv-section`、`open-ctx(event, conv)`、`select-conversation(conv)`、`conv-keydown(event, conv)`、`drag-start(event, conv)`、`drag-over(event, conv)`、`drop(event)`、`drag-end(event)` |
| 重命名/删除/清空 | `update:renameValue`、`rename-keydown(event)`、`commit-rename`、`ask-delete(conv)`、`clear-current` |

模板不变量：

- 根节点保持 `<aside class="sidebar" :class="{ open: sidebarOpen, collapsed: sidebarCollapsed }" ...>`；`.sidebar-backdrop` 不进组件。
- 保留 3 个 aside 内 `@contextmenu.prevent` 入口和所有 `@click.stop`（未读角标、打开最近一期、重命名输入框、删除按钮）；不补 `@click.stop`、不改冒泡。
- 三处 `v-model` 契约：`convQuery` / `showArchived` 用 `update:convQuery` / `update:showArchived`；`renaming.value` 用 `renameValue` + `update:renameValue`。根层分别用 `v-model:conv-query`、`v-model:show-archived`、显式 `@update:rename-value` 接回。
- `@keydown="onTaskGroupKeydown(...)"` / `onRunKeydown` / `onConvKeydown` / `onRenameKeydown` 全部改为 emit 转发，不复制键盘逻辑。
- `aria-expanded` / `aria-current` / `role` / `tabindex` / `:draggable` / `:data-conv-id` / `:title` / `:aria-label` 原样保留。
- `tx()` 由 `getUiLocale()` 在子组件本地生成；`agentText` 直接 import，不复制翻译逻辑。
- `defineExpose({ agentMenuEl, convListEl })`；根层函数 ref 一次桥接两个 DOM：
  ```vue
  :ref="(el: any) => {
    agentMenuEl = el?.agentMenuEl ?? null;
    convListEl = el?.convListEl ?? null;
  }"
  ```

#### 9.2.4 执行顺序

1. 开工前核对 `HEAD`、工作区干净、根解构 655，确认 `ChatSidebarList.vue` 不存在。
2. **先加红测** `apps/web/tests/chat-sidebar-list-contract.test.ts`（4 个源码契约用例，web 49 → 53）：
   - 结构锁：`<aside class="sidebar">`、`.sidebar-backdrop` 不在组件、3 个 `@contextmenu.prevent`、`:ref="setRenameInput"`、`:data-conv-id`、三处 v-model emit 字符串。
   - props 锁：39 个 prop 名字逐项一致；不含 `sortMode` / `ctxMenu` / `pinnedAt`。
   - emits 锁：29 个 emit 名字逐项一致；含 `update:convQuery` / `update:showArchived` / `update:renameValue`。
   - expose/副作用锁：`defineExpose({ agentMenuEl, convListEl })`；组件无 `addEventListener` / `removeEventListener` / `localStorage` / `router.push` / `confirmDialog`。
   - 接线锁：core 返回且 ChatPage 解构 `ChatSidebarList`，根解构计数 656；根层仍保留 `.sidebar-backdrop` 和两个 ref 桥接；aside 原始块不再出现在 ChatPage。
3. 新增组件，只搬 DOM 与文案；29 个动作全部换成 `emit(...)`，helper 只作 prop 调用。
4. `useChatPageCore.ts` 在 UI 组件 import/return 区加入 `ChatSidebarList`；`ChatPage.vue` 解构加入同名项，替换 669–1003 原始块。
5. 跑 9.2.6 门禁；红测转绿后看 diff，确认 CSS、全局监听、composable 函数体、localStorage 逻辑零改动。
6. 代码单独提交；再用独立文档提交回写 commit hash。

#### 9.2.5 风险表

| 风险 | 影响 | 概率 | 缓解/判定 |
|---|---|---|---|
| `agentMenuEl` / `convListEl` 桥接失效 | 助手菜单外部点击不收起；拖拽到顶部/底部不自动滚动 | 中 | 一个函数 ref 同时桥接两个 expose ref；契约测试锁 expose 与桥接；模拟外部点击 + 拖拽边缘 |
| 三处 v-model / 函数 ref 漏接 | 搜索不过滤、归档勾选不刷新、重命名输入框不聚焦/不提交 | 中 | 契约测试锁 emit 名与模板字符串；模拟搜索/归档/F2 重命名全链路 |
| 拖拽事件载荷丢失 | 排序落点错位或直接不排序 | 中 | `drag-start/over/drop/end` 显式 emit；保留 `dropTarget` class 计算由根 prop 回灌；模拟上下半区插入 |
| 键盘路径被吞 | F2 重命名、Alt+↑/↓ 调序、Enter/Space 打开任务期/会话失效 | 中 | 4 类 keydown 均转发且不写 `.stop`；模拟焦点在任务头/运行记录/会话项/重命名框 |
| 右键入口或载荷错 | 任务菜单/对话菜单打不开或打到错误目标 | 中 | 3 个 aside 入口逐一 emit；C10 `ContextMenuHost` 不动；模拟任务头、运行记录与会话项 |
| 展示 helper prop 漏传 | 状态点、快捷文案、运行时间空白或抛错 | 中 | 12 个 helper 列入 props 锁；首屏渲染逐项检查 |
| 折叠偏好被误搬进子组件 | localStorage 写入时机/键名漂移，刷新后展开态丢失 | 低 | `toggleTaskSection` / `toggleTaskGroup` / `toggleConvSection` 留根；契约测试锁组件内无 `localStorage` |
| 遮罩被误搬/包装 | 移动端抽屉层级或点击关闭回归 | 中 | 明确只搬 `<aside>`；契约测试锁子组件无 `.sidebar-backdrop`、根层仍保留 |
| 清空二段态被误搬 | 5s 计时器与 `clearArmedFor` 状态重复 | 低 | 只传 `clearArmed` + emit `clear-current`；组件内无 `setTimeout` |
| 根解构漏加 | 模板未定义变量或返回表漂移 | 中 | 与 core return 同提交；契约测试锁 656 |

#### 9.2.6 验证与模拟推演

门禁命令：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @bx/web test
pnpm --filter @bx/web type-check
pnpm type-check
pnpm build
pnpm test
git diff --check
Get-ChildItem -Name apps/web/dist/assets/ChatPage-*
```

判定：web 53/53、全仓 type-check、build、server 978/978 全绿；`ChatPage-*.js` / `ChatPage-*.css` 仍各一份；Chrome 全清单因已知实例冲突为非阻塞项，可做时按下列路径冒烟。

模拟推演（按顺序验证，任一步状态/焦点不符即停止）：

| # | 操作 | 期望状态链路 |
|---|---|---|
| 1 | 首屏渲染 | brand / 快捷导航 / 搜索框 / 归档勾选 / 任务分组 / 对话列表 / 清空按钮全部出现；active、pinned、archived、dragging、drop-before/after class 与根状态一致 |
| 2 | 点当前助手名 | `toggle-agent-menu` → 根 `agentMenuOpen` 翻转 → 下拉渲染；点角色 → `pick-agent(agent)` → 根 `onPickAgent` 关菜单并路由跳转 |
| 3 | 菜单打开后点外部 / 按 Esc | 全局 `onAgentMenuOutside` / `onAgentMenuEsc` 仍生效；`agentMenuEl` 桥接提供 contains 判断，菜单收起 |
| 4 | 桌面端点收起、移动端汉堡 | `toggle-sidebar` → 根分别改 `sidebarCollapsed` / `sidebarOpen`；root 的 `.sidebar-backdrop` 只在移动端 `sidebarOpen` 时出现，点击仍关闭 |
| 5 | 新建对话 / 打开任务列表 | 两个快捷入口 emit → 根 `newConversation` / `openTaskListPage` 执行；任务列表仍复用根 `showTaskList` / `loadTasks` |
| 6 | 搜索对话 | `convQuery` v-model + `conv-search-input` → 根 `onConvSearchInput` 懒加载拼音；`conversationsFiltered` 由根重算回灌；任务分组隐藏、空态显示 |
| 7 | 勾选显示归档 | `showArchived` v-model + `archived-change` → 根 `reloadConversations`；归档分隔线与计数由根 computed 回灌 |
| 8 | 折叠任务区 / 任务组 / 对话区 | 三个 toggle emit → 根函数改状态并写 localStorage（键名不变）；刷新后展开态恢复 |
| 9 | 右键任务头 / 运行记录 / 会话项 | 3 个入口按原参数 emit → 根 `openTaskCtxMenu` / `openCtxMenu` → C10 `ContextMenuHost` 渲染正确菜单；原生右键菜单不弹出 |
| 10 | 键盘操作 | 任务头 Enter/Space、运行记录 Enter/Space、会话项 F2/Alt+↑/↓/↑/↓/Enter/Space、重命名框 Enter/Esc/↑/↓ 全部由根 handler 处理，焦点/排序/重命名符合既有行为 |
| 11 | 拖拽排序 | `drag-start/over/drop/end` 带 conv 与 event 回根；`convListEl` 桥接生效，拖到边缘自动滚动；drop 后 `dropTarget` 清空、顺序落库 |
| 12 | F2 重命名 | 根 `startRename` 先关菜单再设 `renaming`；`setRenameInput` 函数 prop 拿到 input，聚焦全选；输入 → `update:renameValue` 回根；Enter/失焦 → `commit-rename` |
| 13 | 删除 / 清空 | 会话项 × → `ask-delete` 打开 C8 `ConfirmDialog`；底部清空按钮 → `clear-current` 进入/确认根 `clearArmed` 二段态，5s 计时器仍在根 |

#### 9.2.7 回滚

- 未提交：删除新增组件/测试，恢复 `ChatPage.vue` 与 `useChatPageCore.ts`。
- 已提交：先 `git revert <C11 code sha>`，再单独 revert 回写 hash 的文档提交；禁止与 C12 合并。
- 若仅 DOM ref 桥接失败，优先保留 `defineExpose({ agentMenuEl, convListEl })` 并补 `element` emit 同步根 ref；不把全局监听或 localStorage 写回逻辑搬进子组件。

#### 9.2.8 提交信息

```text
refactor(web): extract ChatSidebarList from ChatPage
```

- 实际代码提交：`383630e`；前置方案文档提交：`e2a1818`。

### 9.3 C12 `MessageComposer.vue`

#### 9.3.1 目标与边界

- 目标：只把 `ChatPage.vue:1814–2302` 的 `<footer v-show="!showTaskForm && !showTaskList" class="composer">` 整段搬进新组件，**输入状态机、工具面板状态机、发送/停止、队列、附件、resize、全局 Esc/外部点击全部留根**。
- 源块定位以符号为准，不依赖行号；旧计划的 `1505–2153` / `2282–2770` 均已过时，当前 footer 到 `</footer>` 结束，后面的 `.copy-toast` 和 `</main>` 留根。
- 本步**不动 CSS**；`.composer*` / `.queue*` / `.pending` / `.tools-*` / `.mcp-*` 规则继续留在 `chat-page.css`，T7 再下沉。
- 修正旧计划两处偏差：
  1. `onInlineSubmitKeydown` 属于任务表单（C13），不在 footer；C12 只涉及 `onKeydown`、`autoGrow`、`onEscTools`、`onOutsideTools`。
  2. `inputEl` 是 core 里由 `promptBoxEl.value?.inputEl` 推导的 computed，不单独 expose；子组件 expose `promptBoxEl` 即可。
  3. 工具飞出层不是 Teleport，而是 `.tools-menu-box` 内的普通 `v-if` 面板；不新增 Teleport。

#### 9.3.2 当前依赖基线（实施前已核对）

| 位置 | 现状 | C12 处理 |
|---|---|---|
| DOM 源块 | `<footer>` 单根节点，内部依次是 queue、pending 图片、pending 文档、图片警告、`composer-row`、`PromptBox` 三个 slot | 整段原样搬入，根节点仍是 `<footer class="composer">`，`v-show` 改由 `visible` prop 控制 |
| 输入状态 | `current.input`、`canSend`、`current.sending`、队列/附件、settings | 传 `current: ConvState` + `modelValue` + `canSend`；`current.input` 用 `update:modelValue` emit 回写 |
| DOM refs | `fileInput`、`promptBoxEl`、`stopBtnRef`、`toolsRoot` 均被根层/全局监听读取 | 子组件 `defineExpose` 四个 ref，根层一个函数 ref 桥接；`inputEl` 继续由 core computed 从 `promptBoxEl` 推导 |
| 工具面板 | `toolsMenuOpen` / `skillOpen` / `mcpOpen` / `expertOpen`；搜索词、列表、busy、错误、add form 状态全在 core | 全部 props + emits；面板开合、hover 预开、焦点策略仍由根函数决定 |
| 全局监听 | `onEscTools` / `onOutsideTools` 在 core 注册；`onOutsideTools` 依赖 `toolsRoot.contains()` | 不搬；`toolsRoot` 桥接失效会导致面板点外面/Esc 不收起 |
| 键盘/resize | `onKeydown` 处理 Enter/Shift+Enter/斜杠等；`autoGrow` 跟输入高度；grip `mousedown.prevent` / `dblclick` | 事件 emit 回根；组件不改键盘逻辑、不复制高度算法 |
| 文件选择 | `<input id="chat-file-input" ref="fileInput" hidden multiple accept=...>`；工具菜单内 `fileInput?.click(); closeToolsPanels()` | input 留在组件内，子组件本地 `fileInput.value?.click()`，另 emit `close-tools-panels` |
| 根解构 | C11 后 656 个同名解构 | 新增 `MessageComposer`，656 → 657 |

#### 9.3.3 组件契约

**新增 `apps/web/src/components/chat/MessageComposer.vue`**

Props（39 个）：

| 分组 | props |
|---|---|
| 可见性/会话 | `visible`、`current`、`modelValue`、`canSend` |
| 输入展示 | `imagesUnsupported`、`composerPlaceholder`、`minHeight`、`maxHeight` |
| 文件/工具开关 | `toolsMenuOpen`、`skillOpen`、`mcpOpen`、`expertOpen`、`currentSendMode`、`currentExpert`、`uiLocale`、`agentId`、`enabledMcpCount` |
| 技能面板 | `skillQuery`、`skillAvailable`、`skillFiltered`、`skillBusy`、`skillAddOpen`、`skillError`、`searchAutofocus`、`iconStyle`、`iconChar` |
| MCP 面板 | `mcpQuery`、`mcpAvailable`、`mcpFiltered`、`mcpPanelRows`、`mcpBusy`、`boundMcpIds`、`mcpReconnecting`、`canClearOptionalMcp`、`mcpAddOpen`、`mcpError`、`mcpDescText` |
| 助手面板 | `expertQuery`、`expertFiltered` |

`current` 用 `ConvState`（`chat-page-types.ts`），一次传入 `queue` / `pendingImages` / `pendingDocs` / `settings` / `sending` / `input`，避免复制一堆窄类型。`minHeight` / `maxHeight` 分别对应 `COMPOSER_BASE` / `COMPOSER_AUTO_MAX`。`iconStyle` / `iconChar` / `mcpDescText` 作为函数 prop；`agentText` 子组件直接 import。

Emits（38 个）：

| 类别 | emits |
|---|---|
| 输入 | `update:modelValue`、`composer-input`、`keydown` |
| 队列/附件 | `move-queue-item(index, dir: 1 \| -1)`、`edit-queue-item(index)`、`remove-queue-item(index)`、`send-queue-item-now(index)`、`remove-pending-image(id)`、`remove-pending-doc(id)`、`pick-files(event)` |
| 输入区 UI | `start-composer-resize(event)`、`reset-composer-size`、`toggle-tools-menu`、`close-tools-panels`、`toggle-send-mode`、`clear-expert` |
| 工具面板开合 | `open-skill-panel`、`open-mcp-panel`、`open-expert-panel`、`hover-flyout(kind)` |
| 技能 | `update:skillQuery`、`toggle-skill(dir, enabled)`、`skill-created(dir)`、`toggle-skill-add`、`cancel-skill-add`、`clear-skill-selection` |
| MCP | `update:mcpQuery`、`toggle-mcp(id, enabled)`、`reconnect-mcp(id)`、`remove-custom-mcp(id)`、`mcp-created(id)`、`toggle-mcp-add`、`cancel-mcp-add`、`clear-mcp-selection` |
| 助手 | `update:expertQuery`、`pick-expert(agent)` |
| 发送/停止 | `stop`、`send` |

模板不变量：

- `<footer v-show="visible" class="composer">` 为单根；`PromptBox` 的 `#top` / `#toolbar-left` / `#toolbar-right` 三个 slot 名称、顺序与内容层级不变。
- `PromptBox` 绑定：`v-model="modelValue"` 改为 `:model-value` + `@update:model-value` 转发；`id` / `name` / `rows` / `:min-height` / `:max-height` / `:pad-top` / `:placeholder` / `:hint` 原样；`@input` 改为 `emit('composer-input', $event)`，`@keydown` 改为 `emit('keydown', $event)`。
- `ref="fileInput"` / `ref="promptBoxEl"` / `ref="stopBtnRef"` / `ref="toolsRoot"` 原样保留；`defineExpose({ fileInput, promptBoxEl, stopBtnRef, toolsRoot })`。
- 工具菜单内 `fileInput?.click(); closeToolsPanels()` 改为子组件本地 `fileInput.value?.click(); emit('close-tools-panels')`；`input accept/multiple/hidden/name` 不变。
- 三处 `ToolsSearch` 用 `v-model` 契约：`skillQuery` / `mcpQuery` / `expertQuery` 分别配 `update:skillQuery` / `update:mcpQuery` / `update:expertQuery`；`autofocus` 继续由 `searchAutofocus` prop 决定。
- `SkillAddForm` / `McpAddForm` 的 `@created` / `@cancel` 改为 emit；`skillAddOpen` / `mcpAddOpen` 不搬进子组件状态。
- 所有 `@click.stop`（专家 chip 取消、MCP 重连/移除）保留；不新增 `.stop`、不改键盘冒泡。
- `tx()` 由 `getUiLocale()` 在子组件本地生成；`agentText` 直接 import。

#### 9.3.4 执行顺序

1. 开工前核对 `HEAD`、工作区干净、根解构 657 的前置 656，确认 `MessageComposer.vue` 不存在。
2. **先加红测** `apps/web/tests/message-composer-contract.test.ts`（5 个源码契约用例，web 53 → 58）：
   - 结构锁：`<footer v-show="visible" class="composer">`、PromptBox 三个 slot、`#chat-file-input` 的 `accept`/`multiple`/`hidden`、`.queue` / `.pending` / `.tools-flyout`、四个 ref。
   - props 锁：39 个 prop 名字逐项一致；不含 `showTaskForm` / `showTaskList` / `inputEl`。
   - emits 锁：38 个 emit 名字逐项一致；含 `update:modelValue` 与三处 `update:*Query`。
   - expose/副作用锁：`defineExpose({ fileInput, promptBoxEl, stopBtnRef, toolsRoot })`；组件内无 `addEventListener` / `removeEventListener` / `AbortController` / `setTimeout`。
   - 接线锁：core 返回且 ChatPage 解构 `MessageComposer`，根解构计数 657；根层仍注册 `onEscTools`/`onOutsideTools`，footer 原始块不再出现在 ChatPage；根层保留 `copy-toast`。
3. 新增组件，只搬 DOM 与文案；38 个动作全部换成 `emit(...)`。
4. `useChatPageCore.ts` import/return 加 `MessageComposer`；`ChatPage.vue` 解构加同名项，替换 1814–2302 原始 footer。
5. 跑 9.3.6 门禁；红测转绿后看 diff，确认 CSS、全局监听、发送/工具函数体零改动。
6. 代码单独提交；再用独立文档提交回写 commit hash。

#### 9.3.5 风险表

| 风险 | 影响 | 概率 | 缓解/判定 |
|---|---|---|---|
| `modelValue` / `composer-input` / `keydown` 漏接 | 输入不更新、高度不增长、Enter 不发送 | 高 | 三事件显式 emit；契约测试锁名字；模拟输入→Enter→发送→停止 |
| 四个 DOM ref 桥接失效 | `fileInput.click()`、`inputEl` 聚焦、`stopBtnRef` 焦点归还、`toolsRoot.contains()` 全失效 | 高 | 一个函数 ref 同时桥接四个 expose；模拟文件选择、停止后聚焦、工具面板外部点击/Esc |
| `toolsRoot` 桥接错导致全局监听误判 | 工具面板点外面不关、Esc 不关，或误关其它面板 | 中 | 契约测试锁 expose 与 root 监听；模拟 click outside 与 Esc |
| PromptBox slot / props 漂移 | 工具栏左右顺序错、高度被锁死、hint/placeholder 丢失 | 中 | 结构锁逐项核对；首屏截图对比（可用时）与手测 |
| 工具飞出 hover + click 顺序回归 | 悬停打开后点击反而关闭；搜索框焦点不对 | 中 | `hover-flyout` 与 `open-*panel` 分开发；根层函数仍用「已展开则保持」口径；模拟 hover→click |
| 队列/附件索引错位 | 上移/下移/编辑/删除/立即发送打错条目 | 中 | 所有 index/id 作为 emit 载荷回根；模拟 3 条队列与混合附件 |
| 发送/停止按钮状态漂移 | `current.sending` 时不显示停止、发送按钮可点、焦点不回输入框 | 中 | `current` + `canSend` 由根回灌；`stopBtnRef` 桥接；模拟流式发送中切换 |
| resize grip 事件丢失 | 拖拽高度、双击复位失效 | 低 | `@mousedown.prevent` / `@dblclick` 直接 emit；模拟拖拽与双击 |
| 文件 input 被误移出/属性变化 | 支持的文件类型、多选、隐藏行为变化 | 低 | 契约测试锁 id/accept/multiple/hidden；模拟工具菜单「添加文件」 |
| 全局监听或 AbortController 被误搬 | 重复注册/中断句柄漂移 | 低 | 契约测试锁组件内无 `addEventListener` / `AbortController`；core 注册/移除不变 |
| 根解构漏加 | 模板未定义变量或返回表漂移 | 中 | 与 core return 同提交；契约测试锁 657 |

#### 9.3.6 验证与模拟推演

门禁命令：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @bx/web test
pnpm --filter @bx/web type-check
pnpm type-check
pnpm build
pnpm test
git diff --check
Get-ChildItem -Name apps/web/dist/assets/ChatPage-*
```

判定：web 58/58、全仓 type-check、build、server 978/978 全绿；`ChatPage-*.js` / `ChatPage-*.css` 仍各一份；Chrome 全清单因已知实例冲突为非阻塞项，可做时按下列路径冒烟。

模拟推演（按顺序验证，任一步状态/焦点不符即停止）：

| # | 操作 | 期望状态链路 |
|---|---|---|
| 1 | 首屏 / 打开任务表单或任务列表 | `visible = !showTaskForm && !showTaskList`；表单/列表打开时 footer `display:none` 但仍挂载，DOM ref 不丢 |
| 2 | 输入文字 | `update:modelValue` 回写 `current.input` → `composer-input` 调根 `autoGrow` → PromptBox 高度在 min/max 间变化；placeholder/hint 正常 |
| 3 | Enter / Shift+Enter | `keydown` emit → 根 `onKeydown`：Enter 发送、Shift+Enter 换行；阻断开关与斜杠命令按既有行为 |
| 4 | 流式发送中切换停止/发送 | `current.sending` 时显示 `stopBtnRef` 按钮；点停止 → 根 `stop` 中断 root `controllers` 并归还焦点；停止后恢复发送按钮 |
| 5 | 队列三条时上移/下移/编辑/删除/立即发送 | 每条 emit 带正确 index → 根函数改 `current.queue`；首项上移与末项下移 disabled；落库后顺序回灌 |
| 6 | 添加/移除图片与文档，模型不支持图片 | `pick-files` 打开本地 hidden input；`remove-pending-*` 按 id 移除；`imagesUnsupported` 时警告行出现且图片不发送 |
| 7 | 拖拽 grip / 双击 | `start-composer-resize(event)` 与 `reset-composer-size` 回根；高度状态由 root 控制，刷新后行为一致 |
| 8 | 工具菜单开合 | 点 + → `toggle-tools-menu`；点外面 → 根 `onOutsideTools` 用桥接后的 `toolsRoot` 判断并关闭；Esc → 根 `onEscTools` 关闭全部面板 |
| 9 | 悬停/点击技能、MCP、助手入口 | `hover-flyout(kind)` 预开 + `open-*panel` 保持已展开；`searchAutofocus` 决定 ToolsSearch 是否聚焦；搜索词通过 `update:*Query` 回根 |
| 10 | 技能操作 | 勾选/取消 `toggle-skill(dir, enabled)`；添加技能打开/取消 SkillAddForm；created 回根刷新；取消全部按 root 状态禁用 |
| 11 | MCP 操作 | 开关 `toggle-mcp`、重连 `reconnect-mcp`、移除自定义 `remove-custom-mcp`、添加/取消/清空全部；`boundMcpIds` 的「已启用」项不可关；错误行回灌 |
| 12 | 助手 chip / 专家列表 / 发送模式 | 选专家 → `pick-expert` 路由跳转；× → `clear-expert` 回通用；`toggle-send-mode` 切换抢占/排队，图标与 title 同步 |
| 13 | 文件选择 | 工具菜单「添加文件」→ 本地 `fileInput.value?.click()` + `close-tools-panels`；选择后 `pick-files(event)` 回根，附件 chip 出现 |
| 14 | 切换对话后再回到原对话 | 四个 DOM ref 桥接仍指向当前 footer 节点；输入草稿/队列/附件随 `current` 切换正确显示 |

#### 9.3.7 回滚

- 未提交：删除新增组件/测试，恢复 `ChatPage.vue` 与 `useChatPageCore.ts`。
- 已提交：先 `git revert <C12 code sha>`，再单独 revert 回写 hash 的文档提交；禁止与 C13 合并。
- 若仅 DOM ref 桥接失败，优先保留四个 expose 并补 `element` emit 同步 root ref；不把全局监听、发送逻辑或 AbortController 搬进子组件。

#### 9.3.8 提交信息

```text
refactor(web): extract MessageComposer from ChatPage
```

- 实际代码提交：`5de59a9`；前置方案文档提交：`89b8c17`。

### 9.4 C13 `ChatTaskPanel.vue`

#### 9.4.1 目标与边界

- 目标：只把 `ChatPage.vue:806–1541` 的 `<Teleport v-if="showTaskForm" to="#task-panel-host">` 整段搬进新组件，**宿主、Esc capture、全局 outside/scroll/resize 监听、body overflow、提交/保存/通道 CRUD 函数全部留根**。
- 源块定位以符号为准：从 `<!-- v-if 挂在 Teleport 上 -->` 注释开始，到任务表单外层 `</Teleport>` 结束；后面的 `<main>`、`#task-panel-host`（`1649`）、任务列表和 MessageComposer 都留根。
- `v-if` 继续挂在组件内部 `Teleport` 上：根层无条件渲染 `<ChatTaskPanel :visible="showTaskForm" ... />`，子组件模板写 `<Teleport v-if="visible" to="#task-panel-host">`。不能把 `v-if` 挪到内部 `.task-panel` div，也不能在根层用 `v-if` 包组件后让子组件无条件 Teleport——两者都会改变宿主解析/挂载时机。
- 内部两层 `<Teleport to="body">`（日期时间面板、任务工具飞出）**随 DOM 一起搬进组件**，不抽出、不改成 Teleport 目标复用。
- 修正旧计划：`resRoot` 属于主区顶栏 `v-if="false"` 的遗留资源面板（`1558`），不在任务表单块，C13 不暴露；`onInlineSubmitKeydown` 留根，C12 已确认它不属于输入区，C13 也不搬。

#### 9.4.2 当前依赖基线（实施前已核对）

| 位置 | 现状 | C13 处理 |
|---|---|---|
| Teleport 宿主 | `#task-panel-host` 在 `<main>` 内，由 ChatPage 渲染；源 Teleport 在 `<main>` 之前 | 宿主留根；组件内部 Teleport 继续 `to="#task-panel-host"`，`v-if` 由 `visible` prop 控制 |
| 根状态机 | `showTaskForm`、`editingTaskId`、`taskDraft`、`editingTask`、`taskError`、`notify*`、`freq*`、`cronUnparsed`、`dt*`、`taskTools*` 全在 core | 全部 props + emits；可写字段通过 3 个 patch 事件回根 |
| 根 patch 桥 | 为避免在子组件内直接改 props，ChatPage 脚本新增三个本地函数：`patchTaskDraft`、`patchTaskRepeat`、`patchChannelDraft`，内部 `Object.assign` 到 reactive 对象 | 只做浅合并，不改业务逻辑；根解构只加 `ChatTaskPanel`，不加这三个函数 |
| DOM refs | `dtRoot` / `dtPanel`（`useOnceAtPicker()`）、`taskToolsRoot` / `taskToolsPanel` 被 core 的定位和 outside 判断读取 | 子组件 `defineExpose` 四个 ref，根层函数 ref 桥接 |
| 全局监听 | `onTaskFormEsc`（capture）、`onOutsideTaskTools`、`syncTaskToolsPos`、`syncDtPos` 在 core 注册/移除 | 不搬；组件内无 `addEventListener` / `removeEventListener` |
| 内部 Teleport | 日期面板 `v-if="dtOpen"`、任务工具面板 `v-if="taskToolsOpen"`，都 `to="body"` | 原样留在组件模板；`ref` 通过 expose 回根 |
| 工具/通道 helper | `iconStyle`、`iconChar`、`mcpDescText`、`taskConvText`、`notifyKindLabel`、`agentText` 等 | 后两者作为函数 prop，`agentText` 子组件直接 import |
| 根解构 | C12 后 657 个同名解构 | 新增 `ChatTaskPanel`，657 → 658 |

#### 9.4.3 组件契约

**新增 `apps/web/src/components/chat/ChatTaskPanel.vue`**

Props（63 个）：

| 分组 | props |
|---|---|
| 可见性/编辑态 | `visible`、`editingTaskId`、`editingTask`、`tasksBusy`、`taskDraft`、`taskError` |
| 通知 | `notifySummary`、`notifyDialogOpen`、`notifyChannels`、`channelDraft`、`notifyBusy`、`notifyNote` |
| 频率 | `freqDialogOpen`、`taskFreqSummary`、`cronUnparsed`、`editingCron`、`repeatPreview`、`taskRepeat`、`repeatFreqs`、`minutelyIntervals`、`weekdays` |
| 一次性日期 | `dtOpen`、`dtPos`、`dtDisplay`、`dtShortcuts`、`dtMonthLabel`、`dtWeekdays`、`dtCells`、`isDtToday`、`isDtPicked`、`dtHour`、`dtMinute`、`dtHours`、`dtMinutes`、`dtHourPart`、`dtMinutePart` |
| 任务工具 | `taskSearchAutofocus`、`taskToolsOpen`、`taskToolsPos`、`taskSkillOpen`、`taskSkillQuery`、`taskSkillFiltered`、`skillAvailable`、`taskSkillAddOpen`、`taskMcpOpen`、`taskMcpQuery`、`taskMcpFiltered`、`mcpAvailable`、`taskMcpCount`、`mcpReconnecting`、`mcpBusy`、`taskMcpAddOpen`、`taskExpertOpen`、`taskExpertQuery`、`taskExpertFiltered`、`taskAgentLabel` |
| helper/常量 | `agentId`、`uiLocale`、`iconStyle`、`iconChar`、`mcpDescText`、`taskConvText`、`notifyKindLabel` |

`dtShortcuts` 是 `DT_SHORTCUTS`，元素自带 `fn()` 闭包；`dtHourPart` / `dtMinutePart` 来自 `useOnceAtPicker()`，模板继续调用其 `onInput` / `onChange`。`taskDraft` / `taskRepeat` / `channelDraft` 是 reactive 对象，子组件**只读**，写操作通过 patch emit 回根。

Emits（40 个）：

| 类别 | emits |
|---|---|
| 表单 | `close-task-form`、`submit-task`、`apply-task-purpose(purpose)`、`open-task-conversation(schedule)`、`patch-task-draft(patch)` |
| 通知弹窗 | `update:notifyDialogOpen`、`save-channel`、`toggle-channel(ch)`、`test-channel(id)`、`remove-channel(id)`、`patch-channel-draft(patch)` |
| 频率弹窗 | `update:freqDialogOpen`、`patch-task-repeat(patch)`、`toggle-weekday(code)` |
| 日期选择 | `open-dt-picker`、`update:dtOpen`、`shift-month(n)`、`pick-day(day)`、`dt-hour-input`、`dt-hour-change`、`dt-minute-input`、`dt-minute-change` |
| 任务技能 | `update:taskSkillQuery`、`toggle-task-skill(dir)`、`task-skill-created(dir)`、`toggle-task-skill-add`、`cancel-task-skill-add`、`clear-task-skills` |
| 任务 MCP | `update:taskMcpQuery`、`toggle-task-server(id)`、`reconnect-mcp(id)`、`remove-custom-mcp(id)`、`task-mcp-created(id)`、`toggle-task-mcp-add`、`cancel-task-mcp-add`、`clear-task-mcp` |
| 任务助手/工具 | `update:taskExpertQuery`、`toggle-task-tools`、`open-task-flyout(kind)`、`hover-task-flyout(kind)` |

模板不变量：

- 外层 `<Teleport v-if="visible" to="#task-panel-host">`；`<div class="task-panel" role="region">` 是 Teleport 内单根。内部 `Teleport to="body"` 两处保持 `v-if` 在内部 div 上。
- `PromptBox v-model="taskDraft.prompt"` 改为 `:model-value` + `emit('patch-task-draft', { prompt: value })`；其余 `taskDraft.*` 直写也改为 patch emit。
- `v-model` 契约：`notifyDialogOpen`、`freqDialogOpen`、`dtOpen` 用对应 `update:*`；三个查询词用 `update:taskSkillQuery` / `update:taskMcpQuery` / `update:taskExpertQuery`。
- `ref="dtRoot"` / `ref="dtPanel"` / `ref="taskToolsRoot"` / `ref="taskToolsPanel"` 原样保留；`defineExpose({ dtRoot, dtPanel, taskToolsRoot, taskToolsPanel })`。
- `@click.stop`（任务面板内没有，但 MCP 重连/移除有）与 `@mouseenter` hover 预开保持；不新增 `.stop`。
- `tx()` 由 `getUiLocale()` 本地生成；`agentText` 直接 import；`iconStyle` / `iconChar` / `mcpDescText` / `taskConvText` / `notifyKindLabel` 只作 prop 调用。
- 组件内无 `addEventListener` / `removeEventListener` / `AbortController` / `setTimeout` / `document.body.style`。

#### 9.4.4 执行顺序

1. 开工前核对 `HEAD`、工作区干净、根解构 658 的前置 657，确认 `ChatTaskPanel.vue` 不存在。
2. **先加红测** `apps/web/tests/chat-task-panel-contract.test.ts`（5 个源码契约用例，web 58 → 63）：
   - 结构锁：外层 `Teleport v-if="visible" to="#task-panel-host"`、两个内部 `Teleport to="body"`、`.task-panel`、`.modal-mask`、`.tools-flyout`、四个 ref。
   - props 锁：63 个 prop 名字逐项一致；不含 `resRoot` / `showTaskForm`。
   - emits 锁：40 个 emit 名字逐项一致；含三类 patch 与七处 `update:*`。
   - expose/副作用锁：`defineExpose({ dtRoot, dtPanel, taskToolsRoot, taskToolsPanel })`；组件内无全局监听/计时器/body overflow 写入；core 仍保留 `onTaskFormEsc` capture 与 `onOutsideTaskTools` / `syncTaskToolsPos` / `syncDtPos` 监听。
   - 接线锁：core 返回且 ChatPage 解构 `ChatTaskPanel`，根解构计数 658；根层仍有 `#task-panel-host`，footer 原始 Teleport 块不在 ChatPage；三个 patch 函数在 ChatPage 脚本中存在。
3. 新增组件，只搬 DOM 与文案；40 个动作全部换成 `emit(...)`，helper 只作 prop 调用。
4. `useChatPageCore.ts` import/return 加 `ChatTaskPanel`；`ChatPage.vue` 解构加同名项，脚本加三个 patch 函数，替换 806–1541 原始 Teleport 块。
5. 跑 9.4.6 门禁；红测转绿后看 diff，确认 CSS、全局监听、提交/通道函数体、body overflow watch 零改动。
6. 代码单独提交；再用独立文档提交回写 commit hash。

#### 9.4.5 风险表

| 风险 | 影响 | 概率 | 缓解/判定 |
|---|---|---|---|
| Teleport 宿主解析时机回归 | 首次打开任务表单时报 target not found，或表单挂到错误节点 | 高 | 根层无条件渲染组件、`v-if` 留在外层 Teleport；契约测试锁字符串；模拟首次打开与反复开关 |
| 四个 DOM ref 桥接失效 | 日期面板定位错、任务工具飞出定位错、outside 点击判断失效 | 高 | 一个函数 ref 桥接四个 expose；模拟日期面板/工具面板定位与点外部关闭 |
| patch emit 漏接 | 名称/频率/提示词/通道草稿改不动，保存的是旧值 | 高 | 3 个 patch emit 显式锁定；契约测试锁名字；模拟改名称→保存→重开编辑 |
| Esc capture 被误搬或重复 | 表单开着时 Esc 关错面板，或关不掉表单 | 中 | `onTaskFormEsc` 留 core；契约测试锁 capture 注册；模拟频率/通知/日期面板开着时按 Esc |
| 内部 Teleport 被误改成 Teleport 目标复用 | 弹窗层级/裁剪回归 | 中 | 两个内部 `to="body"` 原样保留；模拟工具飞出不被弹窗 overflow 裁剪 |
| Cron/频率互斥漂移 | `cronUnparsed` 时选项仍可改，保存覆盖高级表达式 | 中 | `cronUnparsed` 由根 computed 回灌；按钮 `:disabled` 原样；模拟外部 cron 任务编辑 |
| 日期选择器闭包丢失 | `DT_SHORTCUTS` / `dtHourPart` / `dtMinutePart` 的 root 闭包失效 | 中 | 作为 prop 传入，不复制算法；模拟快捷日期、上/下月、时分输入 |
| 工具飞出 hover/click 顺序回归 | 悬停预开后点击反而关闭；focus 不对 | 中 | `hover-task-flyout` 与 `open-task-flyout` 分开；`taskSearchAutofocus` 由根决定 |
| 通道 CRUD 载荷错 | 保存/测试/删除打到错误通道 | 中 | id/ch 对象作为 emit 载荷回根；模拟多通道列表 |
| 根解构漏加 | 模板未定义变量或返回表漂移 | 中 | 与 core return 同提交；契约测试锁 658 |

#### 9.4.6 验证与模拟推演

门禁命令：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @bx/web test
pnpm --filter @bx/web type-check
pnpm type-check
pnpm build
pnpm test
git diff --check
Get-ChildItem -Name apps/web/dist/assets/ChatPage-*
```

判定：web 63/63、全仓 type-check、build、server 978/978 全绿；`ChatPage-*.js` / `ChatPage-*.css` 仍各一份；Chrome 全清单因已知实例冲突为非阻塞项，可做时按下列路径冒烟。

模拟推演（按顺序验证，任一步状态/焦点不符即停止）：

| # | 操作 | 期望状态链路 |
|---|---|---|
| 1 | 首次打开任务表单 | `showTaskForm=true` → 组件内部 Teleport 在 `#task-panel-host` 已存在后挂载 → `.task-panel` 出现；无 target not found |
| 2 | 关闭/重开 | 取消、×、Esc 都由 root `closeTaskForm` / `onTaskFormEsc` 收起；再次打开仍定位正确，四个 ref 重新桥接 |
| 3 | 新建 vs 编辑 | `editingTaskId` 控制标题与按钮文案；编辑时显示结果对话行，`taskConvText` 正确，「打开」回 root `openTaskConversation` |
| 4 | 名称/用途/落点/通知策略 | 每次输入或点击 emit patch → root `Object.assign(taskDraft, patch)` → 表单回显与 `:aria-checked` 同步 |
| 5 | 保存/创建 | root `submitTask` 用最新 `taskDraft` / `taskRepeat` / `channelDraft`；`tasksBusy` 时按钮禁用；错误行 `taskError` 回灌 |
| 6 | 通知通道弹窗 | 管理按钮开弹窗；保存/启停/测试/删除都带正确草稿或 ch/id；摘要 `notifySummary` 与列表随 root 状态更新 |
| 7 | 频率弹窗 | 周期/一次性切换、分钟/小时/日/周/月、时刻、星期多选全部 patch `taskRepeat`；`repeatPreview` 与 `taskFreqSummary` 回灌 |
| 8 | 外部 cron | `cronUnparsed` 时两类按钮 disabled、只显示 `editingCron`；保存不回传频率 |
| 9 | 一次性日期面板 | 点日期字段 → `open-dt-picker` 定位；快捷项/翻月/选日/时分输入/确定全走 root；`dtOpen` 关闭后 Teleport 内 div 卸载 |
| 10 | 任务内容 PromptBox | `taskDraft.prompt` patch 回写；`:hint` 与用途相关 placeholder 正确；Shift+Enter 换行 |
| 11 | 任务工具菜单 | 点 + → `toggle-task-tools`；定位用 `taskToolsRoot` + `taskToolsPos`；点外部/滚动/缩放仍由 root 监听关闭或重定位 |
| 12 | 技能/MCP/助手飞出 | 三类 `open-task-flyout` / `hover-task-flyout` 与查询词 v-model 回根；勾选写 `taskDraft.skills/mcpServers/agentId` 的 patch；badge 同步 |
| 13 | Esc 优先级 | 通知/频率/日期/工具面板任一开启时按 Esc，只关最内层或按 root `onTaskFormEsc` 口径处理；表单退出只走 root |
| 14 | 保存后回列表 | 成功提交后表单关闭、任务列表刷新；再打开编辑回显同一任务；无残留 Teleport 节点或全局监听 |

#### 9.4.7 回滚

- 未提交：删除新增组件/测试，恢复 `ChatPage.vue` 与 `useChatPageCore.ts`，移除三个 patch 函数。
- 已提交：先 `git revert <C13 code sha>`，再单独 revert 回写 hash 的文档提交。
- 若仅 Teleport/ref 桥接失败，优先恢复 `v-if` 在外层 Teleport 与四个 expose 桥接；不把全局监听、body overflow 或提交逻辑搬进子组件。

#### 9.4.8 提交信息

```text
refactor(web): extract ChatTaskPanel from ChatPage
```

- 实际代码提交：`f9e8ac8`；前置方案文档提交：`e9d56f9`；CSS 作用域修复提交：`f702e85`；UiSelect 注册修复提交：`1d441cd`。

### 9.5 T6 通用提交信息

```text
refactor(web): extract <ComponentName> from ChatPage
```

## 10. T7：CSS 下沉

### 10.1 原则

- 按 `chat-page.css` 注释锚点逐块下沉，每块单独提交。
- 曾因 `scoped` 下沉导致 `.group-head` 裸奔，**共享基类不得下沉到 scoped 子组件**；确认只被该组件使用的块才加 `scoped`。
- C6–C13 抽取后父级 `scoped` 无法命中子组件/Teleport 内部元素，`f702e85` 已把 `chat-page.css` 改为非 scoped 并转换 5 处 `:deep()`；T7 下沉时须给对应组件自身加 `scoped`，不要恢复父级 `scoped`。
- 每块下沉后做截图对比：侧栏、任务表单、弹窗、气泡、输入区。

### 10.2 下沉清单

| CSS 块 | 当前锚点 | 归属 |
|---|---:|---|
| 侧栏品牌/助手切换 | 31–217 | `ChatSidebarList.css` |
| 定时任务分组/任务卡片 | 218–252、653–845 | `ChatSidebarList.css` / `ChatTaskPanel.css` |
| 通知通道管理 | 253–489 | `NotifyChannelPanel.css`（如未抽组件，暂留根） |
| 任务表单 | 490–1064、1073–1381 | `ChatTaskPanel.css` |
| 任务时间选择器 | 1382–1594 | `TaskDatePicker.css`（如未抽组件，暂留根） |
| 快捷操作导航 | 1595–1645 | `ChatSidebarList.css` |
| 骨架/拖拽/状态点 | 1646–1750 | 对应列表组件 CSS |
| 删除确认弹窗 | 970–1014 | `ConfirmDialog.css` |
| Toast | `done-toast` 相关规则 | `DoneToast.css` |
| 产物预览 | `preview-*` 相关规则 | `ArtifactPreviewModal.css` |
| 对话区/气泡/大纲 | `.thread` / `.reasoning` / `.outline` 相关规则 | `ChatThread.css` |
| 右键菜单 | `.ctx-*` 相关规则 | `ContextMenuHost.css` |
| 输入区 | `.composer` 相关规则 | `MessageComposer.css` |

### 10.3 必须留在 `chat-page.css`

- `.chat` / `.sidebar` / `.main` 布局骨架。
- `.group-head` 及 `__label` / `__count` / `__caret`。
- `.modal-mask` / `.modal` / `.modal__head` / `.modal__body` / `.modal__foot`。
- `.task-groups` / `.task-groups-empty`。
- `.conv-dot` / `.chip` / `.warn-line` 等通用修饰类。

### 10.4 验证重点

- 截图对比无位移、无遮挡、无字体/颜色回归。
- `apps/web/dist/assets/ChatPage-*` 仍只有一份 CSS，且组件 CSS 被正确打包。
- 通用验证命令 + Chrome 清单。

### 10.5 提交信息

```text
style(web): move <block> styles into <ComponentName>
```

## 11. 全阶段收口门禁

T0–T7 全部完成后，执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm type-check
pnpm test
pnpm --filter @bx/web test
git diff --check
Get-ChildItem -Name apps/web/dist/assets/ChatPage-*
pnpm --filter @bx/web type-check
pnpm --filter @bx/web type-check
pnpm --filter @bx/web type-check
```

判定：

- 前 6 项全绿；单 chunk 唯一。
- 连续 3 次 `pnpm --filter @bx/web type-check` 结果一致且退出码 0。
- 41 键 provide 断言未被触发；Chrome 全清单无 error。

## 12. P1-2：后续独立变更（不属于本计划提交）

满足第 11 节门禁后，单独提交：

- 文件：`.github/workflows/ci.yml`
- 改动：第 49–51 行删除 `continue-on-error: true`，步骤名由 `Type check (web, non-blocking)` 改为 `Type check (web)`。
- 提交信息：`ci: make web type check blocking after ChatPage split`
- 若 CI 连续 2 次失败，先修复类型不稳定根因，不回退拆分；若无法稳定，记录例外并回到设计层评审。

## 13. 回滚策略

| 场景 | 操作 |
|---|---|
| 某步提交前验证失败 | 只 `git restore` 该步涉及的文件，确认 `git status` 回到上一个提交状态 |
| 某步提交后发现回归 | `git revert <该步提交>`，不手改回退；确认后续步骤未依赖该步 |
| C0 文档提交需回退 | 单独 `git revert C0`，不影响代码提交 |
| 多步同时失败 | 从最后一个提交开始逐个 revert，禁止跨步骤手工合并补丁 |
| P1-2 CI 失败 | 单独 revert CI 提交，拆分提交保留 |

## 14. 明确不做

- 不在本计划内做 P1-2（只在第 12 节定义后续独立变更）。
- 不做 P1-3～P1-7、A/B 重跑、BI 治理、后端/API 变更。
- 不改 `App.vue` 的 `:key="$route.path"`。
- 不把 composables 做成动态 import。
- 不为“顺手优化”改 `.catch` 静默行为。
- 不在 UI 抽取阶段顺手做 i18n 资源化或 CSS 重构；这些是独立事项。
