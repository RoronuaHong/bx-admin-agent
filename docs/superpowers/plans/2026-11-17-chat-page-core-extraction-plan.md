# 实现计划：ChatPage 阶段 1 整脚本原子搬迁

- 对应 spec：`docs/superpowers/specs/2026-11-17-chat-page-refactor-design.md`
- 日期：2026-11-17
- 执行状态：T0–T5 已完成并通过验证
- 范围：仅阶段 1（整脚本搬迁 + vitest 底座），不做类型迁移、不抽 composables、不拆 UI 子组件、不改模板/CSS/API/后端
- 提交策略：阶段 1 全部改动一次性提交；任何验收失败则 revert 该提交

## 任务清单（按顺序执行）

### T0 基线与生成器准备（不改源文件）

1. 记录当前 HEAD、行数与大小：`git rev-parse --short HEAD`；`ChatPage.vue` 应为 7723 行 / 393,352 字节；`chat-page.css` 应为 4142 行 / 92,705 字节。
2. 在 `.data/` 写临时生成器（不提交），用TypeScript AST 解析 `ChatPage.vue` 的 `<script setup lang="ts">` 块（源码 1–5607）：
   - 收集顶层 runtime 绑定：所有 `import` specifier（排除 `import type`）、顶层 `const` / `let` / `function` 名称；**对象/数组解构绑定必须递归收集**（例如 `useOnceAtPicker()` 返回的 `dtRoot` / `dtPanel`）。
   - 排除集合：`agentProps`、`router`、`useRouter`、`ChartCard`（模板未用），以及所有 type-only import。
   - 输出两个文本：`core-return.txt`（`return { ... }`）与 `root-destructure.txt`（`const { ... } = useChatPageCore(...)`）。
3. 干跑基线（2026-11-17 实测）：顶层绑定 657、排除后返回值 653、重名 0、provide 键 41；`defineProps` 在 script 第 1364 行、`useRouter()` 在 1363 行。生成器输出若与之不一致，先查解析器是否漏掉解构绑定或 CRLF 下的 provide 块。
4. 用 `vue/compiler-sfc` 做模板绑定反查：把返回值表作为 `bindingMetadata`（全部设为 `setup-maybe-ref`）编译 template，生成的 `_ctx.*` 引用必须为 0；空 metadata 的对照组应出现 291 个 `_ctx.*`，证明校验有效。2026-11-17 干跑结果：完整 metadata 0 / 空 metadata 291 / 编译错误 0。
5. 人工核对生成器输出必须包含：11 个模板组件（`UiSelect`、`PromptBox`、`ToolsSearch`、`SkillAddForm`、`McpAddForm`、`ModelSelect`、`UiLocaleSelect`、`ThemeToggle`、`ChatBubble`、`BackToTop`、`ConversationOutline`）、6 个 runtime import/常量（`agentText`、`AGENTS`、`workspaceDownloadUrl`、`MINUTELY_INTERVALS`、`REPEAT_FREQS`、`WEEKDAYS`）、全部模板 refs、41 个 provide 符号；根层冲突名 `defineProps` / `useRouter` / `useChatPageCore` / `ScheduleDto` 必须不在返回值中。
6. 验证：生成器只写 `.data/` 临时文件，`git status` 无源码变化。

### T1 生成 `useChatPageCore.ts`

文件：`apps/web/src/composables/chat/useChatPageCore.ts`（新增）

1. 把 `ChatPage.vue` script 块（1–5607）的函数体与声明顺序原样搬入。
2. 只做以下机械适配，不改任何函数体、watch、timer、provide 内容：
   - 删除原 `const agentProps = defineProps<...>()` 与 `const router = useRouter()` 两行。
   - 增加 options 签名：`{ agentProps: Readonly<{ agentId?: string; agentLabel?: string }>; router: Router }`（`Router` 从 `vue-router` type import）。
   - 在函数顶部增加 `const { agentProps, router } = options;`。
   - 追加 T0 生成的 `return { ... }`，覆盖全部模板可见 runtime 绑定。
3. 保留原 script 中所有 runtime import 与 type-only import（后者仅 core 内使用）；因文件从 `pages/` 移到 `composables/chat/`，所有相对导入 `from "../..."` 必须机械重定位为 `from "../../..."`。
4. 搬迁后用 AST 再比对一次：原 script 主体（去掉 imports 与 defineProps/useRouter 两行）与 core 函数体（去掉 options 解构与 return 块）必须逐字符一致；2026-11-17 实测旧 195288 字符 / 新 195286 字符（仅 CRLF 尾部差异），identical=true。
5. 禁止：改声明顺序、合并 watch、把 ref/computed 改成 `toValue()`、把 provide/onMounted/onBeforeUnmount 放进 async 或 `await` 之后、动态 import composables。

