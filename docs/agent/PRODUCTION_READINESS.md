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
| **成本 Cost** | `trace.ts` 已捕获 token usage（prompt/completion/total）进 span | 🟡 采集 | 未做按用户/会话核算、无预算告警 |
| **安全 Security** | 写操作 `confirmation_required` 双确认 + M1 执行层越权拒绝 | 🟡 雏形 | 无审计日志落库、无限流、无注入防护闭环 |
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

### 2.4 评测 Eval 🟡 → P0 升级中
- 已有脚本：`eval-full-chain.mjs`（模块/操作识别 + call_api 路径 + orchestrate 链式）、`eval-intent-routing.mjs`、`eval-understand-then-rules.mjs`、`test-regression.mjs`。
- 已有能力：单测断言 + 汇总 PASS/FAIL% + `process.exit(1)`。
- 缺口（本次重点）：
  - **未落库基线**：每次跑完无基线比对，回归靠人眼。
  - **未接 CI**：无提交/合并闸门。
  - **断言维度浅**：只到「模块/操作识别正确」，未复用 traces 断言「轮次不爆炸 / 越权被正确拒绝 / token 成本不超阈值 / 无伪调用」。

### 2.5 成本 Cost 🟡
- 采集：`trace.ts` 的 `llm` span 已捕获 `usage`（promptTokens/completionTokens/totalTokens）。
- 缺口：未聚合到用户/会话/日维度；无预算告警；多 key 轮转（NVIDIA_API_KEYS）无按 key 成本分摊。

### 2.6 安全 Security 🟡
- 已有：写操作 `confirmation_required` 双确认（tool 节点 + 服务端兜底）；M1 执行层越权拒绝（`✗reject worker whitelist violation` 进 trace）。
- 缺口：越权/写操作事件只进 trace，无独立**审计日志落库**；无速率限制（防滥用/刷 token）；无 Prompt 注入防护闭环（用户输入直接进模型）。

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
| **P0** | 评测 Eval | ✅ 已落地：`eval-trace-gate.mjs`（真实 chat + trace 红线断言 + 基线落库） | 复用刚建的 traces，把 demo 验证变成可重复回归；最便宜的「上线」杠杆 |
| **P1** | 安全审计 | 越权/写操作事件落审计库（复用 trace 落盘通道） | 上线必备合规；当前只进 trace 不进审计 |
| **P1** | 成本 Cost | token 按会话/日聚合 + 超阈值告警 | traces 已采集，只差聚合 |
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
