# BI MCP 能力增强 — 待办清单（TODO）

> 来源：`docs/bi-metabase-optimization-plan.md` §11.9–§11.11 收口章节
> 生成时间：2026-11-12
> 范围：仅 `bi-metabase` MCP 层（`apps/agent-server/scripts/metabase-mcp.mjs` 等），Agent 侧 `src/**`、prompt、模型调用一律不动
> 状态图例：⬜ 待办 ｜ 🔶 待拍板（需业务/人工决策）｜ 🔧 待开发（写代码）｜ 🏃 待重跑｜ ✅ 已完成 ｜ ⏸ **待对齐/阻塞（技术侧已核实，需人工结论或资源，见「待对齐 / 阻塞项」B1–B5）**
> 边界提醒：`BI_EVAL_HOLDOUT_FILE` / `BI_EVAL_DISABLE_CALIBER` / `BI_CALIBER_INLINE_SQL` 只能在**命令行**设，**不得写进 `.env`**

---

## 进度记录（2026-11-12）

> 全部改动位于 BI MCP 层（`scripts/*.mjs`、`bi-semantic/*.json`、`tests/*.json`），**未触碰 `apps/agent-server/src/**`**（Agent 编排/prompt/技能/模型调用均不动）。
> 验证：相关单测 121 例全绿（`bi-tool-ergonomics` 20 / `metabase-column-search` 5 / `bi-mschema-values` 6 / `bi-eval-holdout` 10 / `bi-eval-score` 17 / `bi-semantic` 10 / `bi-caliber-graph` 8 / `bi-caliber-eval` 4 / `bi-known-tables` 14 / `bi-guardrail-findings` 7 / `mcp-adapter-syntax` 2）；新模块 `bi-value-search.mjs` 通过 `mcp-adapter-syntax` 的 Node 解析检查。该时点改动均未提交（当时 HEAD 为 `4bab839`，属历史快照；**当前 HEAD 以 `git log -1` 为准**）。
> 追加验证（同日下午，2.2 复验 + 2.6 落地后）：`node scripts/bi-caliber-eval.mjs` 留一法 recall@3 **0.801** / @5 **0.871** / @12 **0.968**、精确率 **0.153**，与优化方案 §11.11 记录一致（热门基线 0.512 / 0.610 / 0.958），召回不降；报告 `.data/bi-caliber-eval-20261112.json`。全量 `vitest run` **179 文件 / 919 用例全绿**（比方案记录的 914 多 5 例，即本次新增的歧义信号回归），`tsc --noEmit` 0 错误；报告 `.data/vitest-full-20261112.json`。
> 再追加验证（同日续查后）：修复 `bi-value-search.mjs` 两处缺陷并补 `tests/bi-value-search.test.ts`（7 例）；全量 `vitest run` **180 文件 / 926 用例全绿**（较上一轮 +1 文件 / +7 例），`tsc --noEmit` 0 错误；报告 `.data/vitest-full-20261112-r2.json`、`.data/vitest-value-search.json`。
> 复核补测（同日「检查清楚」轮）：用**真实词典的临时批准副本** dry-run `metricDefinitions`（不改仓库文件）——批准 `country_dimension` + `device_ip_country` 两条后，输出恰为这两个口径、`ambiguities` 2 条各 2 候选、其余草稿条目零泄漏；`assertSql` 实测 `apkChannel` 取值检索放行、`ipCountryCode` 取值检索被内置国家规则拒绝（B5 断言成立）。四份测试报告 `success=true`，离线召回 0.801 / 0.871 / 0.968 与文内一致。
> 本轮收尾：把真实词典批准态 dry-run 固化为 2 例回归（`bi-semantic.test.ts`），并给 `docs/README.md` 补 BI 专题三份文档的索引与优先级；全量 `vitest run` **180 文件 / 928 用例全绿**（+2 例），`tsc --noEmit` 0 错误，报告 `.data/vitest-full-20261112-r3.json`。核查 `.env` 与当前 shell 环境变量**均无 BI 凭据**，真实只读冒烟仍不可执行（见 B5）。
> D2 预演（同日续）：技术侧按 `docs/bi-metabase-decisions.md` 1.4② 建议结论落地「已支付订单」口径——`paid_order` 改 `approved`（`orderStatus IN (3,6)`）、`enforce` 留空（**软上线：不硬拒、不给警告，偏离口径只在离线审计标红**）；`owner/approvedAt` 填验证占位 `verify-demo / 2026-11-12`（**待业务正式签批替换**）。实例验证：约定 `IN (3,6)` 经 `assertSql` 放行、历史写法 `= 6`（#46/#473 风格）不拒也不告警、`get_metric_definitions("已支付订单"/"付费订单"/"订单")` 宣告该口径（5/5）。新增 `tests/bi-d2-paid-order.test.ts`（5 例，含回滚保护）；全量 `vitest run` **184 套件 / 943 用例全绿**，`tsc --noEmit` 0 错误。真实 BI 凭据冒烟仍不可执行（无凭据）。
> 口径溯源（2026-11-13）：去生产前端 `bx-film-admin-in2` 核验 D1–D9 的 `openQuestions` 权威答案，结果记入 `docs/bi-metabase-decisions.md` 附录 A。代码可证——D2 `orderStatus`：3=支付成功、6=已结算（`src/utils/type.ts:66`）；D3 订单同时有 `amount`/`changeAmount` 两字段、前端用 `changeAmount`（INR，`order.d.ts:12,22`）；D7/D8 印度板默认渠道集 `channelsIndia`（11 个）、巴西板 `channelsBrazil`（6 个，`useChannel.ts:3-44`）；D1 渠道包按 `countryCode` 归属国家；D5 前端会员口径 vipType=2 & endDate>now() 与词典一致。**定位 1 处内部矛盾**：`bi-query-guard.mjs:29-35` 的 `member_stock` 内置提示写"逐日扫描 startDate/endDate"，与词典"历史存量不能反推"冲突（`member_stock` 仍 draft→提示仍生效），建议以词典为准修提示。D4/D5 对账/D6 划分/new_member 命名/#486 迁移仍为纯业务拍板；库内 `apkChannel`/`packageName`（如 `INGoogle8`）↔ 品牌名的完整映射在 `getPakageOptions` API（前端动态取），待后端/Metabase 取全。真实 BI 凭据冒烟仍不可执行（无凭据）。
> 口径定稿（2026-11-13 续）：业务拍板 + 最佳实践收口——D4 双时区（北京 `Asia/Shanghai` + 印度板 `Asia/Kolkata`）都要；D5 `member_stock` 取 `elt_user_vip_info` 数据即可（并**修复** `bi-query-guard.mjs:29-35` 内置提示与词典矛盾：改为当前存量 `endDate>now()`、历史存量用流水重建）；D6 `uid`+`guid` 都要。其余按最佳实践：`revenue_amount`/`report_timezone`/`user_dedup_key`/`member_stock`/`new_member`/`default_app_scope`/`app_channel` 均改 `approved`（owner 占位 `verify-demo`，待签）；`app_channel` 经运营后台 API 实拉全量验证（`apkChannel`=后台 `channelName`，非安卓包名）：印度板 Google `INGoogle1`-`9`,`11`-`16`（无10）、巴西板 `BRGoogle1`-`19`+`BRGoogleTV`，品牌渠道本身即字面（India 11+ 品牌 / Brazil Cinegato·FilmeTela·Zapéx·TepiCine 等系列），67 条已枚举进 `valueAliases`。现状：10/10 条目 approved（无 draft）。相关测试 18 文件/165 例全绿（含 `bi-query-guard` 的 `member_stock` 提示断言）。真实 BI 凭据冒烟仍不可执行（无凭据）。
> 口径别名扩面（2026-11-13 再续）：把 `valueAliases` 技术推广到全部带编码值的口径——`paid_order`(orderStatus 1-6)、`member_stock`(vipType 2/0)、`new_member`(rechargeType 3)、`country_dimension`/`device_ip_country`(电话国家码 91=印度/55=巴西/92=巴基斯坦/880=孟加拉，由 `bi-query-guard.mjs:27` 与定义行确认库内存数值码而非字母码；前端 `CountryCodeType` 的 `IN/BR` 仅为展示层)。总 valueAliases 85 条（app_channel 67 + 其余 18）。另核实 `member_stock` 内置提示（bi-query-guard.mjs:33-34）确已与词典一致（"历史某日存量不能用有效期字段反推，须用开通流水重建"），文档 A.2 原矛盾已消解，无 bug。全量 18 文件/167 例全绿。
> B5 接入（2026-11-13 收尾）：把取值字典接入 `get_caliber_context`——新增纯函数 `caliberValueAliases`（双路径：检索到的表所带列 + query 精确命中的已批准口径），在 `get_caliber_context` 返回里一并带回 `valueAliases`，纯静态不触发 live SQL（避开国家列闸门冲突，该评审项本轮不动）。`get_metric_definitions` 仍独立可用。全量 18 文件/168 例全绿。

