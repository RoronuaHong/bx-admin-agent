# Analytics M2 验收清单

> **状态：已验收（2026-09-10）** — 主路径与拒答 `GATE_*` / CI 已落地。  
> **显式后置：** 可答 seed 暂为 `provisional`（GATE_EX=n/a，待人工晋升 `gold`）；真实 Metabase card id 绑定。

计划：[2026-09-09-metabase-analytics-agent-m2.md](../superpowers/plans/2026-09-09-metabase-analytics-agent-m2.md)  
规格：设计定稿 §8 / §12 M2

## 功能验收

- [x] 执行后 LLM 校对输出契约：`pass | fail | unclear` + 原因码；结构护栏已过后 `unclear` 先二次强制 pass|fail，仍不清则默认 soft-pass（`ANALYTICS_LLM_VERIFY_STRICT=1` 可拒）
- [x] 校对短路：empty 跳过；`ANALYTICS_LLM_VERIFY=0` 可关
- [x] 校对短路：`questionBinding` 未改写跳过（`question-binding.ts` + pack `questionBindings`；`metabase_run_question` 已实现）
- [x] 自纠错 ≤2 轮；含 lint/empty/`verify_fail`/`dim_mismatch` 结构化回喂；耗尽拒答
- [x] 维对账：点名维缺失明示并拒答/重写（`dim-reconcile.ts`；护栏用用户 NL + `pack.probeDimensions`）
- [x] 来源条字段：`packVersion` + `modelId`（结果 JSON；UI 回显）
- [x] 审计薄账本字段齐全（问句/SQL/护栏/校对/rewrite/失败分类/version/modelId/耗时；`.data/analytics/ledger`）
- [x] UI「有用/有误」→ 候选池；人工 `confirmed` 仍不自动进 gold（`audit-ledger.ts` + `/analytics/feedback*`）
- [x] 双轨图：有结果无 Metabase viz 时本地表→ECharts（`local-chart.ts` + `ResultChart`）；默认不建临时 card

> **已知缺口（实例验证 2026-09-10）：**  
> 1. 真实 Metabase card id 绑定需运维填 `questionId`（当前 pack 用 `sqlTemplate` 演示短路）。  
> 2. 全量 EX 仍需本机 Metabase+LLM（CI 只跑拒答 GATE + 单测）。  
> 3. 种子 `2026-09-10.4`：拒答 gold 8 + 可答 **provisional 20**（GATE EX 待人工晋升 gold）。  

## 门禁验收

- [x] harness 含可答题 + 拒答题 + `multi_query`；支持 soft-EX；**GATE EX 仅计 `reviewStatus=gold`**（provisional 只进 smoke）
- [x] `GATE_EX_MIN` ≥ 85%（env 可配；`evaluateGates`；无 gold 可答题时 EX=n/a）
- [x] `GATE_REFUSE_RECALL_MIN` ≥ 95%
- [x] `GATE_REFUSE_PRECISION_MIN` ≥ 80%
- [x] `GATE_CWR_MAX` ≤ 10%
- [x] `GATE_EX_REGRESSION_MAX_PP` ≤ 3 pp（相对 `baseline.json`；首次可空）
- [x] CI / `test:analytics-gate` 失败 exit≠0（`--refuse-only` 无 Metabase 可跑拒答门禁；`.github/workflows/eval.yml` 含 analytics-gate job）

## 自动化

- [x] `pnpm --filter @bx/agent-server test:analytics` 含 `analytics-eval-score` / local-chart / audit-ledger 单测
- [x] `tsx scripts/analytics-eval-harness.mjs` 可跑并打印门禁表（`--refuse-only` / `--full`）— 2026-09-10 full+glm5turbo：provisional smoke **20/20**（修 channel-pair multi_query + soft-EX 列别名后）；GATE 仍只计 gold 拒答（EX=n/a）

> Task 1–7 主路径已落地；`questionBinding` 校对短路已通。  
> **评测分层**：可答 20 条现为 `provisional`（脚手架）；晋升 `reviewStatus=gold` 须人工确认。拒答 8 条为结构性产品规则，标 `gold`。  
> 全量 EX：本机 `pnpm eval:analytics -- --full --model glm5turbo`；有 gold 可答题且过门后可 `ANALYTICS_EVAL_WRITE_BASELINE=1`。

## 不在范围

Best-of-N；换模校对；巡检开 LLM 校对；无人审反馈进 gold；手维同义词/指标公式表。
