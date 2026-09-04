# 生产就绪评估（Production Readiness）

> **评估日期**：2026-09-03  
> **驱动**：用户指出「能 Demo 和能上线的差别 = 身份、异步、追踪、评测、成本、安全、版本」。  
> 本文档评估 bx-admin-agent 在这 8 个维度上的现状，记录缺口，并给出优先级。  
> 落地进度随时更新；评测闸门（P0）已开工，详见 §4。

---

## 1. 八维度现状总览

| 维度 | 现状 | 评级 | 一句话缺口 |
|---|---|---|---|
| **身份 Identity** | **2026-09-04 P2 已落地**：ownerKey 溯源贯穿 trace/cost/audit + 项目级 `allowOwners` ACL + HTTP 面最小权限 | ✅ 已补 | 角色模型/管理员视角缺（CLI 承担全局） |
| **异步 Async** | **2026-09-04 P2 已落地**：执行与推送解耦（断线任务继续跑完+结果自动落库）+ 并发回放 + 显式取消 + 任务状态查询 | ✅ 已补 | 无独立任务队列（进程内单任务/会话） |
| **追踪 Tracing** | **2026-09-03 已建**：`trace.ts` + `inspect-trace.mjs`，runId 贯穿 + span 树 + token usage | ✅ 已补 | 仅 JSONL 落盘，无 Web 可视化/告警 |
| **评测 Eval** | `eval-full-chain.mjs` 等脚本能跑全链路 PASS/FAIL + `process.exit(1)` | 🟡 雏形 | 未落库基线、未接 CI、断言维度浅（无 traces 复用） |
| **成本 Cost** | **2026-09-04 P1 已落地**：`cost.ts` 聚合（日/模型/会话/慢调用）+ `inspect-cost.mjs` CLI + `GET /cost/summary` 只读端点 + 预算告警 | ✅ 已补 | 单价未配（只计 token）；告警未接通知渠道 |
| **安全 Security** | **2026-09-04 P1 已落地**：`audit.ts` 审计落库（越权拒绝/写确认三态）+ `/audit/list` 端点 + `inspect-audit.mjs` CLI | 🟡→✅ 核心 | 限流、Prompt 注入防护仍缺 |
| **版本 Version** | **2026-09-04 P3 已落地**：release 标识（git sha）贯穿 trace run meta + eval 基线，回归按版本可对比 | ✅ 已补 | 提示词仍随代码发布（git revert 即回滚，够用） |
| **可观测 Observ** | **2026-09-04 P3 已落地**：`GET /trace/runs`（摘要+统计）+ `/trace/run/:id`（span 树），ownerKey 隔离 | ✅ 已补 | 前端可视化页面挂账（端点已就绪） |

---

## 2. 维度详情

### 2.1 身份 Identity ✅ P2 已落地（溯源 + 多项目 ACL）
- 已有：`app.ts` 的 `getSession(getCookie(c, COOKIE))` 会话校验；`/chat/conversations` 等接口走 `requireOwner`。
- **调用方溯源（本次落地）**：`ownerKey`（countryId:loginName）在 chatStream 入口计算一次，贯穿——①trace run span meta（可回溯每次请求的操作者）；②成本聚合 `byOwner` 维度 + `inspect-cost.mjs --owner` CLI；③审计事件（P1 已有）；④会话（conversations 既有）。
- **多项目 ACL（本次落地）**：项目配置（clarification-policy.json）可选 `allowOwners`（ownerKey 数组）——未配置/空 = 对所有登录用户开放；配置后仅名单内操作者可 `set_project`（判定先于会话写入，拒绝零副作用，未知项目标识诚实拒绝）。判定逻辑为 `project-registry.ts` 纯函数 `projectAccessibleBy`。
- **最小权限口径**：`GET /cost/summary` 与 `GET /audit/list` 只暴露当前登录操作者自己的数据（ownerKey 强制过滤）；全局视角只走服务端 CLI（inspect-cost.mjs / inspect-audit.mjs），不暴露 HTTP 面。
- 验证：ACL 纯函数 4/4 + set_project 真实路径（名单外拒绝/名单内放行/未配置开放/未知项目拒绝）+ 真实请求 run span 带 ownerKey + byOwner 过滤正确 + 端点 401/200。
- 仍缺：角色/权限模型（越权防护靠 M1 worker 白名单运行期拦截，非数据期 ACL）；跨租户管理员视角（现 CLI 承担）。