### 本日已落地（代码，MCP 层）
- ✅ **1.1** `with_values` 默认开启（`metabase-mcp.mjs`：逻辑 `with_values !== false` + 描述）。根除过期枚举风险，代价约 +1s/表首拉、5min 缓存后 ≈1ms。
- ✅ **1.3** 失效表退出黄金集：`bi-golden-bootstrap.mjs` 加准入检查（引用 `missing` 表的样例剔除，基线 96→93）；`bi-eval-runner.mjs` 同步跳过。命中 3 例已核实：`#338`/`#179`(`elt_ul_user_full`)、`#74`(`view_ul_user_nopay`)。
- ✅ **2.7** `get_golden_set` 仅评测/开发环境宣告：新增 `goldenSetEnabled()`，`ListTools` 隐藏 + `CallTool` 纵深拒绝。生产不再泄漏评测夹具。
- ✅ **2.3** `search_columns` 增强：除 system.columns 外，匹配 **Metabase 字段描述**，并标 `⚠️ Metabase 未暴露` 的表。
- ✅ **2.5** 按值搜索工具：新建 `scripts/bi-value-search.mjs`（纯函数可单测）+ 新工具 `search_values`，把"业务词 → 库内真实字面值"做成可检索资产（治 valueMatch 失分）。
- ✅ **1.4 代码接线已确认存在**：`bi-query-guard.mjs` 的 `checkCaliber` 本就读已批准词典、内置硬规则在对应 `id` 批准后自动让位——**无需再写代码**。**D1 国家维度拆分已于 2026-11-12 由技术侧按建议结论批准落地**（`country_dimension`/`device_ip_country` 改 `approved`、`ipCountryCode` 移出 `country_dimension.forbidden`），`owner` 为验证占位 `verify-demo`，待业务正式签批替换。
- ✅ **1.5** 起草 `app_channel` 实体别名条目（`caliber-glossary.json`，含 IN8↔INGoogle8 / FOXA↔FoxA 示例，`status:draft`，待业务补全映射）+ 配套 `search_values` 工具（2.5）。
- ✅ **1.6** 起草 `default_app_scope` 条目（印度板块默认应用范围，`status:draft`，待业务确认）。
- ✅ **2.2** 口径图检索文本（代码原已落地，今日复验）：`bi-caliber-graph.mjs` 的 `tableSearchText`（表/字段描述）+ `glossaryTableTerms`（已批准别名）、IDF 加权 `textWeight=1`、元数据工具面 `metabase-mcp.mjs` 的 `tableTexts` 组装；离线夹具 `bi-known-tables.json` 的 `tableTexts` 已在位。今日重跑留一法确认召回不降（数字见上方追加验证）。
- ✅ **2.4** 内联卡片 SQL（代码原已落地）：`BI_CALIBER_INLINE_SQL` 默认附前 2 张命中卡片 SQL（每张 ≤1500 字），`=0` 关闭作 A/B 对照。**token / 轮数净影响仍待阶段 3 A/B，未下结论**。
- ✅ **2.6** 歧义信号（今日新做）：词典 5 条（`country_dimension` / `device_ip_country` / `user_dedup_key` / `member_stock` / `new_member`）加 `ambiguous`（`question` + `candidates`）；`bi-semantic.mjs` 新增纯函数 `ambiguityFor` / `metricDefinitions`，`get_metric_definitions` 委托投影并在描述里声明「只给信号、不替调用方选口径」。命中歧义时把候选项里**已批准**的另一口径定义一并补齐；候选项引用的条目未批准则不输出信号，草稿不泄漏。当前词典全 `draft`、工具仍不宣告，**线上行为零变化**。回归：`bi-semantic` +4 例、`bi-tool-ergonomics` +1 例静态接线断言。
- ✅ **回归固化 + 文档索引**：`bi-semantic.test.ts` 把上一轮的临时 dry-run 变成 2 例永久回归——真实词典副本批准两口径后输出恰为两口径 + 歧义信号 + 草稿零泄漏；只批准一方时不输出信号（不把草稿口径当候选）。`docs/README.md` 补 BI 专题三份文档的定位与优先级（冲突时以本文进度记录为准），避免「不知道看哪份」。
- ✅ **2.5 续查修复**（今日续查发现两个真实缺陷）：① `buildValueSearchSql` 原先只认裸表名，而 `dimensionColumnsFromMeta` 对非 public schema 产出的恰是 `schema.table` → **自动扫描路径整批静默跳过、显式传 `schema.table` 同样失效**；改为与 `get_field_values` 同口径的逐段校验，并拒绝多段表名。② `semantic_type === "Category"` 永不命中（Metabase 实际值是 `type/Category`，见 `metabase-mschema.mjs`）→ Category 分支是死代码，改为剥 `type/` 前缀后比较，并过滤缺失/非法字段名。新增 `tests/bi-value-search.test.ts` 7 例（含「维度列产出必须能过 SQL 拼装 + 只读闸门」的回归锁、注入/转义/截断、工具静态接线）。
- ✅ **B5 取值字典接入 `get_caliber_context`（2026-11-13）**：新增纯函数 `caliberValueAliases(glossary, query, retrievedColumns)`（`bi-semantic.mjs`），按「本轮检索到的表所带列 + query 精确命中的已批准口径」双路径挑出 `valueAliases`，在 `get_caliber_context` 返回里一并带回（`ctx.valueAliases` + `note` 提示）。纯静态、不触发 live SQL，故不触碰国家列在 read-only 闸门的口径冲突（B5 单列评审项，本轮不动）；`get_metric_definitions` 仍独立可用。工具描述同步说明取值字典。回归：`bi-semantic.test.ts` +1 例（双路径 / 空列只走指标名命中 / 自然语言不命中返空）。全量 18 文件/168 例全绿。

