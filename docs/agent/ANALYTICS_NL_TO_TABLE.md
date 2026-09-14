# 自然语言 → 正确结果表

> **范围**：只比「一句话进 → 一张列和行都对的结果表出」。不比登录身份、Metabase 卡片 API、评测看板、多轮偏好。  
> **对照**：Cortex Analyst / Looker Conversational Analytics / Cube / dbt Semantic Layer + 本仓 `analyticsAsk`（`pipeline.ts`）。  
> **规格**：[`../superpowers/specs/2026-09-13-analytics-hybrid-sql-agent-design.md`](../superpowers/specs/2026-09-13-analytics-hybrid-sql-agent-design.md)  
> **核对日期**：2026-09-14（进 LLM 前组包与时间分工见 `ANALYTICS_INPUT_TO_LLM.md`；覆盖率 GATE 与扩表名单已对齐代码；NL→表步骤仍以实现为准）

**正确表**：对的表、对的日期、对的指标公式、点过的过滤还在。能跑但换了分母、丢了渠道、少了最后一天，都不算。

```
NL → 护栏 → 目录 → 组包(时钟+已算日期进 facts) → LLM 抽槽 → 代码覆盖日期 → 检索表 → 锁口径 → 路由 A/B/C → 出 SQL → 守卫 → 取值 → 对表 → 行
```

进 LLM 之前（清洗 / 记忆 / 检索 / 组包 / **时间语义 vs 日期算术**）见 [`ANALYTICS_INPUT_TO_LLM.md`](./ANALYTICS_INPUT_TO_LLM.md)。

---

## 0. 核对结论

| 步 | 做什么 | 判定 | 代码锚点 |
|---|---|---|---|
| 1 | 原文进管线，禁止改写 | 对齐 | `pipeline.ts` → `guardAnalyticsInput` |
| 2 | 先定能查哪些表 | 对齐 | `refreshPackFromCatalog`；隐藏表 `blocked_table` refuse |
| 3 | 时间：LLM 读懂相对说法，代码算 YYYY-MM-DD | 对齐 | facts 注入 `today_date`；`resolveAskTimeRange` 能钉则写入 `resolved_time_range`（模型必须用）；钉不死不提前退出；`applyResolvedTime` 覆盖模型心算 |
| 4 | 检索表（不要求用户锁表） | 对齐 | `resolveAskTable` 卡片检索；Path C `get_table_schema` 按需拉列 |
| 5 | 锁对口径（指标 + 形状） | 对齐 | metric family 闸；观看宽表 / 付费 / 留存已编译；缺渠道或版本在 structure 后 grounding clarify |
| 6 | 谁写 SQL（互斥） | 对齐 | 金样进 facts；`routeAnalyticsAsk` 组包前算出路径；Path C 执行在 structure 之后 |
| 7 | 出 SQL | 对齐 | A `sql-compile` / B `bindVerifiedQuery` / C `runSqlAgent` |
| 8 | 跑之前挡住错 SQL | 部分 | AST + `requireWhere` + 三对 relationship；图外多表不出表（V1 有意） |
| 9 | 取值；失败按路径处理 | 对齐 | A/B 失败不换口径；C 最多 3 次 |
| 10 | 问过的条件必须还在 | 对齐 | A 全套闸；C：点名过滤 + 超纲拒 + 渠道接地 + 点名实体；B 靠金样 |

**三条出路**

| 路径 | `sqlSource` | 何时出表 |
|---|---|---|
| A 编译 | `intent_compile` | overlay / 单表四则 / 观看宽表 / 付费率 / 次日留存 |
| B 金样 | `verified_query` | A 还编不出的新形状（当前 6 条均已 promote） |
| C 写 SQL | `llm_sql` | 未建模探索；水印「未核验口径」；不进 GATE EX 分母 |

---

## 1. 逐步对照（已按代码核对）

### 1. 原文进管线，禁止改写

业界：用户句子不可信，不让模型改日期、改指标词。

本仓：`guardAnalyticsInput` 只清洗危险片段，`nlSafe` / `lastUserText` 进后续步骤。附件无法识别则 clarify，不编造问句。

### 2. 先定能查哪些表

业界：只给已发布 / 有文档的表；点到 tmp、upload、字典表直接拒。

本仓：活目录 **72 / 67 / 5**（总 / 可答 / 隐藏）。`catalogApplied.unmodeledTablesInNl` 非空立刻 `refuse`（`blocked_table`），不编 SQL。覆盖率 GATE 见 `warehouse-coverage.ts`：与 EX 分母分开；扩表优先名单在 `config/analytics/warehouse-coverage.json`（batch 0 `elt_watch_detail` overlay；batch 1 付费/留存 VQR 五表；batch 2 首张 `gather_stat` 已升金样，其余影片/会员/邀请等 catalog_only）。

