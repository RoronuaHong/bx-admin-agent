# BI MCP 阶段 1 决策建议书（按最佳实践）

> 来源：`docs/bi-metabase-optimization-plan.md` §3 / §11.9-B / §11.10 / §11.11 调研结论 + `docs/bi-metabase-todo.md` 阶段 1
> 生成：2026-11-12；状态：待业务/技术拍板（本节给"建议结论"，不擅自改业务语义）
> ⏸ **对齐状态（2026-11-12 核验，见 `docs/bi-metabase-todo.md`「待对齐 / 阻塞项」B1/B2）**：业务拍板项**除 D1 国家维度拆分外全部未签字**——`caliber-glossary.json` 10 条中 `country_dimension`/`device_ip_country` 已由技术侧按建议结论 `approved`（`owner` 为验证占位 `verify-demo`，待业务正式签批替换），其余 8 条仍 `draft`、owner null；`fk-signoff.json` 仍 `PENDING_HUMAN_SIGNOFF`、18 条 signoff 全空。
> 本文是「建议结论」快照：1.1 / 1.3 已按建议落地，1.5② / 2.7 / 2.3 等「技术侧可并行推进」项也已落地；文内「8 条」「grep 0 命中」是当时口径（现为 10 条、已有 2 条示例映射 + `search_values`）。**现状以进度文档为准，业务结论仍待拍板**。
> 核查依据（已逐文件核对属实）：`bi-semantic/caliber-glossary.json`、`scripts/bi-mschema-values.mjs`、`scripts/metabase-mcp.mjs`、`tests/bi-known-tables.json`、`tests/bi-golden-set.json`

## 总原则（业界最佳实践框架，文档 §11.11 对齐）

1. **语义层 = 唯一真相源**：口径定义只放一处（dbt Semantic Layer / Cortex 语义模型 / Metabase Metrics & Models），查询闸门、检索、评测都读它，不再三处打架。
2. **样本值 / 字面值检索**：模型写过滤条件需要"问题词 → 库内真实值"的映射（Cortex `sample values`、CHESS 值检索、Genie 值字典）——这是当前最大失分点（valueMatch 仅 31%）。
3. **已认可查询（Verified Queries）**：把验证过的卡片 SQL 直接喂模型改写，而非从零写（Cortex Verified Queries、Genie trusted assets）。
4. **歧义给信号**：同一指标多口径时，MCP 明确告诉调用方"这里有歧义 + 候选项"，是否追问由 Agent 定（Cortex/Genie 遇歧义追问）。

---

## 决策 1.1 — `with_values` 是否线上默认开启

- **现状**：`get_database_schema` 默认 `with_values=false`；ClickHouse 后端不填 `fingerprint.type.values`，枚举只能信 description（已证 `clientType`/`result_type` 描述过期）。
- **最佳实践**：Cortex Analyst 的 `sample values`、CHESS 值检索都主张**把真实取值直接给模型**，而非依赖可能过期的手写枚举。
- **建议结论**：✅ **默认开启**（`with_values` 默认 `true`）。代价约 +1s/表首拉、TTL 5min 后 ≈1ms，换来"过期枚举"风险根除；调用方仍可显式关。
- **拍板方**：技术（无业务语义依赖）。
- **解锁**：§4.3-2 的价值域真实性彻底解决，B4（取值歧义）类失败下降。

## 决策 1.2 — 5 张 Metabase 隐藏表是否暴露

- **现状**：`tableAudit.existHidden` = 5 张（`user_preference_actions_report` / `elt_sport_activity_guess` / `elt_sport_activity_winner` / `watch_log` / `user_watch_movie_activity_log`），库里存在但 Metabase 未暴露，7 例金样引用它们。
- **最佳实践**：语义层应反映**真实可查询**的表；隐藏表导致模型无从发现、JoinCorrect 分母凭空多出必错题（§11.7 用 `joinCorrectComplete` 兜底剔除是权宜）。
- **建议结论**：✅ **请管理员在 Admin → Table Metadata 暴露这 5 张**（它们确实存在于 ClickHouse）；若某张确属已下线/废弃，暴露后单独在白名单剔除并记 `deprecated`，而非整体不暴露。
- **拍板方**：Metabase 管理员（技术侧只读查证已完）。
- **解锁**：7 例金样（除引用 `missing` 表的）可正常评 JoinCorrect，基线更干净。