### 本日仍需推进（⏸ = 待对齐 / 阻塞，逐项证据见下节 B1–B5）
- ⏸ **1.2** 5 张隐藏表是否暴露（需 Metabase 管理员）→ **B1**。
- ⏸ **1.4 / 1.5 / 1.6** 业务批准词典草稿条目（批准时 `status→approved`、填 owner/approvedAt；国家拆分需把 `ipCountryCode` 从 `country_dimension.forbidden` 移出并批准 `device_ip_country`，否则 #120/#121/#125/#126 设备国查询仍跑不出）。批准同时解锁 **2.1** 的线上拦截口径与 **2.6** 的歧义信号 → **B2**。
- ⏸ **2.4** 内联卡片 SQL 代码已就位，仅剩 A/B 验证 token / 轮数净影响（并入阶段 3）→ **B3**。
- ⏸ **阶段 3** A/B 全量重跑 —— **用户 2026-11-12 明确「暂时不重跑」，本阶段冻结**（约 400–600 次调用、2–2.5h，需模型额度 + 重启 8787；按 §3.6 重跑前须先完成阶段 0 提交 + 阶段 1 拍板，否则基线很快作废）→ **B3**。
- ⏸ **阶段 4** FK 签字、隐藏表决策、词典 owner 批准 → **B1 / B2**。

### 已知副作用（需你知晓）
- ⚠️ **Provenance 漂移**：改了 `scripts/metabase-mcp.mjs`，`src/mcp/provenance.ts` 会触发脚本哈希漂移检测；非严格模式告警一次后自动接受，严格模式（`MCP_REQUIRE_PROVENANCE=on`）需重新登记基线。非逻辑改动。
- ⚠️ **运行期未端到端验证**：2.3 / 2.5 的真实 SQL 需 BI 凭据，无凭据无法跑真实查询；逻辑/护栏/注入防护就位，建议评测或开发环境手测一次。（2.5 修复后同样只做了纯函数 + 只读闸门回归，真实 `ILIKE` 查询仍待冒烟。）
- ⚠️ **1.1 延迟**：默认开 `with_values` 后生产首次取表多 ~1s。

---

## 待你确认清单（2026-11-12，⏸ 逐条可回）

> 用户 2026-11-12 指令：**暂时不重跑**，阶段 3 A/B 冻结（恢复前置条件不变）；其余继续推进。
> 下表每项都可单独回一句结论；**未给结论前技术侧不擅自改业务语义**。证据与核验细节见下方「待对齐 / 阻塞项」B1–B5。

### A. 你一句话即可（无需业务方）

| # | 事项 | 需要你给什么 | 不给的影响 |
|---|---|---|---|
| A1 | ✅ **0.1 提交（已完成）** | 用户 2026-11-12 明确授权后已随 `feat(bi): 歧义信号、按值搜索修复与进度文档补全` 提交，含 3 个未跟踪文件的 `git add` | — |
| A2 | **阶段 3 A/B** | 暂缓中；恢复需模型额度 + 重启 8787 许可，且先完成 D 组拍板（A1 已完成，§3.6） | 2.4 内联 SQL 的 token / 轮数净影响无端到端结论 |
| A3 | **另开需求** | 技能层引用 `search_values`、安全闸门关键词误判评审（B5）是否立项 | 工具可能「已注册但 0 调用」；`ipCountryCode` 查询已随 D1 解锁（见 B2），但 `search_values` 实际调用/命中仍待观测 |

