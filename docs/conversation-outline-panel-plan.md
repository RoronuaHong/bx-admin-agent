# 对话大纲浮层（Conversation Outline Panel）方案

> 版本：v2（2026-11-16，阶段 1-5 已实施并通过 `vite build` + `vue-tsc` 校验，见 §12 实施记录）
> 定位：**需求还原 + 可行性结论 + 代码级现状审计 + 交互/边界全量设计 + 实施拆分**。目标是在对话前端（零后端改动）实现右缘悬浮的「对话大纲」面板：列出当前会话的用户指令节点，点击跳转、当前项高亮、折叠 + 计数徽标（对齐截图原型）。
> 相关：`apps/web/src/pages/ChatPage.vue`、`apps/web/src/components/ChatBubble.vue`、`apps/web/src/components/BackToTop.vue`、`apps/web/src/chat-types.ts`、`apps/web/src/api.ts`、`apps/web/src/pages/chat-page.css`。

**当前状态**

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 锚点 + 大纲派生（`data-bubble-id`、`conversationOutline` computed） | ✅ 已完成 |
| 2 | `ConversationOutline.vue` 组件（FAB + 面板 + 徽标 + i18n + a11y） | ✅ 已完成 |
| 3 | 跳转（跨 60 条渲染窗口扩容 + 滚动 + 焦点） | ✅ 已完成 |
| 4 | 当前项高亮跟踪（rAF 滚动扫描） | ✅ 已完成 |
| 5 | 移动端适配 + 验收 | ✅ 已完成（构建/类型通过；§9 手测项待人工过一遍） |

---

## 1. 需求还原（截图 → 功能定义）

原型截图（WorkBuddy 会话「清理C盘垃圾」）红框内的浮层，功能分解：

| 元素 | 行为 |
|---|---|
| 悬浮于对话区右缘（近似垂直居中），半透明深底圆角面板 | 不挤压布局，浮在内容之上 |
| 面板顶部数字徽标（"2"） | 折叠态/角标显示大纲条目数 |
| 条目列表（"清除垃圾 / 继续检查 / 清理权限 / …"） | 即本会话的**用户消息**序列，长文本截断 |
| 当前项左侧高亮竖条 | 标记此刻可视位置对应的节点 |
| 点击条目 | 对话区滚动到那条消息 |

**范围界定**：只做「用户消息大纲」。助手消息、工具步骤、todos 里程碑一律不进大纲（见 §11 扩展）。

## 2. 可行性结论

**可以实现，纯前端即可，后端零改动。** 依据：

1. 数据已在前端：运行时 `Bubble`（`chat-types.ts:23-93`）含 `id/role/text/at`；持久化 `StoredMessage`（`api.ts:208-233`）的 `role/text/at` 随快照往返（`saveConversationMessages` 增量保存），打开会话即重建为 bubbles（`ChatPage.vue:2396`）。
2. 滚动容器、窗口扩容、悬浮层惯例、i18n、移动端断点全部有现成模式可抄（§3）。
3. 唯一的 DOM 缺口是气泡根节点没有锚点属性——加一个 `data-bubble-id` 即可，纯属性、无副作用。

## 3. 现状审计（代码级）