### 2.2 异步 Async ✅ P2 已落地（执行与推送解耦）
- **旧行为（根因）**：`c.req.raw.signal`（客户端断开）直接传进 `chatStream`——刷新/断网 → 各节点 `signal.aborted` → 任务终止、结果不落库（刷新丢结果）；且 generator 是拉模式，SSE 消费断开即冻结。
- **新架构（本次落地，`chat.ts` 零改动）**：`/chat/stream` 引入任务注册表——**后台消费者**驱动 `chatStream`（任务级 `AbortController`，不依赖客户端连接），事件写入任务缓冲；SSE 连接只是缓冲的转发订阅者（100ms 轮询追新，断开仅停转发）。
- **断线闭环**：任务收束后服务端自动把 (userText, 最终答复) 追加到「后台任务结果」专用会话（`id=task-<sessionId>`，与前端 conv_xxx 隔离）——前端不在线也数据不丢，刷新后从会话历史恢复。
- **并发保护**：同会话任务进行中再发请求 → 只回放缓冲 + `task_running` 事件（不开第二个任务，防并发写 session.messages 交错污染）。
- **显式取消**：`POST /chat/cancel`（abort 任务 controller，与原 signal 语义一致）；客户端断开不再等于取消。
- **状态查询**：`GET /chat/task/status`（running/last 摘要，刷新后前端可展示「上一任务仍在后台执行」）；缓冲 5 分钟 GC + lastTasks 上限 100 防内存膨胀。
- 验证（实例 8/8）：T1 断线 2s → 后台完成 → 落库配对 ✓；T2 进行中重连 → task_running ✓；T3 cancel → 收束 → running=null ✓。
- 遗留：跨进程任务队列（多实例部署时任务在单进程内）；任务进度百分比（当前为事件流粒度）。

### 2.3 追踪 Tracing ✅（2026-09-03 补齐）
- 实现：`src/trace.ts`——`beginRun/endRun/span/setRunModel`；`LoopState.traceRunId` 贯穿各节点。
- 覆盖：`llm`（模型/耗时/重试/token usage）、`route`（route_to_agent 目标 Worker）、`tool`（工具名/Worker/越权拒绝状态）。
- 落盘：`.data/traces/<runId>.jsonl`（已被 `.gitignore` 忽略）。
- 查询：`scripts/inspect-trace.mjs --last` / `<runId>`。
- 缺口：仅 CLI 查询；无 Web 可视化、无慢调用/错误率告警。

### 2.4 评测 Eval ✅ P0 已落地（分层 + CI 闸门）

**分层入口（`apps/agent-server/package.json`）**：

| 命令 | 依赖 | 跑什么 | 适用 |
|---|---|---|---|
| `pnpm eval` / `eval:core` / `pnpm test` | **零依赖** | `eval-core.test.ts`（17 用例，测红线断言逻辑本身） | **CI 必跑**、任何环境 |
| `pnpm eval:full` | 本地业务源码（CODEBASE_ROOT） | `eval-full-chain` + core | 本地 |
| `pnpm eval:trace-gate` | agent-server 在线(8787) + 模型凭证 | 真实 chat + trace 红线 (G1-G5) + 基线落库 | 本地 / 定时 |

**通用化**：红线断言已抽为 `scripts/eval-core.mjs`（`assertTraceGates` / `summarize` 纯函数，零 import，
不认识任何业务词/worker/cookie）。业务项目只写适配器（怎么触发请求），红线零改动。
G2 越权断言三态：`enforce`（必有越权拒绝）/ `observe`（有才校验）/ `off`（无越权机制的 Agent 关闭）。
**G6 业务期望**（2026-09-04 实测补缺）：`expectTools`（adapter 传 `--expect-tool` / `EVAL_EXPECT_TOOLS`）——
场景期望的工具调用必须真的发生。背景：实测发现 zen 免费链**短路收束**（<1s、0 token、不调工具）能骗过
G1-G5 全部红线（G5 只验「流程收束」不验「业务目标达成」），G6 专拦「收束了但没干活」。
阈值校准：`EVAL_MAX_ROUNDS` / `EVAL_MAX_TOKENS` 环境变量（G1/G4 默认 8 轮 / 60k token）。