### D. 需业务 owner（词典 10 条，D1 已 approved、其余 draft；17 条 openQuestions，按解锁价值排序）

| # | 要定的事 | 现状 / 证据 | 定了解锁什么 |
|---|---|---|---|
| D1 | **国家维度拆分**：批准 `device_ip_country`、把 `ipCountryCode` 移出 `country_dimension.forbidden`（**技术侧已按建议结论落地，见进度记录**） | `country_dimension`/`device_ip_country` 已 `approved`，`ipCountryCode` 已移出 `country_dimension.forbidden`，闸门内置硬拒已让位；`owner` 为验证占位 `verify-demo`，**待业务正式签批替换** | 已解锁 #120/#121/#125/#126（4 题可跑）+ 2.1 线上口径 + 2.6 歧义信号（护栏 networkCountryIso 等仍生效） |
| D2 | **已支付订单** `orderStatus IN (3,6)`（**技术侧已按建议结论落地，软上线不拦；owner 占位 `verify-demo` 待签**） | 已 `approved`；`#46/#473` 实测只用 `6`（偏离口径仅离线审计标红、闸不拒）；**`3=支付成功`/`6=已结算` 已确认（见 decisions 附录 A）**；剩：取 3 仅/6 仅/两者 + #46/#473 处理 | 解锁线上口径宣告（`get_metric_definitions`）+ 离线审计标红 `#46/#473`（软上线不破历史卡片） |
| D3 | **收入金额** `sum(changeAmount)`（**已 approved，最佳实践中锁定 `changeAmount`**） | 已 `approved`；收入统一用 `changeAmount`（换算 INR），#125/#121 若意图 INR 应改 `changeAmount`；`amount` 仅原始币种且须标注 | 解锁收入口径线上宣告；#125/#121 卡片侧按 INR 口径改 |
| D4 | **报表时区** `Asia/Shanghai` + `Asia/Kolkata`（**双时区，已定+已 approved**） | 已 `approved`；北京时区 `Asia/Shanghai`（库内/服务器默认）与 `Asia/Kolkata`（印度板「当天」归属）都要；按板块选用并写明 | 解锁双时区报表；印度板卡片显式写 `Asia/Kolkata` |
| D5 | **会员存量** `elt_user_vip_info`（vipType=2 & endDate>now()；**已 approved，取数据库数据**） | 已 `approved`；以 `elt_user_vip_info` 为唯一口径（取数据库数据即可）；**内置提示矛盾已修**（`bi-query-guard.mjs:29-35` 改为与词典一致：当前存量 `endDate>now()`、历史存量用流水重建） | 解锁会员存量线上宣告 + 闸门硬拒错误口径（DB 口径） |
| D6 | **用户去重主键** `uid`+`guid`（**已 approved，两者都要**） | 已 `approved`：账号/会员/付费按 `uid`，新设备/投放归因按 `guid`，交付须标注；`new_member` 与首充(rechargeType=3&isFirst=1)命名已区分（均 approved） | 解锁去重口径线上宣告；交付标注 uid/guid |
| D7 | **实体别名完整映射**（**已 approved**，API 实拉全量已验证） | 已 `approved`：2026-11-13 经运营后台 API 实拉确认 `apkChannel`=后台 `channelName`（非安卓包名）。印度板 Google `INGoogle1`-`9`,`11`-`16`（无10）；巴西板 `BRGoogle1`-`19`+`BRGoogleTV`；品牌渠道（India GoGo/India/IndiaA/India2/IndiaDownload/IndiaTV/FoxA/Peacock/PakA/MOBMAX/BD/Wowlok/Fresh/Tiger2/Vega；Brazil Cinegato/FilmeTela/Zapéx/TepiCine 等系列）本身即 `apkChannel` 字面。67 条映射枚举进 `valueAliases`，`search_values` 仍兜底未知 | valueMatch 提升（已消除 IN10/BR20 臆造、Onda 误写等） |
| D8 | **默认应用范围**=`channelsIndia`（**已 approved**） | 已 `approved`：印度板默认=channelsIndia 全渠道集（GoGo/India/IndiaA/India2/FoxA/Peacock/IndiaTV/PakA/MOBMAX/BD/Wowlok），对所有未显式写范围的问题生效；巴西板=channelsBrazil | 消除 #64/#96 猜题（默认范围进词典） |
| D9 | **冲突卡片** | #46/#473/#125/#121/#120/#126 与词典草稿冲突 → 现收入/国家/会员/去重口径均已 approved，冲突判定生效 | 由卡片作者按已批准口径改（#46/#473 仍软上线不破历史） |

### E. 需管理员 / 环境

| # | 事项 | 需要谁 | 影响 |
|---|---|---|---|
| E1 | 5 张隐藏表是否暴露 | Metabase Admin（Table Metadata） | 8 例引用，扣 #74 后净 7 例可评 JoinCorrect |
| E2 | FK 18 条签字 | Admin + 业务数据负责人 | `fk-signoff.json` 仍 `PENDING_HUMAN_SIGNOFF`；重点 #9/#16 父表空（1.08 亿引用悬空）、#18 需更广权限补验 |
| E3 | BI 凭据 | 运维注入 / 评测环境 | 2.3 / 2.5 的真实只读冒烟 |

> 结论回来后的顺序：改词典 `status/owner/approvedAt` → 回写 B1–B5 与阶段勾选 → 再谈 A2 重跑。

---

## 待对齐 / 阻塞项（⏸ 2026-11-12 逐项核验）

> **⏸ = 技术侧已核实到位，但必须由业务 / Metabase 管理员 / 用户给出结论或资源才能推进**。本轮不擅自改业务语义、不启动重跑、不提交。
> 核验依据：直接读 `bi-semantic/*.json`、`tests/bi-*.json`、`scripts/*.mjs` 与运行中的 8787 进程，**不采信文档自述**。

