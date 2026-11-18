# ChatPage.vue 分阶段拆分设计（P1-1）

- 日期：2026-11-17
- 状态：设计已确认（两阶段，阶段 1 策略已纠正）；阶段 1 已按本设计实施完成并提交，阶段 2 待后续确认
- 决策来源：用户逐项确认（文档粒度=设计与实施计划合一；拆分策略=分两阶段；零风险纠正=阶段 1 改为整脚本原子搬迁）
- 关联：`docs/engineering-optimization-review.md` P1-1 / P1-2；`docs/README.md` 效力约定
- 范围：`apps/web/src/pages/ChatPage.vue`、`apps/web/src/pages/chat-page.css`、`apps/web/src/chat-types.ts`、`apps/web/src/bubble-text.ts`、新增 `apps/web/src/composables/chat/useChatPageCore.ts`

## 1. 背景与目标

`ChatPage.vue` 当前 **7723 行 / 393,352 字节**，`chat-page.css` **4142 行 / 92,705 字节**。`docs/engineering-optimization-review.md:106` 的 7218 行 / 354.84 KB 是旧快照，以本文件实测为准。

原方案是阶段 1 直接按职责抽 24 个 composables。符号级核对证明该方案**做不到零风险**：跨组引用成环，根块反向依赖未返回符号，模板 refs 与共享状态散落在多组，任意单组提交都会在 setup 期拿到 `undefined`。因此阶段 1 策略纠正为：

> **整脚本原子搬迁**：把当前 `script setup` 的逻辑（函数体/声明顺序）原封不动搬进 `useChatPageCore.ts`，只对 SFC 宏与模板可见绑定做机械适配；根组件保留 props/router/模板类型 import 与全量解构，模板、CSS、内部顺序、函数体全部不动。

目标：

1. 阶段 1 行为零变化，`ChatPage.vue` 从 7723 行降到约 **2100 行**（只剩 template + 极简 script + style 外链），5607 行 script 进入 `useChatPageCore.ts`。
2. 阶段 1 完成后 `vue-tsc` 连续稳定，P1-2 可恢复阻断门禁。
3. 阶段 2 再按**强连通分量（SCC）**拆 `useChatPageCore.ts`，而不是按直觉逐组抽。
4. 不引入运行时依赖、不改后端、不改 API、不触碰 A/B 或 BI 相关事项。

## 2. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 文档粒度 | 设计与实施计划合一：拆分边界、逐文件清单、风险/回滚、验收命令都写清 |
| 拆分策略 | 分两阶段：阶段 1 整脚本原子搬迁，阶段 2 按 SCC 拆 composables + UI 子组件 |
| 阶段 1 边界 | 只搬 script 到 `useChatPageCore.ts`；模板、CSS、API、后端、脚本内部顺序一律不改 |
| 阶段 2 边界 | 按依赖环拆 SCC，再抽纯 UI 子组件并下沉 CSS；保留 Teleport 顺序、provide/inject、v-model 契约 |
| 执行顺序 | 先阶段 1；阶段 2 必须等阶段 1 全绿且 `vue-tsc` 稳定后再单独确认 |
| 行为约束 | 以“现有功能逐项保持一致”为验收前提，不做顺手优化 |
| 提交粒度 | 阶段 1 原子单提交；阶段 2 每个 SCC / 子组件单独提交 |
| 零风险纠正 | 放弃原逐组抽取；原逐组方案暴露的跨组问题全部转为阶段 2 的 SCC 设计输入 |

## 3. 现状审计（代码级）

行号是 2026-11-17 审计快照，已包含 P0-4 卸载清理改动。核对时以符号名优先。

### 3.1 文件边界

- `script setup`：1–5607
- `template`：5609–7720
- `style`：7722，外链 `./chat-page.css`

### 3.2 script 职责分组（供阶段 2 使用，不是阶段 1 的抽取顺序）

