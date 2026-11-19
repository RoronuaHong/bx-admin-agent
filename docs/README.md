# 文档索引（docs/）

> 用途：说明每份文档的**定位 / 覆盖范围 / 现行代码落点 / 状态 / 阅读注意**，
> 避免「多份文档互相打架、不知道看哪份」。建立：2026-09-24。
>
> **效力约定**
> 1. **代码是唯一真相**：文档里的行号/片段都会漂移，核对时先搜函数名。
> 2. 同名主题以**现行**文档为准；留档/快照只用于理解决策背景。
> 3. 文档间冲突时：现行 > 留档/快照，并在冲突处回写指引（如 `mcp-connect-plan.md` 顶部已标注以 `mcp-guide.md` 为准）。
> 4. 「未逐条复核」= 本次只验证了文中声明的关键落点存在，**不代表逐句比对过**。
> 5. **路径约定**：文中 `src/…` 指 `apps/agent-server/src/…`，`scripts/…` 指 `apps/agent-server/scripts/…`，`apps/web/src/…` 维持原样——**仓库根无顶层 `src/`/`scripts/`**；行号会漂移，核对先搜函数名。

---

## 一、现行设计 / 方案文档

### [best-practice-alignment-review.md](./best-practice-alignment-review.md)
- **定位**：2026-09-30 全项目逐步对照（千问办公 / CodeBuddy CLI / WorkBuddy / ChatGPT Monitoring）。
- **覆盖**：定时任务 S1–S20；其余功能 F1–F20 只标是否要动。A1–A6 已落地。
- **状态**：✅ A1–A6 已落地（2026-09-30）。2026-10-10 起第 5–6 节记录回答呈现与对话刷新（R1–R5）；2026-10-11 第 7 节记录零证据兜底 / 破线口径 / 模型链（G1–G5）。产品口径仍以各主题现行文档为准。

### [artifact-delivery-plan.md](./artifact-delivery-plan.md)
- **定位**：产物交付闭环（模型生成文件 → 用户真能拿到）的设计与落地记录；也是后续「命令执行治理」「配置缓存」修复的承载文档。
- **覆盖**：§1–2 断链核查 · §4 形态判定（内置/MCP/Skill/定时任务）· §10 v2 格式扩展 · §11 报告式导出 + 手写 HTML 零外链护栏 · §12 全对话审计与上下文工程全链路对照 · §13 `run_command` 治理 · §14 配置热重载缓存失效键。
- **现行落点**：`export_data`（8 种格式，`builtins.ts`）· 下载端点（`app.ts` `GET .../files/download`）· `artifact` 事件（`packages/shared`）· `fs_write` 写 `.html` 下发卡片 · `externalRefHint` · `wrapUpWith`（轮次耗尽补位收尾）· `repeatCallHint` + `executedSigRounds` · `appendRoundTrace` · `decodeShellBytes` / `truncateShellOutput`。
- **状态**：✅ 现行（2026-09-24 复核，顶部主状态表 13 项）。
- **注意**：第 4 项（`fs_delete` / 上传入工作区 / 定时任务工具化）**2026-09-24 全部落地**——`fs_delete` 见 §15、上传附件进工作区见 §16、定时任务工具化见 §17。以 `builtins.ts` 的 `BUILTIN_RISK` 登记表为准，内置工具共 **30** 条登记 / 30 个工具定义（**28** 个在 `execBuiltin` 分发，`task` / `search_tools` 在 `chat.ts` 循环内处理）——2026-11-12 复核更正，早期「24 个 / 22 个」与「27 条 / 25 个」口径均作废；第 5 项 `run_script` / `image_gen` **已落地**并纳入统一交付物护栏（§11.8 / `DELIVERABLE_GUARDRAILS.md`；早期「维持暂缓」口径作废，2026-09-28 复核更正）。