### 3. 时间：读懂归 LLM，落地归代码

业界：相对时间（2周内 / 下周三之前）由模型结合「今天」理解意图；具体日历日用时钟工具算，禁止模型心算（跨月、闰年、周序会错）。

本仓：

- 组包时注入 `today_date` + `timezone`（业务时区，默认 Asia/Shanghai）。
- `resolveAskTimeRange` 用同一时钟做确定性算术（昨天 / 最近7天 / ISO 区间等）→ facts `resolved_time_range`。模型 JSON 的 time **必须**用这两个日期；`applyResolvedTime` 再覆盖一遍。
- 钉不死（裸「最近」等）→ facts 写 none，**不**再 `clarify time_range` 提前退出；模型可澄清，不得编造起止日。
- Path C 再经 `overlayResolvedDates` + `includeResolvedEndDay`，禁止 `< 结束日 00:00:00` 丢掉最后一天。

细表见 [`ANALYTICS_INPUT_TO_LLM.md`](./ANALYTICS_INPUT_TO_LLM.md) §0。

### 4. 检索表（不要求用户锁表）

业界（Cortex Analyst / Databricks Genie / Cube / Metabot）：用户不点名表。Agent 用目录文档/字段做 schema linking，把相关表检索进上下文；富字段只给 top-k（约 6 张），其余用一行摘要。SQL 白名单是全部可答表，不是「先锁死一张」。

本仓：`resolveAskTable` **不再**因多候选或未点名而 `clarifySlot=table`。检索卡片在 `catalog-cards.json`（synonyms / identity），对照句不进打分。

- 点名 / 已建模 metric / overlay 观看问 / 文档分唯一 → `confidence=named|metric|overlay|unique`，可走 Path A。
- 多表分数接近（如「有多少台设备」）→ `confidence=retrieved`，top-k 进 Path C，**不**对随意赢家编 `count:*`。
- 检索为空 → `confidence=catalog`，Path C 只带 67 张一行目录，不默认 `elt_watch_detail`。
- 隐藏表仍 `blocked_table` refuse。JOIN 仍只允许已声明 relationship。

### 5. 锁对口径（指标 + 形状）

业界：同一业务词多口径先澄清；形状（按天 / 宽表 / 交叉）也要唯一。

本仓：

- `ambiguousMetricFamilyClarify`：光说「完播率按天」反问（人数 vs 最大进度）。
- 「完播 + 宽表」跳过 family 闸，走 `avg_max_progress`。
- 付费 / 留存已有 `ratio` / `retention_dn`；缺渠道或版本会 clarify。
- 「日活 / 活跃用户」编到 `elt_active_guid`（`uniq(guid)` 按天）；缺渠道在 structure 后 grounding clarify，不进 Path C。模型调用 15s 超时，额度/网关错误不把 JSON 甩到对话里。

### 6. 决定谁写 SQL（互斥）

业界：已建模 KPI 编译；高频金句 Verified Query；其余受控 Text2SQL。一问一条，禁止失败后偷换指标。

本仓顺序（`pipeline.ts`）：

1. 金样命中只进 facts（不在进 LLM 前直接跑 SQL；多命中也不提前反问）。
2. `resolveAskTable` 检索表（唯一才锁编译；否则 retrieved / catalog；**不**因多候选提前选表）。
3. `routeAnalyticsAsk` 组包前算出 A / C / refuse。澄清短答不按当前句进 Path C：AskState 合并完整则直接 Path A。新探索问才在 structure 后 `runSqlAgent`。
4. 文档表默认 `count:*` **不**抢 C（除非 NL 有人数/订单数等显式线索）。

### 7. 出 SQL

| 路径 | 谁写 | 本仓 |
|---|---|---|
| A | 编译器 | structure 填槽 + `compileAnalyticsIntent` |
| B | 金样模板 | `verified-queries.json` 只换 `{{start/end/channel/appVersion}}` |
| C | 模型 | 卡片索引 → `get_table_schema`（检索 top-k 预取，模型可再拉）→ JSON SQL，最多 3 次；日期被代码覆写 |

### 8. 跑之前挡住错 SQL

业界：只读、表白名单、未声明 relationship 不准 JOIN、事实表要有时间 WHERE、LIMIT。

本仓：`lintSql` / AST + 按表 `requireWhere` + `assertJoinsOnDeclaredRelationships` + CTE 不当物理表 + LIMIT 5000。

pack 三对关系（V1，覆盖付费 + 留存金样，**不**为了扩面乱加边）：

- `elt_film_user._id = elt_film_order.uid`
- `elt_new_guid.guid = elt_active_guid.guid`
- `gather.guid = elt_new_guid.guid`

