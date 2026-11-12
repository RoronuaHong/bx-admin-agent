# 工程现状对齐与全局优化清单

> **定位**：2026-11-12 全仓只读梳理的产物——先把「文档口径 ↔ 代码现状」逐条对齐，再基于对齐后的事实列出优化空间与落地路线。不是设计方案，不改变任何主题文档的权威口径。
> **状态**：✅ 现行（事实以本次核对时点的代码为准；行号会漂移，核对时先搜函数名/符号名）。
> **效力**：遵循 [`docs/README.md`](./README.md) 的效力约定——**代码是唯一真相**；同名主题仍以各主题现行文档为准，本文只登记冲突、不裁决方案。
> **路径约定**：文中 `src/…` 指 `apps/agent-server/src/…`，`scripts/…` 指 `apps/agent-server/scripts/…`，`apps/web/src/…` 维持原样；仓库根无顶层 `src/` / `scripts/`。
> **核对方法**：只读，未修改任何源码；计数来自枚举对象键 / `switch case` / 文件清单 / 全文检索，非估算。未跑构建、未跑 profiler、未执行 `pnpm audit` / `pnpm why`，因此产物体积与依赖漏洞归属均为「现存证据」而非本次实测结论。

---

## 0. 结论

项目基础不弱（双端 `strict: true`、129 个后端单测、安全护栏齐备、SSE 契约双端复用）。优化空间集中在三条主线：

1. **巨型单文件 → 前端类型检查被迫不阻断 → 前端工程化与可观测性空白**，这是根因链；
2. **文档口径与代码脱节**，多处现行文档仍引用已删除的脚本、已不存在的模块和过期数字；
3. **横切能力半成品化**（鉴权、错误上报、接口契约、i18n），需按部署形态决定补到什么程度。

以下所有优化项**均未在本次实施**，本文只做登记与排序。

---

## 1. 口径基准表（本次对齐产出）

> 「旧口径」列记录的是**本次修正前**的原文，`README.md` / `docs/README.md` 中的对应位置已按 §3.1 更新；引用这些行号时请以「修正前文本」理解。

