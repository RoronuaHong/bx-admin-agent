# Metabase 数据分析 Agent — M3 巡检预警实现计划

> **给实现 Agent：** 按任务逐步落地。推荐 `subagent-driven-development`。步骤用 `- [x]` 跟踪（Task 1–8 已完成）。  
> **规格：** `docs/superpowers/specs/2026-09-09-metabase-analytics-agent-design.md` §9 / §12 M3。  
> **前置：** M1 对话取数已落地；钉钉 `kind=analytics` 通道已验收。

**目标：** 交付异步巡检 `POST /internal/analytics/scan` + job 查询 + freshness→skipped + 相对/绝对阈值 + dryRun + 钉钉 analytics 告警（含 rerunSeq dedup）+ 默认单 scan worker + 应用内可看 job/告警（登录）与 internal token 鉴权分流 + 深链/runbook。

**书面接受的默认口径（§13 未填齐前，禁止假装 ROI 已定）：**

| 项 | M3 默认 | 说明 |
|----|---------|------|
| 指标 | `channel_daily_users` = `uniq(guid)` 按 `channel` 日汇总 | **不是 ROI**；ROI 待业务对齐后换 pack/rule |
| `minAbsDelta` | `0` | 书面接受；相对破线即可能 warn |
| `minSample` | `100` | 低于则 info/安静 |
| `threshold` | 相对下降 >10%（ratio &lt; 0.9） | dod/wow 任一破线（`baselineLogic=any`） |
| `criticalEntityCount` | `3` | |
| `businessTimezone` | `Asia/Shanghai` | |
| `jobTimeout` | `10min` | |
| `maxChildAlerts` | `5` | |
| Job 存储 | 进程内 Map（可后续换 Mongo） | V1 可验收；多实例不共享 |
| 多实例 | 仅 `ANALYTICS_SCAN_WORKER=1` 执行 | |

**不在范围：** M2 GATE CI；临时 card；共享 Redis dedup；连续 N 天 critical；真·ROI 公式。

---

## 文件清单

| 路径 | 职责 |
|------|------|
| `config/analytics/rules/watch-users.ruleset.json` | 默认规则集 |
| `src/analytics/scan/types.ts` | Job / Alert / RuleSet 类型 |
| `src/analytics/scan/ruleset.ts` | 加载规则 |
| `src/analytics/scan/window.ts` | T-1/T-2/T-8 按 businessTimezone |
| `src/analytics/scan/freshness.ts` | 数据就绪检查 |
| `src/analytics/scan/metrics.ts` | 取数 SQL（经 Metabase，复用 client） |
| `src/analytics/scan/threshold.ts` | 安静条件 + 阈值 + 父/子告警 |
| `src/analytics/scan/job-store.ts` | 内存 job 状态机 |
| `src/analytics/scan/runner.ts` | 编排：freshness → 取数 → 阈值 → 通知 |
| `src/analytics/scan/notify.ts` | fingerprint + `notifyAlerts({kind:'analytics'})` |
| `src/app.ts` | internal scan API + 登录态 job/告警只读 |
| `apps/web/...` | 巡检按钮 + job 列表（薄 UI） |
| `scripts/analytics-scan-*.test.ts` | 单测 |
| `scripts/analytics-m3-smoke.mjs` | dryRun + 实推（可关）冒烟 |

---

### Task 1：类型 + 规则集加载 + 时间窗 — [x]

- [x] 新建 `watch-users.ruleset.json`（字段对齐 §9.3）
- [x] `resolveScanWindow(scanDate | clock, tz)` → `{ scanDate, dodDate, wowDate, echo }`
- [x] 单测：固定 clock `2026-09-09` → scanDate=T-1=`2026-09-08`，dod=`2026-09-07`，wow=`2026-09-01`
- Commit：`feat(analytics): M3 ruleset loader and T-1 scan window`

### Task 2：Job 状态机（内存） — [x]

状态：`queued → running → succeeded|partial|failed|cancelled|skipped`  
- [x] 同 `scanDate+ruleSetId` 已有 `running` → 拒绝 `scan_job_running`（除非 `forceRerun`）  
- [x] `forceRerun` → `rerunSeq++`  
- [x] `jobTimeout` 标记 failed + 运维向消息（kind=analytics 文案标明「巡检未跑成」）  
- Commit：`feat(analytics): in-memory scan job state machine`

