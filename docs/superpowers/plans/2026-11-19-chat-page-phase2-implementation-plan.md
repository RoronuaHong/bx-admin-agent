# 实现计划：ChatPage 阶段 2 细化实施（SCC 拆分 + UI 子组件 + CSS 下沉）

- 日期：2026-11-19
- 状态：**执行中｜C0/T0/T1/T2/T3/T4/C6 已提交，T5 C7（ArtifactPreviewModal）已实现待提交**（2026-11-19 复核）
- 用户指令依据：2026-11-19「写细化计划吧」——按 `docs/superpowers/specs/2026-11-18-chat-page-phase2-design.md` 已被审阅确认处理。
- 执行记录（2026-11-19）：
  - C0 文档提交 `6709f4a`。
  - T0 `useChatPersistence` + `chat-page-types.ts` 提交 `37d8663`（`useChatPageCore.ts` 6269→5959 行）。门禁全绿：build / type-check / web test / server test / diff / 单 chunk。
  - T1 SCC C 拆三件（`useChatModelSettings` / `useChatThreadScroll` / `useChatReasoningUI`）提交 `3f6d81c`（协调层再降约 340 行）。门禁全绿。
  - T2（SCC A）**已提交 `23c9d28`**：先补齐 33 个 web 行为测试与 AST 依赖/TDZ 审计，再按裁剪边界把会话壳（排序/切换/草稿建会话/右键/删除撤销）迁入 `useChatConversationShell.ts`；`useChatPageCore.ts` 降到 5345 行。拆分后 33 个 web 测试、全仓 type-check、build、978 个 server 测试全绿；provide 41 键契约加固仍留 T4。
  - T3（SCC B）已提交 `1bbf757`：先补 `apps/web/tests/chat-tool-panels.test.ts`（9 个特征测试）锁定三飞出互斥/query 重置、MCP 逐行 busy 与回滚、fuzzy 搜索、专家 chip/starter、任务飞出层共享引用、bound MCP 合并落库；再按 37 个跨组依赖注入拆出 `useChatToolPanels.ts`（603 行），协调层降到 4918 行。AST 对比 50 个声明全部行为等价（无 DIFF），42 web 测试、全仓 type-check、build、978 server 测试全绿，仍为单个 ChatPage chunk。
  - T4（provide 契约加固）已提交 `dab6470`：新增 `apps/web/tests/bubble-context-contract.test.ts`（3 个契约测试）锁 provide/interface/ChatBubble 三者 41 键顺序与 guard 存在；`useChatPageCore.ts` 原位抽 `bubbleContext`，加 `satisfies BubbleContext` 与 DEV 数量断言，`bubble-context.ts` 无需改动。web 测试 42→45，全仓 type-check、连续 3 次 web type-check、build、978 server 测试全绿，仍是单个 ChatPage chunk。
  - T5 C6（DoneToast）已提交 `8631510`：新增 `components/chat/DoneToast.vue`，Teleport 与 done-toast DOM 原样搬入，props `doneToast` + emits `view/close`；根层保留 `doneToast` ref、`doneToastTimer`、`openDoneToast` 与关闭清理。web 45/45、web type-check、build 全绿，仍是单个 ChatPage chunk。
  - T5 C7（ArtifactPreviewModal）已实现待提交：新增 `components/chat/ArtifactPreviewModal.vue`，props `previewHtml/previewLoading/downloadUrl` + emits `close`；下载 URL 由根层基于 `workspaceDownloadUrl(currentId, previewHtml.path)` 计算后传入，iframe `sandbox="allow-scripts"` 不变。web 45/45、web type-check、build 全绿，仍是单个 ChatPage chunk。
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

1. `ChatPage.vue` 根层保留 `defineProps`、`useRouter`、`import type { ScheduleDto }`、653 个顶层同名解构。
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
| C7 | T5 `ArtifactPreviewModal.vue` | 新增 `components/chat/ArtifactPreviewModal.vue` + `ChatPage.vue` + `useChatPageCore.ts` | ✅ 已实现待提交：sandbox 不变，downloadUrl 根层计算，web 45/45 + 单 chunk |
| C8–C9 | T5 其余低风险 UI | `ConfirmDialog` → `ChatThread` | ⏳ 按组件单提交 |
| C10–C13 | T6 高风险 UI | 同上 | ⏳ 可独立完成 |
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
- 右键键盘 `Shift+F10` / 菜单键、点击外部关闭、Esc 优先级。
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
- props：`confirmDialog`；emits：`confirm`、`cancel`。
- `confirmDialogEl` / `confirmPrimaryBtn` 通过 `defineExpose` 暴露；`trapConfirmFocus` 与 body overflow 仍由根控制。
- 验证：删除确认、取消、Esc、Tab focus trap、危险按钮样式、确认后删除与撤销条。

### 8.4 C9 `ChatThread.vue`