### [mcp-guide.md](./mcp-guide.md)
- **定位**：MCP 连接与内置服务器的**权威口径**（其它 MCP 文档与它冲突时以本文为准）。
- **覆盖**：入口 UI（输入框「＋」工具菜单 → 连接器）· 传输（stdio / Streamable HTTP）· `MCP_BUILTIN_SERVERS` 配置 · `toolRisks` 工具级风险覆盖 · §10 生产部署检查表（命令白名单、来源指纹）· §11 验证脚本 → 现行回归入口总表。
- **现行落点**：`mcp/config.ts`（文件+内置服务器，`mtime+size` 失效）· `mcp/hub.ts` · `scripts/metabase-mcp.mjs` · `scripts/yapi-mcp.mjs`。
- **状态**：✅ 现行。
- **注意**：内置工具（fs_* / write_todos / task / read_skill / search_tools / render_chart 等）**始终注入**——「一个都不勾」只表示不接外部数据源，不是纯直连。

### [agent-infrastructure.md](./agent-infrastructure.md)
- **定位**：通用 Agent 基建检查表（M0–M4 成熟度模型 + 反模式），每章带「本项目对照」。
- **覆盖**：可观测（§10）· 安全与注入防护 · 评测门禁 · 成本归因（§12）· 发布灰度与回滚 · 调试。
- **现行落点**：`trace.ts`（`runs-<YYYYMM>.jsonl` + 逐轮 `rounds-<runId>.jsonl`）· `cost.ts` · `audit.ts` · `rate-limit.ts` · `untrusted.ts` · `roles.ts`。
- **状态**：✅ 现行（§10 已于 2026-09-24 补入逐轮 trace 说明）。本机投递试跑固定走通道 `dingtalk`（关键词 `bx-agent`），不打开印度业务通道。
- **注意**：整体仍是「🟡 部分」——缺 llm/tool 分层 span、指标看板、按会话回放。前端已有一页 run 级可视化（`/trace`，2026-09-30），不是指标看板。

### [write-op-safety-plan.md](./write-op-safety-plan.md)
- **定位**：写操作确认闸门设计（风险分级 + 会话级只读授权）。
- **现行落点**：`risk.ts`（`resolveToolRisk`，未声明工具按 `MCP_UNKNOWN_TOOLS` 口径）· `confirm.ts` · `sql-readonly.ts`（`isReadOnlySql`，服务端单一真相 fail-closed）· `audit.ts` · `builtins.ts` 的 `BUILTIN_RISK` 登记表。
- **回归**：`tests/write-gate.test.ts`、`tests/sql-readonly.test.ts`。
- **状态**：✅ 现行。
- **注意**：§5.9 自述「本期只解决一半」——第二个风险轴是**数据外发**；且 `isReadOnlySql` 降级属体验优化层，真正边界应由数据库只读角色提供（与 `text2sql-text2api-plan.md` 同口径）。

### [bi-sql-best-practices.md](./bi-sql-best-practices.md)
- **定位**：bi（Metabase）取数通道上 **SQL 怎么写** 的权威口径——13 条判据、改法示例、实测审计数据、实现坑。
- **覆盖**：两道闸门的分工（只读 fail-closed vs 写法体检 fail-open）· 四类判据（结果集有界 / 扫描代价 / **正确性** / 引擎实践）· 元数据语句的例外 · 审计脚本与局限。
- **现行落点**：`scripts/sql-lint-common.mjs`（判据唯一实现）· `scripts/sql-readonly-common.mjs`（只读）· `scripts/metabase-mcp.mjs` 的 `runSql` / `construct_query`（回灌）· `skills/business-data-query/SKILL.md` 的「SQL 怎么写」。
- **回归**：`tests/sql-lint.test.ts`（13 例，含不误伤与 fail-open 反向约束）· 现行回归入口统一为 `pnpm test`。原审计脚本 `scripts/_audit-bi-sql.mjs` 已不在仓库（2026-11-12 核对），勿再照抄其命令。
- **评测集**：`tests/fixtures/text2sql-bi-cases.json`（6 case，零业务词，每个 case 绑定真实测试名）+ `tests/text2sql-eval-fixture.test.ts`（fixture 不腐化门禁：绑定必须存在 + 零业务词自检）。
- **状态**：🆕 2026-10-15 新建。