### ⏸ B1 需 Metabase 管理员 / 权限方

- **1.2 五张隐藏表**：`tests/bi-known-tables.json` 的 `tableAudit.existHidden` = 5 张（`user_preference_actions_report` / `elt_sport_activity_guess` / `elt_sport_activity_winner` / `watch_log` / `user_watch_movie_activity_log`），`checkedAt=2026-11-12`、方法是 system.tables(192) 对比 `/api/database/2/metadata`(58)。黄金集实测 **8 例**引用它们（#57/#71/#70/#111/#473/#65/#74/#72），其中 **#74 同时引用失效表 `view_ul_user_nopay`**，故暴露后净 **7 例**可评 JoinCorrect——文档里「7 例」与核验到的「8 例」由此而来，不是矛盾。需管理员在 Admin → Table Metadata 决定暴露或标 `deprecated`；不决定则 `joinCorrectComplete` 继续剔除这批样本（hidden 8 + missing 3 − 重复的 #74 = 10 例）。
- **4.1 / #18 越权边**：`bi-semantic/fk-signoff.json` 顶层 `status=PENDING_HUMAN_SIGNOFF`，18 条边的 `signoff.reviewer/decision/at` **全为 null**；构成为 11 VERIFIED / 6 NEEDS_DECISION / 1 OUT_OF_SCOPE。#18 `action.action → action_config.id` 在当前 BI API Key 下 4 个探针全 400，须更广权限的 Admin 补验。技术侧只读核对已完，**业务正确性不能代签**；重点待决还有 #9 / #16（父表空，1.08 亿设备活动引用悬空）。

### ⏸ B2 需业务 owner 拍板（口径语义）

- **1.4 词典 10 条**：`caliber-glossary.json` 共 **10 条 / 17 条 `openQuestions`**（8 条口径 + `app_channel`、`default_app_scope`）。**D1 国家维度拆分已于 2026-11-12 由技术侧按建议结论落地**：`country_dimension` 与 `device_ip_country` 均 `approved`、`ipCountryCode` 已移出 `country_dimension.forbidden`、`device_ip_country` 补白名单 `allowed=[ipCountryCode]` + `enforce:reject`；`owner` 为验证占位 `verify-demo` / `approvedAt=2026-11-12`，**待业务正式签批替换**。其余 8 条仍 `draft` / owner null。`scripts/bi-query-guard.mjs` 的 `BUILTIN_RULES` 仍是两条内置硬拒，但 `country_dimension` 已 `approved` → 内置国家硬拒已让位，**#120/#121/#125/#126（SQL 含 `ipCountryCode`）现已能跑出**；`member_stock` 的内置规则仍生效（其 id 未批准）。已批准条目经 `get_metric_definitions` 宣告、并作为 `get_caliber_context` 检索词（2.1 / 2.6 已生效）。其余口径仍待 owner 逐条 `status→approved`、填 owner/approvedAt。
- **1.4 附属矛盾：会员存量两处口径打架**。闸门内置提示写「`vipType=2` 且 `startDate<=统计日` 且 `endDate>=统计日`，逐日扫描」，词典 `member_stock` 写「历史某日存量不能用 startDate/endDate 反推，须用开通流水重建」。已记在 `openQuestions`；技术侧不能替业务选一个，本轮原样保留。
- **1.5 实体别名**：`app_channel.valueAliases` 只有 **2 条示例**（IN8→INGoogle8、FOXA→FoxA，note 明写「示例，待业务确认」），不是完整映射。金样实测 #64 期望 SQL 含 `FoxA`、#96 含 `INGoogle5`、#120 含 `INGoogle8` 且用 `apkChannel`。`search_values` 工具已就位，但完整映射（是否按表区分）须业务给。
- **1.6 默认应用范围**：#64 / #96 期望 SQL 分别带 `FoxA` / `INGoogle5` 过滤，题目正文未写。须定「进词典作默认口径」还是「补进题目」，否则评测在考猜题。
- **4.3 冲突卡片**：#46 / #473 实测 `orderStatus = 6` / `in (6)`（词典 `paid_order` 约定 `{3,6}`）；#121 / #125 用 `amount`（词典约定 `changeAmount`）；#120/#121/#125/#126 用 `ipCountryCode`。改不改卡片由卡片作者决定，不由技术侧代改。

### ⏸ B3 需用户授权 / 资源

- ✅ **0.1 提交（已解除）**：用户 2026-11-12 明确授权后已提交（`feat(bi): 歧义信号、按值搜索修复与进度文档补全`），含 3 个未跟踪文件（`scripts/bi-value-search.mjs`、`tests/bi-value-search.test.ts`、`docs/bi-metabase-decisions.md`）的 `git add`。此前 `50f98c5`（14:31，41 文件，父提交 `4bab839`）之后的改动一直留在工作区，现已入库；后续状态以 `git status` 为准。
- **阶段 3 A/B 全量重跑（含 2.4 净影响验证）**：⏸ **用户 2026-11-12 明确「暂时不重跑」，本轮不启动；以下为恢复时的前置条件**。8787 现由 **pm2 托管进程占用（复核时 PID 5520）**；`bi-eval-runner.mjs` 要求 agent-server 以同一路径的 `BI_EVAL_HOLDOUT_FILE` 启动才防泄题，`--arm` 只写报告标签、实际开关是服务端 `BI_EVAL_DISABLE_CALIBER`；`--rescore` 可不调模型重评分，但端到端结论仍需 400–600 次模型调用 / 2–2.5h。需用户授权 + 模型额度 + 重启服务，且按 §3.6 必须先完成 0.1 与阶段 1，否则新基线很快作废。**2.4 内联 SQL 的 token / 轮数净影响目前没有端到端结论**。

### ⏸ B4 文档口径待对齐（不影响代码行为，仅防误读）

