# 投放渠道 ROI 异常监控：需求对照（2026-09-14）

对照来源：陈鸿梳理的 Demo Agent 场景（投放渠道 ROI 异常监控）。  
核对对象：当前仓库实现（问数 `analyticsAsk` + M3 巡检 `watch-users`），不是旧草案「已规划即已完成」。  
模型探测：DeepSeek-V4-Flash（`dsflash` / `deepseek-v4-flash-202605`）当日可用（约 1.3s，HTTP 200）。

**总评：投放 ROI 监控 Demo 没有做完。** 已落地的是「渠道日活巡检」骨架。指标、渠道口径、漏斗、自动下钻都对不上这份需求。M3 验收写明默认指标是 `channel_daily_users`，真·ROI 公式不在范围内。

权威口径见：

- `docs/analytics/m3-acceptance.md`
- `docs/superpowers/specs/2026-09-09-metabase-analytics-agent-design.md` §9
- `apps/agent-server/config/analytics/rules/watch-users.ruleset.json`

---

## 一、数据需求（每日粒度）

| 点 | 结果 | 现状 |
|---|---|---|
| 日期（日粒度） | **部分完成** | 问数和巡检都能按自然日切（业务时区 `Asia/Shanghai`，巡检默认 T-1）。没有「投放 ROI 日表」。 |
| 渠道：fb / tt / gg / apple-ads / 自然流 / 裂变拉新 / 其它（默认汇总） | **未完成** | 现渠道是产品包码（`IndiaA`、`FoxA`、`GoGo`…），没有这套投放媒体映射，也没有「其它」汇总桶。 |
| 语言：印度语 / 英语 / 泰米尔语 / 泰卢固语 / 玛拉雅拉姆语（可下钻） | **未完成（仅有相近字段）** | 观影表有 `contentLang`（如 `ta-IN` / `te-IN` / `ml-IN` / 空）。没有绑到 ROI 巡检，也没有「印度语/英语」这套业务别名下钻。 |
| 包体：默认汇总、支持下钻 | **未完成** | 规则里预留了 `dimensions.drilldown`，默认 ruleset 没配包体。没有包体维的取数和汇总。 |
| 曝光量 | **未完成** | 语义层 / 巡检 / 编译指标里都没有曝光。 |
| 点击量 | **未完成** | 目录里有印度广告点击流水表（`ad_india_click_*`），没有接到漏斗或巡检。 |
| 播放量 | **未完成** | 有观影/播放相关表，不是投放漏斗里的「播放量」。 |
| 支付人数 | **未完成（表在、口径不在）** | 订单表能编「订单数 / 人数」，没有「投放渠道 → 支付人数」链路。 |
| 支付金额 | **未完成（同上）** | 订单金额能编，没有和投放消耗对齐的金额口径。 |
| CTR | **未完成** | 无公式、无预聚合、无巡检指标。 |
| CVR | **未完成** | 同上。 |
| ROI | **未完成** | 全仓巡检只跑 `uniq(guid)` 渠道日活。文档写明 ROI 待业务对齐后再换 ruleset。 |

---

## 二、监控逻辑

| 点 | 结果 | 现状 |
|---|---|---|
| 每日自动算各渠道 ROI | **未完成** | 有异步巡检 API、页面可手工点「运行巡检」、钉钉可推。`ANALYTICS_SCAN_WORKER=1` 已开。仓库里没有每日 cron，不会无人值守跑。算的也不是 ROI。 |
| 对比昨日 + 上周同期 | **框架完成，指标不对** | `dod`（T-2）+ `wow`（T-8）已实现，任一破线可告警（`baselineLogic=any`）。对比的是观看人数，不是 ROI。需求里的「同比」按上下文应理解为上周同期（wow），不是自然年同比。 |
| 某渠道下降超过 10% 就预警 | **框架完成，指标不对** | `thresholdRatio=0.9`（降幅 >10%）已实现，可钉钉 + 深链。预警文案是渠道日活，不是 ROI。 |
| 预警后自动按语言 / 包体下钻，定位细分群体 | **未完成** | 告警 runbook 只写了一句「请按语言/包体下钻」。runner 不会自动再查语言或包体。`maxChildAlerts` 配了，没有子查询。 |

---

## 三、和这份 Demo 的关系

已经能复用的只有：日窗、环比/周比、降幅 10%、freshness、钉钉、页面手工巡检。

还缺、而且是业务前提的是：

1. 投放侧日表（或接口）：渠道（fb / tt / …）× 语言 × 包体 × 曝光 / 点击 / 播放 / 支付 / 消耗
2. 书面口径：ROI = ?（支付金额 / 消耗？），CVR 分母是点击还是曝光
3. 新 ruleset + 取数，替换现在的 `channel_daily_users`
4. 预警后的自动下钻
5. 外部每日调度

这些和「数据获取难度大可以约时间讨论」是对上的：数据层还没对齐，Agent 侧无法假装 ROI 已经能监控。

---

## 四、实现锚点（便于复核）

| 能力 | 位置 |
|---|---|
| 默认巡检规则 | `apps/agent-server/config/analytics/rules/watch-users.ruleset.json` |
| 日活取数（非 ROI） | `apps/agent-server/src/analytics/scan/metrics.ts` → `fetchChannelDailyUsers` |
| 阈值（ratio &lt; 0.9） | `apps/agent-server/src/analytics/scan/threshold.ts` |
| 巡检编排 | `apps/agent-server/src/analytics/scan/runner.ts` |
| 告警文案 / 深链 / runbook | `apps/agent-server/src/analytics/scan/notify.ts` |
| M3 验收（明确排除真 ROI） | `docs/analytics/m3-acceptance.md` |