| 关注点 | 现状 | 位置 |
|---|---|---|
| 会话状态容器 | `states = reactive(new Map())`，`current` computed | ChatPage.vue:1712/1726 |
| 气泡 id | 模块级 `let seq = 0`，`id: ++seq`，**仅运行时有效、不落库** | ChatPage.vue:1956、2233 |
| 快照→bubbles | `bubblesFromStored()`（notice 单独合并） | ChatPage.vue:2231-2269 |
| 大纲数据源 | `current.value.bubbles`，reactive | ChatPage.vue:1771-1775 |
| 渲染窗口 | 只渲染最近 `threadWindow`(=60) 条；`showEarlierMessages()` 扩容并按「距底部距离」回填 scrollTop | ChatPage.vue:1765-1785 |
| 滚动容器 | `div.thread` `overflow-y:auto`，`@scroll="onThreadScroll"` | ChatPage.vue:6727；chat-page.css:3318 |
| 跟底逻辑 | `followBottom` + 48px 容差 `nearBottom()`；`queueScroll` rAF+nextTick | ChatPage.vue:1966-2017 |
| 气泡锚点 | **无**（根节点 `.row` 只有 role class；仅步骤结果有 `step-result-*` id） | ChatBubble.vue:126 |
| 悬浮层惯例 | fixed + z-index：内容层 30–70（`BackToTop`/`.done-toast` 均 60），抽屉/弹窗 1000+（ctx-menu 1000、modal 1100、mcp 面板 1200） | BackToTop.vue:180-184、chat-page.css:1996-2000 等 |
| 移动端断点 | `MOBILE_QUERY = "(max-width: 860px)"`；`.sidebar` 变 fixed 抽屉 z-60 + 遮罩 z-50 | ChatPage.vue:1377-1384；chat-page.css:3847-3859 |
| i18n | 内联 `tx(zh, en, pt, hi)` 四语 | ChatPage.vue:1261、BackToTop.vue:28 |
| 主题 | 只用 CSS 变量（`--panel/--line/--ink/--muted/--shadow/--radius-*`），不写死颜色 | BackToTop.vue:190-196 |
| 既有同类能力 | 无大纲/时间线/锚点跳转；最接近的是 `BackToTop`（rAF 节流滚动监听、ResizeObserver 避让输入框） | BackToTop.vue:84-142 |

## 4. 总体设计

```
section.chat
├─ aside.sidebar                    （不动）
└─ div.chat-main
   ├─ div.thread  ref=threadEl      （@scroll 已有）
   │  ├─ ChatBubble v-for …         ← 根节点加 :data-bubble-id="b.id"
   │  ├─ BackToTop                  （不动，右下）
   │  └─ ConversationOutline        ← 新增，fixed 右缘垂直居中（避开右下 BackToTop 与底部 .composer）
   └─ footer.composer               （不动）
```

- 新组件 `apps/web/src/components/ConversationOutline.vue`（`<script setup lang="ts">` + scoped style），挂载在 `.thread` 内、`BackToTop` 之后（同层即共享 v-show 场景：任务表单/任务列表页替换对话区时面板自然消失）。
- props：`items: OutlineItem[]`、`activeId: number | null`、`open: boolean`；emits：`toggle`、`jump(id)`。状态（`outlineOpen`）留在 ChatPage，与 `showTaskList` 等开关惯例一致。

**OutlineItem 派生（关键响应式细节）**：

```ts
interface OutlineItem { id: number; label: string; images: number; docs: number }
const conversationOutline = computed<OutlineItem[]>(() => {
  const out: OutlineItem[] = [];
  for (const b of current.value?.bubbles ?? []) {
    if (b.role !== "user") continue;          // 只读 role：assistant 流式改 text 不会使本 computed 失效
    out.push({ id: b.id, label: summarize(b.text), images: b.images?.length ?? 0, docs: 0 });
  }
  return out;
});
// summarize：trim → 压平空白/换行为单空格 → 截 48 字符加省略号（完整文本进 title）
```

> 为什么「只读 role」很重要：computed 细粒度追踪依赖。若对每条气泡都读 `b.text`，流式期间助手气泡 text 每个增量都会让大纲重算、列表 diff 抖动；只读 `role` 后，流式增量零触发，大纲仅在新增/删除气泡或用户消息文本变化时更新。

- 纯图片/附件的用户消息给占位文本（沿用队列既有文案惯例 `（仅图片）`，ChatPage.vue:6782）：`（图片 ×N）/（附件 ×N）`。
- `notice` 气泡（模型切换提示等）不进大纲。

## 5. 交互流程

### 5.1 展开 / 折叠