### [text2sql-text2api-plan.md](./text2sql-text2api-plan.md)
- **定位**：bi（text2sql）/ yapi（text2api）两类取数通道的最佳实践对齐。
- **现行落点**：`scripts/metabase-mcp.mjs`（8 工具 + MCP 侧 `isReadOnlySql`）· `scripts/yapi-mcp.mjs`（GET-only + 项目白名单）· `src/sql-readonly.ts`（服务端同口径，**双层必须同步改**）· `risk.ts` 的只读 SQL 降级。
- **状态**：✅ 现行（2026-09-24 已逐项核对关键声明与代码一致：bi/yapi 工具名、只读降级 + 非只读硬拒、`call_api` 硬编码 GET、调试脚本确已移除；仅补了路径/配置落点说明）。
- **注意**：文内 ❌（DB 层只读角色、行级权限/身份透传）指的是**安全边界**仍缺，不要因为看到 `sql-readonly.ts` 就以为已补齐。

### [agent-stall-incident-20261014.md](./agent-stall-incident-20261014.md)
- **定位**：取数类对话「零进展 23 分钟」事故复盘（2026-10-14，run `run_c284e83d`）+ 对标 4 篇权威原文的分步修复计划 + 评测集固化方案。**只讲韧性 / 收敛 / 资源治理**；取数正确性与只读安全见上一份文档。
- **核心结论**：28 轮预算从未出现综合轮（0 次）→ 48 次外部工具调用 7 次失败 → 45 条结果被卸载成句柄 → 静默 627s 被看门狗收口 → 落兜底句。对标 Anthropic 上下文工程 / 工具设计、AWS 超时重试预算、OpenRouter 配额口径共 4 篇，给出 P0×3 / P1×5 / P2×3 修复项，每项含验收与回滚开关。
- **评测集**：L0 case 定义已落 `apps/agent-server/tests/fixtures/stall-incident-cases.json`（10 个 case，**零业务词**、public/private 分层）；L1 确定性回归进 `pnpm test`；L3 扩在线评测维度。
- **状态**：🆕 2026-10-14 新建；**第 1～11 批修复全部已实施**（2026-10-14 至 2026-10-15）。`tsc` 0 错误；全量 98 文件 653 用例全绿（含真实端到端复跑，见 §5「第 9 批实施记录」）。各批落地明细见 §5 实施记录：第 1 批（P0-1/P0-3/P1-5）、第 2 批（P2-1/P1-1/P1-2/P1-4）、第 3 批（P1-3 子代理状态契约 / P0-2 冷却落盘 / P2-2 评测扩维 / P2-3）、第 4 批（task span / 轮级 mode / 异常检测）、第 5 批（C1–C4 候选链与重试治理）、第 6 批（concise/detailed + 自适应超时）、第 7 批（Jev 统一治理）、第 8 批（卸载 recall 优先 + key 轮换入预算）、第 9 批（真实复跑 + 适配器语法门禁）、第 10 批（重复提醒跨轮阶梯）、第 11 批（对齐 Micro-compact 安全子集）。**§7 的「真实复跑验证」项已于 2026-11-10 全部闭环**（见 §7.1）：L4 探索效率（总工具调用 83→40、单点最大重复 32→30）、`[chat:compact]` 压缩日志（真实长轨迹里 13 次压缩、卸载但清空 0、keep 硬下限守住）、**客服 Jev 路**（真实 `/support` 复跑，`classifierCalls=1` 且 `classifier_health=PASS`，Jev 四项分类均正确）三者均验证通过。复跑脚本 `scripts/_stall-replay.mjs`（BI 路）与 `scripts/_jev-replay.mjs`（客服路）均已补回（§9 当时临时脚本从未入仓）。此次事故的全部修复与遗留验证项已闭合。
- **注意**：与 `text2sql-text2api-plan.md` §3.2「语句超时默认 30s」不冲突——那份证明"外部调用必须有界"，本份补上"超时/反复失败之后模型与运行该怎么处置"。

