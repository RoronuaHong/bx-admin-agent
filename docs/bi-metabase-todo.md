# BI MCP 能力增强 — 待办清单（TODO）

> 来源：`docs/bi-metabase-optimization-plan.md` §11.9–§11.11 收口章节
> 生成时间：2026-11-12
> 范围：仅 `bi-metabase` MCP 层（`apps/agent-server/scripts/metabase-mcp.mjs` 等），Agent 侧 `src/**`、prompt、模型调用一律不动
> 状态图例：⬜ 待办 ｜ 🔶 待拍板（需业务/人工决策）｜ 🔧 待开发（写代码）｜ 🏃 待重跑｜ ✅ 已完成
> 边界提醒：`BI_EVAL_HOLDOUT_FILE` / `BI_EVAL_DISABLE_CALIBER` / `BI_CALIBER_INLINE_SQL` 只能在**命令行**设，**不得写进 `.env`**

---

## 阶段 0 — 收尾

- [ ] **0.1** 把 11-12 以来未提交的改动整理 `git commit`（当前停在 `4bab839`），保证后续评测报告对得上代码版本。本仓库不自动提交。

---

## 阶段 1 — 业务拍板（🔶 需你/业务方决策）

- [ ] **1.1** `with_values` 是否线上默认开启：开 → 换真·实测取值域，代价约 +1s/表首拉（缓存后 ≈1ms）；不开 → §4.3-2 过期枚举风险仍在，调用方可显式开启。
- [ ] **1.2** 5 张 Metabase 隐藏表是否请管理员暴露（`user_preference_actions_report` / `elt_sport_activity_guess` / `elt_sport_activity_winner` / `watch_log` / `user_watch_movie_activity_log`）：暴露后可补进 `tables` 白名单、7 例金样正常评 JoinCorrect。
- [ ] **1.3** 引用失效表的 3 例（#338 / #179 / #74）是否退出黄金集：退出会把基线从 96 例改为 93 例，历史数字不可直接比较。
- [ ] **1.4** 口径词典 8 条草稿逐条拍板（`apps/agent-server/bi-semantic/caliber-glossary.json`，当前全 `status: draft`）。重点先定：**已支付订单状态 3/6 含义、收入金额单位 `changeAmount` vs `amount`、报表时区、国家维度拆分（账号注册国 `elt_user_full.countryCode` vs 设备 IP 国 `elt_app_params.ipCountryCode`）、会员存量口径**。
- [ ] **1.5** 实体别名确认（第 1 项②）：IN8 / FOXA 等 ↔ 库内取值 `INGoogle5` / `FoxA` 等的对应关系，需业务确认后写进口径词典。
- [ ] **1.6** 第 2 项：黄金集隐含范围条件（如 #64 默认看 `FoxA`、#96 过滤 `INGoogle5`）是否作为默认应用口径进词典，还是补进题目（否则评测在考"猜题"）。

---

## 阶段 2 — 待开发（🔧 多数依赖阶段 1 拍板后改线上）

- [ ] **2.1** 第 3 项：查询闸门 `bi-query-guard.mjs` 改为读**已批准**词典条目（`enforce: reject/warn/不拦`）；"国家"拆成两个具名维度，不再一刀切禁 `ipCountryCode`。当前无批准条目，线上行为不变。
- [ ] **2.2** 第 5 项：口径图检索文本补表描述 + 字段描述 + 已批准别名（`glossaryTableTerms`，IDF 加权）；离线夹具 `bi-known-tables.json` 的 `tableTexts` 已导出，需离线验证召回不降再上线。
- [ ] **2.3** 第 6 项：`search_columns` 同时匹配 Metabase 字段描述；对不在 58 张白名单里的表标"Metabase 未暴露"。
- [ ] **2.4** 第 4 项：`get_caliber_context` 给前 1–2 张命中卡片附 SQL（每张 ≤1500 字，`BI_CALIBER_INLINE_SQL=0` 关闭作 A/B）。token 净影响需 A/B 验证。
- [ ] **2.5** 第 1 项③：新工具按值搜索（白名单维度列：应用/渠道/事件名/素材，缓存去重值，按问题词模糊匹配）。
- [ ] **2.6** 第 8 项：词典条目加 `ambiguous` 与候选项，`get_metric_definitions` 返回时带上歧义信号（是否追问由 Agent 决定，不越界）。
- [ ] **2.7** 第 9 项：`get_golden_set` 改为**仅评测/开发环境**宣告（生产不暴露），消除评测夹具泄漏风险。

---

## 阶段 3 — A/B 全量重跑（🏃 唯一能给出端到端结论）

- [ ] **3.1** 提交阶段 0 改动后，按 §11.8 步骤重跑：命令行设 `BI_EVAL_HOLDOUT_FILE=<绝对路径>`（对照组再加 `BI_EVAL_DISABLE_CALIBER=1`，均不写 `.env`）。
- [ ] **3.2** 先 `--case 125` 核对 `leaked=0`、`meta.arm` 与实际开关一致；若模型尝试取原卡片却没被拦，停下排查。
- [ ] **3.3** 两边各 2–3 轮全量：`--gap 15 --resume --arm caliber-on|caliber-off --out <报告>`。
- [ ] **3.4** 统计：按题配对精确 McNemar（单轮）/ 按题重抽样 bootstrap（多轮），同时报 pass^k；92 题 Wilson 区间约 ±10 个百分点，差距 <10 点不足以下结论。
- [ ] **3.5** 同时观察：`cardTablesFromSql` 改动后 `get_cards_for_table` / `get_related_cards` / 口径图线上输出影响；`get_caliber_context` 对 JoinCorrect 提升是否成立。
- [ ] **3.6** 成本约 400–600 次模型调用、2–2.5 小时，需重启 8787（当前服务运行中）。重跑前先完成阶段 0 + 阶段 1 拍板，否则题目/样本/工具输出/口径标准还会变，新基线很快作废。

---

## 阶段 4 — 人工签字（🔶 非代码可完成）

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
3. 拍板后做阶段 2 的 2.1/2.2/2.4/2.5/2.6，再走阶段 3 A/B 重跑。
4. 阶段 4 签字贯穿全程，不阻塞代码，但决定评测口径标准。