- 默认**折叠**为 FAB 小胶囊（图标 + 条目数徽标）。不持久化开关状态到 localStorage（会话级工具面板，YAGNI）。
- FAB `aria-expanded`；Esc 关闭（焦点在面板内时），焦点回 FAB。
- 点击面板外**不**关闭（区别于 ctx-menu：它是常驻导航，不是一次性菜单）。
- 条目数为 0（新会话/无用户消息）时 FAB 整体隐藏（`v-if="conversationOutline.length"`）。

### 5.2 点击跳转（含跨渲染窗口）

```ts
function jumpToBubble(id: number) {
  const all = current.value?.bubbles ?? [];
  const index = all.findIndex((b) => b.id === id);
  if (index < 0) return;
  const need = all.length - index;               // 让目标进入窗口所需窗口大小
  if (need > threadWindow.value) threadWindow.value = need + 20;  // 只增不减，留 20 条余量
  void nextTick(() => {
    const el = threadEl.value?.querySelector(`[data-bubble-id="${id}"]`);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    (el as HTMLElement).focus({ preventScroll: true });   // 行需 tabindex="-1"
  });
}
```

- 窗口扩容复用 `showEarlierMessages` 的语义（只增不减，ChatPage.vue:1777-1785）；`.row` 加 `scroll-margin-top: 12px` 防止贴顶。
- **跟底联动（免费收益）**：向上跳后 `nearBottom()` 为 false → `onThreadScroll` 自然置 `followBottom = false`（ChatPage.vue:1988-1991），流式增量不会把用户拽回底部；滚回底部附近自动恢复跟随。**不要**在跳转里 `queueScroll(true)` 强制回底。
- 移动端跳转后自动折叠面板，避免遮住刚滚到的内容；桌面端保持展开。

### 5.3 当前项高亮

- rAF 节流（同 BackToTop `onScroll` 模式），在 thread scroll 事件里扫描：遍历 `conversationOutline` 的锚点元素 `getBoundingClientRect()`，取「顶边在 thread 可视区上半 40% 之上」的**最后一条**为 active；全在视口上方时取最后一条，全在下方时取第一条。
- 大纲条目规模 = 用户消息数（几十量级），矩形扫描每帧成本可忽略；不做 offsetTop 缓存/IntersectionObserver（内容含图表、图片，offset 缓存失效复杂度不划算）。
- active 项 `aria-current="true"`，滚动同步面板内部滚动位置（`scrollIntoView({ block: "nearest" })` 只动面板内层）。

### 5.4 流式生成中

- 大纲 computed 不受助手流式影响（§4 响应式细节）。
- 用户发送新消息 → 新 user bubble 追加 → 大纲自动追加、徽标 +1，无需订阅。
- 生成中用户点击旧条目向上翻阅：允许，行为同 §5.2（跟底自动暂停）。

### 5.5 会话切换

- `watch(currentId)` 已重置 `threadWindow`（ChatPage.vue:1768-1770）；面板 `open` 状态**保留**，大纲随 `current` 自动切换；新会话无条目时按 §5.1 隐藏。切换后 active 在下一次 scroll/nextTick 重算，首帧先置 `null` 防串会话高亮残影。

## 6. 边界与异常（查缺补漏清单）