**真实波动基线（2026-09-04 实测记录）**：免费链上游存在劣化窗口——同一 prompt（读场景）
健康时段 rounds=3/tokens≈27k/152s；劣化窗口 nemotronultra 连续 2 次 rounds=10（其中 3 轮
空响应轮，单轮 LLM 30-212s，无 429 日志）、zenhy3 连续 2 次短路（<1s 收束）。
劣化期 G1/G4/G6 如实红——这是闸门诚实，不是误报；复跑或换模型窗口即可恢复。

**CI 闸门**：`.github/workflows/eval.yml`（push main / PR 触发）只跑 `pnpm eval:core`。
其余两层 CI runner 不具备条件（无业务源码 / 无 `.env` / 无 8787 服务），强行跑只会假红，故不进 CI。

**⚠️ 评测发现的真实问题（评测价值的体现）**：
`eval-intent-routing.mjs` 实测 **0/6 FAIL** —— 该脚本用中文业务词硬编码
（「二级分类详情」「关闭搜索栏」）去查 `api-operation-index`，①索引无中文 key 故恒 null；
②业务词写死违反 AGENT_CHARTER「禁止写死」红线。状态：**已失效 + 违规，不纳入任何闸门**，
保留文件仅供追溯。教训：评测资产本身也需被评测，否则会积累「永远红但没人管」的死脚本。

### 2.5 成本 Cost ✅ P1 已落地
- 采集：`trace.ts` 的 `llm` span 捕获 `usage`（promptTokens/completionTokens/totalTokens）。
- **聚合（本次落地）**：`src/cost.ts` 纯只读遍历 trace JSONL，按 **日 / 模型 / 会话** 维度汇总 token 与费用 + 慢调用 Top N；单个损坏文件跳过不中断。
- **查看入口**：①CLI `scripts/inspect-cost.mjs`（`--from/--to/--session/--top`）；②HTTP `GET /cost/summary?from=&to=&session=`（requireOwner 保护，只读）。
- **预算告警**：`budgetAlerts()` 按 `DAILY_TOKEN_BUDGET`（日）与 `RUN_TOKEN_BUDGET`（单请求均值）环境变量判断，超限输出告警（CLI 退出码 1 可接 CI/巡检）。
- **单价可配**：`COST_RATE_<MODEL>_PROMPT/_COMPLETION`（每百万 token），未配置只统计 token、不编造费用（诚实降级，未配价 token 计入 `unpricedTokens`）。
- 设计原则：零业务词（维度仅时间/模型/会话/耗时）、零新依赖（Node 标准库）、采集侧零感知。
- 遗留：多 key 轮转（NVIDIA_API_KEYS）按 key 成本分摊；告警接入通知渠道（钉钉等）。

### 2.6 安全 Security 🟡→✅ 核心（P1 审计已落地）
- 已有：写操作 `confirmation_required` 双确认（tool 节点 + 服务端兜底×2）；M1 执行层越权拒绝；写确认三态（granted/denied/timeout）。
- **审计落库（本次落地）**：`src/audit.ts`——三类事件（`reject` / `confirm_request` / `confirm_result`）append-only JSONL 按月分文件（`.data/audit/audit-YYYYMM.jsonl`），与 trace 通过 runId 关联（审计独立留痕，不随 trace 轮转丢失）。接线点：tool 节点越权拒绝 + 三处写确认（工具节点 / 主 fallback / catch 兜底）。
- **查看入口**：①CLI `scripts/inspect-audit.mjs`（`--from/--to/--kind/--limit`，全局视角）；②HTTP `GET /audit/list`（**ownerKey 隔离**：登录用户只能查自己的审计事件，最小权限；全局视角走 CLI）。
- 设计原则：零业务词（事件类型为通用安全语义）、零新依赖、写失败不阻断主流程、ownerKey 来自登录态（countryId:loginName）。
- 验证：模块回环 8/8（写入/倒序/kind 过滤/ownerKey 隔离/日期/limit）+ 端点匿名 401 / 登录态 200。
- 仍缺：速率限制（防滥用/刷 token）、Prompt 注入防护闭环、审计事件告警推送。