| 项目 | 旧口径（出处） | 现行正确口径 | 权威证据 |
|---|---|---|---|
| 内置工具数量 | `README.md:66`「24 个」；`docs/README.md:27`「27 条登记 / 25 个分发」 | `BUILTIN_RISK` **登记 30 条**、`builtinToolSpecs()` **定义 30 个**（29 个 `spec()` + 1 个 `TOOL_SEARCH_SPEC`）、`execBuiltin` 的 `switch (name)` **分发 28 个 case**；另 2 个（`task` / `search_tools`）在 `chat.ts` 主循环内处理。旧值均为历史快照 | `src/builtins.ts:77-145`、`:311-318`、`:440`、`:461-980`、`:1498-2150`；`src/chat.ts:3031,3149` |
| `pnpm test` 的外部依赖 | `README.md:46`「零外部依赖，Mongo 不可用会自动降级内存存储」 | 降级逻辑确实存在，但**仅限冷启动从未连上**（认证错 / 运行期掉线显式报错）；定时任务批次（`schedule-retry` / `schedule-runs` / `schedule-tools`）依赖真实 Mongo，CI 用 `mongo:7` service + `MONGO_URI` 提供；另有 24 个测试文件靠显式指向 `127.0.0.1:1` 主动走内存。「零外部依赖」非无条件成立 | `src/db.ts:31-34,165-171`；`.github/workflows/ci.yml:7,25-29,56`；`apps/agent-server/vitest.config.ts:8-23`；`tests/schedule-retry.test.ts:9,12-13` |
| 测试规模 | `docs/README.md:68`「98 文件 653 用例」；`best-practice-alignment-review.md:119`「43 文件 251 例」 | `tests/**/*.test.ts` **现行 129 个文件**；旧数字是 2026-10-15 / 2026-09-30 的验证快照 | `apps/agent-server/tests/`；`apps/agent-server/vitest.config.ts:28` |
| 源码与脚本体量 | 初版梳理「16 个 `_` 前缀脚本」 | `src/*.ts` **78 个**、`apps/web/src/*.vue` **17 个**、`scripts/*.mjs` **42 个**（其中 `_` 前缀 **14 个**） | `apps/agent-server/src/`、`apps/web/src/`、`apps/agent-server/scripts/` |
| 幽灵脚本引用 | `docs/README.md:54` 引 `scripts/_audit-bi-sql.mjs`；`:94` 引 `_movie-grounding-gate.mjs` | 两个脚本**均不存在**（全仓 0 命中）；`:94` 自述「已清理移除」正确，`:54` 及若干主题文档仍当作现行审计/门禁入口 | `docs/README.md:54,94`；`docs/mcp-guide.md:376`；`docs/bi-sql-best-practices.md:151,181` |
| 评测层 | `ci.yml:4-5`「eval-core / adapter / gate 已不存在」；部分文档仍写「已落地」 | 源码中这些模块 **0 个**，`packages/` 仅 `shared/src/index.ts` 一个源码文件；现行在线评测是 `src/eval-online.ts`。`agent-infrastructure.md` 已明写「未恢复」，但 `docs/agent/PRODUCTION_READINESS.md:21,157` 仍有残留描述 | `.github/workflows/ci.yml:4-5`；`src/eval-online.ts`；`docs/agent-infrastructure.md:338,521`；`docs/agent/README.md:1` |
| `any` 分布 | 初版梳理称「全仓 `any` 少见，仅 `rag/parsers.ts` 3 处」 | 全仓 `: any` 系写法 **36 行 / 41 处 / 3 个文件**；`apps/web/src/components/ChartCard.vue` 独占 **35 行 / 40 处**（`: any` 系 37、`as any[]` 2、`Map<string,any>` 1）；另 `UiLocaleSelect.vue` 1 处、`src/rag/parsers.ts` 3 处。「仅 3 处」只在检索范围为 `src/**/*.ts` 时成立 | `apps/web/src/components/ChartCard.vue:15-517`；`apps/web/src/components/UiLocaleSelect.vue:60`；`src/rag/parsers.ts:127-130` |
| `app.ts` 路由注册 | 初版梳理「120+ 处」 | 精确 **75 处**：`get` 33 / `post` 24 / `patch` 2 / `delete` 8 / `use` 8 | `src/app.ts:1021-2361` |
| `process.env.` 分布 | 「散落 44 个文件」 | 源码目录精确 **44 个文件**，全部在 `apps/agent-server/src/`（`apps/web/src` 与 `packages/` 为 0）；若含 `tests/` + `scripts/` + 配置，`apps/` 下共 110 个文件 | `apps/agent-server/src/` |
| 「产物零外链」红线 | 初版梳理疑与 `index.html` 的 Google Fonts 矛盾 | **不构成矛盾**：红线原文限定「交付物」（图表内联 SVG、`fs_write` 手写 HTML），不含 SPA 入口；但 `apps/web/index.html:15-20` 确有 3 条 Google Fonts 外链，属内网/离线部署的可达性风险，另案处理 | `README.md:88`；`apps/web/index.html:15-20`；`src/builtins.ts:362-389` |
| 安全自述 | 「未配置管理令牌即默认放行」「不做登录」 | 均为源码原文，确凿 | `src/admin-gate.ts:13,31-37`（`if (!expected) return { ok: true }`）；`src/owner.ts:1-4` |
| 前端错误边界 / 测试 | 「零错误边界、零测试」 | `apps/web/src/main.ts` 全文 6 行、无 `app.config.errorHandler`；`apps/web/src` 中 `console.error` / `sendBeacon` / `onErrorCaptured` 均 0 命中；`apps/web` 下 `*.test.*` 与 `*.spec.*` 均 0 个 | `apps/web/src/main.ts:1-6`；`apps/web/package.json:6-11` |
| 静默吞错计数 | 初版梳理「39 处」 | 严格匹配 `.catch(() => null / [] / undefined / {})` 与 `.catch(() => {})` 为 **32 处**（`ChatPage.vue`），宽松口径含其它变体约 39 处；差异来自写法变体，处置时应逐处审查而非按数字批量替换 | `apps/web/src/pages/ChatPage.vue`、`MoviePage.vue`、`PortalPage.vue`、`api.ts` 全文检索 |
| 打包死配置 / 死依赖 | 「4 个 manualChunks 分支无用」 | `echarts` / `zrender` / `mermaid` / `monaco-editor` / `vscode` / `pinia` 在 `apps/web/package.json` 与源码中**零 import**；但同行的 `/vue/`、`/vue-router/` 与另一行的 `/highlight.js/` 是**在用**的，不能整行删。`@zereight/mcp-gitlab`（`apps/agent-server/package.json:16`）与 web 的 `tsx`（`apps/web/package.json:27`）在各自包内零代码引用 | `apps/web/vite.config.ts:43-53`；`apps/web/package.json:12-31` |
| 首屏产物体积 | `index` 277.98 KB / `vendor` 807.99 KB / `vendor-antv` 1.71 MB | 为**工作区现存 `dist/` 产物**实测，不是本次重新构建的结果；仅作量级参考 | `apps/web/dist/assets/` |