| # | 场景 | 行为 | 依据/理由 |
|---|---|---|---|
| 1 | 空会话 / 只有助手欢迎语 | FAB 不渲染 | §5.1 |
| 2 | 用户消息 > 200 条 | 不截断；面板 `max-height: 60vh` 内滚 | 数量级内无需虚拟列表 |
| 3 | 目标气泡在 60 条窗口之外 | 先扩 `threadWindow` 再滚动 | §5.2 |
| 4 | 目标气泡 id 失效（HMR/刷新后 seq 归零重编） | `findIndex < 0` 直接 return；id 本就运行时语义，不落库 | ChatPage.vue:1956 |
| 5 | 流式中上翻被增量拽回 | 不会发生：`followBottom` 联动 | §5.2 |
| 6 | 移动端（≤860px）侧栏抽屉打开 | 面板隐藏 `v-show="!(isMobile && sidebarOpen)"` | 抽屉 z-60 与面板同档且 DOM 在后，同 z 会盖住遮罩，直接隐藏最稳 |
| 7 | 面板展开遮住右侧文本/滚动条 | 展开态 `right: 10px; width: min(240px, 40vw)`；移动端跳转后自动折叠（§5.2） | 折叠态 FAB 仅 36px 宽，遮挡可忽略 |
| 8 | BackToTop 与 FAB 重叠 | FAB 垂直居中（top 50% 平移），BackToTop 在右下 | 位置天然错开 |
| 9 | 任务表单/任务列表页 | 面板在 `.thread` 内，随 `v-show="!showTaskForm && !showTaskList"` 整体隐藏 | ChatPage.vue:6727 |
| 10 | 深浅主题 | 全变量取色；半透明底 `color-mix(in srgb, var(--panel) 88%, transparent)` + `@supports (backdrop-filter)` 加 blur | 对齐 BackToTop 约定 |
| 11 | reduced-motion | 跳转 `behavior: "auto"`，无过渡动画 | BackToTop.vue:221-227 同款 |
| 12 | 键盘可达 | FAB 与条目均为原生 button；条目 Tab 可达、Enter 触发；Esc 关面板回焦点 | BackToTop 焦点管理同思路 |
| 13 | 长文本条目 | 48 字符截断 + title 全文；`white-space: nowrap` + ellipsis | 截图样式 |
| 14 | 会话切换首帧高亮残影 | 切换时 active 置 null | §5.5 |
| 15 | 图片/附件-only 消息 | 占位文案 `（图片 ×N）/（附件 ×N）` | ChatPage.vue:6782 惯例 |

## 7. 视觉与 a11y 规范

- z-index：60（内容层顶档，同 BackToTop/`.done-toast`；低于 1000+ 抽屉/弹窗家族）。
- 尺寸：折叠 FAB 36px 圆角胶囊；展开面板宽 `min(240px, 40vw)`、高 `max-content` 且 ≤60vh 内滚。
- 条目：13px、`--muted` 默认色；active 用 `--accent` 文字 + 左侧 2px 竖条（对齐截图）。
- 无障碍：FAB `aria-label`（i18n 四语）+ `aria-expanded`；面板 `nav aria-label="对话大纲"`；条目 `aria-current`。

## 8. 实施拆分

| 阶段 | 改动 | 文件 | 预估 |
|---|---|---|---|
| 1 | `.row` 加 `:data-bubble-id` + `tabindex="-1"` + `scroll-margin-top`；`conversationOutline` computed + `OutlineItem` | ChatBubble.vue:126、ChatPage.vue（`visibleBubbles` 旁） | ~30 行 |
| 2 | `ConversationOutline.vue`：FAB/面板/徽标/i18n/a11y/样式 | 新组件 | ~200 行 |
| 3 | ChatPage：`outlineOpen`/`activeOutlineId` 状态、`jumpToBubble()`、挂载、移动端隐藏条件、`watch(currentId)` 重置 active | ChatPage.vue:6771 附近 | ~40 行 |
| 4 | 高亮跟踪：rAF 滚动扫描（可在组件内以 props.items + 自找 `.thread` 实现，或由 ChatPage 传入回调） | ConversationOutline.vue / ChatPage.vue | ~40 行 |
| 5 | `chat-page.css` 视觉 + 移动端断点微调；手测验收 | chat-page.css | ~80 行 |

构建校验：`pnpm -C apps/web build`（vue-tsc 类型 + vite 产物）。

## 9. 验收清单（手测）