### 2.7 版本 Version ✅ P3 已落地（release 标识贯穿）
- **release 标识（本次落地）**：`trace.ts getRelease()`——优先 `RELEASE` 环境变量（部署注入），否则 git 短 sha（进程内缓存一次），失败诚实 `unknown`。
- **贯穿点**：①每个 run 的 span meta 落 `release`（真实请求已验证 `release: "b6b0dd7"`）；②eval 基线 summary 顶层加 `release` 字段——回归可按版本对比（哪个提交引入的退化一目了然）。
- 设计取舍：提示词/工具随代码单仓发布，git revert 即整体回滚，够用；「只回退提示词不回退代码」的提示词外置化不做（prompt 引导按红线必须在代码内评审维护，外置反而失控）。
- 遗留：无（版本可回滚=git 语义；版本可观测=release 贯穿）。

### 2.8 可观测 Observ ✅ P3 已落地（trace 只读视图 + 统计）
- **端点（本次落地，登录态 + ownerKey 隔离）**：
  - `GET /trace/runs?limit=` ——最近 N 个 run 摘要（模型/轮次/token/耗时/ownerKey/release/userText）+ 统计（`{runs, llmCalls, tokens, avgRounds}`），实测 `avgRounds=1.2`；
  - `GET /trace/run/:runId` ——完整 span 树；**归属校验**：非本人 run 一律 404（不泄漏存在性）；响应带当前 release。
- **最小权限口径与 /cost/summary、/audit/list 一致**：HTTP 面只看自己，全局视角走 CLI（inspect-trace/inspect-cost/inspect-audit）。
- 验证：own run 200（spans=6, release 正确）/ unknown run 404 / 匿名 401 / 旧 run（无 release 字段时代）诚实显示 undefined 不编造。
- 遗留：Web 前端可视化页面（端点已就绪，前端接入即可）；进程级 metrics 暴露（Prometheus 格式，等接入需求）。

---

## 3. 优先级与 roi

| 优先级 | 维度 | 动作 | 理由 |
|---|---|---|---|
| **P0** | 评测 Eval | ✅ 完整落地：通用 `eval-core` + `eval-trace-gate` + 分层入口（`pnpm eval`/`eval:full`/`eval:trace-gate`）+ CI 闸门 `.github/workflows/eval.yml` | 复用 traces，把 demo 验证变成可重复回归；最便宜的「上线」杠杆 |
| **P1** | 安全审计 | ✅ 已落地：`audit.ts` 三类事件（越权拒绝/写确认请求/确认结论三态）append-only 落库 + `/audit/list`（ownerKey 隔离）+ `inspect-audit.mjs` | 上线必备合规；runId 关联 trace 可反查上下文 |
| **P1** | 成本 Cost | ✅ 已落地：`cost.ts` 聚合 + `inspect-cost.mjs` CLI + `GET /cost/summary` 端点 + 预算告警（env 阈值） | traces 已采集，只差聚合 |
| **P2** | 身份 Identity | ✅ 已落地：ownerKey 溯源贯穿 trace/cost/audit + 项目级 `allowOwners` ACL + HTTP 面最小权限（只看自己，全局走 CLI） | 多租户上线前必需 |
| **P2** | 异步 Async | ✅ 已落地：执行与推送解耦（断线任务跑完+自动落库）/ 并发回放 / `/chat/cancel` / `/chat/task/status` | 刷新丢结果根因消除；chat.ts 零改动 |
| **P3** | 版本 Version | ✅ 已落地：release 标识（git sha/RELEASE env）贯穿 trace run meta + eval 基线，回归按版本对比 | 降低线上试错成本 |
| **P3** | 可观测 | ✅ 已落地：`GET /trace/runs`（摘要+统计）+ `/trace/run/:id`（span 树），ownerKey 隔离 | Web 可视化直接接端点即可 |

---

## 4. 进度记录

