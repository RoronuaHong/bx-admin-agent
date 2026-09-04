# 生产就绪评估（Production Readiness）

> **评估日期**：2026-09-03  
> **驱动**：用户指出「能 Demo 和能上线的差别 = 身份、异步、追踪、评测、成本、安全、版本」。  
> 本文档评估 bx-admin-agent 在这 8 个维度上的现状，记录缺口，并给出优先级。  
> 落地进度随时更新；评测闸门（P0）已开工，详见 §4。

---

## 1. 八维度现状总览

| 维度 | 现状 | 评级 | 一句话缺口 |
|---|---|---|---|
| **身份 Identity** | `app.ts` 有 cookie session + `requireOwner`（会话级 401 拦截）；模型侧 `x-api-key` 是上游凭证 | 🟡 雏形 | 无调用方/租户/用户态溯源，无 ACL |
| **异步 Async** | SSE 流式同步返回（`/chat/stream`） | 🔴 缺失 | 无后台任务/长作业/断线续跑/进度查询 |
| **追踪 Tracing** | **2026-09-03 已建**：`trace.ts` + `inspect-trace.mjs`，runId 贯穿 + span 树 + token usage | ✅ 已补 | 仅 JSONL 落盘，无 Web 可视化/告警 |
| **评测 Eval** | `eval-full-chain.mjs` 等脚本能跑全链路 PASS/FAIL + `process.exit(1)` | 🟡 雏形 | 未落库基线、未接 CI、断言维度浅（无 traces 复用） |
| **成本 Cost** | **2026-09-04 P1 已落地**：`cost.ts` 聚合（日/模型/会话/慢调用）+ `inspect-cost.mjs` CLI + `GET /cost/summary` 只读端点 + 预算告警 | ✅ 已补 | 单价未配（只计 token）；告警未接通知渠道 |
| **安全 Security** | **2026-09-04 P1 已落地**：`audit.ts` 审计落库（越权拒绝/写确认三态）+ `/audit/list` 端点 + `inspect-audit.mjs` CLI | 🟡→✅ 核心 | 限流、Prompt 注入防护仍缺 |
| **版本 Version** | git 提交即版本 | 🟡 雏形 | 模型/提示词/工具无版本化与回滚机制 |
| **可观测 Observ** | `trace.ts` span 树 + `console.log` 散点 | 🟡 部分 | 无结构化日志聚合、无 metrics |

---

## 2. 维度详情

### 2.1 身份 Identity 🟡
- 已有：`app.ts` 的 `getSession(getCookie(c, COOKIE))` 会话校验；`/chat/conversations` 等接口走 `requireOwner`。
- 缺口：
  - 调用方溯源：谁（哪个前端/服务/用户）发的请求，无 `x-request-id` / `caller` 落库。
  - 租户隔离：多项目（bx-film-admin 等）仅 `set_project` 切换，无 `allowedProjects` ACL。
  - 权限分层：无角色/权限模型，越权防护靠 M1 worker 白名单（运行期），非数据期 ACL。

### 2.2 异步 Async 🔴
- 当前：`/chat/stream` 同步流式，单次请求生命周期内完成。
- 缺口：长耗时作业（如大批量导出、多页聚合、跨项目扫描）无法后台化；断线后无法续跑；无任务状态查询接口。

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

### 2.7 版本 Version 🟡
- 已有：git 提交即代码版本。
- 缺口：模型/提示词/工具 schema 无独立版本号；线上回滚只能 git revert，无法「只回退提示词不回退代码」。

### 2.8 可观测 Observability 🟡
- 已有：trace span 树 + `console.log` 散点。
- 缺口：无 metrics（QPS/时延分位/错误率）；无结构化日志聚合；多实例下 trace 文件需集中。

---

## 3. 优先级与 roi

| 优先级 | 维度 | 动作 | 理由 |
|---|---|---|---|
| **P0** | 评测 Eval | ✅ 完整落地：通用 `eval-core` + `eval-trace-gate` + 分层入口（`pnpm eval`/`eval:full`/`eval:trace-gate`）+ CI 闸门 `.github/workflows/eval.yml` | 复用 traces，把 demo 验证变成可重复回归；最便宜的「上线」杠杆 |
| **P1** | 安全审计 | ✅ 已落地：`audit.ts` 三类事件（越权拒绝/写确认请求/确认结论三态）append-only 落库 + `/audit/list`（ownerKey 隔离）+ `inspect-audit.mjs` | 上线必备合规；runId 关联 trace 可反查上下文 |
| **P1** | 成本 Cost | ✅ 已落地：`cost.ts` 聚合 + `inspect-cost.mjs` CLI + `GET /cost/summary` 端点 + 预算告警（env 阈值） | traces 已采集，只差聚合 |
| **P2** | 身份 Identity | 调用方溯源 + 多项目 ACL | 多租户上线前必需 |
| **P2** | 异步 Async | 后台任务框架 | 长作业场景；非阻塞核心路径 |
| **P3** | 版本 Version | 提示词/工具版本化与回滚 | 降低线上试错成本 |
| **P3** | 可观测 | Web trace 可视化 + metrics | 体验增强 |

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