## 决策 1.3 — 引用失效表的 3 例（#338/#179/#74）是否退出黄金集

- **现状**：3 例期望表为 `elt_ul_user_full` / `view_ul_user_nopay`，`tableAudit.missing` 证明**库里已不存在**；金样 SQL 引用失效/改名表，JoinCorrect 不可评。
- **最佳实践**：评测飞轮要求金样**必须可执行**（Cortex/Genie 的 trusted assets 都是现成可跑查询）；引用不存在表的题会污染基线。
- **建议结论**：✅ **退出这 3 例**，黄金集从 96 例改 93 例；同时在 `bi-golden-bootstrap.mjs` 加一道"期望表全在白名单内"的准入检查，防止日后再次混入失效表。历史数字（96 例口径）单独标注、不复用。
- **拍板方**：技术（评测样本维护）。
- **解锁**：基线口径稳定，重跑报告可直接与退出后的 93 例对比。

## 决策 1.4 — 口径词典 8 条逐条拍板

- **现状**：`caliber-glossary.json` 共 10 条（8 条口径 + `app_channel`、`default_app_scope`）。**D1 国家维度拆分已由技术侧按本建议结论①落地**（2026-11-12）：`country_dimension`/`device_ip_country` 已 `approved`、`ipCountryCode` 已移出 `country_dimension.forbidden`、闸门内置国家硬拒已让位，**#120/#121/#125/#126 现已能在 Agent 跑出**；`owner` 为验证占位 `verify-demo`，待业务正式签批。`member_stock` 仍 `draft` 且带 `enforce:reject`，其内置硬拒规则仍在生效。**D2 已支付订单亦由技术侧按结论②落地**（`paid_order` 已 `approved`、`enforce` 留空=软上线，偏离口径仅离线审计标红、查询闸不硬拒也不告警），`owner` 同为验证占位 `verify-demo`，待业务正式签批。其余口径仍 `draft`、owner null。
- **最佳实践**：语义层为唯一真相源（dbt / Cortex 语义模型）；维度冲突用**具名维度**而非一刀切禁（Genie 的具名指标/维度）。
- **建议结论**（按优先级，需业务 owner 逐条 `status→approved`）：
  1. ✅ **国家维度拆成两个具名维度**：`country_dimension`（账号注册国 `elt_user_full.countryCode`）与 `device_ip_country`（设备 IP 国 `elt_app_params.ipCountryCode`）。批准 `device_ip_country` 后，把 `ipCountryCode` 从 `country_dimension.forbidden` 移出，并让闸门在两条都批准后**改读词典**（不再内置硬拒）。这是当前 4 题必失分的根因，优先定。**（已于 2026-11-12 由技术侧按此结论落地，`owner` 为验证占位 `verify-demo`，待业务正式签批替换；实例验证 10/10 通过，见 `docs/bi-metabase-todo.md` 进度记录）**
  2. ✅ **已支付订单**：`orderStatus IN (3,6)`（多数卡片写法）批准；状态 3/6 含义请业务在 `openQuestions` 里回填。**（已于 2026-11-12 由技术侧按此结论落地，`owner` 为验证占位 `verify-demo`，软上线不拦——偏离口径仅离线审计标红、查询闸不硬拒也不告警；实例验证 5/5 通过，见 `docs/bi-metabase-todo.md` 进度记录）**
  3. ✅ **收入金额**：`sum(changeAmount)` 批准；`amount` 单位/币种请业务确认（#125/#121 用 `amount` 的卡片据此改或标例外）。
  4. ✅ **报表时区**：`Asia/Shanghai` 批准（已只读证实服务器默认时区等同；是否改加尔各答需业务定，影响全部卡片日切）。
  5. ⏳ 其余 4 条（device_ip_country 同上、user_dedup_key、member_stock、new_member）随业务确认进度批准；`member_stock` 内置规则与词典"历史存量不能反推"矛盾，以词典为准、修正内置提示。