图外多表 → 拒，不会编出错 JOIN。需要新 join = 改 pack 配置。

### 9. 取值；失败按路径处理

业界：KPI 失败不让模型改分母重编；探索 SQL 报错回灌、限轮。

本仓：A/B 失败 → refuse/clarify。C 把 Metabase / 守卫错误回灌，共 3 次。禁止改走另一个 A metric 冒充。

### 10. 对表：问过的条件必须还在

业界：点名的渠道、版本、语种必须还在过滤或结果列。幽灵码反问，禁止 silently drop 后仍 ok。

本仓：

- Path A：`resolvePackFilters` + `groundChannelFilters` + `evaluateCapabilityGate`（超纲拒，不降级）。
- Path B：过滤写死在金样；缺 `channel` / `appVersion` 槽会 clarify。
- Path C：点名渠道 / 版本 / 语种必须出现在 SQL；超纲 op（TopN / 分位）直接 refuse；抽出的渠道码先走 `groundChannelFilters`；点名实体还经 `verifyNamedChannel`。

---

## 2. 已修 / 待修（只影响「表是否正确」）

| 项 | 状态 | 说明 |
|---|---|---|
| 观看语言宽表（人均 / 起播 / 完播）升 Path A | **已修** | `conditional_wide`：`layout=wide` + `pivotDim`；未点语种用 pack `guards.defaultWideLangs`。VQR 三条 `needsWide` 因 `compileCanCoverVerified` 不再抢答。 |
| Path C 点名渠道 / 版本必须进 SQL | **已修** | `missingNlAnchorsInSql`；缺则当本轮失败回灌。 |
| 付费率 `ratio` kind | **已修** | 升 A；缺渠道/版本 clarify。金样仍可绑槽对照。 |
| 次日留存 `retention_dn` kind | **已修** | 合计默认；「留存1 / 按语言」走宽表。 |
| JOIN 图扩边 | 不做（除非新金样需要） | V1 三对已够付费 / 留存；乱加边会放开错 JOIN |
| Path C 超纲 op + 点名语种/实体 + 渠道接地 | **已修** | `refuseUnsupportedOpsFromNl`；`missingNlAnchorsInSql` 含 locale；C 执行前 `groundChannelFilters`；`runHybridSqls` 加按天/点名实体校验。不搬 A 的全套 lexicon 探词循环。 |
| 67 张可答表不要求先锁表 | **已修** | schema linking：retrieved top-k + compact catalog；不再 `ambiguous_table` / `table_unspecified`。 |
| 每表检索卡片（identity + synonyms） | **已修** | `catalog-cards.json`；对照/他表提及不进打分。避免「订单数」锁到邀请提现。 |
| Path C `get_table_schema` | **已修** | 先卡片索引，再按需拉列；SQL 白名单 = 已 schema 的表。A/B 不动。 |
| 执行后校对 + 解读 | **已修** | A/B 本地解读、不再额外打模型；C 校对+解读合并为 1 次调用。数字只许来自样例。 |
| GATE coverage + Path C 分报 | **已修** | coverage 是可失败 GATE：`evaluateWarehouseCoverage`（spec `warehouse-coverage.json`）。无 catalog 时仍断言 overlay pack + 扩表名单；有 snapshot 时强制 **72 / 67 / 5** 与 overlay 活字段 23。8/23 为文档化缺口。`llm_sql_ex` / `llm_sql_exec_ok` 不进 EX。隐藏表拒答入 gold refuse。 |
| batch 2 `gather_stat` 升 Path B | **已修** | 金样 `gather_stat_daily`：按日+事件 `sum(eventCount)` / `sum(activeUsers)`，`toDate(date)`。别名「埋点汇总」等；裸「埋点」仍走 Path C 明细。 |

规格步 5 的三个 kind（`conditional_wide` / `ratio` / `retention_dn`）已落地。新形状仍先走 B 再升 A。

---

## 3. 不要从本页推出的结论

- 不要生成 71 份 pack。warehouse 已经是 67 可答。
- 不要把「1/71 + Phase 0–4」当实现计划（见 `ANALYTICS_ARCHITECTURE_REVIEW.md` 文首更正）。09-13 的 1/71 是当日 pack 锁表快照，不是今日覆盖率。
- 不要把 Path C 的「能跑」算进发版正确率。
- 语义层扩表按 `warehouse-coverage.json` 的 batch 0/1/2 排队（overlay → VQR → 下一批评方），不要一次铺 67 张 overlay。batch 2 首张 `gather_stat` 已升 Path B（`gather_stat_daily`，「埋点汇总」走金样，时间列 `date` 不是 `createTime`）。「埋点」明细仍走 Path C。