| 分组 | 行号 | 主要内容 |
|---|---:|---|
| imports / 共享类型 / i18n | 1–134、1252–1265 | Vue、Router、组件、API、`@bx/shared`、工具函数；`tx()` 四语 |
| 任务 | 135–1265 | 任务列表、草稿、轮询、通知、cron、模板指令、CRUD、飞出 |
| 气泡模型 / `ConvState` | 1175–1325 | 气泡、工具步骤、子代理、确认/澄清类型；`blankState()` 在 1310 |
| 会话壳 | 1327–1616 | 模型/会话列表、拼音搜索、Agent 切换、右键菜单、确认/预览、排序拖拽；`currentId` 在 1419 留根 |
| 输入区尺寸 | 1610–1696 + 1732 | 输入框高度、autoGrow、resize、`watch(current.input, autoGrow)` |
| 运行时 Map | 1698–1729 | `states: reactive(Map)`、`current`、`stateOf()`；`deviceLocale`(1699)/`settingsError`(1710) 留根 |
| 告警/长窗口 | 1734–1810 | 告警标记缓存、长对话窗口、展开更早消息 |
| 大纲 | 1812–1952 | 大纲派生、跳转、高亮 pin、缓存、fallback 定时器 |
| 焦点修复 | 1954–1969 | 发送/停止后的焦点接管，留根 |
| 模型设置 | 1971–2112 | 模型下拉、auto 解析、失败黑名单、语言/模型乐观更新 |
| MCP 面板状态 | 2114–2122 | `mcpOpen` / `mcpAvailable`，归 MCP 组 |
| 滚动/推理 UI | 2124–2340 | `seq`(2124) 留根；跟底滚动、推理/步骤展开、思考计时与标题 |
| 快照/持久化 | 2341–2537 | `toStored`、`bubblesFromStored`、`applyServerThread`、`syncOpenConversation`、`persist` |
| 会话列表/动作 | 2538–3052 | 列表刷新、新建、排序、拖拽、置顶分组、归档计数 |
| 右键/破坏性动作/设置 | 3054–3599 | 右键菜单、删除撤销、归档/免打扰/完全访问/发送模式、复制导出、重命名/置顶/清空 |
| 附件/队列/run | 3601–4015 | 上传、队列、发送、`send/runTurn/resumeRun/applyChatEvent`（run 留根） |
| 后台守望 | 4017–4133 | 后台守望、`deferOnPage()`、`pageUnmounted`、done toast，留根 |
| 中断/澄清 | 4135–4481 | 中断收口、补提问、确认/澄清票据，与 run 强耦合、留根 |
| MCP/技能/工具/专家 | 4483–5073 | MCP 加载/勾选/重连、技能、工具搜索、专家入口、全局 Esc/outside |
| 记忆/工作区/文案 | 5075–5237 | 长期记忆、工作区文件、产物 URL、气泡文案、复制、回填 |
| bootstrap/生命周期/provide | 5239–5607 | 首屏恢复、时钟、`onMounted`、route query watch、`onBeforeUnmount`、`provide(bubbleContextKey, …)` |

顶层 `watch` 9 处：1369、1577、1732、1757、1793、1896、1901、1961、5488。主要定时器/守望：任务轮询、撤销删除、设置错误、清空确认、大纲 fallback、rAF 滚动、队列/后台守望、复制提示、活跃上报、骨架延迟、每秒时钟、统一卸载清理（5496–5560）。

### 3.3 必须保持的不变量

1. 路由 props `agentId` / `agentLabel`（1364–1366）与 `AGENT_ID` 推导。
2. `RouterView :key="$route.path"`（`App.vue:29-31`）的重挂载语义。
3. `provide(bubbleContextKey, …)`（5565–5605，41 键）与 `bubble-context.ts` 注入契约。
4. 全局键盘与外部点击在 `onMounted()`（5384–5416）注册、`onBeforeUnmount()`（5499–5516）对称移除；任务表单 Esc capture 优先级最高。
5. `document.title` immediate watch、确认弹窗锁 body overflow、theme fallback 等文档副作用。
6. `states: reactive(new Map)`（1715）与 `persistedCount` 非响应式游标；后台流写各自 bubbles。
7. 卸载清理（5496–5560）：时钟、任务轮询、全局监听、待删落库、骨架、大纲 fallback、`pageUnmounted`、`unmountTimers`、四个具名定时器、队列/后台守望、done toast。
8. Teleport 宿主 `#task-panel-host`（7017）必须先于条件挂载的 Teleport 内容存在。
9. `currentId`（1419）必须留根并先于所有依赖 `current` 的 watch/composable 声明；1732、1757、1901、1961 在 setup 期读取。
10. `seq`（2124）是每页可写计数器，必须留根并通过 `nextSeq()` 递增；7 处 `++seq` 不得分散到私有副本。