### [conversation-state-plan.md](./conversation-state-plan.md)
- **定位**：会话状态与上下文/记忆层契约（thread / 并发 / 队列）。
- **现行落点**：`conversations.ts` · `history.ts`（四层上下文策略：prune → LLM 摘要）· `chat-tasks.ts`（异步任务 / 断线续传 / 结果回投）。
- **回归**：`tests/task-persistence.test.ts`、`tests/task-resume.test.ts`。
- **状态**：✅ 现行（2026-09-24 已核对关键声明与代码一致：对话文档字段、`CONVERSATION_BUSY`↔`isTaskRunning` 链路、`running` 标志、`assembleContext`、`usage` 扩展字段、前端 `ConvState`/`states`/`convStatus`；修正了若干已删除脚本的残留引用）。
- **注意**：任务状态在进程内存（`project-review.html` 标为「有意偏离」），多实例部署需另做。

### [conversation-list-ux-plan.md](./conversation-list-ux-plan.md)
- **定位**：会话列表交互（右键菜单 / 内联重命名 / 删除撤销 / 置顶 / 拖拽排序 / 键盘可达）。
- **现行落点**：`pinnedAt`、`convSortMode`、`reorder` 在 `apps/web/src/api.ts`、`ChatPage.vue`、`conversations.ts`、`app.ts`、`session.ts` 中均有实现（2026-09-24 复核）。
- **状态**：✅ 现行。
- **注意**：**只保留右键入口**（用户明确要求）；键盘用 `Shift+F10` / 菜单键，触屏用长按。

### [web-search-guide.md](./web-search-guide.md)
- **定位**：联网检索与工具搜索 UI。
- **现行落点**：`web_search` / `fetch_url`（`builtins.ts`）· `src/web-search.ts` · 前端 `pinyin.ts` + `ToolsSearch`（`ChatPage.vue`）· `pinyin-pro` 依赖（按需加载，已拆出主 chunk）。
- **状态**：✅ 现行（2026-09-24 复核）。

### [movie-safety-policy.md](./movie-safety-policy.md)
- **定位**：`/movie` 角色（观影助手）的安全与限制策略。
- **现行落点**：`system-prompt.ts`（`SAFETY_GUARDRAIL`，注入稳定前缀最前）· `roles.ts`（`MOVIE_BASE_PROMPT` + `forceEagerTools` / `forceToolCall` / `enforceGrounding`）· `role-guard.ts`（确定性身份护栏）· `grounding.ts`（反编造接地护栏）。
- **回归**：`tests/grounding-guard.test.ts`、`tests/deep-agent-live.test.ts`。
- **状态**：✅ 现行。
- **注意**：原 `scripts/_movie-grounding-gate.mjs` 已随调试脚本清理移除，现行回归入口是 `pnpm test`。

### [agent/support-salesiq-plan.md](./agent/support-salesiq-plan.md)
- **定位**：客服助手接入 Zoho SalesIQ 的现行方案（坐席侧查阅 → 确认后发送）。
- **覆盖**：与订单源、对话量预警的边界；工具白名单 / `pathDefaults` / `toolNotes` / 写闸门；角色人设与验收。Zoho 控制台上的两百多个工具不放进模型，白名单收在只读子集（2026-10-12：阶段一 10 个、阶段二 26 个，配中文注记与按需加载）。
- **现行落点**：`roles.ts` 的 `support` · `.data/mcp-servers.json` 的 `zoho-salesiq`（目前仅 `ZohoSalesIQ_getConversationsList`）· `src/mcp/path-defaults.ts`。按需加载本身在 `mcp-guide.md`，不代替这张白名单。
- **状态**：🟡 角色已挂上现有 `zoho-salesiq`（2026-10-08）。未新增连接器。单条消息与代发仍未做。订单/工单仍以 `docs/agent/support-data-source-plan.md` 为准；预警仍以 `scheduled-spike-detection-plan.md` 为准。

### [agent/support-jev-plan.md](./agent/support-jev-plan.md)
- **定位**：客服助手的封闭分类。2026-10-12 已接到 `/support`。
- **做法**：Jev 不写回复，也不进对话模型名单。事项、是否要求代发、路由建议、越权只显示。不把坐席的指令当成访客情绪。草稿把退款说成已经答应且概率 ≥ 0.9 时只标高风险，不改正文。代发在没有安全结果或概率 ≥ 0.9 时不放行。不是「向量召回 → Jev 精分 → 大模型兜底」；知识库检索仍由对话模型自己调 `search_knowledge`。
- **现行落点**：`apps/agent-server/src/jev.ts` · `chat.ts`（仅 support）· 客服页气泡标签。
- **状态**：✅ 客服助手已接线。其它角色不调用。