---

## 2. 本次对齐修正了什么

相对 2026-11-12 初版口头梳理，以下结论已订正，后续引用以本表为准：

| 初版说法 | 订正后 | 原因 |
|---|---|---|
| `app.ts` 有 120+ 处路由注册 | 75 处 | 初版为检索缓冲截断后的估算；本次按方法名逐个枚举 |
| 16 个 `_` 前缀脚本 | 14 个（`.mjs` 共 42） | 按文件名枚举 |
| 全仓 `any` 少见 | `ChartCard.vue` 集中 40 处 | 初版只检索了 `: any` 且范围限服务端 `.ts` |
| 「产物零外链」与 Google Fonts 矛盾 | 不矛盾（范围不同） | 补读红线原文与 `externalRefHint` 作用点 |
| README「24 个」/ docs「27/25」 | 均为历史快照，现行 30/30/28 | 枚举 `BUILTIN_RISK` 键、`spec()` 调用、`case` 分支 |
| 「39 处静默 catch」 | 严格匹配 32 处，宽松约 39 处 | 正则口径差异 |

---

## 3. 与现行文档的冲突及处置

### 3.1 本次已同步修正

| 位置 | 修正内容 |
|---|---|
| `README.md:66` | 内置工具标题与清单按 30 条登记表更新，补入 `run_script` / `image_gen` / `search_dingtalk_doc` / `count_list_by_time` / `run_tool_code` / `salesiq_chat_brief` |
| `README.md:46` | 「零外部依赖」改为「默认可内存降级；定时任务批次需 MongoDB，CI 由 `mongo:7` 提供」 |
| `docs/README.md:27` | 「27 条登记 / 25 分发」→「30 条登记 / 28 分发」，并标注 24/22 与 27/25 口径均作废 |
| `docs/README.md:54` | 标注 `_audit-bi-sql.mjs` 已不在仓库、勿再照抄其命令，并把回归入口指回 `pnpm test` 与 `tests/sql-lint.test.ts` |
| `docs/README.md` 第一节 | 登记本文 |

### 3.2 按效力约定**不修**（历史快照 / 决策背景）

`docs/README.md:68`（98/653）、`best-practice-alignment-review.md:119`（43/251）、`docs/agent-stall-incident-20261014.md:437,458,492`、`docs/scheduled-task-sessions-plan.md:255`、`docs/project-review.html:295,297`、`docs/agent/CURRENT_ARCHITECTURE.md:3-5` 已自述为固定版本快照。按「现行 > 留档」处理，保留原值即可，不回写。

### 3.3 仍待各主题文档自行订正（本次未改，避免越权改动权威口径）

- 仍引用已删除脚本：`docs/mcp-guide.md:376`、`docs/bi-sql-best-practices.md:151,181`、`docs/agent-infrastructure.md:336,466`、`docs/agent/PRODUCTION_READINESS.md:10,89`、`docs/movie-safety-policy.md:5,64`。
- 仍把不存在的评测模块写成现行能力：`docs/agent/PRODUCTION_READINESS.md:21,157`。
- `docs/deep-agents-plan.md:410`「26 个 `_` 前缀脚本」为历史值（现行 14）。
- `docs/README.md` 第五节第 1 条「内置工具清单（21 个）」是 2026-09-24 补齐根 README 时的快照描述，现行值为 30（见根 `README.md` §4）；属挂账历史描述，本次未改写。
- 建议由各主题文档负责人在下次复核时统一订正，并在 `docs/README.md` 的「已知文档缺口」挂账。