- 源块：约 2211–2280 的 `.thread` 容器。
- props：`visibleBubbles`、`booting`、`showSkeleton`、`modelSwitchHint`、`currentExpert`、`expertStarters`、`latestAlertMarkerId`、`outline` 相关 props、`isMobile`、`sidebarOpen`。
- emits：`scroll`、`outline-user-scroll-intent`、`show-earlier`、`dismiss-model-hint`、`ask-starter`、`jump`、`active`。
- `threadEl` 通过 `defineExpose` 暴露；`@scroll="onThreadScroll"` 保留在根传入的 handler；`v-model:open="outlineOpen"` 的 prop 名必须是 `open`。
- 验证：骨架/空态、长对话“显示更早”、BackToTop、大纲浮层与跳转高亮、滚动跟底、移动端抽屉遮挡逻辑。

### 8.5 T5 通用提交信息

```text
refactor(web): extract <ComponentName> from ChatPage
```

## 9. T6：抽高风险 UI 子组件

每个组件仍单独提交。全局键鼠监听、Teleport 宿主顺序、`v-model` 契约、provide 链是本阶段红线。

### 9.1 C10 `ContextMenuHost.vue`

- 源块：约 1009–1135 的 `Teleport to="body"`。
- props：`ctxMenu`、`ctxTarget`、`ctxTargetTask`、`ctxConfirm`、`sortMode`、`locations`；emits：所有 `ctx*` 动作事件 + `close`。
- 保留 `@click.stop`、`@contextmenu.prevent`、`@keydown="onCtxMenuKeydown"`、`role="menu"` / `role="menuitem"`。
- `ctxMenuEl` 用 `defineExpose` 暴露；全局 Esc capture、scroll/resize capture 与焦点归还继续留根。
- 验证：对话/任务两套菜单、二次确认清空、Shift+F10、键盘导航、点击外部关闭、发送模式切换。

### 9.2 C11 `ChatSidebarList.vue`

- 源块：约 667–1001 的 `<aside>` 内容。
- props：会话/任务列表、`sortMode`、`showArchived`、`currentId`、`ctxMenu`、`pinnedAt` 等；emits：`select`、`new`、`ctx`、`drag`、`drop`、`reorder`、`rename`、`toggle-archive`。
- `agentMenuEl`、`convListEl`、`renameInputEl`、`setRenameInput` 用 `defineExpose` 暴露；`tx()` 文案可暂留模板内，不在本步做 i18n 重构。
- 验证：列表分组、拖拽排序、内联重命名、右键入口、移动端抽屉、归档计数。

### 9.3 C12 `MessageComposer.vue`

- 源块：约 2282–2770 的 `<footer class="composer">`。
- props：`modelValue`（对应 `current.input`）、`queue`、`pendingImages`、`pendingDocs`、`canSend`、`busy`、`panels`、`models` 等；emits：`update:modelValue`、`send`、`stop`、`pick-files`、`toggle-tools` 等。
- 必须使用 `v-model` 契约，不复制 ref 为普通值；`fileInput`、`promptBoxEl`、`inputEl`、`stopBtnRef`、`toolsRoot` 通过 `defineExpose` 暴露。
- Teleport 飞出层、Esc、工具面板互斥、发送模式快捷入口行为不变。
- 验证：普通发送、停止、续传、附件、工具菜单、MCP/技能/专家面板、输入框 autogrow 与焦点。

### 9.4 C13 `ChatTaskPanel.vue`

- 源块：约 1230–1965 的 `Teleport v-if="showTaskForm" to="#task-panel-host"` 及其内容。
- props：`taskDraft`、`editingTaskId`、`notifyChannels`、`freqDialogOpen`、`notifyDialogOpen`、`cronUnparsed` 等；emits：`submit`、`cancel`、`run`、`toggle` 等。
- `#task-panel-host` 约 2073 行，必须先于条件 Teleport 渲染；`v-if` 继续挂在 `Teleport` 上，不能移到内部 div。
- `dtRoot` / `dtPanel`（来自 `useOnceAtPicker()`）、`taskToolsRoot` / `taskToolsPanel`、`resRoot` 用 `defineExpose` 暴露。
- 内部多层 Teleport、Esc capture、`onOutsideTaskTools` 留根；body overflow 由根控制。
- 验证：新建/编辑任务、Cron 解析、通知通道、日期时间选择器、工具选择面板、Esc 退出、打开结果会话。

### 9.5 T6 通用提交信息

```text
refactor(web): extract <ComponentName> from ChatPage
```

## 10. T7：CSS 下沉

### 10.1 原则

- 按 `chat-page.css` 注释锚点逐块下沉，每块单独提交。
- 曾因 `scoped` 下沉导致 `.group-head` 裸奔，**共享基类不得下沉到 scoped 子组件**；确认只被该组件使用的块才加 `scoped`。
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
