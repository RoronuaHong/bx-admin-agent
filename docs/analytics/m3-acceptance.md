# Analytics M3 验收清单

计划：[2026-09-09-metabase-analytics-agent-m3.md](../superpowers/plans/2026-09-09-metabase-analytics-agent-m3.md)  
规格：设计定稿 §9 / §12 M3

## 默认口径（书面接受）

| 项 | 值 |
|----|-----|
| 指标 | `channel_daily_users` = `uniq(guid)` 按 `channel` 日汇总（**不是 ROI**） |
| `minAbsDelta` | `0` |
| `minSample` | `100` |
| 相对阈值 | ratio &lt; 0.9（下降 &gt;10%）；`baselineLogic=any` |
| `criticalEntityCount` | `3` |
| `businessTimezone` | `Asia/Shanghai` |
| Job 存储 | 进程内 Map（多实例不共享） |
| 多实例 | 仅 `ANALYTICS_SCAN_WORKER=1` 执行 |

## 功能验收

- [x] 异步 `POST /internal/analytics/scan` 立即返回 `{ jobId }`，后台跑 runner（Bearer `SCAN_INTERNAL_TOKEN`）
- [x] `GET /internal/analytics/scan/:jobId` 同 token 可查状态
- [x] 非 scan worker（`ANALYTICS_SCAN_WORKER≠1`）返回 403
- [x] freshness 未就绪 → job=`skipped` / `data_not_ready`，不跑阈值、不发业务 warn（`freshness.ts` + runner）
- [x] `businessTimezone` 下 T-1 / dod / wow 时间窗正确（单测：`2026-09-09` → scan=`2026-09-08`）
- [x] Job 状态机含 `queued→running→succeeded|partial|failed|cancelled|skipped`；同日同规则 running 拒绝（除非 `forceRerun`）
- [x] 相对 + 绝对阈值 + 安静条件（empty / 基线缺失 / sample&lt;minSample / \|Δ\|&lt;minAbsDelta）
- [x] `dryRun=true` 不调用钉钉 `notifyAlerts`（notify 单测 + smoke dryRun）
- [x] `dryRun=false` 走钉钉 `kind=analytics`；fingerprint 含 `rerunSeq` dedup（notify 单测；实推可选 `M3_SMOKE_NOTIFY=1`）
- [x] 默认单 scan worker；应用内 `/analytics/scan/*` 与 internal Bearer **鉴权分流**（应用内暂不强制运营 session，见计划）
- [x] 告警深链 `/analytics?q=...&from=&to=` + 一句话 runbook
- [x] `/analytics` 页可触发巡检并看到 job / 告警摘要（`AnalyticsAgentPage` 巡检对话框）

## 自动化

- [x] `pnpm --filter @bx/agent-server test:analytics` 含 scan 单测（window / job-store / threshold / freshness-metrics / notify / runner-unit）— 2026-09-10 全绿
- [x] `.\node_modules\.bin\tsx.cmd scripts\analytics-m3-smoke.mjs`：dryRun 入队并到终态 — 2026-09-10 `succeeded`（~36s）
- [x] 可选：`M3_SMOKE_NOTIFY=1` 实推钉钉一次 — 2026-09-10 `succeeded`（dryRun + notify）

## 环境变量（`.env.example`）

- `SCAN_INTERNAL_TOKEN` — internal scan API Bearer
- `ANALYTICS_SCAN_WORKER=1` — 本实例接受入队并执行

## 不在范围（勿当验收缺口）

M2 GATE CI；临时 card；共享 Redis dedup；连续 N 天 critical；真·ROI 公式。