### [skill-management-plan.md](./skill-management-plan.md)
- **定位**：本地技能与技能管理页。2026-10-12 写入，**尚未改代码**。
- **做法**：仓库 `skills/` 仍是只读内置；本地技能落 `.data/skills/`。管理页管增删和全局开关；对话飞出继续只做「本对话全文注入」。不对齐技能市场和技能包脚本。
- **状态**：✅ 已落地（2026-10-12）。F12（`best-practice-alignment-review.md`）当时因技能少、静态目录而维持；技能目录与管理页以本文为准。

### [domain-adaptation-guide.md](./domain-adaptation-guide.md)
- **定位**：规范性指南——如何在不动引擎的前提下把通用 Agent 改造成垂直领域 Agent（以观影助手为例）。
- **状态**：✅ 现行（弱代码耦合，属「怎么做」而非「现状记录」）。
- **注意**：§10 提到的 `scripts/_role-check.mjs` / `_movie-e2e.mjs` 等**大多已移除，不要照抄脚本命令**；替代回归总表见 `mcp-guide.md` §11。新领域做到哪一步停，以该指南文首四步为准。不上集群见 `docs/agent/CURRENT_ARCHITECTURE.md` 文首。

### [movie-mobile-ui-plan.md](./movie-mobile-ui-plan.md)
- **定位**：影视移动端 UI 方案。
- **状态**：✅ 现行（2026-09-24 已核对关键声明与代码一致：`MoviePage.vue` 存在、`isMovieMode` 全仓库 0 处、`getApiErrorCode`/`foldAgentBlocks`/`theme.ts` 优雅降级/`styles.css` forced-colors/`ModelSelect` aria-label 均吻合）。

### [engineering-optimization-review.md](./engineering-optimization-review.md)
- **定位**：2026-11-12 全仓**工程现状对齐 + 全局优化清单**（P0–P3 分级、证据、落地路线与验收）。属工程治理评审，**不是设计方案**，不改变各主题文档的权威口径。
- **覆盖**：口径基准表（内置工具数量 / 测试外部依赖 / 测试规模 / `any` 分布 / 路由注册数等）· 文档冲突与处置 · 优化空间 · 现状基线 · 待确认项。
- **状态**：✅ 现行（2026-11-12 建立；2026-11-18 复核：P0-1～P0-5 已实施；P3-4 生产依赖审计 0 漏洞、全量审计 1 条 dev-only picomatch 无修复版例外；P1-1 阶段 1 已提交、阶段 2 设计已写入待审阅，其余项仍未实施）。
- **注意**：与主题文档冲突时以各主题现行文档为准；实施优化后回写该文状态行与 §3 冲突清单。

### [superpowers/specs/2026-11-17-chat-page-refactor-design.md](./superpowers/specs/2026-11-17-chat-page-refactor-design.md)
- **定位**：P1-1「拆 `ChatPage.vue` 巨型文件」的设计 + 实施计划合一文档；阶段 1 为整脚本原子搬迁，阶段 2 按 SCC 拆 composables 与 UI 子组件。
- **覆盖**：现状审计（7723 行 / 4142 行 CSS）、根边界不变量、整脚本搬迁规则、SCC 拆分清单、风险/回滚/验收、P1-2 门禁。
- **状态**：设计已确认（2026-11-17 策略纠正）；阶段 1 已完成提交（`5e962ca`），阶段 2 执行中——T0/T1 已提交，T2（SCC A 会话壳）已提交 `23c9d28`，见下方 phase2 条目。
- **注意**：行号是 2026-11-17 快照，实施前用符号名定位；阶段 1 不碰模板/CSS/API，不做逐组 composable 抽取。