## 4. 总体设计

### 4.1 阶段 1：整脚本原子搬迁

```
ChatPage.vue
  ├─ import type { ScheduleDto } from "../api"   ← 模板 5818/7143 类型断言需要
  ├─ defineProps(agentId, agentLabel)
  ├─ useRouter()
  └─ const { ...模板可见绑定 } = useChatPageCore({ agentProps, router })
      ↑ 解构表排除 agentProps / router / useRouter，保留模板同名绑定

useChatPageCore.ts
  └─ 当前 script 1–5607 的逻辑原封不动（函数体/声明顺序不变）
      ├─ 用 options 接 agentProps(Readonly) 与 router，不再自己调用 defineProps/useRouter
      ├─ 同步调用 useTheme()/useOnceAtPicker()/provide/watch/onMounted/onBeforeUnmount
      ├─ 返回所有模板可见的 runtime 绑定（含 11 个组件与 6 个 runtime import/常量）
      └─ 不改任何函数体、不改模板、不改 CSS
```

这是**搬迁**，不是重写。`useChatPageCore.ts` 仍是一个大文件，但把逻辑与 SFC 模板解耦，为阶段 2 提供单一可控的拆分对象。

### 4.2 阶段 1 硬规则

- `useChatPageCore.ts` 的 function body 与声明顺序必须与当前 script 1–5607 一致；禁止调整顺序、合并 watch、改名。唯一允许的机械适配是：`defineProps` / `useRouter` 改为 options 入参，type-only import 按需要拆分。
- options 类型：`agentProps: Readonly<{ agentId?: string; agentLabel?: string }>`、`router: Router`。core 不得返回 `agentProps` / `router` / `useRouter`；根层解构表也必须排除这三者，避免重复声明。
- 返回值必须覆盖所有模板可见 runtime 绑定，且**对象/数组解构绑定要递归收集**（如 `useOnceAtPicker()` 的 `dtRoot` / `dtPanel`）。尤其包括：11 个模板组件 `UiSelect`、`PromptBox`、`ToolsSearch`、`SkillAddForm`、`McpAddForm`、`ModelSelect`、`UiLocaleSelect`、`ThemeToggle`、`ChatBubble`、`BackToTop`、`ConversationOutline`；6 个 runtime import/常量 `agentText`、`AGENTS`、`workspaceDownloadUrl`、`MINUTELY_INTERVALS`、`REPEAT_FREQS`、`WEEKDAYS`。`ChartCard` 模板未用，可不返回。2026-11-17 AST 干跑基线：顶层绑定 657、排除后 653、重名 0、provide 键 41。
- 根层必须保留 `import type { ScheduleDto } from "../api"`，因为模板 5818 / 7143 有 `ScheduleDto['lastStatus']` 断言；其他 type-only import 留在 core。
- `ChatPage.vue` 用自动生成的顶层解构保持模板绑定名不变，禁止改成 `core.xxx`；解构表与实际返回值做 `satisfies` 核对，少一个即提交失败。ref/computed 必须以对象返回，不得 `toValue()` 成快照。
- `provide` / `watch` / `onMounted` / `onBeforeUnmount` / `useTheme()` / `useOnceAtPicker()` 必须在 setup 同步调用链里执行，禁止放进 async 函数或 `await` 之后。
- 模板、CSS、API、后端、路由语义、provide 对象结构一律不改。
- `vitest@^4.1.12` 仅作为 devDependency 加入，`"test": "vitest run"` 脚本与 `pnpm-lock.yaml` 同提交；不进生产 bundle。
- composables 不做动态 import，`ChatPage-*.js` 仍只有一个路由 chunk。

### 4.3 阶段 2：按 SCC 拆 `useChatPageCore.ts`