| 日期 | 模块 | 进展 | 关联文件 |
|---|---|---|---|
| 2026-09-03 | 追踪 Tracing | ✅ 建 `trace.ts` + `inspect-trace.mjs`：runId 贯穿 + llm/route/tool span + token usage；JSONL 落盘 `.data/traces/` | src/trace.ts / src/chat.ts / src/models.ts / scripts/inspect-trace.mjs |
| 2026-09-03 | 评估 | 建立本文档（八维度现状 + 优先级） | PRODUCTION_READINESS.md |
| 2026-09-03 | 评测 Eval | ✅ P0 落地：`eval-trace-gate.mjs` 跑真实 chat + 读 trace 断言 5 条生产红线（轮次/越权/伪调用/成本/收束）+ 基线落库 `.data/eval-baseline/`；`trace.ts` 加 `latestRunId()` | scripts/eval-trace-gate.mjs / src/trace.ts |
| 2026-09-04 | 评测 Eval | ✅ 通用化 + 分层 + CI：抽 `eval-core.mjs`（纯函数零 import，G2 三态）；`eval-core.test.ts` 17 用例全 PASS 作零依赖地基；`package.json` 加 `eval`/`eval:core`/`eval:full`/`eval:trace-gate`/`test`；根 package.json 转发；**CI 闸门 `.github/workflows/eval.yml`**（push main/PR 只跑零依赖 core，其余层 CI 无条件）；发现 `eval-intent-routing.mjs` 0/6 失效+违规（业务词硬编码），排除出闸门 | eval-core.mjs / eval-core.test.ts / eval-trace-gate.mjs / package.json / .github/workflows/eval.yml |
| 2026-09-04 | 评测 Eval（去硬编码） | ✅ 适配器零硬编码：登录凭证（EVAL_COUNTRY/EVAL_USER/EVAL_PASS）**必填无默认**、prompt **必填无默认业务词**、端点走 `AGENT_BASE_URL`、模型走 `EVAL_MODEL`、G3 伪调用黑名单改 `eval-core` 参数注入（`EVAL_PSEUDO_TOOLS`，core 零内置工具名）；core 单测 18/18（新增空黑名单不检测用例） | eval-trace-gate.mjs / eval-core.mjs / eval-core.test.ts |
| 2026-09-04 | 成本 Cost | ✅ P1 落地：`cost.ts`（日/模型/会话/慢调用聚合 + `budgetAlerts`，零业务词零依赖）+ `inspect-cost.mjs` CLI + `GET /cost/summary` 只读端点（requireOwner）；`trace.ts` 导出 `getTraceDir()`；实测真实 trace 4 runs/12 llm/79463 tokens 聚合正确；单价/预算全走环境变量（COST_RATE_*/DAILY_TOKEN_BUDGET/RUN_TOKEN_BUDGET，未配价诚实只计 token） | src/cost.ts / src/app.ts / src/trace.ts / scripts/inspect-cost.mjs |
| 2026-09-04 | 安全 Security | ✅ P1 审计落地：`audit.ts`（reject/confirm_request/confirm_result 三类事件，append-only 按月 JSONL，runId 关联 trace，零业务词零依赖）+ `chat.ts` 四处接线（tool 节点越权拒绝 + 三处写确认，确认结论三态 granted/denied/timeout——`waitForConfirmation` 改返回 `{confirmed, outcome}`）+ `GET /audit/list`（ownerKey 隔离最小权限）+ `inspect-audit.mjs` CLI；验证：模块回环 8/8 + 端点匿名 401/登录态 200 | src/audit.ts / src/chat.ts / src/app.ts / scripts/inspect-audit.mjs |
| 2026-09-04 | 安全+评测 实例验证 | ✅ 真实实例验证：①写确认审计端到端 PASS（真实写意图 → confirmation_required → 自动拒绝零副作用 → 审计落 confirm_request+confirm_result=denied，owner=countryId:loginName、runId 关联 trace、/audit/list 可查）；②读场景回归发现免费链劣化窗口（nemotronultra 2 次 rounds=10 含 3 空响应轮、zenhy3 2 次短路 <1s）——非代码回归（diff 不涉 LLM 循环）；③**gate 盲区修复**：短路/幻觉直答不调工具能骗过 G1-G5，补 **G6 业务期望断言**（`expectTools`，默认关）+ 阈值环境变量（EVAL_MAX_ROUNDS/EVAL_MAX_TOKENS）+ adapter `--expect-tool`；core 单测 23/23，G6 实战拦截 zenhy3 短路（5/6 如实红） | eval-core.mjs / eval-core.test.ts / eval-trace-gate.mjs |
| 2026-09-04 | 身份 Identity | ✅ P2 落地：①溯源——`ownerKey`（countryId:loginName）chatStream 入口计算，贯穿 trace run span meta / 成本 `byOwner` 维度（+`inspect-cost.mjs --owner`）/ 审计（P1）/ 会话；②多项目 ACL——项目配置可选 `allowOwners`（未配置=开放），`set_project` 判定先于会话写入（拒绝零副作用）+ 未知项目诚实拒绝，`projectAccessibleBy` 纯函数；③最小权限——`/cost/summary` 与 `/audit/list` HTTP 面强制 ownerKey 过滤（只看自己），全局视角只走 CLI；顺手修 bySession/byOwner runs 计数恒 0 缺陷。验证：ACL 11 用例 + 真实 run span 带 ownerKey + byOwner 过滤正确 + 端点 401/200 + 最小权限不泄漏 | src/trace.ts / src/cost.ts / src/chat.ts / src/tools.ts / src/project-registry.ts / src/app.ts / scripts/inspect-cost.mjs |
| 2026-09-04 | 异步 Async | ✅ P2 落地：`/chat/stream` 执行与推送解耦——后台消费者驱动 chatStream（任务级 AbortController），事件入缓冲，SSE 只做转发订阅者（断开不停执行）；断线闭环=任务收束自动落「后台任务结果」会话（task-<sessionId>，前端不在线数据不丢）；并发保护=进行中重连只回放+task_running；新增 `/chat/cancel`（显式取消）+ `/chat/task/status`（状态查询）+ shared 契约加 task_running 事件；缓冲 5min GC + lastTasks 上限 100。验证实例 8/8：断线后台完成落库配对 / 进行中重连回放 / cancel 收束 running=null | src/app.ts / packages/shared/src/index.ts |
| 2026-09-04 | 版本+可观测 | ✅ P3 落地（八维度收官）：①版本——`trace.ts getRelease()`（RELEASE env > git 短 sha，进程内缓存），run span meta 落 release（实测 b6b0dd7）+ eval 基线顶层加 release 字段（回归按版本对比）；②可观测——`GET /trace/runs`（最近 N run 摘要+统计 avgRounds/tokens，实测 stats 正确）+ `GET /trace/run/:runId`（span 树，非本人 404 不泄漏存在性），ownerKey 隔离口径与 cost/audit 一致。验证：真实 run release 落盘 + 端点 own 200/unknown 404/anon 401 + 基线 release 字段 | src/trace.ts / src/app.ts / scripts/eval-trace-gate.mjs |
| 2026-09-04 | 全链路多点回归 | ✅ 新增可复用回归工具 `chain-multirun.mjs`（battery/chit/kb/read/write/async 六 suite）+ `chain-report.mjs`（聚合分析），证据落 `.data/multirun/`；**2026-09-04 首轮多点实测 24/26（92.3%）**：正确性链路全绿（battery 9/9、chit 3/3、kb 1/1 命中考勤制度、write 4/4 双确认点全拒+审计 denied、async 6/6 断线落库配对、read 数据正确性 3/3 含逐页校验与 G6 全中）；唯二红=读链路效率 G1/G4（2/3 次 rounds 10-12、tokens 114k-146k）——trace 定性为上游免费链**空响应轮**（tok=0、无工具调用、10-35s/轮，每轮后模型自愈继续，数据终局正确）非客户端缺陷；改善建议见 §5 | scripts/chain-multirun.mjs / scripts/chain-report.mjs |