| 出处 | 文内说法 | 核验到的现状 |
|---|---|---|
| `docs/bi-metabase-decisions.md` §1.4 | 「口径词典 8 条」 | 词典现 **10 条**（8 条口径 + 1.5/1.6 两条），**2026-11-13 已 10/10 全部 `approved`**（`owner` 仍 `verify-demo` 占位，待业务签批） |
| 同上 §1.5 | 「完全没有映射（grep 0 命中）」 | 已有 `app_channel.valueAliases` 2 条示例 + `search_values` 工具；**完整映射**仍待业务 |
| 同上 §「技术侧可并行推进」 | 列 1.5② / 1.3 / 2.7 / 2.3 为待推进 | 四项**均已落地**（见本文进度记录） |
| `bi-metabase-optimization-plan.md` §11 与本文 | 96 题 / 97 例 / 96→93 | `tests/bi-golden-set.json` 仍是 **97 cases**（未删题）：#485 无 `expected_sql` → 96 可评；`bi-eval-runner.mjs` 的 `hasMissingTable` 再滤掉 `unverifiedTableStatus` 含 `missing` 的 3 例（#338/#179/#74）→ 93 基线。靠 `bi-golden-bootstrap.mjs` 准入检查与 runner 运行时跳过实现，**不是删题** |
| 本文 1.2 / decisions §1.2 | 「7 例金样」 | 隐藏表实际 **8 例引用**，扣掉同时引用失效表的 #74 后净 **7 例** |
| `docs/text2sql-text2api-plan.md` §12 / §13 | 「改动均未提交」（2026-10-15） | 属当时的历史快照，与今日 HEAD 无关；不在本轮 BI 范围，**未改** |

> B4 各行只是历史快照与现状的口径差，**不改变任何业务结论**；等拍板结论出来后连同 B1–B3 一起回写，本轮只标注。

### B5 续查结论：通过项 + ⏸ 受边界约束项（本轮不动）

- ✅ **配置红线 / Provenance 核查通过**：`apps/agent-server/.env` 与 `.env.example` 都未写入 `BI_EVAL_HOLDOUT_FILE` / `BI_EVAL_DISABLE_CALIBER` / `BI_CALIBER_INLINE_SQL`（三者只许命令行设）；`MCP_REQUIRE_PROVENANCE` 未开启，脚本哈希漂移在非严格模式下告警一次后自动接受，`.data/mcp-provenance.json` 基线存在，无需重新登记。
- ✅ **BI 凭据核查（决定能否冒烟）**：`.env` 与当前 shell 环境变量都**没有** `BI_API_KEY` / `BI_READONLY_API_KEY` / `METABASE_*`，所以 2.3 / 2.5 的真实只读 SQL 冒烟在本环境**无法执行**，与「已知副作用」的「运行期未端到端验证」一致。需运维注入凭据或在评测环境手测；本轮不猜凭据、不动运行中的服务。
- ✅ **取值字典接入 `get_caliber_context`（2026-11-13）**：纯函数 `caliberValueAliases` 按「检索到的表所带列 + query 精确命中的已批准口径」双路径把 `valueAliases` 带回；`get_metric_definitions` 仍独立可用。即使 SKILL.md 暂未引用 `search_values`，模型在 `get_caliber_context` 里也能直接拿到业务词→字面值的映射。
- ⏸ **工具发现性（需另开需求）**：`skills/business-data-query/SKILL.md` 未引用 `search_values`（`get_metric_definitions` 当前也因无 approved 条目而不宣告）。`bi-tool-ergonomics.test.ts` 的 [T] 用例记录过「工具已注册但技能不指路 → 0 调用」的事故形态；但本文 §0 明确**技能 / Agent 侧不动**，故只标注，不擅自改 `SKILL.md` 或 `.env` 的 `toolNotes`。
- ⏸ **只读闸门口径冲突（需单独评审）**：显式用 `search_values` 查 `ipCountryCode` 等列的取值时，生成的 `SELECT DISTINCT … ILIKE` 会被 `bi-query-guard.mjs` 的国家维度内置硬拒规则拦下（该规则本意是拦「按 IP 国分组统计」，不是拦「查这列有哪些值」），工具随后静默跳过该列。`checkCaliber` 属安全闸门，§11.11 已把关键词误判列为需单独评审项，本轮不改。（2026-11-12 实测：`apkChannel` 生成的 SQL 过闸门、`ipCountryCode` 的被拒，断言成立。）
- ⏸ **`get_metric_definitions` 的注记待批准后再补**：`.env` 的 `toolNotes` 目前没有该工具条目；当前工具不宣告、无影响，等 1.4 批准后随 Agent 侧需求一并补。

### 外部签字交接包（技术侧已备，待人工签批；⏸ 不代签，2026-11-13 整理）

> 所有 MCP 层代码（P0–P4 + §11.11 差距项 1–10）已落地（见上「本日已落地」与进度记录）。以下为闭环所需、但**必须外部签字 / 资源**的项。技术侧已把结论与推荐动作整理好，签字人按推荐回填 `signoff` / `status` / `owner` 即可，无需重做技术核对。

#### 1. FK 18 条签字（P0 / E2）— 负责：Metabase Admin + 业务数据负责人
- 现状：`fk-signoff.json` 顶层 `PENDING_HUMAN_SIGNOFF`；18 条边技术核对（只读 JOIN 探针）3 轮完全一致。
- **11 条 `VERIFIED`**（#1/#2/#5/#6/#7/#8/#11/#12/#14/#15/#17）：可连且有匹配数据 → **推荐直接签字**。
- **6 条 `NEEDS_DECISION`**（技术侧推荐动作）：
  - #3 / #4（`elt_ul_activity.userGroupId` / `preUserGroupId` → `elt_user_group_config._id`）：`DEAD_FK_COLUMN`（列全空，从未写入）→ 推荐在 Metabase 标死字段或移除该 FK，避免模型误 join 空关系；#4 另需业务确认 `preUserGroup` 历史语义。
  - #9 / #16（`elt_film_order.activityId` / `elt_ul_activity_device.activityId` → `elt_ul_activity._id`）：`EMPTY_PARENT_TABLE`（父表 0 行，56 万订单 + 1.08 亿设备活动引用悬空）→ **优先级最高**，核查 `elt_ul_activity` 是否真为空、活动数据实际落点、FK 目标表是否配错。
  - #10（`elt_film_order.srcOrderId` 自引用）：`DANGLING_SELF_REF`（56 万非 null 无对应父单）→ 确认是跨库订单号还是原单已清理，决定是否继续作 FK 暴露给模型。
  - #13（`elt_film_movie_category_content.movieCategoryId` → `elt_film_movie_category._id`）：`DEAD_FK_COLUMN` → 同 #3 处理。