---

## 4. 优化空间清单

> 排序依据：收益 / 改动面 / 风险。所有条目均标注证据与动作，**尚未实施**。

### P0 低投入、高收益（建议 1～2 天）

| # | 问题 | 证据 | 建议动作 | 收益 / 风险 |
|---|---|---|---|---|
| P0-1 | 两个大页面静态导入，进首屏包 | `apps/web/src/router.ts:2-3,12-13`，而 `:11,18,19` 已懒加载；`ChatPage.vue` 354.84 KB / 7218 行、`MoviePage.vue` 59.11 KB | 改动态 `import()`；`/chat` 与 `/support` 共用 `ChatPage`（`:12,16`），抽一个 `const ChatPage = () => import(...)` 复用，避免生成两份 | 首屏主包显著变小；风险低，注意 `/support` 的 `props` 保持不变 |
| P0-2 | `manualChunks` 死分支 + 1.71 MB 单块 + 告警被关 | `apps/web/vite.config.ts:40`（`chunkSizeWarningLimit: 3000`）、`:45`（G2+G6 并一块）、`:47-51`（6 个零引用库名） | 精确删死分支（**保留** `/vue/`、`/vue-router/`、`/highlight.js/`）、G2/G6 分块、阈值回落到合理值 | 块粒度可控、回归告警恢复；只改构建配置 |
| P0-3 | 无用依赖与不可移植配置 | `apps/web/package.json:24`（`@types/dompurify` 为 deprecated stub，且拖入第二份 dompurify 3.4.13）、`:27`（web 的 `tsx` 零引用）；`apps/agent-server/package.json:16`（`@zereight/mcp-gitlab` 零代码引用）；`ecosystem.dev.config.cjs:21`（硬编码 `D:/.../tsx@4.23.12`）；四个 `package.json` 均无 `engines`，`@types/node` 24.x 对 Node 22 | 删 stub 类型包；补 `engines`；统一 `@types/node` 与 Node 22；pm2 配置改用 `pnpm exec` 而非绝对路径 | 依赖树变干净、跨机器可跑；**删 `@zereight/mcp-gitlab` 与 web 的 `tsx` 前先确认部署侧 `MCP_BUILTIN_SERVERS` 与 pm2 loader，见 §7** |
| P0-4 | 组件卸载时 5 个具名定时器未清理 | `ChatPage.vue:5082-5117` 的 `onBeforeUnmount` 只清 `nowClockTimer` / `stopTasksPoll()` / `skeletonTimer` / `bgWatch` / `doneToastTimer` 与监听器；未清 `undoDeleteTimer`(`:1441,2930`)、`settingsErrorTimer`(`:1825,1830`)、`clearArmTimer`(`:3288,3302`)、`copyToastTimer`(`:4818,4827`)、`activeReportTimer`(`:4857,4872`，回调内还会发请求)；另 `:257,4053,4192` 三处无句柄 `setTimeout` | 在清理块补 `clearTimeout`，无句柄处保存句柄 | 消除卸载后回写状态 / 发请求；风险极低 |
| P0-5 | 定时器与资源在路由切换时的存活语义 | `apps/web/src/App.vue:31` 用 `:key="$route.path"` 强制重挂载 | 结合 P0-1 验证懒加载后重挂载行为不变 | 防止 P0-1 引入回归 |

### P1 结构性（建议 1～2 周，解决根因）