### Task 3：Freshness + 指标取数 — [x]

- [x] Freshness SQL：`SELECT max(toDate(lastWatchTime)) AS d FROM elt_watch_detail`（表白名单）  
- [x] 未就绪 → job=`skipped` / `data_not_ready`，**不**跑阈值、**不**发业务 warn  
- [x] 指标：按 channel 取 scanDate / dodDate / wowDate 三日 `uniq(guid)`（三条 SQL 或一次 GROUP BY 日）  
- [x] 复用 `runNativeDataset` + sql-guard  
- Commit：`feat(analytics): scan freshness check and channel users fetch`

### Task 4：阈值 + 安静条件 + 父告警聚合 — [x]

- [x] empty / 基线缺失 / sample&lt;minSample / |Δ|&lt;minAbsDelta → 不发 warn  
- [x] ratio&lt;0.9 且过绝对门槛 → warn；破线实体数≥criticalEntityCount → critical  
- [x] 父告警 + ≤maxChildAlerts 子摘要  
- [x] 单测纯函数，零网络  
- Commit：`feat(analytics): scan threshold and quiet rules`

### Task 5：Notify（rerunSeq fingerprint） — [x]

- [x] fingerprint = `ruleSetId|scanDate|metric|entityKey|baseline|severity|rerunSeq`  
- [x] dryRun → **不**调用 `notifyAlerts`  
- [x] 深链：`/analytics?q=...&from=&to=` + 一句话 runbook  
- Commit：`feat(analytics): analytics scan notify with rerunSeq dedup`

### Task 6：Runner 编排 + Internal API — [x]

- [x] `POST /internal/analytics/scan`：`Authorization: Bearer ${SCAN_INTERNAL_TOKEN}`；校验 `ANALYTICS_SCAN_WORKER=1`（否则 403）  
- [x] 立即返回 `{ jobId }`；后台跑 runner  
- [x] `GET /internal/analytics/scan/:jobId` 同 token  
- [x] Body：`ruleSetId`、`scanDate?`、`forceRerun?`、`dryRun?`  
- Commit：`feat(analytics): async /internal/analytics/scan API`

### Task 7：登录态只读 + Web 薄 UI — [x]

- [x] `GET /analytics/scan/jobs`、`GET /analytics/scan/jobs/:id`（session + 权限，对齐 analytics 入口）  
- [x] `/analytics` 页增加「运行巡检」按钮（调内部需经 BFF：服务端用 token 转发，或仅运维 curl；**推荐**登录用户调 `POST /analytics/scan/run`，服务端校验权限后若本机是 scan worker 则入队）  
- [x] 列表展示 status / alerts 摘要  
- Commit：`feat(web): analytics scan job UI and logged-in job APIs`

### Task 8：单测 + 冒烟 + 文档 — [x]

- [x] `test:analytics` 追加 scan 单测  
- [x] `analytics-m3-smoke.mjs`：dryRun 一次；可选 `M3_SMOKE_NOTIFY=1` 实推  
- [x] `docs/analytics/m3-acceptance.md` 中文验收清单  
- [x] `.env.example`：`SCAN_INTERNAL_TOKEN`、`ANALYTICS_SCAN_WORKER`  
- Commit：`test(analytics): M3 scan smoke and acceptance notes`

---

## 规格覆盖自检

| M3 验收项 | Task |
|-----------|------|
| 异步 scan API | 6 |
| freshness→skipped | 3 |
| businessTimezone / T-1 | 1 |
| partial/timeout/skipped | 2–3 |
| 相对+绝对阈值 | 4 |
| dryRun | 5–6 |
| 钉钉 analytics + rerunSeq | 5（通道已有） |
| 单 scan worker | 6 |
| 鉴权分流 | 6–7 |
| 深链+runbook | 5–7 |

---

## 执行方式

1. **子 Agent 驱动（推荐）** — 每任务一子 Agent  
2. **本会话内联** — 连续实现  

**默认采用 1。** 若无异议，下一消息起派发 Task 1。