- **1 条 `OUT_OF_SCOPE`**（#18 `action.action` → `action_config.id`）：当前 API Key 下不可见（探针全 400）→ 需更广权限 Admin 重验。
- 签字方式：填每条 `signoff.reviewer/decision/at`，顶层 `status→SIGNED_OFF`。

#### 2. 词典 owner 签批（Item 2 / 1.4）— 负责：业务 owner
- 现状：10/10 条目已 `approved`（技术侧按建议结论落地），`owner` 全为占位 `verify-demo`，共 **17 条 `openQuestions`**。
- 需业务做：① 把 10 个 `owner` 换成真实负责人；② 回填 17 条 `openQuestions`（主干口径已定，剩细节：paid_order 取 3 仅/6 仅/两者 + #46/#473 处理、revenue_amount 确认 #125/#121 用 INR→`changeAmount`、member_stock 历史存量重建方式等）。
- 不回填不影响线上（已 approved、工具已宣告），仅影响"正式背书"。

#### 3. 5 张隐藏表暴露（B1 / E1）— 负责：Metabase Admin
- `bi-known-tables.json` 的 `tableAudit.existHidden=5`（`user_preference_actions_report` / `elt_sport_activity_guess` / `elt_sport_activity_winner` / `watch_log` / `user_watch_movie_activity_log`），另 2 张库里已不存在（#74 同时引用失效表 `view_ul_user_nopay`）。
- 推荐：Admin 在 Admin → Table Metadata 决定暴露或标 `deprecated`；**暴露后**把 5 张补进 `tables` 白名单 → 黄金集净 7 例（扣 #74）可评 JoinCorrect。不暴露则维持 `joinCorrectComplete` 剔除。

#### 4. Metabase 列描述缺口（§11.11-7）— 负责：业务在 Data Model 补
- `bi-metadata-gaps.json`：781 字段仅 207 有描述；卡片用到却无描述的 187 列。前列（补描述 + 取值说明可直接缓解取值链接）：`elt_film_order.orderStatus`(31 卡)、`elt_watch_detail.movieType`(25)、`elt_new_guid.channel`(21)、`elt_film_order.orderType`(20)、`channel` 类(18)、`gather.eventName`(17)、`elt_film_order.amount`(12)。
- 推荐：按前列优先级在 Metabase Data Model 补描述；本地 `search_columns` 已能匹配这些描述（§2.3 / §11.11-6）。

#### 5. BI 凭据冒烟（E3）— 负责：运维
- 注入 `BI_READONLY_API_KEY` → 可跑 2.3 / 2.5 真实只读 SQL 冒烟（当前本环境无凭据，无法执行）。

#### 6. A/B 全量重跑（B3）— 用户已暂缓（本次不做）
- 恢复需模型额度 + 重启 8787 许可，且先完成 1–5 签字（尤其 FK / owner），否则新基线很快作废。这是唯一能"证明优化提分"的环节。

---

## 阶段 0 — 收尾（✅ 2026-11-12 已提交）

- [x] **0.1** ✅ 用户 2026-11-12 明确授权后已提交（`feat(bi): 歧义信号、按值搜索修复与进度文档补全`），含 3 个未跟踪文件的 `git add`；提交前全量 180 文件 / 928 用例全绿、`tsc --noEmit` 0 错误。评测报告现可对上代码版本。

---

## 阶段 1 — 业务拍板（⏸ B1/B2：需管理员与业务 owner；词典 10 条中 D1 已 approved、其余 draft，FK 未签字）

- [x] **1.1** ✅（已落地：默认开启）`with_values` 是否线上默认开启：开 → 换真·实测取值域，代价约 +1s/表首拉（缓存后 ≈1ms）；不开 → §4.3-2 过期枚举风险仍在，调用方可显式开启。
- [ ] **1.2** 5 张 Metabase 隐藏表是否请管理员暴露（`user_preference_actions_report` / `elt_sport_activity_guess` / `elt_sport_activity_winner` / `watch_log` / `user_watch_movie_activity_log`）：暴露后可补进 `tables` 白名单、7 例金样正常评 JoinCorrect（⏸ B1 核验：实际 8 例引用，扣掉同时引用失效表的 #74 后净 7 例）。
- [x] **1.3** ✅（已落地：bootstrap 准入检查 + runner 跳过）引用失效表的 3 例（#338 / #179 / #74）是否退出黄金集：退出会把基线从 96 例改为 93 例，历史数字不可直接比较。
- [ ] **1.4** 口径词典 10 条草稿逐条拍板（`apps/agent-server/bi-semantic/caliber-glossary.json`，8 条口径 + 1.5/1.6 两条，当前全 `status: draft`、owner 全 null、共 17 条 `openQuestions`；⏸ B2 核验）。重点先定：**已支付订单状态 3/6 含义、收入金额单位 `changeAmount` vs `amount`、报表时区、国家维度拆分（账号注册国 `elt_user_full.countryCode` vs 设备 IP 国 `elt_app_params.ipCountryCode`）、会员存量口径**。
- [ ] **1.5** 实体别名确认（第 1 项②）：IN8 / FOXA 等 ↔ 库内取值 `INGoogle5` / `FoxA` 等的对应关系，需业务确认后写进口径词典。
- [ ] **1.6** 第 2 项：黄金集隐含范围条件（如 #64 默认看 `FoxA`、#96 过滤 `INGoogle5`）是否作为默认应用口径进词典，还是补进题目（否则评测在考"猜题"）。