| # | 问题 | 证据 | 建议动作 |
|---|---|---|---|
| P1-1 | **巨型单文件是全仓最大瓶颈** | `apps/web/src/pages/ChatPage.vue` 354.84 KB / 7218 行（60+ `computed`、17+ 定时器）、`apps/web/src/pages/chat-page.css` 89.04 KB、`apps/web/src/api.ts` 989 行 / 92+ 导出、`src/chat.ts` 263.12 KB / >4800 行、`src/app.ts` 128.13 KB、`src/builtins.ts` 121.59 KB、`src/notify/deliver.ts` >1100 行 | 按「状态 / 副作用 / 渲染」三层拆 `ChatPage`（composables + 子组件）；`app.ts` 按域拆路由模块；`api.ts` 按资源拆并抽出重复的 `as {...}` 样板；样式按组件拆 |
| P1-2 | 拆分后恢复前端类型门禁 | `.github/workflows/ci.yml:47-51` 明确「vue-tsc 对巨型单文件 SFC 结果不稳定」，故 `continue-on-error: true` | P1-1 完成后复现 `vue-tsc` 稳定性，把该步改为阻断；这是拆分最可量化的验收 |
| P1-3 | 请求层无统一收口 | `apps/web/src/api.ts:54-61` 的 `jsonFetch` 无 signal / timeout / 缓存 / 去重；仅 `streamChat`(`:132,140`) 与 `resumeChatTaskEvents`(`:180,190`) 支持 `AbortSignal`。`ChatPage.vue:185-194` 每 5s 并发 3 请求，`:3737-3752` 每个后台任务再起 5s interval，`:4971` 另有 1s 时钟；`fetchConversations` 在 4 处调用、`fetchChatMcpServers` 3 处 | 在 `jsonFetch` 统一 signal / timeout / in-flight 去重；轮询随页面可见性暂停；卸载时统一 abort。保留已有的 `syncOpenConversation` 单路去重(`:2293-2317`) |
| P1-4 | 错误静默 + 前端零可观测 | `ChatPage.vue` 32 处严格匹配的静默 `.catch`（如 `:202`、`:4974`），项目已有 `ApiError`（`api.ts:4-15`）却被绕过；`main.ts` 无 `errorHandler`、`App.vue` 无 `onErrorCaptured`、前端 0 上报；后端 200+ 处裸 `console.*` 无 logger / 等级 | 统一错误态与用户可见提示；加 `app.config.errorHandler` + 轻量上报；后端引入分级 logger（保留现有脱敏约定） |
| P1-5 | 接口契约无单一真相 | `packages/shared/src/index.ts` 只覆盖 SSE 事件与常量；REST DTO 全在前端 `api.ts` 以 `as {...}` 断言消费，服务端无对等导出、无运行时校验；shared 直接导出 TS 源码还导致 `apps/web/vite.config.ts:8` 与 `apps/agent-server/build.mjs:14-23` 两处构建特判 | 共享 REST DTO，边界加运行时校验；给 shared 补独立 build / type-check |
| P1-6 | 渲染层重复计算与同构模板 | `ChatPage.vue:1124` 的 `filteredRuns` 是普通函数，却在模板每个分组重复调用 4 次（`:5356,5360,6670,6674`）；侧栏 `:5307-5374` 与任务页 `:6590-6684` 是两套同构列表；`ChatBubble.vue:178` 用 index 作 `:key`；模板内 `tx()` / `iconStyle()` 每轮重算 | 改 `computed`、抽公共列表组件、换稳定业务 key、模板文案预计算 |
| P1-7 | 配置读取分散、无启动校验 | `process.env.` 跨 44 个源码文件，`src/config.ts:92-104` 仅集中 4 项；仅 `HOST=0.0.0.0` 有令牌检查 | 集中 env schema + 启动期校验，保留现有 `load-env.ts` 的加载语义 |

### P2 工程治理（可与 P1 并行）

