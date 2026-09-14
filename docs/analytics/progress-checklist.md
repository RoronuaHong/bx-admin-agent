# 问数 Agent 进度对照（复核，2026-09-14）

对照对象是仓库实现，不是「计划即完成」。ROI 投放监控另见 [roi-channel-monitor-status.md](./roi-channel-monitor-status.md)。

| 你的目标 | 状态 | 复核结论 |
|---|---|---|
| 训练它（配置 / skill 而非微调） | **✅ 思路已落，未完全干净** | 用 prompt + pack / ruleset / eval 替代微调；`AGENT_CHARTER` 禁止写死业务词。规格在 `docs/superpowers/specs/2026-09-09-metabase-analytics-agent-design.md`、`2026-09-13-analytics-hybrid-sql-agent-design.md`。analytics TS 里仍有残留中文业务词正则，未完全清干净。 |
| 对接 Metabase 数据库权限 | **✅ 已落地** | `src/analytics/metabase-client.ts`；db **2** 主库。口径是 **71 / 67 / 4**（总表 / 可答 / 隐藏）。隐藏规则：`metabase_upload` / `upload_*` / `*_tmp` / `*_dict`。`scripts/enumerate-metabase-tables.mjs` 打印同一口径，不再写 `coverage: 1 / N`。 |
| 给它写 skill | **🔵 半完成** | `apps/agent-server/skills/` 有约 10 个 SKILL（PC 后台与通用混杂）。**没有** analytics 专用 `SKILL.md`；问数规则在 pipeline 提示词 + `config/analytics/`。 |
| 整理数据 + 初步分析 | **✅ 核心已落** | `analyticsAsk`：NL → 护栏 → 目录 → 时间 → **schema linking（不是锁单表）** → Path A/B/C → 守卫 → 取数 → 对表 → 解读。问数页表格支持 **CSV** 导出；聊天侧才有 `export_dataset` xlsx。 |
| 人工校验 | **✅ 代码已落，门禁未全绿当验收** | `analytics-eval-harness.mjs` + soft-EX 1.5%。EX / CWR / RefuseRecall / RefusePrecision 有分母约定：71/67/4 **不是** GATE EX 分母；Path C `llm_sql` **不计 EX**。refuse-only 可 100%；全量 EX 不保证绿。 |
| 接入钉钉群 | **🔴 代码在，群未接** | `alert-notify.ts` `kind=analytics`，读 `ALERT_DINGTALK_WEBHOOK`。Webhook 未配则静默 no-op。建群 / 机器人是群外事项，仓库做不了。 |
| 定时日报推送 | **🔵 日活日报已接，不是 ROI** | `ANALYTICS_SCAN_WORKER=1` + `ANALYTICS_SCAN_CRON=1` 时，进程内每日一次入队 `watch-users`（`digest: true`，默认 10:00 `Asia/Shanghai`，T-1）。文案标题写明 **渠道日活（非 ROI）**。无 webhook 则只跑任务不推送。 |
| 不定时告警（异常监控） | **🔵 半完成（日活，非 ROI）** | `thresholdRatio=0.9` + 钉钉 + 深链。指标是 `channel_daily_users`，**不是 ROI**。没有自动按语言 / 包体下钻（runbook 只提示）。 |

## 本轮可修 vs 不能装的

已修：巡检日报 cron、enumerate 口径、对照文档。

不能装成「已完成」的：真·ROI（仓里没有消耗 / 曝光日表）、钉钉群本身、analytics 专用 SKILL.md（未要求不另开大改）、自动语言/包体下钻。