### [superpowers/specs/2026-11-18-chat-page-phase2-design.md](./superpowers/specs/2026-11-18-chat-page-phase2-design.md)
- **定位**：P1-1 阶段 2 设计：按 SCC 拆 `useChatPageCore.ts`，再抽 UI 子组件并下沉 CSS。
- **覆盖**：阶段 2 基线、SCC A/B/C、共享符号硬约束、UI/CSS 边界、分步实施顺序、风险/回滚/验收。
- **状态**：设计已审阅；阶段 2 执行中——T0/T1 已提交，T2（SCC A 会话壳）已提交 `23c9d28`；原文 §4/§5.2 与代码偏差已在实施计划 §0.3 修订。
- **注意**：行号是阶段 1 提交后的快照，部分跨组描述已按 2026-11-19 代码核对修订；实施前用符号名定位；本阶段不与 P1-2 门禁混合同一提交。

### [superpowers/plans/2026-11-19-chat-page-phase2-implementation-plan.md](./superpowers/plans/2026-11-19-chat-page-phase2-implementation-plan.md)
- **定位**：P1-1 阶段 2 的可执行细化实施计划（T0–T7 + P1-2 后续独立变更）。
- **覆盖**：开工基线检查、SCC 边界与 Options 契约、逐提交验收命令、UI 子组件 props/emits 与 ref 暴露、CSS 下沉清单、回滚策略。
- **状态**：执行中（2026-11-19）——C0 `6709f4a`、T0 `37d8663`、T1 `3f6d81c` 已提交（门禁全绿）；**T2 已提交 `23c9d28`**：先修正 §5 的 4 处事实偏差，再补 33 个 web 行为测试与 AST/TDZ 审计，按裁剪边界把会话壳迁入 `useChatConversationShell.ts`；拆分后 33 web 测试、全仓 type-check、build、978 server 测试全绿。
- **注意**：设计文档中的行号/伪符号已被代码快照校正，实施时以符号名为准；本次文档对齐（C0 增补）已把 §5.3 搬迁边界改为「会话壳核心先搬、任务表单与飞出层留根」。

### [superpowers/plans/2026-11-17-chat-page-core-extraction-plan.md](./superpowers/plans/2026-11-17-chat-page-core-extraction-plan.md)
- **定位**：P1-1 阶段 1「整脚本原子搬迁」的可执行实施计划（T0–T5）。
- **覆盖**：AST 生成器准备、`useChatPageCore.ts` 生成、`ChatPage.vue` script 替换、vitest 底座、全量验证、单次提交与回滚。
- **状态**：T0–T5 已完成并提交；不与阶段 2 / P1-2 门禁混合同一提交。

### BI Metabase 专题（2026-11-12）
- **[bi-metabase-optimization-plan.md](./bi-metabase-optimization-plan.md)**：§11.9 是「接下来做什么」的唯一入口，§0–§11.8 保留评估过程与证据；文内历史「工作区状态」行已按 2026-11-12 复核更新。
- **[bi-metabase-todo.md](./bi-metabase-todo.md)**：**进度唯一载体**——当日进度记录、阶段 0–4 勾选，以及「待对齐 / 阻塞项」B1–B5（需业务 / 管理员 / 用户结论或资源，逐项附核验证据）。
- **[bi-metabase-decisions.md](./bi-metabase-decisions.md)**：阶段 1 决策建议书（待拍板快照），顶部已标注未签字状态与当时口径。
- **注意**：三份文档冲突时以 `bi-metabase-todo.md` 的进度记录为准；改动只落 `apps/agent-server/scripts/*.mjs` 与 `bi-semantic/*.json`，`src/**`、prompt、技能、模型调用不动。

### [SECURITY.md](./SECURITY.md)
- **定位**：安全态势**权威文档**——已落地控制项、默认部署假设、加固清单与诚实标注的已知局限。
- **关联**：各维度设计见 `agent-infrastructure.md` §5。
- **状态**：✅ 现行。

### [BEST_PRACTICE_ALIGNMENT.md](./BEST_PRACTICE_ALIGNMENT.md)
- **定位**：功能与业界最佳实践（OWASP LLM/ASI/Agentic Skills、OTel GenAI、Anthropic 等）逐条对照的**缺口清单 SSOT**。
- **关联**：安全细节见 `SECURITY.md`；各维度设计见 `agent-infrastructure.md`。
- **状态**：✅ 现行。