| # | 问题 | 证据 | 建议动作 |
|---|---|---|---|
| P2-1 | 零 lint / format 体系 | 全仓无 ESLint / Prettier / Biome / `.editorconfig`；四个 `package.json` 无相关脚本；CI 无静态检查；目前仅 `strict: true` 兜底 | 上 Biome 或 ESLint+Prettier，**只对增量代码生效**，避免全量格式化洪水 |
| P2-2 | CI 门禁偏弱 | `ci.yml:49-51,60-62` 中 web 类型检查与 `pnpm audit --prod` 都 `continue-on-error`；无 build 校验、无覆盖率配置 / 门槛、无前端测试 | 加 build 校验；补 `@vitest/coverage-*` 与门槛；按 P1-2 恢复 web 阻断 |
| P2-3 | 前端零测试、零 e2e | `apps/web` 下 `*.test.*` / `*.spec.*` 均 0；三个 `package.json` 无 Playwright / Cypress；e2e 只有需真实凭证的手工脚本 | 先给 `api.ts` / `chat-richtext.ts` / `localize.ts` / `pinyin.ts` 等纯函数补单测 |
| P2-4 | 文档治理 | 见 §3；另缺 `CONTRIBUTING` / `CHANGELOG` / 独立接口参考（75 处路由注册无 API 文档） | 一次「文档对齐」专项；`docs/README.md` 第五节挂账；补开发规范与 OpenAPI |
| P2-5 | 仓库卫生 | 14 个 `_` 前缀探针脚本无 npm script 入口、`scripts/*.d.mts` 生成物、`docs/audit/*.png` 约 3 MB、`assets/fonts/NotoSansSC-Regular.otf` 7.95 MB、`docs/project-review.html` 200 KB 自认过时仍被引用 | 临时脚本迁 `scripts/_archive/` 或移除；大文件走 LFS / 外链；`.gitignore` 已覆盖密钥与产物，保持不变 |
| P2-6 | i18n 无资源文件 | 4 语言靠内联 `tx(zh,en,pt,hi)` 硬编码散在多个文件（含 354 KB 的 `ChatPage.vue`），`localize.ts:22,38,58` 葡语有残缺拼写 | 抽语言包；新增语言不再改所有组件 |
| P2-7 | `ChartCard.vue` 类型退化 | 全仓 41 处 `any` 中 40 处集中于此文件（G2/G6 适配层） | 为 G2/G6 建最小类型门面，逐步收敛 |

### P3 需先评估再决定

| # | 问题 | 证据 | 决策点 |
|---|---|---|---|
| P3-1 | 鉴权模型为匿名设备态 | `src/session.ts:71,113`（cookie `bx_agent_sid`）；`src/admin-gate.ts:33-34` 未配置 `AGENT_ADMIN_TOKEN` 即放行；`src/owner.ts:1-4` 自述「不做登录、cookie 可被复制」；无用户 / RBAC / 行级权限 | 是否补登录体系取决于部署形态；单机内网可维持现状并写明边界 |
| P3-2 | 生产攻击面 | `src/app.ts:1013-1016` 无条件把 `localhost:5173` 等开发来源加入 CORS 白名单；`:1136,1171,1182,1214,2219` 的 `limit` 无上界 | 按环境区分白名单、给 `limit` 加上界 |
| P3-3 | 外网资源可达性 | `apps/web/index.html:15-20` 3 条 Google Fonts 外链 | 与「产物零外链」不冲突（§1），但内网 / 离线部署需本地字体兜底 |
| P3-4 | 依赖风险 | `pnpm-lock.yaml` 内有 deprecated 的 `glob@7` / `fstream` / `rimraf@2` / `graceful-fs@1`；`pnpm audit --prod` 非阻断 | 用 `pnpm why` 定位归属后再决定升级或加 override；本次未下结论 |
| P3-5 | 1.71 MB 图表块 | `apps/web/dist/assets/vendor-antv-*.js` | 用构建分析工具确认 G2/G6 各自占比，再决定能否按图表类型二次拆分 |

---

## 5. 现状基线（重构时不要误伤）

- 双端 `strict: true`，`any` 只集中在 `ChartCard.vue` 一处，其余代码类型纪律良好。
- `packages/shared` 的 SSE `ChatEvent` 契约双端复用；NDJSON 断线续传、`X-Chat-Task-Id`、`isChatTaskRunning` 网络错误降级、`syncOpenConversation` 单路去重都已有实现。
- 安全护栏与测试覆盖扎实：SQL 只读 fail-closed、写操作确认闸门、RAG ACL、管理员闸门、配额 / 模型冷却、反编造接地护栏，共 129 个测试文件。
- 消毒链完整：`chat-richtext.ts` 用 DOMPurify + `afterSanitizeAttributes` 钩子，`ChatBubble.vue` 对部分内容明确不走 `v-html`；未发现 `eval` / `new Function`。
- G2 / G6 / `pinyin-pro` 已按需动态 import，`highlight.js` 用 `lib/common`；`ChatBubble.vue` 以气泡为独立渲染单元控制流式重渲染。
- 服务端可观测已有 `otlp.ts` / `trace.ts` / `audit.ts` / `metrics.ts` / `redact.ts`，并有 `otlp-pii.test.ts` 守住脱敏。
- 测试环境隔离严谨（`vitest.config.ts` 只取 `MONGO_URI`、独立测试库、临时 `AGENT_DATA_DIR`）；`.gitignore` 已覆盖密钥与产物。