---

## 5. 多点回归发现的改善项（按 ROI 排序）

1. **空响应轮即时重试**（低成本高收益）：read#3 实测 4 个空响应轮（llm 返回空内容、tok=0、无工具调用，10-35s/轮）。现靠条件边重跑 understand 自愈（数据终局正确），但每轮浪费 1 轮次 + ~30s。建议 `callAgentSafe` 把「空结果（无 text 且无 toolCalls）」纳入瞬时重试（与 429 同路，退避后重发一次），预计可消掉大部分空轮。
2. **G4 预算自适应**：60k 阈值按「≤8 轮健康轮次」标定；实际成本大头是 prompt 随轮次线性累积（每轮 11-24k，completion 仅 1-2k）。可改为 `maxTotalTokens ≈ base + perRound × rounds` 或直接以 `EVAL_MAX_TOKENS` 按场景注入（闸门已支持）。
3. **多模型降级信号**：劣化窗口（空响应轮/短路）有明确 span 签名（tok=0 / rounds=1&tokens=0）。可让 `/trace/runs` 统计输出 `emptyRoundRate`，超阈值时提示切换 EVAL_MODEL 到备选（zenhy3/nemotronfree），把「人发现劣化」变成「数据提醒劣化」。
4. **前端可视化**：`/trace/runs` 端点已就绪，接一个只读页面即可看到轮次/成本/版本分布。