### [DELIVERABLE_GUARDRAILS.md](./DELIVERABLE_GUARDRAILS.md)
- **定位**：所有「产出可下载/可查看文件」内置工具的统一护栏基线，由 `artifact-delivery-plan.md` §11 提炼复用。
- **状态**：✅ 现行。

### [grounding-verify-alignment.md](./grounding-verify-alignment.md)
- **定位**：`src/grounding.ts` 事后核验部分与公开最佳实践（CoVe / Self-RAG / FActScore）的对照对齐。
- **状态**：✅ 已落地（2026-09-30）。

### [chat-preempt-plan.md](./chat-preempt-plan.md)
- **定位**：对话抢占式生成（Chat Preempt）P0 实施与验收记录（确认等待协程泄漏 / 校验顺序 / 定时任务豁免 / 并发双发等）。
- **状态**：✅ 现行（2026-11-13 重建，聚焦落地与验收）。

### [cross-role-restore-scoping.md](./cross-role-restore-scoping.md)
- **定位**：跨角色会话恢复按角色收窄，修复「跨角色会话被自动恢复拉到错误角色页面」。
- **状态**：✅ 现行（v1，2026-10-13）。

### [verification-plan-20261019.md](./verification-plan-20261019.md)
- **定位**：多场景多实例全链路验证矩阵（时延 / 质量 / 记忆 / 上下文 / 全工具 / skill / MCP / 图文 十维度）。
- **状态**：🆕 2026-10-19。

### 定时任务 / 预警专题
- **[scheduled-task-sessions-plan.md](./scheduled-task-sessions-plan.md)**：定时任务运行会话方案（每期独立会话 + 侧栏分组），阶段 0–6 落地记录。**现行**。
- **[scheduled-spike-detection-plan.md](./scheduled-spike-detection-plan.md)**：数据暴涨检测/预警最佳实践版（先测后跑 + 仅异常通知 + 恢复）。**P1–P2.5 已落地**。
- **[scheduled-alert-failure-notify-plan.md](./scheduled-alert-failure-notify-plan.md)**：执行失败不每期刷通知（`on_alert` 失败分离 + 模型冷却换链）。**已落地（2026-10-09）**。
- **[scheduled-alert-best-practices-comparison.md](./scheduled-alert-best-practices-comparison.md)**：定时预警业界最佳实践与竞品对照（调研文档），产品口径以 `scheduled-spike-detection-plan.md` 为准。

---

## 二、计划留档（决策背景；文内 ❌ 多为「改前现状」）

> 读这类文档**务必先看顶部修订说明**，否则容易把「改前缺口」误读成「现在还缺」。

### [chart-visualization-plan.md](./chart-visualization-plan.md)
- **定位**：图表可视化三路线选型记录。
- **现状**：**路线 3（本地渲染、零外链）已实施**——前端 `@antv/g2` + `@antv/g6`（`apps/web/package.json`）+ 内置 `render_chart`；`chart` 服务器已于 2026-09-21 从 `MCP_BUILTIN_SERVERS` 移除。
- **注意**：文首表格的 ❌「无」是**改前现状**快照。

### [movie-personalized-plan.md](./movie-personalized-plan.md)
- **定位**：个性化推荐方案——**推荐能力已下线**。
- **现状**：保留**观影口味画像**（`src/movie/profile.ts`，只留 history / feedback）+ 内置工具 `record_watched_movies`（`builtins.ts`）；影片数据源已由豆瓣换成 **TMDb**。
- **注意**：文内 ❌（相似电影 / 冷启动 / 反馈闭环）指**推荐能力**缺口，不是画像缺失。

### [deep-agents-plan.md](./deep-agents-plan.md)
- **定位**：Deep Agents 架构评估 → 实施记录（v4，2026-09-20）。
- **现状**：四项差距均已补齐——虚拟文件系统（`fs_*`）· 任务规划（`write_todos`）· 子代理（`task`，`chat.ts` 内 `SubagentHandle`）· 详细系统提示 + Skills（`read_skill`）。
- **注意**：§8 / §11 里的 `scripts/_*.mjs` 已清理，`apps/agent-server/scripts/` 现只留功能性脚本。