验证：`useChatPageCore.ts` 存在，返回对象由 AST 生成，diff 中函数体无手工改写痕迹。

### T2 改 `ChatPage.vue` 根组件

文件：`apps/web/src/pages/ChatPage.vue`

1. 把整个 script 区替换为：
   - `import type { ScheduleDto } from "../api"`（模板 5818 / 7143 的 `ScheduleDto['lastStatus']` 断言需要）。
   - `import { defineProps } from "vue"`（如果使用全局宏则可省略，按项目现有写法）。
   - `import { useRouter } from "vue-router"`。
   - `import { useChatPageCore } from "../composables/chat/useChatPageCore"`。
   - `const agentProps = defineProps<{ agentId?: string; agentLabel?: string }>()`。
   - `const router = useRouter()`。
   - T0 生成的顶层 `const { ... } = useChatPageCore({ agentProps, router })`。
2. template（5609–7720）与 style 外链（7722）**零改动**；禁止把绑定改成 `core.xxx`。
3. 解构表排除 `agentProps` / `router` / `useRouter`，避免重复声明。

验证：`git diff --unified=0 -- apps/web/src/pages/ChatPage.vue` 中 template/style 区段无变化；只有 script 区被替换。

### T3 vitest 测试底座

文件：`apps/web/package.json`（修改）、`pnpm-lock.yaml`（修改）、`apps/web/tests/...`（新增）

1. 同提交加 `vitest@^4.1.12` devDependency。
2. 同提交加脚本 `"test": "vitest run"`。
3. 运行 `pnpm install` 更新锁文件。
4. 加最小单测，先覆盖 `bubble-text.ts` 的纯函数（搬迁阶段不改变函数体，只做冒烟验证）。

验证：`pnpm --filter @bx/web test` 通过；`pnpm audit --prod --json --registry=https://registry.npmjs.org` 必须 0 漏洞。全量 `pnpm audit --json` 当前有 1 条 dev-only high（`picomatch` GHSA-fc5q-39xc-vjpf，公告 Patched Versions=None），记录为例外即可；禁止写 `picomatch@^4.0.8` 这类不存在的 override，否则 `pnpm install` 会失败。

### T4 全量验证

按以下顺序执行，全部通过才进入 T5：

1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `pnpm type-check`
4. `pnpm test && pnpm --filter @bx/web test`
5. `git diff --check`
6. `Get-ChildItem -Name apps/web/dist/assets/ChatPage-*`：必须仍只有一份 ChatPage JS/CSS。
7. Chrome 手工清单：
   - `/chat` → `/support` → `/movie` → `/chat`：标题、Agent 身份、输入框占位符正确，path 变化重挂载。
   - 发送普通消息并收到流式回复；刷新/续传恢复正常。
   - 任务表单、MCP 面板、右键菜单、大纲、队列、删除撤销、复制气泡、记忆/工作区面板正常。
   - 控制台无 error。
8. 连续 3 次 `pnpm --filter @bx/web type-check`，结果一致且退出码 0（为 P1-2 门禁准备）。

### T5 单次提交

1. 改动文件应仅包含：`apps/web/src/pages/ChatPage.vue`、`apps/web/src/composables/chat/useChatPageCore.ts`、`apps/web/package.json`、`pnpm-lock.yaml`、`apps/web/tests/...`，以及文档状态回写（如需）。
2. 一次性提交，提交信息注明“P1-1 phase1: atomic script extraction, no behavior change”。
3. 不在此提交中做类型迁移、composable 细拆或 P1-2 门禁；这些是阶段 2 / P1-2 的独立变更。

## 风险与注意

- `defineProps` 不能进 `.ts`；必须留根并通过 options 传入。
- 根层必须保留 `import type { ScheduleDto }`，否则模板类型断言失效。
- 11 个模板组件与 6 个 runtime import/常量必须返回并同名解构，否则运行时组件/变量未解析。
- 根解构表排除 `agentProps` / `router` / `useRouter`；core 内不解构 props 为普通值。
- `provide` / `watch` / `onMounted` / `onBeforeUnmount` / `useTheme()` / `useOnceAtPicker()` 必须保持同步 setup 调用链。
- 模板、CSS、函数体、声明顺序、watch/timer/provide 内容一律不改。
- 阶段 1 仍是大文件（`useChatPageCore.ts` 约 5600 行），这是可接受的中间态。

## 回滚

1. T0～T4 任何一步失败，不提交；删除新增文件、恢复 `ChatPage.vue` / `package.json` / `pnpm-lock.yaml`。
2. 若已提交后发现问题，`git revert` 该原子提交即可回到 7723 行原文件。
3. 不要把阶段 2 的 SCC 拆分或 P1-2 门禁混入本次回滚单元。