符号级核对发现以下强连通分量，必须整体处理，不能逐组抽：

| SCC | 成员 | 原因 | 处理方式 |
|---|---|---|---|
| A | 会话壳 + 会话列表 + 右键菜单 + 任务 | `taskConvIds`、`removeConversation`、`closeCtxMenu`、`showTaskForm/loadTasks` 等互相引用成环 | 合并为一个 composable，或先把共享状态/函数留根再拆 |
| B | MCP + 技能 + 工具选择 + 专家 | `mcpAvailable/skillAvailable/boundMcpIds/skillQuery/searchAutofocus` 互依 | 合并为一个 composable，或共享状态留根 |
| C | 滚动 + 推理 UI + 模型设置 | `useChatRun` 与根块反向依赖 `followBottom/atBottomNow/thinkPhaseStart/queueScrollIfCurrent/lastGoodModelId` 等 | 先 define ComposableApi 返回，再按 modelSettings → threadScroll → reasoningUI 顺序调用 |
| 前置 | 快照/持久化 | 被 shell/task/ctx/run 多处调用 | 在 SCC A/B 之前抽出，并把 `syncOpenConversation/waitPendingPersists/toStored/bubblesFromStored` 列入 ComposableApi |

阶段 2 仍须遵守以下硬清单（这些内容在阶段 1 不需要落地，但要保留为阶段 2 约束）：

- **RootApi**：`currentId`、`current`、`states`、`stateOf`、`AGENT_ID/AGENT_LABEL`、`uiLocale`、`tx`、`messageTimes`、`persistedCount`、`browserTimeZone`、`deviceLocale`、`settingsError`、`nextSeq()`、`deferOnPage`、`send`、`watchBackgroundDone`、`ensureRunPrompt`、`attachRunningTask`、`onNavigate`、`flushPendingDelete` 等 getter / 回调。
- **ComposableApi 必须额外返回**：`{followBottom,atBottomNow,queueScrollIfCurrent,thinkPhaseStart,thinkPhaseEnd,stickThinkingToBottom,openReasoningPanel,closeReasoningPanel,lastGoodModelId,failedModelIds,createConvFromDraft,enqueueMessage,drainQueue,syncOpenConversation,waitPendingPersists,toStored,bubblesFromStored,upgradeConversationDetail}`，以及全局监听处理器与 `loadTasks/loadNotifyChannels/startTasksPoll/stopTasksPoll` 等 bootstrap 回调。
- **模板 refs 硬清单**：`threadEl`、`fileInput`、`promptBoxEl`、`inputEl`、`stopBtnRef`、`agentMenuEl`、`convListEl`、`ctxMenuEl`、`confirmDialogEl`、`confirmPrimaryBtn`、`dtRoot/dtPanel`、`taskToolsRoot/Panel`、`resRoot`、`toolsRoot`、`setRenameInput`、`renameInputEl`；`threadEl`/`inputEl` 留根并 getter 注入。
- **每页实例 vs 模块单例**：每页实例有 `states`、`persistedCount`、`seq`、`alertMarkerCache`、`outlineCache`、`bubbleArrSeq`、`thinkStarts`、`pendingPersists/persistChains`、`queueSetChains`、`pageUnmounted/unmountTimers`；模块级有意复用 `uiLocale`、theme fallback/provide、`AGENTS`。
- **工具函数提前抽出**：`bubbleHasAlertMarker`（648）移到 `bubble-text.ts`，`blankState`（1310–1325）归入 runtimeMap。
- **provide**：41 键用 `satisfies BubbleContext` + `Object.keys(obj).length === 41` 双重断言；7 个裸 import 键与约 37 个 inject-only 键都必须保留。

## 5. 阶段 1 实施清单（先执行）

阶段 1 是一个原子提交，不逐组提交。