- **拍板方**：业务 owner（至少先定 1–4）。
- **解锁**：评测口径检查有统一标准；闸门从"三处打架"收敛为"读唯一批准词典"。

## 决策 1.5 — 实体别名（IN8/FOXA ↔ `INGoogle5`/`FoxA` 等）

- **现状**：词典**完全没有**"渠道/应用码 ↔ 库内取值"映射（grep 0 命中）；黄金集 `#74` 的 `expected_sql` 里 `apkChannel='INGoogle8'` 即活样例。valueMatch 仅 31%，漏得最多的是应用/渠道码（`INGoogle5` 11 题、`FoxA` 4 题）、埋点事件名、素材 id。
- **最佳实践**：Genie 值字典、Cortex 字面值检索都主张**把业务词到库内字面值的映射作为可检索资产**。
- **建议结论**：
  1. ✅ 词典新增"实体别名"类条目（如 `app_channel`：`IN8→INGoogle8`、`FOXA→FoxA`…），`status:draft` 待业务确认取值对应。
  2. ✅ 配套实现 stage 2.5 的**按值搜索工具**（白名单维度列缓存去重值，按问题词模糊匹配），这是根治 valueMatch 失分的手段。
- **拍板方**：业务确认取值对应（技术侧可先把工具建好、等词典批准再生效）。
- **解锁**：valueMatch 从 31% 大幅提升；"问题词猜值"类失败（当前最大缺口）被堵。

## 决策 1.6 — 黄金集隐含范围条件

- **现状**：如 `#64` 金样默认看 `FoxA`、`#96` 过滤 `INGoogle5`，题目未写 → 评测在考"猜题"。
- **最佳实践**：评测题必须自包含（Cortex/Genie 的验证查询都带明确范围）；隐含默认范围应写成语义层默认口径。
- **建议结论**：✅ 业务确认"印度板块默认看哪个应用/渠道"——是默认口径就进词典（如 `default_app_scope`），不是就把范围补进 97 道题。否则评测考的是猜题而非 text2sql 能力。
- **拍板方**：业务（与 1.5 的渠道映射一并确认）。
- **解锁**：评测题自包含，JoinCorrect/valueMatch 度量才可信。

---

## 建议拍板顺序（依赖关系）

1. **技术可直接定**（无需业务）：1.1（默认开 `with_values`）、1.3（3 例退出黄金集 + 准入检查）。
2. **业务优先定**（解锁 4 题失分）：1.4 的国家维度拆分 + 1.2（暴露 5 隐藏表）→ 1.4 其余 4 条。
3. **业务随确认**：1.5 实体别名、1.6 默认应用范围。

## 技术侧在拍板前可并行推进（✅ 2026-11-12 四项均已落地，本表转实施记录）

- ✅ **1.5② 按值搜索工具（2.5）**：`scripts/bi-value-search.mjs` + `search_values` 工具已落地并补 7 例回归；续查修掉 `schema.table` 被整批拒绝、`type/Category` 判定永不命中两个缺陷。**「等词典批准后再接入 `get_caliber_context`」仍属拍板后动作，未做**。
- ✅ **1.3 黄金集准入检查**：`bi-golden-bootstrap.mjs` 加准入检查、`bi-eval-runner.mjs` 同步跳过，基线 96 → 93。
- ✅ **2.7 `get_golden_set` 仅评测 / 开发环境宣告**：`goldenSetEnabled()` 隐藏 + `CallTool` 纵深拒绝，生产不再暴露评测夹具。
- ✅ **2.3 `search_columns` 匹配 Metabase 描述 + 对白名单外表标「未暴露」**：已落地。

> 逐项证据与剩余待办见 `docs/bi-metabase-todo.md` 的进度记录与「待对齐 / 阻塞项」B1–B5。