---

## 6. 落地路线与验收

| 批次 | 范围 | 验收标准 |
|---|---|---|
| 第 1 批（约 1 周） | P0-1～P0-5、P2-1、CI 加 build 校验 | 首屏 chunk 不含 `ChatPage` 代码；`pnpm build` 通过且无超大块告警回归；`onBeforeUnmount` 覆盖全部具名定时器；新增 lint 只对增量生效 |
| 第 2 批（约 2～3 周） | P1-1～P1-4、P2-2、P2-3 | `ChatPage.vue` 拆分后行数显著下降；`vue-tsc` 连续两次运行结果一致并恢复 CI 阻断；前端有纯函数单测；前端异常有统一落点 |
| 第 3 批（按需） | P1-5～P1-7、P2-4～P2-7、P3 | 共享 REST DTO 双端复用、env 启动校验、文档专项对齐完成；P3 各项形成明确的「做 / 不做」结论并回写本文状态 |

每批独立可回滚；P0 各项之间无依赖，可分 PR 提交。

---

## 7. 待确认项（本次未下结论）

1. `@zereight/mcp-gitlab` 是否通过 `MCP_BUILTIN_SERVERS` 在运行时由 `npx` 动态拉取——源码零引用不等于可删，需核对部署侧实际配置。
2. web 的 `tsx` 虽在 `apps/web` 内零引用，但根 `ecosystem.dev.config.cjs:21` 的 loader 路径写死 `tsx@4.23.12`，删依赖前须同步改 pm2 启动方式。
3. `docs/project-review.html`、`dist/`、`.data/`、`.env` 是否已入 git 索引，需 `git ls-files` 验证（`.gitignore` 已声明忽略）。
4. `pnpm audit` / `pnpm why` 未执行，废弃传递依赖的归属链与现行 advisory 状态未知。
5. `MoviePage.vue:118,494` 的异步 `watch` 无 `onCleanup`、`ChatPage.vue` 多处 `void promise()` 无 `.catch`、`src/tool-code-fs-guard.ts:195-216` 的空 `catch` 是否刻意设计，需人工确认。
6. 全量循环依赖需 `madge` / `dependency-cruiser` 出图；本次只确认 `app` / `chat` / `builtins` / `index` 之间无直接双向引用。
7. `vue-tsc` 在巨型 SFC 上「同一份代码两次跑不同结果」的具体报错未本地复现。
8. 首屏体积数据来自现存 `dist/`，未经本次重新构建验证；`vendor-antv` 内部 G2/G6 占比未知。

---

## 8. 核对范围与局限

- 覆盖：仓库根配置、`.github/workflows/ci.yml`、四个 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`（只读抽样）、`apps/web/src/`、`apps/agent-server/src/`、`apps/agent-server/tests/`、`apps/agent-server/scripts/`、`packages/shared/`、`docs/` 索引与冲突点。
- 未覆盖：逐行业务逻辑正确性、运行时性能 profiling、真实构建与产物分析、依赖漏洞库在线查询、git 索引验证。
- **BI / Metabase text2sql 能力不在本文范围**：Schema 呈现、外键、口径一致性、口径图 / GraphRAG、黄金集评测的现行状态与待决事项，以 [`docs/bi-metabase-optimization-plan.md`](./bi-metabase-optimization-plan.md) §11.9（当前状态）与 §11.10（口径一致性复核）为准；相关代码在 `scripts/metabase-mcp.mjs`、`scripts/bi-*.mjs` 与 `apps/agent-server/bi-semantic/`，不要按本文的「巨型单文件 / 前端工程化」主线去拆改。
- 本文所有「建议」均未实施；实施后请回写本文状态行与 §3 冲突清单。