### [mcp-connect-plan.md](./mcp-connect-plan.md)
- **定位**：早期 MCP 连接方案。
- **注意**：**顶部已自行标注**「现状一律以 `docs/mcp-guide.md` 为准」；本文只作决策背景。

---

## 三、快照 / 复盘（对应固定代码版本，不随现状更新）

### [project-review.html](./project-review.html)
- **定位**：项目整体复盘（业界做法 → 本项目做法 → 是否最佳实践 → 偏离原因 → 何时改回）。
- **状态**：🗂 快照；**2026-09-28 已刷新到 master @ `d9db377`**。**2026-10-02** §7 已补全分页计数。**2026-10-08** §9、部署常量表、环境变量清单与 B 章已对齐 MCP 命令白名单、来源指纹，以及「不上 Agent 集群」。**2026-10-10** C 章是当前全链路待办：F1–F7 已修，F8 部分完成，F12 只做了定时拒绝，F9–F11、F13–F15 与 K1–K7 维持，F16 已作废。同日 R1–R5：对话约 5 秒同步，定时提问按本期补上。细目在 `best-practice-alignment-review.md` 第 6 节。其余叙述性段落仍是较早快照，只作背景。
- **注意**：其中「MCP 配置缓存：按 mtime 失效、4 例全绿」已过时——现为 `mtime + size`、5 例（见 `artifact-delivery-plan.md` §14）。

### [mongo-outage-incident-20261105.md](./mongo-outage-incident-20261105.md)
- **定位**：MongoDB 存储层事故复盘（2026-11-05，`MONGO_URI` 缺凭据导致 16h 500）+ 随之落地的代码防线。
- **状态**：🗂 复盘（2026-11-05）。

---

## 四、子目录

| 目录 | 内容 | 状态 |
|---|---|---|
| `docs/agent/` | `RAG_INGESTION_PLAN.md`：知识入库方案（2026-09-23 按 `src/rag/*` 重写对齐）。落点 `rag/parsers.ts`（md/txt/html/pdf/docx/xlsx）+ `store.ts`（词法 TF-IDF + 可选向量 RRF）+ `scripts/build-rag-index.mjs`；模型侧入口 `search_knowledge` / `knowledge_sources`。**不引入独立向量库**（有意偏离） | ✅ 现行 |
| `docs/knowledge/` | RAG 语料（人事 / 安全 / 财务 / 运维），**同时是知识库内容**，改目录即改检索结果 | ✅ 现行 |

---

## 五、已知文档缺口（挂账）

1. ~~**仓库根无 `README.md`**~~ → ✅ **已补齐（2026-09-24）**：根 [`README.md`](../README.md) 覆盖工程结构、
   快速开始、端口与关键环境变量、内置工具清单（21 个）、五条项目红线。本文只管「文档怎么读」。
2. 标「未复核 / 未逐条复核」的三份文档（`text2sql-text2api-plan.md`、`conversation-state-plan.md`、`movie-mobile-ui-plan.md`）**已于 2026-09-24 完成对齐复核**（关键声明逐项比对代码，修正了若干 stale 脚本引用与措辞偏差；见各文档状态行）。
3. `project-review.html` 部分过时：2026-09-28 已把**事实性内容**（§1 技术栈、§2 体量、§3 起源码行号引用、§8 工具清单、A 章工程配套、MCP/RAG 缓存口径）刷新到 `d9db377`；各章叙述性段落（知识点 / 业界对照 / 偏离汇总）以 `cc6c7a6` 为底稿，**已按 Anthropic《Effective context engineering for AI agents》补齐上下文四项**（跨轮重复观察提示、预算耗尽补位收尾、逐轮 trace、产物零外链），并补 §13 客服角色与 `orders` 示例数据源；尚未逐段复核的是与各章正文细节无关的历史观点表述。
4. 多数计划文档里的**行号引用**会漂移，已在效力约定第 1 条统一说明（先搜函数名）。