1. 新会话无用户消息 → 无 FAB；发送首条后 FAB 出现且徽标 =1。
2. 30+ 轮对话：展开面板逐条点击，每条都能滚到位且高亮随滚动移动。
3. 100+ 条消息：点击第 3 条（窗口外），先扩窗再滚动成功。
4. 流式生成中：点旧条目上翻 → 不被拽回底部；滚回底部 → 恢复跟随。
5. 生成中助手流式输出：面板条目与徽标不闪烁、不重排。
6. ≤860px：FAB/面板位置合理；打开侧栏抽屉时面板隐藏；跳转后面板自动折叠。
7. Esc 关面板、焦点回 FAB；Tab 遍历条目正常；`aria-current` 正确。
8. 深色/浅色主题、reduced-motion、纯图片消息占位文案。
9. 切换会话：大纲跟随切换、无上一会话高亮残影。

## 10. 明确不做 / 回滚

- **不做**：后端任何改动；大纲持久化；助手消息/步骤/todos 进大纲；大纲内搜索；面板内 ↑/↓ 快捷导航。
- **未来扩展（P2）**：todos 里程碑视图（`bubble.todos` 已有结构化状态，可做执行进度时间线）；步骤级锚点（`step-result-${id}` 已有 DOM id 可复用）。
- **回滚**：删除组件挂载与 3 处小改动即可整体下线，无数据/接口残留。

## 12. 实施记录（2026-11-16）

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/ConversationOutline.vue` | **新增**。FAB + 面板 + 徽标；props `items/activeId/open`(v-model)、emits `update:open/jump/active`；rAF 滚动扫描高亮（40% 高亮带）；`revealActive` 面板内滚（instant，避免与手动滚列表打架）；Esc 关面板回焦点；scoped 样式全主题变量 + `@supports` 毛玻璃 + reduced-motion + ≤860px 适配 |
| `apps/web/src/components/ChatBubble.vue` | 根节点 `.row` 加 `:data-bubble-id="b.id"` + `tabindex="-1"`（跳转锚点与落焦，不进 Tab 序列） |
| `apps/web/src/components/bubble.css` | `.row` 加 `scroll-margin-top: 12px`（⚠️ 该文件为 `<style scoped src>` 引入，改后需重启 web-dev 才生效） |
| `apps/web/src/pages/ChatPage.vue` | ① `conversationOutline` computed + `outlineLabel`（只读 user 气泡 text / 其余只读 role，流式零重算）；② `outlineOpen` / `activeOutlineId` + `watch(currentId)` 清残影；③ `jumpToOutline()`（跨窗扩容 `need+20`、移动端跳转后收起、scrollIntoView + 落焦）；④ `.thread` 内 BackToTop 之后挂载组件，`v-show="!(isMobile && sidebarOpen)"` 避让移动端侧栏抽屉 |

实施差异（相对原设计）：

1. 组件自扫高亮（`closest('.thread')` 取宿主），不走 ChatPage 的 `onThreadScroll`——保持单一数据流（`active` 事件回传父级存储）。
2. FAB 固定垂直居中锚点不动，面板绝对定位向上展开（`max-height: calc(50vh - 60px)` 防顶部溢出），替代原「整组居中、FAB 随面板位移」方案。
3. 实施时补修一个设计遗漏：`.conv-outline__list` 作为 flex 子项需显式 `min-height: 0`，否则条目超出时被面板 `overflow:hidden` 裁切而不内滚。
4. 校验：`pnpm -C apps/web build`（vite）与 `pnpm -C apps/web type-check`（vue-tsc）均通过；§9 手测清单待人工执行。

### 12.1 浏览器实测（2026-11-16，chrome-devtools MCP，`http://localhost:5173/chat`）