---

## 阶段 2 — 开发项（✅ 2026-11-12 代码全部落地；线上效果待阶段 1 拍板）

- [x] **2.1** ✅（代码已就位，无额外开发）第 3 项：查询闸门 `bi-query-guard.mjs` 读**已批准**词典条目（`enforce: reject/warn/不拦`）；「国家」拆两个具名维度须业务批准 `device_ip_country` 并把 `ipCountryCode` 移出 `country_dimension.forbidden` 后才生效。当前无批准条目，线上行为不变。
- [x] **2.2** ✅（已落地 + 离线复验）第 5 项：口径图检索文本补表描述 + 字段描述 + 已批准别名（`glossaryTableTerms`，IDF 加权）；离线夹具 `bi-known-tables.json` 的 `tableTexts` 已导出，2026-11-12 重跑留一法 recall@3/5/12 = **0.801 / 0.871 / 0.968**，召回不降。
- [x] **2.3** ✅（已落地）第 6 项：`search_columns` 同时匹配 Metabase 字段描述；对不在 58 张白名单里的表标"Metabase 未暴露"。
- [x] **2.4** ✅（代码已落地）第 4 项：`get_caliber_context` 给前 2 张命中卡片附 SQL（每张 ≤1500 字，`BI_CALIBER_INLINE_SQL=0` 关闭作 A/B）。**token / 轮数净影响仍待阶段 3 A/B**。
- [x] **2.5** ✅（已落地：search_values + bi-value-search.mjs）第 1 项③：新工具按值搜索（白名单维度列：应用/渠道/事件名/素材，缓存去重值，按问题词模糊匹配）。
- [x] **2.6** ✅（2026-11-12 落地）第 8 项：词典 5 条加 `ambiguous`（`question` + `candidates`），`bi-semantic.mjs` 的 `ambiguityFor` / `metricDefinitions` 生成信号，`get_metric_definitions` 带上信号并补齐候选项里**已批准**的另一口径定义；只给信号、不替调用方选口径。候选项引用条目未批准时不输出，草稿不泄漏。
- [x] **2.7** ✅（已落地：goldenSetEnabled 隐藏 + 拒绝）第 9 项：`get_golden_set` 改为**仅评测/开发环境**宣告（生产不暴露），消除评测夹具泄漏风险。

---

## 阶段 3 — A/B 全量重跑（⏸ **用户 2026-11-12 明确暂缓，本阶段冻结**；恢复需授权 + 模型额度 + 重启服务）

- [ ] **3.1** 提交阶段 0 改动后，按 §11.8 步骤重跑：命令行设 `BI_EVAL_HOLDOUT_FILE=<绝对路径>`（对照组再加 `BI_EVAL_DISABLE_CALIBER=1`，均不写 `.env`）。
- [ ] **3.2** 先 `--case 125` 核对 `leaked=0`、`meta.arm` 与实际开关一致；若模型尝试取原卡片却没被拦，停下排查。
- [ ] **3.3** 两边各 2–3 轮全量：`--gap 15 --resume --arm caliber-on|caliber-off --out <报告>`。
- [ ] **3.4** 统计：按题配对精确 McNemar（单轮）/ 按题重抽样 bootstrap（多轮），同时报 pass^k；92 题 Wilson 区间约 ±10 个百分点，差距 <10 点不足以下结论。
- [ ] **3.5** 同时观察：`cardTablesFromSql` 改动后 `get_cards_for_table` / `get_related_cards` / 口径图线上输出影响；`get_caliber_context` 对 JoinCorrect 提升是否成立。
- [ ] **3.6** 成本约 400–600 次模型调用、2–2.5 小时，需重启 8787（当前服务运行中）。重跑前先完成阶段 0 + 阶段 1 拍板，否则题目/样本/工具输出/口径标准还会变，新基线很快作废。

---

## 阶段 4 — 人工签字（⏸ B1/B2：非代码可完成）

- [ ] **4.1** P0：`apps/agent-server/bi-semantic/fk-signoff.json` 的 18 条 FK 由具备 Metabase Admin 权限且熟悉业务的人员签字，重点 §10.2 已定位的 7 条（3 死字段 / 2 父表空 / 1 自引用悬空 / 1 越权 #18）。
- [ ] **4.2** 1.2 的 5 张隐藏表是否暴露，需管理员在 Admin → Table Metadata 决策（技术侧只读查证已完）。
- [ ] **4.3** 口径词典需一位业务 owner 逐条确认并把 `status` 改为 `approved`；冲突卡片（#46/#473/#125/#121/#120/#126）是否修改，由卡片作者决定。

---

## 已明确暂缓 / 不做（仅记录）

- ⛔ 真·结果集 EX（与金样结果集比对）：当前 EX 只表示"返回非空行"。
- ⛔ 全量 GraphRAG 语义层：schema 层确定性 18 边 FK 图 + 口径层零 LLM 共现图已够，未触发 recall<70% 闸门；瓶颈在推理组装与口径定义，不在检索。
- ⛔ `eval-online.ts` 及 Agent 侧任何改动：超出本文档范围（§0）。

---

## 建议执行顺序（综合 §11.11.5）

1. 阶段 0（提交） → 阶段 1（拍板）必须先于其它，否则基线会变。
2. 纯离线、不改线上的小项可并行穿插：2.7（`get_golden_set` 仅评测宣告）、2.3（描述匹配）、第 7 项补描述清单（已落 `bi-metadata-gaps.mjs`）。
3. 阶段 2 代码已于 2026-11-12 全部落地（含 2.2 离线复验），**不再需要开发**；剩下的只是阶段 1 拍板解锁线上效果，以及阶段 3 A/B 给出 2.4 等项的端到端净收益结论。
4. 阶段 4 签字贯穿全程，不阻塞代码，但决定评测口径标准。