1. **生成核心文件**：新建 `apps/web/src/composables/chat/useChatPageCore.ts`，把 `ChatPage.vue:1-5607` 的函数体与声明顺序原样搬入；把 `defineProps` / `useRouter` 改成 options 入参；用脚本生成返回值表，覆盖全部模板可见绑定（11 个组件、6 个 runtime import/常量、所有模板 refs 与 41 个 provide 符号），排除 `agentProps` / `router` / `useRouter`。
2. **改根组件**：`ChatPage.vue` 的 script 只保留 `import type { ScheduleDto }`、`defineProps`、`useRouter`、顶层同名解构；template 与 style 外链不动。解构表由脚本生成，禁止 `core.xxx` 写法。
3. **测试底座**：同提交加 `vitest@^4.1.12` devDependency、`"test": "vitest run"` 脚本、锁文件更新，以及针对纯函数的最小单测。
4. **验证后一次性提交**：`pnpm build`、`pnpm type-check`、`pnpm test`、`pnpm --filter @bx/web test`、Chrome 全量手工清单、`ChatPage-*.js` 单 chunk 检查全部通过才提交。
5. 类型迁移（`ConvSettings` / `ConvState` / `TaskGroupRun` / `TurnRun`、页内重复 `Bubble`、`bubbleHasAlertMarker`）留到阶段 2，不进阶段 1，确保阶段 1 只做机械搬迁。

阶段 1 完成标准：`ChatPage.vue` 约 2100 行；`useChatPageCore.ts` 约 5600 行；模板/CSS 零 diff（除 script 区与 style 外链确认）；所有行为用例通过；`vue-tsc` 连续 3 次稳定。

## 6. 阶段 2 设计（后续执行，不立即实施）

阶段 2 以 SCC 为单位拆 `useChatPageCore.ts`，每个 SCC 单独提交、单独验证；A/B SCC 内部不再强行细拆。之后抽纯 UI 子组件（列表、任务表单、工具菜单、弹窗、消息区、输入区等），CSS 按已有注释块下沉，共享基类留在 `chat-page.css`。每个子组件显式声明 props/emits，重点检查 `PromptBox`、`ModelSelect`、`ConversationOutline`、`ToolsSearch` 的 v-model 契约；保留 `@click.stop`、Esc capture、Teleport 宿主顺序和 provide/inject 链。

## 7. 风险与控制

| 风险 | 证据 | 控制手段 |
|---|---|---|
| 整脚本搬迁漏返回值 | 解构表漏一个绑定，模板拿到 undefined | AST 自动生成解构表 + `vue/compiler-sfc` 反查 `_ctx.*`（完整 metadata 应为 0，空 metadata 对照 291） + `satisfies` + `type-check` + Chrome 全量用例 |
| 搬迁时无意改顺序 | 函数体/声明顺序变化引发 TDZ 或 watch 时机变化 | 阶段 1 禁止改顺序/合并 watch；用 diff 确认 script 区是纯搬迁 |
| SFC 宏误搬进 .ts | `ChatPage.vue:1364` `defineProps` 只在 SFC 顶层有效 | defineProps 留根；core 用 options 接收 `Readonly<{agentId?,agentLabel?}>`；全文件无其它 define* 宏 |
| 相对导入路径失效 | core 从 `pages/` 移到 `composables/chat/`，原 `../api` 等会解析失败 | 所有 `from "../..."` 机械改为 `from "../../..."`；`vue-tsc` 验证 0 错误 |
| 组件自动注册丢失 | 11 个模板组件初始在 `ChatPage.vue:14-25` import | 11 个组件必须作为 core 返回值并由根同名解构；`ChartCard` 模板未用可不返回 |
| 模板类型断言失效 | `ChatPage.vue:5818,7143` 用 `ScheduleDto['lastStatus']` | 根层保留 `import type { ScheduleDto }`；其他 type-only 留在 core |
| 重复绑定 agentProps/router | 根层已有 defineProps/useRouter，若 core 再返回同名绑定会重复声明 | core 返回值与根解构表都排除 `agentProps`/`router`/`useRouter`；core 不解构 props 为普通值 |
| runtime import/常量未返回 | 模板用 `agentText/AGENTS/workspaceDownloadUrl/MINUTELY_INTERVALS/REPEAT_FREQS/WEEKDAYS` | 6 个符号必须返回并同名解构 |
| setup 调用时机变化 | provide/watch/onMounted/onBeforeUnmount/useTheme/useOnceAtPicker 依赖同步 setup | core 只在 setup 同步调用链里执行；禁止包进 async/await 或 effectScope 改变时机 |
| 阶段 1 仍是大文件 | `useChatPageCore.ts` 约 5600 行 | 可接受的中间态；阶段 2 按 SCC 拆，不在阶段 1 强行拆 |
| 跨组环未解（阶段 2） | SCC A/B 已确认成环 | 整体 SCC 提交或共享状态留根；不按直觉逐组抽 |
| 根块反向依赖（阶段 2） | `useChatRun` 用 threadScroll/reasoningUI/modelSettings/list/messageQueue 符号 | 阶段 2 前先补全 ComposableApi 返回清单 |
| 卸载清理冲突 | `effectScope()` 不停原始 `setTimeout` | 阶段 1 原样保留；阶段 2 composable 自清原始定时器，根同步删对应行 |
| provide 契约断裂 | 41 键中约 37 键只被 inject、7 键裸 import | 阶段 1 原样保留；阶段 2 用 `satisfies` + 长度断言 |
| 新增 vitest | web 原本无 test 脚本；全量审计有 1 条 dev-only high | 仅 devDependency；脚本与锁文件同提交；`pnpm audit --prod --json` 必须 0；全量审计的 `picomatch` GHSA-fc5q-39xc-vjpf（<=4.0.7，公告 Patched Versions=None）记录为 dev-only 例外，不通过不存在的 4.0.8 override 强行修复 |
| 文档状态/行号漂移 | 行号是 2026-11-17 快照 | 实施前用符号名定位；README 与 engineering 状态已同步 |
| 范围蔓延 | 顺手修 P1-3～P1-7 | 设计明确不做；阶段 1 原子提交，阶段 2 按 SCC 提交 |