| 用例 | 结果 |
|---|---|
| 小会话（4 条消息）：FAB 出现、徽标"2"、展开面板、条目/`aria-expanded`/`aria-current` | ✅ |
| 点击条目跳转：向上/向下滚动到位（`scroll-margin-top` 生效）、焦点落目标行、高亮跟随 | ✅ |
| × 关闭 / Esc 关闭：面板收起、徽标恢复、焦点回 FAB | ✅ |
| 贴底高亮滞后（实测发现）：最后一条 user 气泡落在 40% 带下方导致高亮停在上一轮 → 已修：贴底（48px 容差，与跟底逻辑同口径）时取最后一条 | ✅ 已修并复测 |
| 压测：10,523 条消息的定时任务会话（大纲 5,259 条目）：computed 派生、窗口 60 条渲染、徽标计数、面板内滚 | ✅ |
| 压测：点击最早条目 → 扩窗至全部 10,523 行渲染、滚动 ~2.8M px 到位、焦点/高亮正确 | ✅ 功能正确 |
| 流式/任务会话动态追加：测试期间任务自动跑了一期，徽标 5259→5260 实时 +1 | ✅ |
| 移动端 ≤860px（视口 777px）：断点命中、面板 240px/限高、右距 ~10px、全在视口内、FAB 不遮内容 | ✅ |

**已知限制（记录，不阻塞）**：极端大会话（1 万+ 消息）上点击窗口外早期条目时，按设计需一次性渲染全部前缀（本例 10,523 个复杂气泡，实测首帧约 7.5s 停顿）——这是「60 条渲染窗口 + 一次性扩窗」架构的固有代价；人类对话规模（数百条内）无感。根治需虚拟滚动，归入 P2（与 todos 里程碑视图同批）。

### 12.2 最佳实践对齐 + 性能实测（2026-11-16 第二轮，Web Interface Guidelines + chrome-devtools 实测）

**按指南审查后修复**：

| 项 | 修复 |
|---|---|
| 高亮扫描 O(N)/帧（万条会话实测全量扫描 ~46ms/帧） | 缓存已渲染条目（签名=条目数+首末 id+scrollHeight/512 分桶）+ rect.top 单调性二分 → O(log N)；面板收起时跳过扫描（0 开销） |
| 高亮变化重渲染整表（5,261 条 vnode diff，+10ms/帧） | 条目 `v-memo="[item, item.id === activeId]"` → 每次高亮变化只重渲染 2 条 |
| `aria-controls` 缺失 | FAB `aria-controls="conv-outline-panel"` + 面板 `id` |
| 触屏双击缩放延迟 | FAB/条目 `touch-action: manipulation` |
| 移动端点击目标 32px 偏小 | FAB 提升到 40px（对齐页内 `.hamburger`） |
| 徽标对比度不达 WCAG AA（浅色金底白字 ~3:1） | 改墨底纸字（`--ink`/`--panel`），两主题 >15:1 |
| 首次打开不滚到高亮项（实测发现） | `revealActive` 原在 pre-flush watcher 里同步跑，早于 DOM 补丁量不到新的 `aria-current`；改为 `nextTick` 后执行 |

**实测后有意偏离指南**：

- 指南「>50 条列表须虚拟化/`content-visibility: auto`」：**实测 c-v 在本组件上是净减速**——数千个均匀单行条目（31px）下，c-v 的逐帧相关性检查开销 33.9ms/帧 vs 关掉 16.6ms/帧（原生 ~60fps）。c-v 适合「少量大块」，不适用「海量小块」；条目变多行/富内容时再评估真虚拟化（结论已写进组件注释防回退）。

**性能实测（万条级压测会话：10,527 行 / 大纲 5,263 条目）**：

| 指标 | 修复前 | 修复后 | 达标 |
|---|---|---|---|
| 线程滚动（面板收起，默认态） | ~46ms/帧 扫描开销 | **0**（跳过扫描），16.7ms/帧、0 掉帧 | ✅ |
| 线程滚动（面板展开，最坏组合） | 全量扫描 + 整表 diff | 25.9ms/帧（≈38fps；含浏览器对 2.8M px DOM 的基线成本），二分扫描 <1ms | ✅（边缘组合） |
| 面板列表滚动（5,263 条） | 32.5ms/帧、19/37 掉帧（首测含打开长任务污染）/ c-v 后 34→实测 16.6ms/帧、0 掉帧 | 16.6ms/帧、0 掉帧 | ✅ |
| 面板打开（5,263 条目） | 328ms、长任务累计 ~393ms | 稳态重开 **184ms**、冷开 ~557ms（一次性，含缓存构建+GC） | 🟡 万条级一次性成本可接受 |
| 面板打开（人类规模 2 条目） | — | **14ms** | ✅ |
| 高亮跳转/焦点/Esc/贴底取末条/reveal | — | 全部复测通过 | ✅ |

**结论**：人类规模会话全链路 60fps；万条级任务会话除「冷开面板 ~0.5s 一次性」与「扩窗跳转全量渲染（§12.1 已知限制）」外均达标。类型检查与构建通过。

### 12.3 面板打开专项优化（2026-11-16 第三轮，窗口化渲染）

针对 §12.2 遗留的 🟡「万条级冷开 ~557ms」，把面板列表改为**窗口化渲染**（真虚拟化，替代 v-memo 方案）：

- 条目统一单行（nowrap + ellipsis）→ 行高恒定；画布总高 = 条目数 × 行高，条目绝对定位铺排，只挂可视区 ±16 条（`OVERSCAN`）。
- 行高不写死：首帧 31px 预估，挂载后实测单条自校（同字体同行高，单点测量即全量成立）。
- 打开时（pre-flush watcher）**预置滚动种子**到 active 附近，首帧直接渲染正确窗口，无二次渲染。
- `revealActive` 退化为纯算术（`index × rowH`），不再量 DOM、不依赖补丁时序（顺带修掉 §12.2 的 reveal 时序 hack）。
- `syncActive` 增加**贴底快速路径**：贴底/不满一屏时当前项=末条，免锚点缓存（万条级锚点收集 ~40ms 从打开关键路径上消失）。
- 条目带 `aria-setsize`/`aria-posinset`，屏外不可见也能让读屏器感知规模与位置。
- v-memo 移除（渲染面只剩 ~50 条，逐条 diff 成本可忽略）。

**实测（万条级：大纲 5,264 条目）**：

| 指标 | §12.2（v-memo 方案） | §12.3（窗口化） |
|---|---|---|
| 冷开面板 | ~557ms，长任务 88/106/416ms | **12ms，0 长任务** |
| 稳态重开 | 184ms | **10ms** |
| 首帧挂载节点 | 5,263 条目 | **29 条目** |
| 打开即 reveal 到深处 active（第 5,264 条） | — | ✅ 视区内 |
| 面板列表窗口滑动（scrollTop=80000） | — | ✅ 窗口 2565–2609、算术对齐 |
| 带扫描 / 跳转 / 焦点 / Esc / 徽标 | ✅ | ✅ 全回归通过 |
| 人类规模（2 条目）冷开 | 14ms | **7ms** |

**结论**：🟡 → ✅。万条级面板打开进入十毫秒级、零长任务；「扩窗跳转全量渲染 ~7.5s」仍是唯一已知大成本（§12.1，根治需对话区虚拟滚动，P2）。

### 12.4 跳转高亮错位补修（2026-11-16 第四轮）

修复「点第一条却亮第二条」及其边界：

- 跳转不再 `scrollIntoView({ block: "start" })`，改为把目标行落到 40% 高亮带**上方 12px**；`.row` 的 `scroll-margin-top` 随之移除。
- 点击即设置 `activeOutlineId`，并通过 `pinnedId` 暂停滚动跟踪；滚轮/触摸/翻页键或用户滚动（拖滚动条走 `scroll`）才解锁。`scrollend` + 无支持浏览器的兜底定时器负责结束程序滚动标记，另加 120ms 尾随忽略窗口防补发 scroll 误解锁。
- `band` / `pinnedId` 改为显式 props，父级跳转落点与组件滚动跟踪共用同一高亮口径；resize 时重算面板窗口度量，`revealActive` 计入列表 `padding-top`；同条目数换会话也强制重算 active。
- FAB `aria-controls` 仅在面板实际存在时输出。

> §5.2 及 §12.1–§12.3 记录的是各阶段当时的实现；跳转与高亮锁定以本节和当前代码为准。