## 8. 回滚策略

1. 阶段 1 只有一个提交；任何验收失败就 `git revert` 该提交，回到 7723 行原文件。
2. 阶段 2 每个 SCC / 子组件单独提交；失败只回退对应提交。
3. P1-2（`continue-on-error` 改阻断）必须在 `vue-tsc` 连续 3 次稳定后才做；不稳定保持 CI 原状。
4. 若阶段 1 的自动解构生成出错，优先重新生成解构表，不改 `useChatPageCore.ts` 内部顺序。

## 9. 验收清单

命令：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm type-check
pnpm test && pnpm --filter @bx/web test
```

Chrome / 手工清单：

- `/chat` → `/support` → `/movie` → `/chat`：标题、Agent 身份、输入框占位符正确，路径变化重挂载。
- 发送普通消息并收到流式回复；刷新/续传恢复正常。
- 任务表单：新建、编辑、打开结果会话、通知通道与 cron 面板正常。
- MCP 面板：工具勾选、重连、外部点击关闭、Esc 关闭正常。
- 右键菜单：重命名、置顶、归档、发送模式切换；删除撤销正常。
- 对话大纲、队列、删除撤销、复制气泡、记忆面板、工作区面板正常。
- 控制台无 error；`ChatPage-*.js` 构建产物仍只有一份。

## 10. P1-2 门禁

阶段 1 完成后：

1. 连续 3 次执行 `pnpm --filter @bx/web type-check`，结果必须一致且退出码 0。
2. 把 `.github/workflows/ci.yml:47-51` 的 `Type check (web, non-blocking)` 改为阻断步骤：移除 `continue-on-error: true`，并更新注释。
3. 重跑一次 CI 命令组确认。

## 11. 明确不做

- 阶段 1 不做逐组 composable 抽取、不拆 UI 子组件。
- 不修改后端、API 契约、共享包运行时行为。
- 不做 A/B 重跑、BI 治理、FK 签字等外部依赖事项。
- 不修改 MoviePage。
- 不引入运行时依赖（仅 `vitest` devDependency）。
- 不对 composables 做动态 import，不改变当前懒加载 chunk 边界。
- 不在阶段 1 顺手修 P1-3～P1-7 或其它工程优化项。

## 12. 交付物

本设计确认后，下一步用实施计划文档把第 5 节拆成可执行步骤（含精确文件、改动范围、验证命令、回滚点）。阶段 1 以单原子提交完成；阶段 2 需另行确认后再写实施计划。
