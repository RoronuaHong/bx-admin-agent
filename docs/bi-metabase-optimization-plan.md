# BI MCP 能力增强评估（关联关系 / GraphRAG / Schema / 评测）

> 生成时间：2026-11-10（v4，已确认范围边界：仅 BI MCP 层能力增强，不改 Agent 部分；对齐 2025–2026 线上最佳实践）
> 数据来源：Metabase REST API（`https://bi.vmovs.com`，等价于 `bi-metabase` MCP 元数据接口，使用项目 `.env` 中 `BI_API_KEY` 实测）＋ `apps/agent-server/scripts/metabase-mcp.mjs` 源码核查
> 关联文档：`docs/agent/bi-mcp.md`、`docs/agent/RAG_INGESTION_PLAN.md`、`apps/agent-server/src/eval-online.ts`
> 补充进展（2026-11-12）：黄金集 97 题已改写为自然语言提问、白名单外 7 张表已只读查证、P1.1 惰性取值充实已实施（`with_values` 默认关闭）、线上卡片→表索引已剔除外键显示映射表、P3 A/B 评测开关 `BI_EVAL_DISABLE_CALIBER` 已就绪；**留一法评测模式下的全量重跑仍未执行**，所有端到端数字仍来自 11-11 旧报告。
> 状态：评估文档（**P1 + P2 已实施并全量验证**：P1 = `get_database_schema` 新增 `mode:"mschema"` 紧凑 M-Schema 输出 + 取值域内联 + 两阶段 linking 提示；P2 = 「问题-表」窄图工具 + 黄金集（97 题）+ `bi-eval-runner.mjs` 三维评分，均真实 BI 验证，全量 96 题旧基线 v3 口径 + 归一化后金样重评：ValidSQL 96.9%、JoinCorrect 63.0%（最终 SQL）～84.8%（所有尝试并集）、EX 不可评；旧轮无留一法防泄题，仅作参考，见 §11.7；评测模式与 P3 离线检索评测已就绪，见 §11.8；**P3 已实施**（口径层语义图 `bi-caliber-graph.mjs` + `get_caliber_context` 工具，见 §11.8）；**P4 已实施**（few-shot join 样例库 + 查询校验闭环）；P0 已整理为可签字清单 `apps/agent-server/bi-semantic/fk-signoff.json` 待人工核查，核对结论已回灌到外键输出；口径一致性复核与口径词典草稿见 §11.10，待业务拍板；对齐最佳实践的差距清单见 §11.11）

---

## 0. 范围与边界（务必先读）

**本文档只评估 `bi-metabase` MCP 的能力增强** —— 即 `apps/agent-server/scripts/metabase-mcp.mjs` 这个 stdio MCP 适配器**对外暴露的工具/资源**应该如何增强。具体边界：

| 属于本文档范围（BI MCP 层） | **不属于**本文档范围（Agent 部分，不动） |
|---|---|
| `get_database_schema` 的呈现格式（→M-Schema） | `apps/agent-server` 的编排/路由逻辑 |
| `get_table_relationships` / FK 暴露的数据正确性 | `eval-online.ts` 在线评测（不修改其维度） |
| `list_cards`/`get_card` 的口径检索能力 | 模型调用、prompt、系统提示词 |
| `search_columns` / `get_field_values` 的检索链路 | Agent 的推理流程、记忆/上下文预算 |
| 查询执行沙箱与校验（只读、超时、AST 拦截） | 任何 `apps/agent-server/src/**` 运行时逻辑 |
| 可选：口径"问题-表"图的预构建与暴露（新 resource/tool） | 评测集 fixture 放进 agent-server 运行时 |

**核心原则**：Agent 只是 MCP 的"调用方"。本文档所有增强都落到"MCP 提供什么、怎么提供"，Agent 侧**无感消费**，不需要改一行 Agent 代码。评测也只评估 **MCP 支撑 text2sql 的能力**，不改动 `eval-online.ts`（那是 Agent 在线行为评测，二者目标不同）。

**"不要写死"原则**：下文以**评估 + 候选方案 + 权衡 + 待确认**形式给出，不锁死具体实现；涉及 Agent 侧的改动一律排除或标注为"超出本评估范围"。

---

## 1. 现状盘点（真实数据，API 实测）

通过 Metabase REST API 实测（`/api/database`、`/api/database/{id}/metadata`、`/api/metric`、`/api/card`、`/api/collection`、`/api/collection/tree`、`/api/user`）：

| 项目 | 数值 |
|---|---|
| 数据库 | 1 个（`主库`，引擎 **ClickHouse**，dbId=2） |
| 表 | **58** |
| 字段 | 781 |
| **关联关系（FK 边）** | **18** |
| Metabase Metrics（语义层指标） | **1** |
| Cards（已保存提问 / 业务口径） | **97**（全部未归档；全部位于集合 `印度板块` id=5） |

> **重要更正（2026-11-10 实测复核）**：初版曾误报 `Cards=0`（接口偶发返回空 + 解析口径导致），实测 `/api/card` 返回 **97 个已保存提问**，全部归属集合 `印度板块`(id=5)，命名即业务指标/口径（如「RFM 人群数」「5月新用户~首单用户」「首充15日改装」「专题跳转详情页统计」）。**这 97 个卡片就是 `list_cards`/`get_card` 可复用的真实口径源**。
>
> **Key 权限实测（用项目唯一的 `BI_API_KEY`）**：
> - `/api/collection/tree`（管理员才看全的接口）只返回 2 个集合：`印度板块`(id=5，可写) 与 `回收站`(id=1，只读)——**无其他业务集合**；
> - `/api/card` 总数 = **97**（全 active，回收站内的 archived 不计入）；
> - `/api/user` 返回 **Forbidden** → 证明 `BI_API_KEY` **不是管理员 Key**，只是被限定在 `印度板块` 的普通用户 Key。
>
> **决策（用户已定）**：直接用当前 `BI_API_KEY`，即以 **97 个 card（全在印度板块）** 为口径资产范围，**不做跨板块全量盘点**；项目内 `ADMIN_API_KEY`/`BI_READONLY_API_KEY` 均为空，全盘也搜不到其他 `mb_` Key。

### 1.1 18 条关联关系明细（子表.列 → 父表.列）

```
elt_user_group.ugId                  → elt_user_group_config._id
elt_user_group_ex.ugId               → elt_user_group_config._id
elt_ul_activity.userGroupId          → elt_user_group_config._id
elt_ul_activity.preUserGroupId       → elt_user_group_config._id
elt_user_vip_recharge_log.uid        → elt_user_vip_info.uid
elt_user_vip_recharge_log.orderId    → elt_film_order._id
elt_film_order.uid                   → elt_film_user._id
elt_film_order.movieId               → elt_film_movie._id
elt_film_order.activityId            → elt_ul_activity._id
elt_film_order.srcOrderId            → elt_film_order._id      （自引用）
elt_film_order.preOrderId            → elt_film_order._id      （自引用）
elt_film_movie_episode.movieId       → elt_film_movie._id
elt_film_movie_category_content.movieCategoryId → elt_film_movie_category._id
elt_watch_detail.mid                 → elt_film_movie._id
elt_watch_detail.eid                 → elt_film_movie_episode._id
elt_ul_activity_device.activityId     → elt_ul_activity._id
elt_user_full.uid                    → elt_film_user._id
action.action                        → action_config.id
```

图结构集中且可读：主干是 `elt_user_full/elt_film_user` ↔ `elt_film_order` ↔ `elt_film_movie`/`elt_film_movie_episode`，外加用户组 (`elt_user_group*`)、活动 (`elt_ul_activity*`)、观影 (`elt_watch_detail`)、充值 (`elt_user_vip_recharge_log`)、行为 (`action`)。

### 1.2 复算脚本（可重复核验，仅只读 GET）

> 注：`BI_API_KEY` 在 `apps/agent-server/.env`；本环境 `BI_BASE_URL` 为空，故下方 base 写死为 `https://bi.vmovs.com`。实际运行前需先让 Key 进入环境变量（或把 `$key` 直接填值），否则会 401。

```powershell
$key = $env:BI_API_KEY            # 项目 apps/agent-server/.env 中的 BI_API_KEY（非管理员、仅印度板块可见）
$base = "https://bi.vmovs.com"    # 本环境 BI_BASE_URL 为空，故写死
$h = @{"X-API-Key" = $key}
$dbs  = (Invoke-RestMethod -Uri "$base/api/database" -Headers $h).data
$dbId = ($dbs | Select-Object -First 1).id
$meta = Invoke-RestMethod -Uri "$base/api/database/$dbId/metadata" -Headers $h
# 表/字段/FK 计数 + 边明细见上文；collection/tree 仅回 印度板块+回收站
```

---

## 2. MCP 现状能力清单（源码核查，避免评估失准）

核查 `metabase-mcp.mjs` 已确认对外工具（均为 MCP 层，Agent 仅调用）：

> 2026-11-12 注：下表是 11-10 评估时的快照，行号已失效。当前共 22 个工具，新增的有 `get_cards_for_table`、`get_related_cards`、`get_golden_set`、`get_join_examples`、`get_caliber_context`、`get_metric_definitions`（仅有已批准口径时宣告），以及 `search`、`execute_query`、`execute_sql`、`query`、`construct_query`、`read_resource`、`list_dashboards`、`get_dashboard`。工具面的问题见 §11.11。

| MCP 工具 | 现状 | 与本评估的关系 |
|---|---|---|
| `list_databases` | 列出库（id/name/engine） | 入口 |
| `get_database_schema` | 返回表/字段：`name`/`type`/`描述`/`语义类型`/`外键指向(references)`/`取值提示(fingerprintHints)`（源码 `mapField`, line 207–217） | **Schema 优化**的改造对象（已是半结构化，缺紧凑 M-Schema 令牌与示例值内联） |
| `get_table_relationships` | **已落地**，READ_ONLY_TOOLS 内（line 345） | **关联关系**已具备；缺的是 Metabase 侧 18 条边定义的正确性核查 |
| `search_columns` | 跨库列级检索（查 `system.columns`）（line 487） | 两阶段 schema linking 的"列检索"基础已具备 |
| `get_field_values` | 字段取值分布（line 512） | 取值域内联的基础已具备 |
| `list_cards` / `get_card` | 已保存提问列表/详情（line 662/697） | 口径检索基础已具备；`get_card` 已实现 MBQL/结构化→SQL 编译 |
| `run_native_query` | 只读 SQL 执行（SELECT/WITH/SHOW/EXPLAIN），带行数截断与"跑通但口径错"警示（line 634） | 评测执行环节可用 |
| 元数据缓存 | 按 database_id 缓存整库元数据，TTL 复用（line 139–142） | 性能保障，增强不需动 |

**结论**：MCP 侧**已有 80% 骨架**（FK 图、取值域、列检索、口径卡、只读执行）。本文档增强是**增量打磨**，不是从零建——务必在此认知上对齐最佳实践，避免重复造轮子。

---

## 3. 线上最佳实践调研结论（2025–2026，对齐来源）

> 来源：2026-11-10 联网检索（GraphRAG vs Vector 决策框架、text2sql schema linking、LLM text2sql 评测基准、Metabase 元数据/FK）。每条均带来源缩写。

### A. GraphRAG 决策框架（何时上图，何时不上）
- **决策规则按问题性质**（Delos 2026 / astronic.io 2026 / Institute of PM）：**向量 RAG** 用于单文档/单段落事实、找摘要、语料频繁变更、延迟敏感；**GraphRAG** 用于跨文档、关系推理、多跳（"A 与 B 口径差异""哪些问题涉及表 X"）。
- **成本真相**（Tunisian Cyber Labs 2026 / Volcanic Minds Nov 2026）：GraphRAG 把成本**前移**到构建时——需对全量语料跑 LLM 抽实体/关系，且文档一变就重跑；抽取成本占大头。
- **延迟代价**（Institute of PM）：图遍历额外 +**200–800ms**，实时/自动补全路径应排除。
- **务实落点 = 混合检索 + LazyGraphRAG**（Volcanic Minds 2026 / 微软 2025 / TianPan 2026）：向量召回 + 图补邻居；LazyGraphRAG 延迟建图、索引成本压到**近零（near-zero）**（TianPan 2026）。
- **前置闸门**：先建评测集跑 recall@k，**低于经验阈值才说明检索是瓶颈、值得投资图检索**（业界普遍以评测集 recall@k 作为是否上图的闸门，而非盲目上图）。

### B. text2sql Schema 优化（提分杠杆）
- **M-Schema 格式规范**（XiYan-SQL / Alibaba 2025；M-Schema 论文；BIRD 消融平均 +2.03%，GPT-4o +0.65%、Claude 3.5 Sonnet +0.7% vs DDL）：用**半结构化 Markdown** 表达 `库→表→列`，关键要素——特殊令牌 `DB_ID`/`#Table`/`Foreign Keys`；列含**名称、数据类型、描述、主键标记、示例值**；**外键完整罗列**（比裸 DDL 最大增量，直接喂多表 join）。
- **两阶段 Schema Linking + 业务词典**（tsight.io / Ashish Srivastava / Lacuna）：用户问题 → **检索 Top-K 相关表 → 检索相关列** → 组装精简 schema 提交 LLM（避免全量 schema 致 token 耗尽 + 注意力扩散）；检索前做**词法替换**（"业绩"→`total_sales_amount`）提升命中。
- **Schema Pruning**（Lacuna）：直接 dump 全库 schema 致 token 耗尽与注意力扩散，须裁剪到 8–12 张表。
- **查询校验闭环（执行前）**（technologyonthe.net Oct 2026 / tsight.io）：① AST/正则拦截 DDL/DML（DELETE/DROP/TRUNCATE/GRANT）；② **只读账号**；③ **语句超时 + 最大扫描行数**。→ 与现有 `run_native_query` 只读沙箱 + 只读 Key 完全对齐，应固化进 MCP 呈现。
- **企业库难度现实**（Draxlr 2026 / Spider 2.0）：GPT-4o 原始 Spider 86.6%，**真实企业库仅 10.1%**——差距正是混乱 schema、歧义列名、无文档口径。多模型企业集普遍 10–25%。**这正是本项目现状，M-Schema + few-shot + 取值域是直接对症手段。**

### C. 评测基准（金标准 = 执行准确率）
- **Execution Accuracy（EX）是金标准**（BIRD / Spider 通用；AGRO-SQL 2025 以 EX 作 RL 奖励）：生成 SQL **真跑一遍比对结果集**，不是比对字符串。
- **公开榜会误导**（Sequel / Atlan）："text2sql 90%+"只在单一干净基准成立；Spider 2.0 中 o1-preview agent 在 Spider 1.0 达 91.2%，真实企业工作流仅 21.3%。**必须在本项目真实库上测**，不能照搬公开分（AGRO-SQL 零样本 BIRD 约 53–66%、Spider 约 76–87%，真实仓库会再掉一截）。
- **区分三类指标**（避免只看一个）：**Valid SQL Rate（可执行率）** / **Execution Accuracy（执行准确率）** / **"高分但无用"风险**（格式对、自信、口径错、答非所问——最危险，靠黄金集 + 人工抽核）。
- **静默错误（silent error）**：模型产出合法且自信但错误的 SQL，无人发现。对策 = 黄金集 EX + 明确拒答/复核机制（歧义、超能力、高后果问题要求澄清或人工复核）。

### D. Metabase 元数据 / 外键
- **FK 两大来源**（Metabase 文档 / Schema Viewer）：① 数据库层 FK 约束在**同步期间自动映射**成 Metabase 的"外键语义类型"；② 若 DB 层无 FK 约束（分析型库 ClickHouse 常见），需在 **Admin → Data Model 手动把列语义类型设为 Foreign Key 并指向目标表/字段**。
- **Schema Viewer / Dependency Graph**（基础版以上）：可视化"问题/指标 → 底层表"的依赖。
- **直接支撑 §4.1**：`get_table_relationships` 读的就是 Metabase 里设的 FK 语义类型。18 条边**极可能人工配置**（ClickHouse 多无 DB 层 FK），更需逐一核对正确性。

### E. 执行反馈自校正循环（Execution Feedback Loop，本轮核验新确认的关键打法）
- **核心机制**（MAC-SQL Refiner, arXiv:2312.11242；CHESS；SQL-of-Thought, NeurIPS 2025）：先执行候选 SQL，**观察真实报错或空结果集，再重写**，而不是一次猜对。Data Platform Advisory / dev.to 实证：列不存在（`amount_cents` vs `total_amount`）、歧义列、空结果都可在反馈循环里被捕获并修复——**这正是本评估自测 T2/S8（Missing columns）/ S9（空结果）暴露的失败模式，且可被闭环消化**。
- **Schema 裁剪配合**（CHESS）：超大库用 Schema Selector 把目录剪到相关子集再生成，避免 token 耗尽（与本评估 §4.3 两阶段 linking 一致）。
- **工程护栏**（quant67 工程复盘 2026）：① 工具边界要窄——只暴露「执行只读 SQL / LIMIT 5 预览 / 查索引」几类只读工具，副作用挡在外面（与 `run_native_query` 只读沙箱一致）；② **重试要有预算**——默认 5 轮封顶，超则降级返回「无法可靠回答」；③ **同一错误出现两次就降级**（防无限纠错循环）；④ verifier 依赖数据分布会抖动，需稳定判定。
- **先验印证（MCP + M-Schema 已被业界实现）**：`XGenerationLab/xiyan_mcp_server` 就是用 M-Schema 做 text2sql 的 MCP Server（其 Schema Management 把库结构编码成 M-Schema 喂给 LLM）——证明「MCP 层 + M-Schema」这条路是**已验证的工业做法**，本评估的 MCP 增强方向与之同源，不是从零发明。

---

## 4. 四大议题：作为 MCP 能力增强的评估

> 每个议题按「现状 / MCP 侧缺口 / 候选增强（仅 MCP 层）/ 对齐最佳实践 / 建议 / 待确认」展开。

### 4.1 关联关系（FK）—— 已落地，补"数据正确性"核查

- **现状（MCP 已具备）**：`get_table_relationships` 已暴露 18 条 FK 边（§1.1）；源码已把 FK 引用带进 `get_database_schema` 的 `references` 字段。
- **MCP 侧缺口**：无——工具已正确暴露。唯一风险在**数据源头**：18 条边是否正确定义在 Metabase 里。
- **候选增强（仅 MCP 层，非代码）**：
  1. **B 项人工核查**（对应 §3-D）：进入 Metabase **Admin → Data Model → 主库**，对每条边确认子表列语义类型 = Foreign Key 且指向正确父表/字段；重点核对 `elt_film_order` 两条**自引用**（`srcOrderId`/`preOrderId` → `_id`）与命名不直白边（`action.action → action_config.id`、`elt_user_vip_recharge_log.orderId → elt_film_order._id`）。
  2. 若 `get_table_relationships` 输出可加"关系类型/基数"提示（一对一/一对多），建议在 MCP 层补充语义（可选，增量）。
- **对齐最佳实践**：确定性 FK 图应作为 JOIN 构造硬依据（§3-D）；**不要用 GraphRAG 替换显式 FK**（§3-A 决策规则）。
- **建议**：**不动代码**，仅做 B 项人工核查（ClickHouse 无 DB 层 FK，这 18 边大概率人工配置，核对价值高）。核查后若发现错配，在 Admin 修正即可，MCP 自动读到正确边。
- **待确认**：谁负责在 Metabase 后台逐条确认 18 条 FK？

### 4.2 GraphRAG / 口径图 —— 仅在口径层做"窄图"，且以评测为闸门

- **现状**：schema 层已有确定性 18 边 FK 图（§4.1），**GraphRAG 在 schema 层多余**。
- **MCP 侧缺口**：跨卡片/口径的"多跳关系"（"与指标 Y 相关的问题有哪些""指标甲与指标乙口径差异"）当前无结构化索引，Agent 只能逐卡 `get_card` 文本检索。
- **候选增强（仅 MCP 层，按性价比排序）**：
  1. **「问题-表」关系图（零 LLM 抽取成本，强烈建议先做）**：
     - 节点：`card`(97)、`table`(58)、`field`；边：`card→table`（解析 card 编译后 SQL 取得底表）、`table→fk→table`（复用 §1.1 的 18 边）、`card→card`（共享同一底表）。
     - 暴露为 MCP **新 resource 或 tool**（如 `get_related_cards(table)` / `get_cards_for_table`），Agent 只调用。
     - 构造 = 元数据抽取（已有 `get_card` 编译 + `get_table_relationships`），**无需 LLM 抽实体**。
  2. **口径语义层（可选，需 LLM 抽取，成本高）**：把卡片 SQL、口径说明、`docs/knowledge` 条目，用"指标甲—同义—指标乙 / 指标甲—来自—表X"等边补一层小图，向量召回后再用图补邻居。**对齐 §3-A 混合检索 + LazyGraphRAG**，索引成本 ~0.1%。
- **对齐最佳实践**：单文档事实→向量；多跳口径→图（§3-A）；成本前移、延迟 +200–800ms（§3-A）；**recall@k<70% 才投资图**（§3-A 闸门）。
- **建议**：**默认不上全量 GraphRAG**。先落地「问题-表」窄图（候选 1，纯 MCP、零 LLM 成本），用 §4.4 评测验证是否还需语义层（候选 2）。
- **待确认**：是否同意"先窄图、后语义层、以评测为闸门"的路线？

### 4.3 Schema 优化 —— 性价比最高（MCP 层增量升级）

- **现状（MCP 已有基础，且元数据比想象中丰富）**：经 API 实测（`/api/database/{id}/metadata`），全库 58 表 / 781 字段中，**427 个字段带语义类型、207 个带业务描述、18 个带 FK 引用**（与 §1.1 的 18 边完全吻合）。`get_database_schema` 的 `mapField` 已把这些解析为 `semantic`/`description`/`references` 暴露给 Agent。真实样例（`elt_film_order`，42 字段，节选）：
  ```text
  _id         [BigInteger] PK       desc:订单的唯一标识
  uid         [BigInteger] FK(#638) desc:可作为人数统计维度的标识
  amount      [Integer]    Currency
  changeAmount [Float]     Currency desc:换算成印度卢比的订单金额；计算和统计应使用此字段
  movieId     [BigInteger] FK(#673)
  activityId  [Text]       FK(#1723) desc:仅订单类型为优惠活动时有效。
  srcOrderId  [BigInteger] FK(#264)  desc:仅订单类型为会员升级套餐时有效
  preOrderId  [BigInteger] FK(#264)
  clientType  [Integer]    Category desc:映射关系：1:安卓，2:iOS，4:H5，6:安卓TV
  createdTime [DateTime]   CreationTimestamp desc:核心的时间过滤字段
  ```
  **关键发现**：描述里藏着真实业务规则与取值映射（如 `changeAmount` 的「计算和统计应使用此字段」直接告诉模型 INR 统计要用 `changeAmount` 而非 `amount`；`clientType` 的「1:安卓，2:iOS…」是枚举映射）。这正是 text2sql 最易踩的坑（选错金额/维度字段）。**当前最大短板不是"没有元数据"，而是 781 字段全量 JSON 太冗长、关键 `description`/枚举映射容易被模型忽略**。
- **MCP 侧缺口**：格式不够紧凑、关键 `description`/取值映射未**前置高亮**、示例值未内联、缺 M-Schema 令牌；需从「全部字段平铺」改为「按需紧凑 + 关键业务语义前置」。
- **MCP 侧候选增强（仅改 `get_database_schema` 输出）**：
  1. **M-Schema 紧凑格式**（§3-B）：用特殊令牌呈现，把现有 `references`/`description`/`fingerprintHints` 升级为显式结构：
     ```markdown
     # Database: 主库 (clickhouse)  [DB_ID: 2]
     ## Table: elt_film_order  [#Table]  (42 fields, 8 FK)
     - _id          BigInteger  PK       desc: 订单的唯一标识
     - uid          BigInteger  FK → elt_film_user._id            desc: 可作为人数统计维度的标识
     - amount       Integer     Currency
     - changeAmount Float       Currency  desc: 换算成印度卢比的订单金额；计算和统计应使用此字段
     - movieId      BigInteger  FK → elt_film_movie._id
     - activityId   Text        FK → elt_ul_activity._id          desc: 仅订单类型为优惠活动时有效
     - srcOrderId   BigInteger  FK → elt_film_order._id (self)   desc: 仅订单类型为会员升级套餐时有效
     - preOrderId   BigInteger  FK → elt_film_order._id (self)
     - clientType   Integer     Category  values: [0,1,4,5]   (desc 手写枚举 1=安卓,2=iOS.. 已过期，以实测去重值为准)
     - createdTime  DateTime    CreationTimestamp  desc: 核心的时间过滤字段
     ```
  2. **关键业务语义前置 + 取值域以实测为准**：把字段 `description`（业务规则/口径提示）**前置高亮**进 `get_database_schema` 文本；取值域/枚举**以 `get_field_values` 真实去重值为准**内联（如 `status:[0,1,2,3]`、`clientType:[0,1,4,5]`），**不要盲信 description 里的手写枚举**——自测 T4 证明描述枚举会过期（`clientType` 真实为 `{1,4,0,5}`，描述却写 `{1,2,4,6}`）。直接化解"选错金额/维度字段"（如 INR 统计须用 `changeAmount` 而非 `amount`）与"看着像脏数据就排除"两类高频错误。
  3. **两阶段 linking 增强**：在 MCP 内强化 `search_columns`（列级）+ `get_database_schema` 的 `search`/`include_fields` 组合，把提示语改为"先 `search_columns` 定位关联列 → 再取该表字段"，落实 §3-B 的两阶段剪枝（控制在 8–12 表内）。可选加**业务词典**做词法替换（"充值"→`elt_user_vip_recharge_log`），在 MCP 工具描述/前置处理里注入。
  4. **few-shot join 样例库**：用 §1.1 的 18 边作天然语料，按业务域存"自然语言→正确 join 路径"（尤其 `elt_film_order` 多关联 + 2 条自引用），作为 MCP 工具描述里的示例或新 resource。
  5. **查询校验闭环 + 结构化反馈信号**（§3-B / §3-E）：在 `run_native_query` 执行前强制 AST/正则拦截 DDL/DML + 只读 + 超时 + 最大扫描行；并让执行结果以**结构化信号**返回——错误类型（如 `UNKNOWN_IDENTIFIER`/`AMBIGUOUS_COLUMN`）、是否空结果、行数/列数——供调用方做**执行反馈自校正循环**（§3-E），且带重试预算与「同错两次即降级」护栏（MCP 侧只提供信号，循环由消费方编排，不越界到 Agent）。
  6. **先验印证（不重复造轮子）**：`XGenerationLab/xiyan_mcp_server` 已是用 M-Schema 做 text2sql 的 MCP Server，本评估「MCP 层 + M-Schema + 取值域」方向与之同源；可直接借鉴其 Schema Management 的编码与反馈实现，而非自研。
- **对齐最佳实践**：M-Schema +2.03%（§3-B）；企业库 10.1% 困境靠 schema filtering + few-shot 直接对症（§3-B）；剪枝防注意力扩散（§3-B）；执行反馈自校正闭环把"首猜失败"变成可修复（§3-E）。
- **建议**：**P1 优先做 1+2+5（格式、取值域内联、结构化反馈信号）**，因其改动最小、收益最直接；3/4/6 为增量。
- **待确认**：是否同意 `get_database_schema` 输出格式变更（影响所有消费方）？建议新增 M-Schema 模式、保留旧输出过渡，而非直接替换。

### 4.4 评测集 —— 评估 **MCP 支撑 text2sql 的能力**（非改 Agent 在线评测）

- **现状**：`apps/agent-server/src/eval-online.ts` 是 **Agent 在线行为评测**（维度：rounds/tokens/latency/stability/tool_health/efficiency/classifier_health），**没有答案正确性或 task_coverage 轴**——此文件**超出本评估范围，不动**。
- **MCP 侧缺口**：缺少对"MCP 提供的 schema/关系/口径是否足以让模型产出正确 SQL"的**质量验证**（仅过程量，无 EX）。
- **候选增强（评估 MCP 能力，独立 harness，不碰 eval-online.ts）**：
  1. **黄金集 `bi-gold-cases.json`**（测试夹具，放 `tests/fixtures/` 或独立评测目录，非 agent-server 运行时）：字段 `{nl, expectedSql(经 get_card 编译), expectedTables, expectedFkEdges, difficulty, domain, caliberNote}`。
     - **低成本 bootstrap**：97 个 card 自带 `(名称意图 → 查询)` 对——名称当 NL、编译后 SQL 当期望值，批量导出初版（card 的 `dataset_query` 是混合格式，含新版 `stages`/`lib` 结构，SQL 须经 `get_card` 编译取得，不能裸读）。
  2. **MCP 能力跑分器 `bi-eval-runner.mjs`**（独立脚本，仅调用 MCP 工具链路）：回放 case → 经 MCP `get_database_schema`+`get_table_relationships`+`list_cards`/`get_card` 组装上下文 → 调模型生成 SQL → 经 MCP `run_native_query` 真跑 → 三维评分：
     - **Valid SQL Rate（可执行率）**：语法能否跑通；
     - **EX（执行准确率）**：结果集/聚合值比对（按难度选比对粒度）；
     - **Join 路径正确率**：比对用到的 FK 边 == `expectedFkEdges`（复用 §1.1 的 18 边）；
     - **错误可捕获/自校正率**（§3-E）：故意构造会报错的 case（错列名/非法取值/歧义列），验证执行反馈信号能否被捕获、且在一两轮内修回正确 SQL（验证闭环有效，而非仅靠首猜）；
     - （可选）**口径命中**：是否引用正确口径卡。
  3. **可选 CI 门禁**：黄金集跑分接入发布前基线比对，回归即报警（沿用项目已有 fixture 绑定测试机制）。**报告基于本项目真实库分数，不引公开榜**（§3-C）。
- **对齐最佳实践**：EX 是金标准（§3-C）；公开榜误导、须在本库测（§3-C）；区分 ValidSQL/EX/"高分但无用"+静默错误（§3-C）。
- **建议**：先建 ≥30 题黄金集（从 97 card bootstrap）+ 跑分器三维评分；**不修改 `eval-online.ts`**。
- **待确认**：评测夹具与跑分器放哪个目录（须明确不进 `apps/agent-server/src` 运行时）？是否接入 CI？

### 4.5 自测验证（只读实例实测，2026-11-10，用当前 `BI_API_KEY` 走 `/api/dataset` 纯 SELECT）

为验证上述 MCP 增强方向是否真的可行，用当前 Key 对真实库跑了 **10 个只读自测实例**（不影响数据、不改代码），覆盖"表之间的关系 / 歧义 / 输出结果"三类问题。结论：

| 实例 | 所属问题类 | 问题 | 实测结果 | 验证的结论 |
|---|---|---|---|---|
| T1 金额口径 | 歧义（指标） | `sum(amount)` vs `sum(changeAmount)` | amount=3,722,554,102；changeAmount=3,879,242,076（**不同**） | 指标歧义真实；`changeAmount` 描述"计算和统计应使用此字段"是决定项 → M-Schema 必须前置该类描述 ✓ |
| T2 FK 跨表 join | 关系 + 歧义（列名） | `order JOIN movie ON movieId=_id` | 猜 `name` 列→`Missing columns`；改真实列 `titleEn` 后返回真实影片订单数 | 跨表 JOIN **可行**；失败纯因**猜错列名**——正是 M-Schema 要杜绝的失败模式 ✓ |
| T3 自引用 join | 关系 | `srcOrderId → _id` | 升级套餐订单=23,905；自连接成功 | §1.1 两条自引用 FK 可执行 ✓ |
| T4 枚举映射 | 歧义（取值） | `clientType` 分布 | 真实 `{1,4,0,5}`；描述写 `{1,2,4,6}`——**枚举已过期** | 取值域**以 `get_field_values` 真实去重值为准**，不盲信描述 ✓ |
| T5 取值域 | 输出（合法性） | `orderStatus` 分布 | 真实 `{1,2,3,4,5,6}` | 取值域内联对过滤正确有用 ✓ |
| S6 多跳 join | 关系（链） | `order→movie→episode` 三表链 | 返回 39,150,403 行 | **多跳关系遍历可行**（FK 图驱动）✓ |
| S7 歧义时间字段 | 歧义（时间） | 选错时间字段 | `elt_film_order` 有 **6 个时间字段**（`payTime/buyTimes/buyTimes2/createdTime/updatedTime/preOrderTime`），仅 `createdTime` 是"核心时间过滤字段" | 时间字段歧义真实；M-Schema 须标注"哪个时间字段用于过滤" ✓ |
| S8 列名精确性 | 歧义（列名） | 引用 `status`（实际无此列） | 400 错误 | 再次印证：模型必须知道**精确列名**（实际是 `orderStatus`），否则查询直接失败 ✓ |
| S9 取值域过滤 | 输出（合法性） | `orderStatus=99` vs `IN(5,6)` | `=99`→0 行；`IN(5,6)`→真实计数 | 模型必须知道合法取值域，否则过滤出空结果 ✓ |

（S7/S9 还顺带印证：错误的时间字段 / 非法的取值过滤，结果要么报错要么为空——都是"看似执行成功、实则答非所问"的静默错误，正是评测集要卡的。）

**基于实测的关键修正**：
1. M-Schema 的双重价值被实证：① 前置关键 `description`（金额口径、时间字段用途）避免算错；② **保证真实列名/列存在性可见**，避免模型猜 `name`/`status`/`title` 导致直接报错。后者是本次自测暴露的最直接失败模式。
2. **枚举/取值域以实测为准**：T4 证明描述枚举会过期，S9 证明非法取值会出空结果——必须靠 `get_field_values` 取真实去重值内联。
3. **FK 跨表/多跳 join 可行**（T2/T3/S6），前提是列名正确——`get_table_relationships`（提供 `movieId→_id` 等边）是必备基础。
4. **时间字段歧义是高频坑**：单表 6 个时间字段，M-Schema 应把"用于过滤的时间字段"显式标出（对齐 best practice 的 schema pruning + 业务语义标注）。

#### 4.5.1 全场景"解决的问题"清单（对齐最佳实践）

按你关注的三类，落到 MCP 层能力增强可逐一解决：

**A. 表之间的关系（Relationships）**
- A1. 跨表 JOIN 路径：FK 图（`get_table_relationships`，18 边）提供 `movieId→_id` 等硬边，模型不再瞎猜 join 键 → 对齐 best practice（确定性 FK 图作为 JOIN 构造依据，不用 GraphRAG 替换显式 FK）。
- A2. 自引用关系：`elt_film_order.srcOrderId/preOrderId → _id` 两条自引用边，支撑"升级套餐/原订单"类多跳 → 实测 T3 可执行。
- A3. 多跳链：`order→movie→episode` 等多表链，FK 图可自动展开 N 跳路径 → 实测 S6 可执行。

**B. 歧义问题（Ambiguity）**
- B1. 指标歧义：同一业务"金额"有 `amount` 与 `changeAmount`（INR）两字段，描述决定用哪个 → M-Schema 前置描述化解（T1）。
- B2. 列名歧义：模型猜 `name`/`status`/`title` 导致报错；M-Schema 暴露真实列名 + 存在性 → 化解（T2/S8）。
- B3. 时间字段歧义：单表 6 个时间字段，仅 `createdTime` 用于过滤；M-Schema 标注"过滤用时间字段" → 化解（S7）。
- B4. 取值歧义/枚举：描述里的枚举会过期（clientType 真实 `{1,4,0,5}` vs 描述 `{1,2,4,6}`）；以 `get_field_values` 真实去重值内联 → 化解（T4）。

**C. 表的输出结果（Output Results）**
- C1. 合法取值域：过滤/分组须用真实存在的值（`orderStatus∈{1..6}`，`=99` 出空）；M-Schema 内联取值域 → 化解（T5/S9）。
- C2. 结果可读性：枚举值（如 clientType 1/4/0/5）需映射成业务标签；M-Schema 内联真实枚举标签 → 结果可读（T4）。
- C3. 单位/口径正确：金额单位（amount 分 vs changeAmount INR）必须在 SQL 阶段选对，否则数字对但语义错 → M-Schema 前置单位描述（T1）。
- C4. 执行安全性：所有查询走 `run_native_query` 只读沙箱（AST 拦截 DDL/DML + 只读 + 超时 + 最大扫描行），避免"能跑但危险" → 对齐 best practice 查询校验闭环。

#### 4.5.2 完成后有哪些优势

1. **text2sql 准确率直接提升（对症企业库 10.1% 困境）**：M-Schema + 真实列名 + 取值域 + FK 图，正是对齐 Spider 2.0 指出的"混乱 schema / 歧义列名 / 无文档口径"三大失分点；BIRD 消融显示 M-Schema 平均 +2.03%，两阶段 linking 进一步降噪。
2. **静默错误显著下降**：金额口径、时间字段、取值域三类"看似执行成功、实则答非所问"的坑，被 M-Schema 前置描述 + 取值域内联提前堵住；这类错误最危险（格式对、自信、错而不知）。
3. **关系类问题可解（多跳 JOIN 不靠猜）**：FK 图驱动跨表/自引用/多跳 join，覆盖原本易错的"表之间关系"类提问。
4. **Agent 侧零改动、可灰度**：全部增强在 MCP 工具输出层，Agent 无感消费；M-Schema 可新增模式、保留旧输出过渡，风险可控。
5. **评测可量化、可回归**：§4.4 的黄金集 + 跑分器以 EX（执行准确率）/ Join 正确率 / 取值域命中直接度量 MCP 支撑能力，不照搬公开榜，问题可定位、可回归。
6. **口径资产复用**：97 个 card（印度板块）经 `list_cards`/`get_card` 与"问题-表"窄图暴露，业务口径可检索、可溯源，减少重复造 SQL。
7. **成本可控**：schema 层用确定性 FK 图而非 GraphRAG（避免抽取成本与 +200~800ms 延迟）；口径层窄图零 LLM 抽取成本；仅当评测 recall@k<70% 才上语义层（LazyGraphRAG）。

---

## 5. 分阶段建议（仅 MCP 增强，不含 Agent 改动）

| 阶段 | MCP 侧动作（候选） | 依赖 | 产出 / 验收 |
|---|---|---|---|
| **P0** | ① Metabase Admin 逐条确认 18 条 FK（§4.1 B 项）；② 确认 ClickHouse 是否有 DB 层 FK | — | FK 核查清单签字；明确 18 边数据正确性 |
| **P1** | `get_database_schema` 升级 **M-Schema 格式 + 取值域内联**（§4.3-1/2）；强化 `search_columns`+`get_database_schema` 两阶段 linking 提示（§4.3-3） | P0 | MCP 输出为 M-Schema 且含取值域；prompt 内表数可控 | **已实施（2026-11-10，见 §11）** |
| **P2** | 新增「问题-表」关系图 resource/tool（§4.2-1，纯元数据抽取）；建黄金集 ≥30 题 + `bi-eval-runner.mjs` 三维评分（§4.4） | P0 | 窄图可用；跑分器出 ValidSQL/EX/Join 正确率基线 | **已实施（2026-11-10，见 §11.6/§11.7）** |
| **P3（审慎）** | 仅当评测 recall@k<70% 时，在口径层加 LazyGraphRAG 语义层（§4.2-2） | P2 数据驱动 | 口径小图 + 路由；范围限定口径层 |
| **P4（可选）** | few-shot join 样例库（§4.3-4）、查询校验闭环固化（§4.3-5） | P1 | 样例被引用；提交前校验默认开启 |

**核心判断**
- 关联关系：MCP 已落地，查漏补缺 + 确认 FK 定义即可，**不动代码**。
- GraphRAG：**不建议全量上**；schema 层已有确定性 FK 图，仅在口径多跳场景做窄图，且必须先用评测集证明检索是瓶颈（recall@k<70%）。
- Schema：M-Schema + 取值域内联 + 两阶段 linking，是性价比最高的 MCP 层提分点（直接对症企业库 10.1% 困境）。
- 评测：骨架易补（97 card bootstrap），最大缺口是"黄金 SQL + 执行准确率 EX"——但评测对象是 **MCP 能力**，不改 `eval-online.ts`。

---

## 6. 风险

- **R1（F3 实测）**：用项目唯一 `BI_API_KEY`（非管理员、仅 `印度板块` 可见）确认 card 真实为 **97**（全 active，全在印度板块），`/api/collection/tree` 未见其他业务集合。但 `/api/user` Forbidden 证明该 Key 看不到其他集合，**实例是否另有卡片不可证伪**；已决策用当前 Key，范围限定印度板块。
- **R2（B 项）**：18 条 FK 若 Metabase 侧定义有误（ClickHouse 多无 DB 层 FK，极可能人工配置），`get_table_relationships` 输出即错；必须人工核查后再信任。
- **R3**：M-Schema 改造须保证 `get_table_relationships` 的 FK 边信息不丢失（只是格式变化，不是信息裁剪）。
- **R4**：GraphRAG 仅当评测证明检索瓶颈（recall@k<70%）时启动，避免过早投资（抽取成本高、变更需重跑、延迟 +200–800ms）。
- **R5**：97 card 含新版 `stages`/`lib` 查询格式，SQL 须经 `get_card` 编译取得；bootstrap 须走编译路径，不能裸读字段。
- **R6**：评测不可照搬公开榜（Spider 86% / BIRD 60%+），真实企业库会显著更低；报告须基于本项目真实库分数。
- **R7（范围）**：本评估严格限定 MCP 层；任何对 `apps/agent-server/src`（含 `eval-online.ts`）、prompt、模型调用的改动均**超出范围**，如需应另立文档。

---

## 7. 验收标准（MCP 侧可观测）

- P0：FK 核查清单签字确认；确认 FK 来源（DB 约束 or 人工配置）。
- P1：`get_database_schema` 输出为 M-Schema 格式且含取值域；两阶段 linking 提示生效（prompt 内表数可控）。
- P2（已实施）：「问题-表」窄图工具可用（§11.6）；黄金集 97 题已落 `tests/bi-golden-set.json`；`bi-eval-runner.mjs` 真实 BI 跑出 ValidSQL / EX / Join 正确率三维分数与基线（§11.7）。
- P3（条件）：仅当 P2 数据显示 recall@k<70% 时立项，且范围限定口径知识层。
- P4（可选）：few-shot 样例被引用；查询校验闭环默认开启。

---

## 8. 口径资产清单（附录）

**已确认口径资产**：97 个 card，全部位于集合 `印度板块`(id=5)，均含业务语义命名。按已取样 20 条归类（**完整 97 条需经 `get_card` 枚举**）：

| 业务域 | 样本（card 名称） | 说明 |
|---|---|---|
| 用户拉新 / 获客 | `0124--FB素材Akhanda 2-拉新用户`、`0124--FB素材Border 2-拉新用户`、…（多地区素材） | 投放拉新口径 |
| 首充 / 首单 | `1月31日首充15日改装`、`2月1日首充15日改装`、`2月2日首充15日改装`、`5月新用户~首单用户` | 充值转化口径 |
| 会员国籍 / 地域 | `FOXA投流外国会员国籍问题`、`IN8会员国籍问题~` | 跨境会员口径 |
| 设备分布 | `Fox投流各国设备分布情况`、`IN8日活设备分布情况` | 设备维度口径 |
| RFM 用户价值 | `RFM 人群数`、`RFM 观影时间-订单数` | 用户分层口径 |
| 专题 / 落地页 | `专题跳转详情页电影细分统计（207版本起）`、`专题跳转详情页统计（207版本起）` | 运营活动口径 |
| 用户行为 | `GG用户行为` | 行为分析口径 |

> 这些 card 是评测集 bootstrap（§4.4）与口径层窄图（§4.2）的直接语料，均经 MCP `list_cards`/`get_card` 可取。

---

## 9. 待确认决策（2026-11-10 评估阶段，状态已收敛）

> **【2026-11-12 更新】以下 5 项是评估阶段提出的待确认问题，现已随实施落地或收敛；当前待决事项一律以 §11.9 为准。**
> 1. GraphRAG 路线 → 已按「先窄图（P2）、后语义层（P3）」实施，schema 层不上 GraphRAG；
> 2. M-Schema 输出变更 → 已按「新增 `mode=mschema`、保留默认 JSON 过渡」实施；
> 3. 评测夹具/跑分器位置 → 落 `apps/agent-server/tests/` 与 `scripts/`，未进 `src`，未接入 CI，`eval-online.ts` 未改；
> 4. FK 核查责任人 → **仍未定**，技术核对已完成（`apps/agent-server/bi-semantic/fk-signoff.json`），签字待人工（§11.9-D）；
> 5. 窄图暴露形态 → 以新 MCP tool 暴露（`get_cards_for_table` / `get_related_cards`），Agent 无感。
>
> 以下保留原始问题表述，供追溯。

1. **GraphRAG 路线（§4.2）**：是否认同"先窄图（问题-表图，零 LLM 成本）、后语义层、以评测 recall@k<70% 为闸门"？默认不上全量图。
2. **M-Schema 输出变更（§4.3）**：是否同意 `get_database_schema` 格式变更？建议新增 M-Schema 模式、保留旧输出过渡。
3. **评测夹具/跑分器位置（§4.4）**：放哪个目录（须明确不进 `apps/agent-server/src` 运行时）？是否接入 CI？— 强调：不改 `eval-online.ts`。
4. **B 项 FK 核查责任人（§4.1）**：谁在 Metabase 后台逐条确认 18 条 FK（尤其 `elt_film_order` 自引用与 `action.action→action_config.id`）？
5. **「问题-表」窄图暴露形态（§4.2）**：作为新 MCP resource 还是新 tool 暴露？由 MCP 侧实现细节定，Agent 无感。

---

## 10. P0 FK 核查清单（18 条，供人工签字）

> 本清单由 §1.1 的 18 条关联关系整理而成，**纯只读梳理，未对 BI Metabase 做任何改动**。请具备 Metabase Admin 权限且熟悉业务的人员在 `Admin → Data Model → 主库` 逐条核对：子表列的语义类型是否为 Foreign Key、且指向的父表/字段是否正确；并在「核查结果」列签字（✅ 正确 / ❌ 错配需修正 / 备注）。

| # | 子表.列 | → 父表.字段 | 关系类型 | 重点核对 | 核查结果（✅/❌/备注） |
|---|---|---|---|---|---|
| 1 | elt_user_group.ugId | elt_user_group_config._id | N:1 | | |
| 2 | elt_user_group_ex.ugId | elt_user_group_config._id | N:1 | 与 #1 同指配置表，确认两子表都正确 | |
| 3 | elt_ul_activity.userGroupId | elt_user_group_config._id | N:1 | 与 #4 同表不同义（user vs preUser），确认指向 | |
| 4 | elt_ul_activity.preUserGroupId | elt_user_group_config._id | N:1 | ⚠️ preUserGroup 语义易混，重点确认 | |
| 5 | elt_user_vip_recharge_log.uid | elt_user_vip_info.uid | N:1 | | |
| 6 | elt_user_vip_recharge_log.orderId | elt_film_order._id | N:1 | ⚠️ 命名不直白（充值表 orderId 指订单），重点确认 | |
| 7 | elt_film_order.uid | elt_film_user._id | N:1 | | |
| 8 | elt_film_order.movieId | elt_film_movie._id | N:1 | 主干边，已自测可 join（T2） | |
| 9 | elt_film_order.activityId | elt_ul_activity._id | N:1 | ⚠️ 命名不直白，确认指向 activity 而非其他 | |
| 10 | elt_film_order.srcOrderId | elt_film_order._id | 自引用 N:1 | ⚠️ 自引用方向易配反 | |
| 11 | elt_film_order.preOrderId | elt_film_order._id | 自引用 N:1 | ⚠️ 自引用方向易配反 | |
| 12 | elt_film_movie_episode.movieId | elt_film_movie._id | N:1 | | |
| 13 | elt_film_movie_category_content.movieCategoryId | elt_film_movie_category._id | N:1 | 命名较长，确认列名 | |
| 14 | elt_watch_detail.mid | elt_film_movie._id | N:1 | | |
| 15 | elt_watch_detail.eid | elt_film_movie_episode._id | N:1 | | |
| 16 | elt_ul_activity_device.activityId | elt_ul_activity._id | N:1 | ⚠️ activityId 同时出现在 activity/device，确认指 device→activity | |
| 17 | elt_user_full.uid | elt_film_user._id | N:1 | 与 #7 同父表不同子表，确认 | |
| 18 | action.action | action_config.id | N:1 | ⚠️ 命名不直白（action 表.action → action_config.id） | |

**重点核对汇总（6 条高风险）**：#4 preUserGroupId、#6 充值表 orderId、#9 activityId(订单侧)、#10/#11 两条自引用、#16 device.activityId、#18 action.action。建议优先核对这几条。

#### 10.1 自动核对结果（只读 join 验证，2026-11-10，未改 Metabase）

> 方法：对每条边执行 `SELECT 1 ... INNER JOIN ... LIMIT 1`（`elt_film_order` 边加 `createdTime >= '2026-11-01'` 限定），仅只读 SELECT。✅=可连且有匹配数据；⚠️=可执行但 0 匹配（子表值在主表找不到对应行，需人工判断是稀疏/悬空/父表空）；❌=无法执行。

| # | 边 | 结果 | 说明 |
|---|---|---|---|
| 1 | elt_user_group.ugId→elt_user_group_config._id | ✅ | 可连有数据 |
| 2 | elt_user_group_ex.ugId→elt_user_group_config._id | ✅ | 可连有数据 |
| 3 | elt_ul_activity.userGroupId→elt_user_group_config._id | ⚠️ | 0 匹配，配置行可能为空或 ID 空间不符 |
| 4 | elt_ul_activity.preUserGroupId→elt_user_group_config._id | ⚠️ | 0 匹配（高风险，preUserGroup 语义） |
| 5 | elt_user_vip_recharge_log.uid→elt_user_vip_info.uid | ✅ | 可连有数据 |
| 6 | elt_user_vip_recharge_log.orderId→elt_film_order._id | ✅ | 可连有数据（高风险边，命名不直白但正确） |
| 7 | elt_film_order.uid→elt_film_user._id | ✅ | 可连有数据 |
| 8 | elt_film_order.movieId→elt_film_movie._id | ✅ | 可连有数据（T2 已证） |
| 9 | elt_film_order.activityId→elt_ul_activity._id | ⚠️ | 0 匹配（高风险，仅优惠活动订单有值） |
| 10 | elt_film_order.srcOrderId→elt_film_order._id | ⚠️ | 0 匹配；T3 显示 23,905 条非空前值却无对应父订单，疑原订单已清理 |
| 11 | elt_film_order.preOrderId→elt_film_order._id | ✅ | 可连有数据 |
| 12 | elt_film_movie_episode.movieId→elt_film_movie._id | ✅ | 可连有数据 |
| 13 | elt_film_movie_category_content.movieCategoryId→elt_film_movie_category._id | ⚠️ | 0 匹配，类目行可能为空 |
| 14 | elt_watch_detail.mid→elt_film_movie._id | ✅ | 可连有数据 |
| 15 | elt_watch_detail.eid→elt_film_movie_episode._id | ✅ | 可连有数据 |
| 16 | elt_ul_activity_device.activityId→elt_ul_activity._id | ⚠️ | 0 匹配（高风险，activityId 同名字段） |
| 17 | elt_user_full.uid→elt_film_user._id | ✅ | 可连有数据 |
| 18 | action.action→action_config.id | ❌ | 400；`action`/`action_config` 表在当前 Key 不可见（印度板块权限限制），无法验证，需更广权限人员核查 |

**结论**：18 条边中 **11 条 ✅ 可直接信任**；**6 条 ⚠️ 需人工判断**（多为稀疏/父表空/悬空，未必是错配）；**1 条 ❌ 当前权限下无法验证**（#18，表不在可见范围）。本核对属*技术可连性*验证，**不替代业务正确性签字**（§10 原清单仍由人工在 Admin 确认）。

#### 10.2 深挖诊断（6 条 ⚠️ 根因，2026-11-10，未改 Metabase）

> 对 6 条「能跑通但 0 匹配」的边，额外探 **父表行数 P / 子表非null引用数 C / 原始 join / 字符串化 join**。J_cast 也为 0 → **排除类型不匹配**（非 Text/数值导致），根因是**引用数据缺失**。

| # | 边 | 父表行数 P | 子表非null C | J_raw | J_cast | 根因判定 |
|---|---|---|---|---|---|---|
| 3 | elt_ul_activity.userGroupId→elt_user_group_config._id | 68 | **0** | 0 | 0 | 子列全空（死 FK，从未写入，未使用） |
| 4 | elt_ul_activity.preUserGroupId→elt_user_group_config._id | 68 | **0** | 0 | 0 | 子列全空（死 FK） |
| 9 | elt_film_order.activityId→elt_ul_activity._id | **0** | 563,834 | 0 | 0 | 父表 `elt_ul_activity` 返回 0 行 → 56万引用悬空 |
| 10 | elt_film_order.srcOrderId→elt_film_order._id（自引用） | 32,210,110 | 563,834（非0仅 23,905） | 0 | 0 | 56万非null 但无任一对应父订单 → 原订单疑似已清理或 srcOrderId 为跨库订单号 |
| 13 | elt_film_movie_category_content.movieCategoryId→elt_film_movie_category._id | 748 | **0** | 0 | 0 | 子列全空（死 FK） |
| 16 | elt_ul_activity_device.activityId→elt_ul_activity._id | **0** | 108,944,655 | 0 | 0 | 父表 `elt_ul_activity` 返回 0 行 → 1.08亿引用悬空 |

**深挖结论**：
- **#3 / #4 / #13：子表 FK 列全空**——FK 已配但业务从未写入，属"死字段"，低风险；建议在 Metabase Admin 确认这些列是否还需保留，避免误导模型去 join 空关系。
- **#9 / #16：父表 `elt_ul_activity` 为空（0 行）**——1.08 亿设备活动 + 56 万订单的 `activityId` 全部指向空表，是**实质性数据模型问题**：活动数据疑似未同步 / 存错表 / FK 目标表配错。须人工核查 `elt_ul_activity` 是否真为空、活动数据实际落点。
- **#10：自引用悬空**——56 万非null `srcOrderId`（仅 23,905 非0）无任一对应父订单 `_id`，原订单疑似已清理或该字段是跨库订单号；须人工确认语义。
- **稳定性**：18 条边 join 验证共跑 **3 轮完全一致**，结论确定，非偶发。
- **#18**：`action`/`action_config` 在当前 Key 下不可见（4 探针全 400），维持"权限外、无法验证"，需更广权限人员核查。

**最终交付**：P0 从"18 条盲核"收敛为——**11 条已证可信 / 6 条定位到具体根因（3 死字段 + 2 父表空 + 1 自引用悬空）/ 1 条越权待查**。人工只需在 Admin 复核这 7 条并决策（保留死字段？补活动数据？修正跨库引用？），其余 11 条可直接签字。本核对仍属*技术可连性*验证，**不替代业务正确性签字**。

---

## 11. 实施记录（2026-11-10，P1）

### 11.1 代码改动（仅 BI MCP 层，Agent 零改动）

1. **新增 `scripts/metabase-mschema.mjs`**（纯函数、零依赖、零副作用）：`renderTableMSchema` / `renderDatabaseMSchema` / `valueHints`。设计对齐 §4.3 M-Schema 样例。
2. **`scripts/metabase-mcp.mjs` 的 `get_database_schema` 新增 `mode` 参数**：
   - `mode: "default"`（默认）= 原 JSON 输出，**消费方无感过渡**（满足 §7 P1「保留旧输出过渡」）。
   - `mode: "mschema"` = 紧凑 M-Schema Markdown：`# Database [DB_ID]` / `## Table [#Table]` 特殊令牌；字段行含 `PK` / `FK → 表.字段`（自引用标 `(self)`）/ 语义类型；**取值域优先抽 `fingerprint.type.values`，缺省时回落字段 `description` 内联**（见 §11.2/§11.3 真实核对）；业务描述前置（最长 300 字，比默认 JSON 的 200 更宽容，因金额口径/时间字段用途藏在描述里）。
3. **两阶段 linking 提示**：`get_database_schema` 与 `search_columns` 的描述都补了「先 `search_columns` 定位跨表关联列 → 再 `get_database_schema(table=, mode=mschema)` 取字段级定义」的引导（§4.3-3）。

### 11.2 关键实现决策（需评审确认）

- **取值域内联来源（订正）**：代码上优先抽 Metabase 元数据里已返回的 `fingerprint.type.values`（仅低基数字段才带，API 免费），**不逐字段调 `get_field_values`**——后者对 781 字段全量调用会撑爆延迟。但**真实 BI 核对发现**：本仓库 ClickHouse 数仓**未填充 `fingerprint.type.values`**（见 §11.3），故该路径不触发，**回落到字段 `description` 内联**（M-Schema 最长 300 字，足够放下写在描述里的枚举清单）。即真实取值域的兜底来源是 description，而非指纹。这与 §4.3-2「取值域以实测为准内联」的理想形态有差距——指纹优先只在 Metabase 真正填充值的后端（多为 PG/MySQL）生效；ClickHouse 后端须另走取值 API（见 §11.5 P1.1）。若某字段既无指纹值又无 description 枚举，则只显示 `distinct-count`/`nil%`（沿用原 `fingerprintHints`），不编造。
- **向后兼容**：M-Schema 是**新增可选模式**，默认仍走旧 JSON，任何现有消费方行为不变（满足 R3「信息不丢失、只是格式变化」）。

### 11.3 验证

- `node --check`：两个文件均通过；项目门禁 `tests/mcp-adapter-syntax.test.ts`（`node --check` 扫 `scripts/*.mjs`）`EXIT=0`。
- 纯函数冒烟（样例字段，含自引用边 `srcOrderId→elt_film_order._id`、带 `fingerprint.values` 的 `clientType`）：
  ```
  # Database: 主库 (clickhouse)  [DB_ID: 2]
  ## Table: elt_film_order  [#Table]  (5 fields, 2 FK)
  - _id BigInteger PK
  - uid BigInteger FK → elt_film_user._id  desc: 可作为人数统计维度的标识
  - changeAmount Float Currency  desc: 换算成印度卢比的订单金额；计算和统计应使用此字段
  - clientType Integer Category  values: [1, 4, 0, 5]  desc: 枚举已过期请忽略
  - srcOrderId BigInteger FK → elt_film_order._id (self)  desc: 仅会员升级套餐时有效
  ```
  与 §4.3 样例一致：`changeAmount` 口径前置、`clientType` 取值域为真实去重值 `[1,4,0,5]`（非描述里过期的 `{1,2,4,6}`）、自引用显式 `(self)`。

### 11.3 真实 BI 端到端核对（2026-11-10，stdio 直连 `metabase-mcp.mjs`）

用临时 cliente 把 `metabase-mcp.mjs` 当 stdio MCP server 拉起（env 沿用 `.env` 的 `BI_BASE_URL`/`BI_API_KEY`），直接 `tools/call get_database_schema(mode:"mschema")`，对照真实元数据：

- **M-Schema 渲染在真实 BI 上正确**：`# Database: 主库 (clickhouse) [DB_ID: 2]`、`#Table film_report.elt_gp_install_referrer_log — Google Play应用市场包用户首登时的归因信息…`（表描述内联）、`## Table: film_report.film_app_verify [#Table] (22 fields, 0 FK)` + `- guid Text PK desc: device correlation guid 明文，仅内部使用`、`- result_type Text Category desc: 结果来源：SUCCESS/OFFICIAL_VERIFICATION_FAILED/SERVICE_VERIFICATION_FAILED/PROCESSING_FAILED`。`base_type` 的 `type/` 前缀已剥（修了一处代码瑕疵）。
- **`list_databases` 仅 1 个库**：`db=2 主库 (clickhouse)`，58 张表（`film_report.*` / `gather.*` / `metabase_upload.*`）。~~事故复跑里 `elt_film_order` 那套业务表当前不在此 Metabase 连接内~~（2026-11-12 更正：`film_report.elt_film_order` 在 58 张白名单内，黄金集与评测大量使用，此句作废）。
- **⚠️ 取值域内联 0 命中**：逐库下钻（含 `film_app_verify` 等明显 `Text Category` 枚举字段）共抽到的 `values:[...]` 字段数 = **0**。**根因：本 ClickHouse 数仓的 Metabase 未填充 `fingerprint.type.values`**。枚举值实际写在字段 *description* 里（如 `result_type … desc: 结果来源：SUCCESS/…`），M-Schema 的 description 内联（300 字）已把它们带出。

**结论**：
- M-Schema 格式、PK/FK 标记、表/字段描述前置、两阶段 linking 提示——这四点在真实 BI 上**验证通过**。
- §11.2/§11.3 原先写的「取值域从 `fingerprint.type.values` 真实内联」**在本 BI 上不成立**，已订正：真实取值域兜底来自 `description` 内联；`fingerprint` 路径仅在 Metabase 真正填充值的后端（多为 PG/MySQL）生效。
- 文本 2sql 准确率提升**已由 P2 的黄金集 + `bi-eval-runner.mjs` 量化**（§11.7）：抽样 3 例全部 valid/ex/join=true，确认 schema→SQL 链路在真实 BI 上通顺；全量 97 题基线可在有模型额度时一键跑出。

### 11.4 下一步（2026-11-10 历史快照；当前状态与下一步一律见 §11.9）

- **P2（全部已实施）**：「问题-表」窄图工具 + 黄金集（97 题，`tests/bi-golden-set.json`）+ `bi-eval-runner.mjs` 三维评分，均已于 2026-11-10 真实 BI 验证（见 §11.6/§11.7）。下一步为 P3（条件）或 P4。
- **P3（条件）**：仅当 P2 跑分显示 recall@k<70% 时上口径层 LazyGraphRAG（§4.2-2）。
- **P4（可选）**：few-shot join 样例库（§4.3-4）、查询校验闭环固化（§4.3-5，run_native_query 已有只读+超时+口径护栏，属收尾）。
- **P0（人工）**：§10 的 18 条 FK 核查仍待 Metabase Admin 权限人员签字（含 §10.1/§10.2 已定位的 7 条根因复核）。

### 11.6 P2 问题-表窄图（2026-11-10 已实施 + 真实 BI 验证）

- **新增模块 `scripts/metabase-card-graph.mjs`**（纯函数、零依赖、可单测）：`extractTables(sql)` 正则抽 `FROM/JOIN` 表引用；`getCardTables(mb,cardId)` 取卡片 SQL（原生直接读 `native.query`，MBQL 走 `POST /dataset/native` 编译）；`buildCardTableIndex(mb,{databaseId,force})` 批拉全库卡片（每批 10）建 `card→table` 索引，**模块级缓存 TTL 5min**；`cardsForTable` / `relatedCards` 两张查询。
- **新增两个 MCP 工具**（`metabase-mcp.mjs`）：`get_cards_for_table(table)` 反向查「哪些现成提问引用此表」；`get_related_cards(card_id)` 找「共享底表的其它提问」（按共享表数排序）。两者描述都引导「优先复用以验证查询，而非从零写 join」。
- **真实 BI 验证**（stdio 直连，`db=2` 印度板块 97 张卡片）：`get_related_cards(96)` 正确解析出 `film_report.elt_new_guid` + `film_report.elt_gp_install_referrer_log` 两张底表，并召回 5+ 个共享**两张表**的关联卡片；`get_cards_for_table("film_report.elt_new_guid")` 返回 10 个引用该表的现成提问；首次索引构建 15.9s（97 卡片 SQL 批拉 + 正则抽表），二次调用 1ms（缓存命中）。`node --check` + 项目语法门禁 `EXIT=0`，lint 0 错误。
- **价值**：把「先翻 781 字段 / 97 卡片 schema」收敛为「按表/按问题」的窄图导航，直接服务 §4.2-1 的 prompt 瘦身目标；且是纯元数据、零 LLM 成本，Agent 无感。

### 11.7 P2 黄金集 + 三维跑分器（2026-11-10 已实施 + 真实 BI 验证）

- **黄金集已落盘**：`scripts/bi-golden-bootstrap.mjs` 从 97 张卡片抽 `{id, question=卡片名, expected_sql=编译后原生SQL, tables}` 落 `tests/bi-golden-set.json`（纯元数据，零 LLM，97 例 / 96 带 SQL）。**遗留**：卡片名是标题而非标准自然语言提问，作为 eval 提示偏弱——真实评测建议后续把 `question` 改写为自然语言（见 §11.8）。
- **`bi-eval-runner.mjs`（已落地，评分口径 v3）**：加载黄金集 → 逐例经真实 `agent-server` 的 `/chat/stream`（BI MCP 已启用）驱动模型 → **逐次记录取数工具调用**（工具名 / SQL / 卡片 id / 成败 / 行数，按 `tool_call.id` 配对参数与结果）→ 评分（纯函数在 `scripts/bi-eval-score.mjs`）：
  - `ValidSQL`：有取数成功（含多轮自我修正后跑通）；另报 `firstAttemptOk`（第一次就成功）与 `attempts`（尝试次数）。
  - `EX`：返回非空行。行数取自结果文本末尾的 `-- [feedback]` 机读行；结果被服务端按 `MCP_MAX_TOOL_RESULT_CHARS` 截尾时算非空（空结果不可能超长）；拿不到行数记未知、不进分母。**不是 BIRD/Spider 意义上「结果集与金样一致」的 EX**。
  - `JoinCorrect`：**最终 SQL**（最后一条成功的取数 SQL；DESCRIBE/SHOW 不算）用到的表 ⊇ 期望表；表名任一方不带 schema 时按裸名比对。另报 `joinCorrectAny`（所有尝试取并集的旧口径，作上界）、表召回 / 精确率、`missingTables`。只判覆盖、不查 join 键与过滤条件，是必要非充分条件。
  - `cardShortcut`：最后一次成功取数走的是执行已保存卡片（`execute_query` / 带 `question_id` 的 `query`），join 不评、单独计数。
  - 所有比率附 n 与 Wilson 95% 区间；期望表含白名单外表的用例（`expectedIncomplete`）另报 `joinCorrectComplete`。
  - `executed:false` 的取数结果（同轮重复被跳过 / 安全闸门拒绝 / 暂缓，服务端根本没执行）不计入 `attempts`，单独记 `skippedCalls`，汇总报 `skippedCallsTotal`。评测模式的拒绝属于真实执行后的失败（`executed` 为真、`ok=false`），照常计入尝试。
  - 参数：`--limit N` / `--case ID` / `--dry`（期望 SQL 当生成 SQL，自检评分函数）/ `--rescore 报告`（不调模型、按当前口径重评；v1/v2 旧报告无逐次记录，用抽到的 SQL 序列近似）/ `--out report.json`。
- **评测防泄题（留一法，2026-11-12）**：题目 = 卡片标题，而 BI 工具能按标题 `search` 到原卡片、`get_card` 读其 SQL、`execute_query` 直接执行，`get_golden_set` 更是整包返回期望 SQL；`get_caliber_context` / `get_join_examples` 也由同一批卡片构建。runner 每例把「本例卡片 + 孪生卡片（编译后 SQL 或标题相同）」写进留出文件；agent-server 以 `BI_EVAL_HOLDOUT_FILE=<同一绝对路径>` 启动时，BI MCP 进入评测模式（`scripts/bi-eval-holdout.mjs`）：不宣告并拒绝 `get_golden_set`；按 id 读/跑留出卡片的调用（`get_card` / `get_related_cards` / `execute_query` / `query` / `construct_query` / `read_resource type=card`）被拒；`list_cards` / `search` / 仪表盘 / `get_cards_for_table` / 关联卡片 / join 样例的输出剔除留出卡片；口径图用剔除后的卡片现建（缓存只存全量图）。报告里 `leaks`（尝试取留出内容）与 `evalModeSeen`（见到拒绝标记）用于核查；汇总 `leaked` = 尝试了但没被拦的用例数。**`BI_EVAL_HOLDOUT_FILE` 只能在评测时于命令行设置，不得写进 `.env`**（MCP 进程会加载 `.env`，写进去生产也会进入评测模式；`.env.example` 已加同样的注释，2026-11-12 核查两份 `.env` 均未配置）。
- **评测模式与事件流核实（2026-11-12，不调模型）**：
  1. 进程级冒烟：以 stdio 直接拉起 `metabase-mcp.mjs`，设 `BI_EVAL_HOLDOUT_FILE` 时 `tools/list` 为 20 个工具、不含 `get_golden_set`；`get_golden_set`、`get_card(125)`、`execute_query(999)`、`query(question_id=125)`、`read_resource(type=card,id=125)` 全部返回 `[eval-holdout]` 拒绝（`isError`），拒绝发生在访问 BI 之前。不设该变量时 21 个工具、`get_golden_set` 照常宣告。
  2. agent-server 的 `/chat/stream` 是逐行 JSON（NDJSON），透传原始事件：`tool_call.args` 是未脱敏的参数 JSON 字符串、`tool_result` 带同一个 `id` 与 `executed`，runner 按 `id` 配对成立；截断标记文案与 `chat.ts` 的 `truncateResult` 一致；`BI_*` 环境变量会透传给 MCP 子进程。
- **真实 BI 验证（全量 96 例基线，2026-11-11 跑完，报告 `.data/bi-eval-full.json`）**：逐例经模型跑分（节流：每例独立进程 + `--gap 15` + `--resume` 断点续跑），0 error。v1 评分口径报 ValidSQL 93/96、EX 93/96、JoinCorrect 55/92 (59.8%)。
- **评分口径 v2 更正（2026-11-12）**：复核 v1 报告发现两处评分 bug——
  1. **JoinCorrect 误判 16 例**：黄金集期望表有的是裸名（`elt_film_order`），模型 SQL 抽出的都带 schema（`film_report.elt_film_order`），v1 用字符串精确比对，同一张表被判不同（#39/#42/#51/#77/#80 等 16 例）。v2 按裸名比对后重评：**JoinCorrect 71/92 (77.2%)**（`.data/bi-eval-full.rescored.json`）。分母 92 = 96 − 3 例模型未执行任何查询（#99/#116/#121）− 1 例期望表 `elt_ul_user_full` 不在白名单（#338）。
  2. **EX 恒等于 ValidSQL**：SSE 的 `tool_result` 不带行数，v1 回退为「有文本就记 1 行」，821 次执行 rows 全为 1，EX 实际未生效。v2 改为解析结果文本的 `[feedback]` 行，拿不到行数记未知、不并入分母。**v1 报告的行数不可恢复，EX 需按 v2 口径重跑模型才有数**。
  - 原记载的「同日另一次 98.9% / 69.1%」在仓库内无对应报告（唯一另一份日志 `.data/logs/bi-eval-full.out.log`，11-10，旧口径，终值 ValidSQL 88.5% / JoinCorrect 68.6%），不作为基线引用。
- **评分口径 v3 更正（2026-11-12）**：v2 仍把一个用例里**所有尝试**（平均 8.6 次、最多 29 次取数，含失败与 LIMIT 试探）的表取并集再判覆盖，试得越多越容易「蒙对」。v3 按最终 SQL 判定，并修正 runner 两处漏抓：SSE 的 `tool_call.args` 是 JSON 字符串（旧代码只认数组/对象，失败执行的 SQL 全丢）；`query` / `execute_query` 不匹配旧的工具名正则（卡片执行不可见）。v3 口径重评同一报告（`.data/bi-eval-full.rescored.json`；旧报告无逐次记录，按抽到的 SQL 序列近似；期望表用下文归一化后的金样，含外键显示映射剔除）：

  | 指标 | 值 | 95% 区间 |
  |---|---|---|
  | ValidSQL | 93/96 (96.9%) | 91.2–98.9% |
  | 首次即成功 | 72/96 (75.0%) | 65.5–82.6% |
  | JoinCorrect（最终 SQL） | 58/92 (63.0%) | 52.8–72.2% |
  | JoinCorrect（剔除期望表不全的 10 例） | 56/83 (67.5%) | 56.8–76.6% |
  | JoinCorrectAny（并集，上界） | 78/92 (84.8%) | 76.1–90.7% |
  | 表召回均值 / 精确率均值 | 0.759 / 0.916 | — |
  | EX | 旧报告不可评（行数未记录） | — |

  真实表选择正确率落在 63.0%（下界：只认最终那条 SQL，对「分多步查询再汇总」的回答偏严）与 84.8%（上界）之间，两个区间不重叠。剔除外键显示映射前是 53/92 (57.6%) ～ 71/92 (77.2%)，差的 5 例（下界）/ 7 例（上界）全部来自 `elt_ul_activity`（见下）。
- **核心结论（量化 §3-C 风险）**：按最终 SQL 有 34 例没用齐期望表，其中 20 例在某次试探里用过、最终 SQL 却丢了——「试对了又丢掉」是最大的一类失败。缺得最多的表：`elt_film_order`（10 例）、`elt_watch_detail`（8）、`gather`（7）、归因表 `elt_gp_install_referrer_log`（7）/`elt_fo_ap_src`（5）、`elt_app_params`（5）、`elt_new_guid`（5）。#125 原记为「模型真实漏表」，2026-11-12 更正为**口径冲突**：模型按 Agent 技能的书面规定用 `elt_user_full.countryCode` 拆国籍，卡片用的是 `elt_app_params.ipCountryCode`（设备 IP 推断），JoinCorrect 惩罚的恰好是遵守规定的那一方，见 §11.10。下界 63.0% 低于 §5 P3 的 70% 触发阈值、上界 84.8% 高于它——阈值判断取决于口径，需在评测模式下重跑后定论。
- **`elt_ul_activity` 漏表 9 例是金样过严，不是模型盲区（2026-11-12 逐例核对）**：#60/#62/#63/#64/#67/#85/#86/#87/#484 的金样 SQL 里，`elt_ul_activity` 都只出现在「会员订单表」模型内部的同一段 `LEFT JOIN (SELECT … FROM film_report.elt_ul_activity) AS elt_ul_activity__via__activityId ON elt_film_order.activityId = …_id`——这是 Metabase 的外键显示映射（`activityId` 设置为显示活动名）自动编译出来的，只为取 `name` 列；而外层查询的 SELECT / WHERE / GROUP BY 从没用过这一列（9 例各 32 处引用，全部在这段子查询内）。对照模型的最终 SQL（如 #60 `elt_film_order JOIN elt_app_params ON guid` 按地区计数），口径与金样一致。已在归一化里剔除这类表（见下）。
- **评测有效性风险（旧报告）**：11-11 那轮没有留一法，模型可按标题找到原卡片；当时 runner 也没记录工具调用，**无法回溯泄题程度**。旧报告的数字只能作参考，P3 前后对比必须两边都在评测模式下重跑。
- **白名单求交（a，已落地）**：runner 加载 `tests/bi-known-tables.json`（58 张真实表，由 bootstrap 从 `get_database_schema` 导出）过滤 `usedTables`/`expectedTables` 的 CTE 名与表别名噪声（`od`/`u`/`m5`/`new_dev` 等），`filterKnownTables` 对空白名单 fail-open。修正了早期 #486 等复杂 SQL 的抽取噪声（join 判定不再被别名干扰）；#125 不是抽取误判；它是技能与卡片的国家口径冲突（见 §11.10），不应算作模型用错表。
- **黄金集期望表归一化（2026-11-12）**：`normalizeGoldenCase`（`metabase-card-graph.mjs`）按当前抽表规则从 `expected_sql` 重抽、白名单内唯一对应的裸名补成 `schema.table`、剔除 CTE 名；bootstrap 落盘时自动执行，`scripts/bi-golden-normalize.mjs [--check]` 可离线重做（27/97 例期望表写法有变化，白名单内真实表集合 0 例变化）。抽表同时修正：ClickHouse `ARRAY JOIN w.movieTags` 展开的是数组列，不再被当成表。白名单外、又不是 CTE 的名字记进 `unverifiedTables`，共 10 例：`elt_ul_user_full`（#179/#338）、`user_preference_actions_report`（#57/#70/#71/#72/#74）、`elt_sport_activity_guess`+`elt_sport_activity_winner`（#111）、`watch_log`（#473）、`view_ul_user_nopay`（#74）、`film_report.user_watch_movie_activity_log`（#65）。它们在金样 SQL 里是真实引用（非 CTE），但不在 58 张白名单中。2026-11-12 用当前 key 经 MCP `search`（`models=["table"]`，只读）逐个查，7 张表**全部无命中**（对照组 `elt_ul_activity` 能搜到，说明搜索本身正常）；Metabase 搜索不返回隐藏表，因此只能判断「当前 key 不可见」，分不清是隐藏表、已下线还是没权限。#338 的期望表只有 `elt_ul_user_full` 一张，因此 join 不可评。
- **同日续查已定性（只读 SQL，不依赖管理员）**：`SELECT database, name FROM system.tables`（192 张）比对 `/api/database/2/metadata`（58 张），7 张表结论分两类——
  - **5 张库里存在、Metabase 未暴露（`existHidden`）**：`film_report.user_preference_actions_report`、`film_report.elt_sport_activity_guess`、`film_report.elt_sport_activity_winner`、`film_report.watch_log`、`film_report.user_watch_movie_activity_log`。模型通过任何 MCP 工具都发现不了它们，**故不并入 `tables` 白名单**（并进去只会让 join 分母多出必错的题），由评分的 `joinCorrectComplete` 单独剔除。
  - **2 张库里也不存在（`missing`）**：`elt_ul_user_full`、`view_ul_user_nopay`（`system.tables` 里只有 `elt_user_full`/`_history`/`_tmp`，无任何 `nopay` 表）——金样 SQL 引用了失效/改名的表，涉及 #338/#179/#74 三例。
  - 结论落 `tests/bi-known-tables.json` 的 `tableAudit`（含查证方法与日期），`normalizeGoldenCase` 自动给 10 例标 `unverifiedTableStatus`（`existHidden`/`missing`）；bootstrap 重导白名单时会保留 `tableAudit`。**剩余决策**：引用 `missing` 表的 3 例是否退出黄金集（会改变 96 例基线口径），以及是否请管理员在 Metabase 暴露那 5 张隐藏表——两者都需你拍板，本轮未改评测样本集。
- **外键显示映射剔除（2026-11-12）**：`unusedRemapTables(sql)`（`metabase-card-graph.mjs`）识别 Metabase 编译出的 `LEFT JOIN (SELECT … FROM T) AS \`T__via__fk\``，当映射出的列（`T__via__fk__xxx`）只在定义处出现、且 T 没有别的 FROM/JOIN 引用时，判 T 对结果无贡献；`normalizeGoldenCase` 把这类表从 `tables` 移到 `remapOnlyTables`（可追溯）。全集只命中上面 9 例的 `elt_ul_activity`，无误伤。口径图由金样 `tables` 构建，同步去掉了「订单表 ↔ `elt_ul_activity`」这条假共现边。线上的卡片→表索引（`get_cards_for_table` 等，`getCardTables`）仍用不剔除的 `extractTables`，是否也剔除待定：剔除后「按表找卡片」不会再把 9 张订单类卡片挂到 `elt_ul_activity` 名下，更准确，但这会改变线上工具输出，留到评测模式重跑时一并验证。白名单来自 `get_database_schema`，不受影响。
- **已知限制**：
  1. 生成 SQL 优先取成功结果里回显的「实际执行的 SQL」（只读闸门处理后），失败执行取 `tool_call.args` 里的 SQL；纯文本回答、没调用取数工具的 case 记 valid=false。
  2. **上游限流**：同一 `agent-server` 进程连续跑 ≥3 例会被上游（模型 API）限流——表现为前 2 例通过后第 3+ 例 `terminated`/`fetch failed`。**规避**：每例独立进程 + 间隔（已验证 `--case` 间隔 12s 可 12/12 通过）；全量 97 题必须节流（如每例新进程 + sleep），否则会大面积误报 ERROR。
  3. **join 评分对复杂 SQL 过匹配**：`extractTables` 的 `FROM/JOIN` 正则会把别名/列名（如 `od`/`u`/`m5`）误判为表，导致 #486/#125 等复杂 SQL 的 `usedTables` 含噪声、`join` 偶发误判为 false。已通过白名单求交缓解（见上）；schema 前缀不一致导致的误判已在 v2 口径修正，回归测试 `tests/bi-eval-score.test.ts`。

### 11.8 遗留与后续

- **黄金集 `question` 改写（2026-11-12 已实施）**：97 题逐条改写为自然语言问句，落 `tests/bi-golden-questions.json`（保留标题里的日期/素材名/版本/维度/业务术语，不新增金样 SQL 之外的约束）。原卡片名保留在 golden-set 的 `cardTitle`，留一法孪生识别改用它；`applyGoldenQuestions` 在 bootstrap 与 `bi-golden-normalize.mjs` 共用、幂等，`--check` 会校验题目是否已生效（现为 0 例变化）。配套修正：`buildCaliberGraph` 的卡片节点文本优先 `name || cardTitle || question`，即**图仍由业务卡片标题构成、改写后的问句只作检索输入**，与线上 `get_caliber_context`（图来自 BI 实时卡片名）保持一致；否则图会用改写题建索引，与线上口径资产不一致、单测也会失去意义。改写后重跑 P3 离线检索（留一、top12）：口径图全命中 92/95 (96.8%)、朴素基线 89/95 (93.7%)、不留一 95/95 (100%)——口径图相对朴素基线的优势由约 +1 点变为 +3.1 点，检索有效性结论不变；端到端 JoinCorrect 仍须按 A/B 重跑验证。
- **全量基线（旧，仅参考）**：11-11 跑完 96 例（0 error），报告存 `.data/bi-eval-full.json`；v3 口径重评见 §11.7。该轮无留一法、无逐次记录，**不作为 P3 前后对比的基线**。
- **P3 前后对比（待做；统计方法按此，执行命令以本节「重跑评测操作步骤」与 §11.9-C 为准）**：
  1. agent-server 以 `BI_EVAL_HOLDOUT_FILE=<apps/agent-server/.data/bi-eval-holdout.json 的绝对路径>` 启动（命令行设置，不写 `.env`）；
  2. 关闭 / 开启 `get_caliber_context` 各跑 96 例，每边 2–3 轮；核对汇总里 `leaked = 0`、`evalModeSeen` 有出现；
  3. 按题配对比较：单轮用精确 McNemar（只看不一致的题），多轮用按题重抽样的配对 bootstrap；同时报 pass^k（k 轮全对）。92 题的 Wilson 区间宽约 ±10 个百分点，差距小于 10 个点时单轮结果不足以下结论。
- **P3 离线检索评测（2026-11-12，不调模型）**：`node scripts/bi-caliber-eval.mjs [--top N]` 用留一法评 `get_caliber_context` 推荐的表对期望表的召回，并与「不看问题、按卡片引用次数推前 N 张」的朴素基线对比（95 题）：

  | 推荐表数 | 口径图召回（留一） | 朴素基线召回 | 口径图召回（不留一，含泄题） |
  |---|---|---|---|
  | 12（线上默认） | 96.8%（全命中 92/95） | 95.8% | 100% |
  | 8 | 94.5% | 84.1% | 98.7% |
  | 5 | 84.5% | 61.0% | 93.6% |
  | 3 | 79.2% | 51.2% | 90.1% |

  （外键显示映射剔除后重算；剔除前留一召回 12/5/3 张为 96.6% / 83.8% / 77.8%。）结论：① 推前 3–5 张时口径图比朴素基线高 24–28 个点，检索是有效的；② **线上推 12 张（58 张表的约 1/5）时与朴素基线几乎持平**，精确率仅 16%，区分度被稀释；③ 不留一会把召回抬高约 10 个点。
  **注意：本表是题目改写前的历史值，勿与改写后复测混用。** 2026-11-12 黄金集 `question` 改写后复测（见本节首条）：top12 留一全命中 92/95 (96.8%)、朴素基线 89/95 (93.7%)、不留一 95/95 (100%)；口径图相对朴素基线的优势由约 +1 点变为 +3.1 点，检索有效性结论不变。
- **口径图输出分层（2026-11-12 已实施）**：没有把 `topTables` 收到 5——那样会丢掉约 1/8 的必需表（召回 96.8% → 84.5%）。改为只分层不截断：`buildCaliberContext` 的 `tables` 每项加 `tier`，前 `primaryTables`（默认 5）张为 `primary`、其余为 `candidate`，工具说明提示模型优先用 primary、覆盖不了问题时再看 candidate。离线召回不变；对端到端 JoinCorrect 的影响要在评测模式重跑时验证。下文旧的端到端示例（「观影过AK2」命中 #100/#101/#102）是在包含这些卡片的图上检索的，只能说明索引能召回已有卡片，不能说明对新问题的效果。
- **P3（已实施）**：立项时依据 v1 口径的 59.8%（含误判）。v3 口径下端到端 JoinCorrect 在 63.0%–84.8% 之间、离线检索有效（见上），P3 保留；它针对的正是失败集中的「该 join 什么表」问题（订单表、观影表、归因表等）。端到端提升仍须按上面流程重跑验证。
- **口径图两处修正（2026-11-12）**：`joinHints` 的「最多 8 条」截断此前没生效（`sort().slice()` 的返回值被丢弃）；`getCaliberGraph` 的缓存键比较的是 `known` Set 的引用，每次调用都新建 Set，缓存从未命中——改为按内容作键。
- **P3 技术实现（口径层语义图）**：`bi-caliber-graph.mjs` 从 97 卡片 SQL + 58 真实表白名单构建「表/卡片」共现图（节点=表+卡片，边=卡片用表、表共现于同卡、卡片共享表），`buildCaliberContext(query)` 用关键词命中 + 图遍历返回「该用的表 + 常一起 join 的表 + 可参考现成卡片」。MCP 工具 `get_caliber_context` 把该上下文喂给模型，使其在写多表 SQL 前先拿到精准表清单，直接改善 JoinCorrect。near-zero 成本：无 embedding 预计算，仅图遍历 + 关键词匹配；TTL 缓存避免重复构建。
  - **实现要点**：表名 canonical 归一化以 golden 自带 `schema.table` 为优先（消除白名单裸名与 golden 带 schema 名的节点分裂）；白名单仅用于过滤 CTE 别名/列名噪声（fail-open）；共现边权重=同卡共现次数，检索时按 direct×2+co 排序。
  - **验证**：`tests/bi-caliber-graph.test.ts` 6 例单测全过（含归一化/边界）；真实 BI 端到端验证 `get_caliber_context`——「观影过AK2」精准命中 #100/#101/#102 并推荐 `film_report.elt_watch_detail`+`elt_gp_install_referrer_log`、「会员存量」正确推荐 `elt_app_params`/`elt_fo_ap_src`，表名全为 canonical 形式。
  - **待验证**：JoinCorrect 提升需在 eval harness 中让模型调用 `get_caliber_context` 后重跑 96 例基线（见遗留项）。
- **P3 A/B 工具开关（2026-11-12 已实施）**：原先「关闭 / 开启 `get_caliber_context` 各跑」缺少可复现的关闭方式。现新增评测专用开关 `BI_EVAL_DISABLE_CALIBER=1`（命令行临时设置，与 `BI_EVAL_HOLDOUT_FILE` 一样**不得写进 `.env`**）：设了之后 BI MCP 在 `tools/list` 不宣告 `get_caliber_context`，硬调也会被评测闸门拒绝（对照组）；不设则口径图可用（实验组）。**仅在评测模式下生效**，误配进生产不会关掉线上工具；`mcpChildEnv` 按 `BI_` 前缀透传给 MCP 子进程。runner 增加 `--arm caliber-on|caliber-off` 把实验组标签写进报告 `meta`（标签只记录、不控制 MCP，重评时沿用原 meta），避免两份报告分不清归属。
- **重跑评测操作步骤（尚未执行，需要时按此做）**：
  1. 离线自检：`npx vitest run tests/bi- tests/metabase`；`node scripts/bi-golden-normalize.mjs --check` 应报 0 例变化；`node scripts/bi-eval-runner.mjs --dry --limit 5` 核对评分函数。
  2. 启动 agent-server 时在**命令行**设置 `BI_EVAL_HOLDOUT_FILE=<apps/agent-server/.data/bi-eval-holdout.json 的绝对路径>`（PowerShell：`$env:BI_EVAL_HOLDOUT_FILE="D:\…\bi-eval-holdout.json"; pnpm dev`），runner 用同一路径（默认即此路径，或同样设该变量）。跑对照组时**同一个命令行**再设 `$env:BI_EVAL_DISABLE_CALIBER="1"`，换组需重启 agent-server（MCP 子进程随服务启动）。
  3. 先跑 `--case 125` 一例：报告里应有 `evalModeSeen` 或 `leaks` 为空、`meta.arm` 与实际开关一致；若模型尝试取原卡片却没被拦（`leaked > 0`），说明两边路径不一致，停下排查。
  4. 全量：`node scripts/bi-eval-runner.mjs --gap 15 --resume --arm caliber-on --out .data/bi-eval-caliber-on.json`（对照组换 `--arm caliber-off` + 另一个 `--out`）；每边 2–3 轮，按上面「P3 前后对比」做配对检验。
  5. 跑完关闭 agent-server、清掉这两个环境变量；runner 会在每例结束和异常退出时清空留出文件。
- **仍需人工 / 未做的事**：
  1. 白名单外 7 张表的存在性**已只读查证完毕**（5 张库里存在但 Metabase 隐藏、2 张库里不存在，见 §11.7）；仍待拍板：是否请管理员暴露那 5 张隐藏表、以及引用失效表的 3 例（#338/#179/#74）是否退出黄金集。
  2. 真正的结果集 EX（与金样结果比对）按决定暂缓；当前 EX 只表示「返回非空」。
  3. 黄金集 `question` **已改写完毕**（见上）；若业务口径变化，后续只需更新 `tests/bi-golden-questions.json` 再跑 `bi-golden-normalize.mjs`。
  4. 线上卡片→表索引**已剔除**未使用的外键显示映射表（2026-11-12，`cardTablesFromSql` 复用 `unusedRemapTables`，单测覆盖「外层用到映射列时保留」；见 §11.7）。9 张订单类卡片不再挂到 `elt_ul_activity` 名下。同轮把 `buildGoldenSet` 也统一到 `cardTablesFromSql`——此前线上 `get_caliber_context` / `get_join_examples` 用 `extractTables` 保留了「订单表 ↔ `elt_ul_activity`」的假共现边，而离线评测读的是已剔除的 golden 文件，两边口径不一致。这会改变 `get_cards_for_table` / `get_related_cards` / 口径图的线上输出，端到端影响仍待 A/B 重跑时观察。
  5. 所有端到端数字都来自 11-11 那轮无防泄题的旧报告；评测模式下的新基线要重跑模型才有。
- **P4（已实施）**：few-shot join 样例库（`get_join_examples` + `scripts/bi-join-examples.mjs`）、查询校验闭环固化（`scripts/bi-query-guard.mjs`，§4.3-5）均已 2026-11-11 落地并带单测。
- **P0（人工）**：§10 的 18 条 FK 核查已整理为可签字清单 `apps/agent-server/bi-semantic/fk-signoff.json`（技术核对结论收敛），仍待 Metabase Admin 权限人员签字（含 §10.1/§10.2 已定位的 7 条根因复核）。

### 11.5 残留风险与 P1.1 实施（取值域真实性）

- **残留风险**：当字段 description 里写的枚举是**过期**的（§4.3 T4 的原场景：`clientType` 描述为 `{1,2,4,6}` 但真实是 `{0,1,4,5}`），而本 BI 又不提供 `fingerprint.type.values` 纠偏，则 M-Schema 内联的 description 会**把过期枚举喂给模型**——这正是 §4.3-2 想解决的痛点。默认路径（`with_values=false`）下在本 ClickHouse 后端**仍未根除**；显式开启 P1.1 的 `with_values=true` 后可由实测取值覆盖描述而根除（见下）。
- **P1.1（2026-11-12 已实施；默认关闭，线上零额外延迟）**：`get_database_schema(mode="mschema", table=…, with_values=true)` 触发惰性取值充实，`max_value_fields` 控制预算（默认 8、上限 20）。实现拆成 `scripts/bi-mschema-values.mjs`（候选筛选 + 取样 DISTINCT + TTL 缓存 + 并发/预算护栏）与 `metabase-mschema.mjs`（实测值标 `(live)`，优先级高于指纹与可能过期的描述枚举）；单字段失败只回落、不影响整表输出。护栏：默认关闭、仅表级生效、标识符白名单、每字段取样 ≤20 万行 / ≤30 个去重值、并发 ≤3、跨调用缓存 5 分钟。
  - **真实 BI 验证（只读，stdio 直连 `film_report.film_app_verify`）**：关闭时输出无 `(live)`、零额外查询；开启时 3 个 Category 字段全部拿到实测值，且**再次证明描述枚举过期**——`result_type` 描述只列 4 种 `SUCCESS/OFFICIAL_VERIFICATION_FAILED/SERVICE_VERIFICATION_FAILED/PROCESSING_FAILED`，实测多出 `VERIFICATION_SKIPPED`；`reason` 实测 10 个原因码、`verification_path` 实测 3 种。首拉 1030ms（含 2 字段查询），同参数二次调用 1ms（缓存命中 2/2），库级输出不触发查询。
  - **残留决策**：默认仍走 description 兜底；是否把 `with_values` 在线上默认打开（代价约 +1s/表首拉、缓存后 ≈1ms）待拍板。未打开前 §4.3-2 的「ClickHouse 后端枚举以描述为据，可能过期」风险仍在，调用方可按需显式开启。

---

### 11.9 当前状态与待决事项（2026-11-12 收口）

> **本节是「接下来做什么」的唯一入口**。§0–§11.8 保留评估过程与证据，这里只列当前状态与下一步。
> 边界不变（§0）：只动 `bi-metabase` MCP 层，`apps/agent-server/src/**`（含 `eval-online.ts`）、prompt、模型调用一律未改。
> 工作区状态：11-12 以来的改动（含本轮）**均未提交**，最后提交为 `4bab839`（P3）。
> **留一法评测模式下的全量重跑尚未执行**；所有端到端数字（ValidSQL / JoinCorrect / EX）仍来自 11-11 无防泄题的旧报告，只能作参考。

#### A. 已实施（代码 + 离线验证）

| 项 | 落地 | 当前状态 |
|---|---|---|
| P0 FK 技术核对 | `apps/agent-server/bi-semantic/fk-signoff.json` + §10.1/§10.2 | 11 可信 / 6 根因定位 / 1 越权；**人工签字待办** |
| P1 M-Schema | `metabase-mschema.mjs` + `get_database_schema(mode=mschema)` | 新增可选模式，默认仍是旧 JSON，消费方无感 |
| P1.1 惰性取值 | `bi-mschema-values.mjs` + `with_values` / `max_value_fields` | **默认关闭**，真实 BI 只读验证通过（§11.5） |
| P2 窄图 + 黄金集 + 跑分器 | `metabase-card-graph.mjs` / `tests/bi-golden-set.json` / `bi-eval-runner.mjs` | 评分口径 v3；防泄题留一法 + `--arm` 已就绪 |
| P3 口径图 | `bi-caliber-graph.mjs` + `get_caliber_context`；A/B 开关 `BI_EVAL_DISABLE_CALIBER` | 离线检索有效；**端到端提升未验证** |
| P4 收尾 | `bi-join-examples.mjs` / `bi-query-guard.mjs` | 已带单测 |
| 黄金集 97 题改写 | `tests/bi-golden-questions.json` + `cardTitle` | 已生效，`--check` 0 变化；留一法按 `cardTitle` 认孪生 |
| 白名单外 7 张表查证 | `bi-known-tables.json` 的 `tableAudit` + `unverifiedTableStatus` | 5 张库里存在但 Metabase 隐藏 / 2 张库里不存在（§11.7） |
| 抽表口径统一 | `cardTablesFromSql`（`getCardTables` + `buildGoldenSet`） | 剔除未使用的 FK 显示映射表，线上工具与离线金样一致 |
| 外键问题边标注 | `bi-semantic.mjs` + `bi-semantic/fk-signoff.json` | `get_table_relationships` / M-Schema 对 7 条核对未通过的外键标 `verified=false` + 说明（§11.10） |
| 口径词典草稿 + 审计 + 评测口径检查 | `bi-semantic/caliber-glossary.json` / `bi-caliber-audit.mjs` / 评分口径 v4 | 8 条草稿口径**全部待业务拍板**；`get_metric_definitions` 只提供已批准条目，当前不宣告（§11.10） |
| 最佳实践差距项（第一批） | 评分口径 v5（`valueMatch` / `goldBlocked`）、`bi-metadata-gaps.mjs`、`runCard` 反馈行、口径图表检索文本、`get_caliber_context` 内联 SQL、闸门读词典 | 见 §11.11-6；闸门在词典批准前行为不变 |

离线验证基线：`npx vitest run tests/bi- tests/metabase tests/mcp-adapter-syntax.test.ts` → **18 文件 / 149 测试通过**（含 `sql-readonly-consistency`；全量 131 文件 / 914 测试），lint 0；`bi-golden-normalize.mjs --check` 0 例变化；`bi-eval-runner.mjs --dry` 自检通过；真实 BI 只读 stdio 冒烟（工具列表三态、A/B 拒绝、`with_values` 开关与缓存）全部通过。

#### B. 待拍板（4 项，建议按此顺序定）

1. **`with_values` 是否线上默认开启**：开 → 换真·实测取值域，代价约 +1s/表首拉（缓存后 ≈1ms）；不开 → §4.3-2 的过期枚举风险仍在，调用方可显式开启。
2. **5 张隐藏表是否请 Metabase 管理员暴露**：暴露后可补进 `tables` 白名单、7 例金样正常评 JoinCorrect；不暴露则维持现状，由 `joinCorrectComplete` 剔除。
3. **引用失效表的 3 例（#338/#179/#74）是否退出黄金集**：退出会把基线从 96 例改为 93 例，历史数字不可直接比较。
4. **口径词典 8 条草稿逐条拍板**（§11.10 的问题清单）：至少先定已支付订单、收入金额、时区、国家维度四条，评测的口径检查才有统一标准。
5. **是否启动 A/B 全量重跑**：见 C；建议 1–4 定稿后再启动，否则题目 / 样本 / 工具输出 / 口径标准还会变，新基线很快作废。

#### C. 待重跑（唯一能给出端到端结论的动作）

- 流程：§11.8「重跑评测操作步骤」（命令行设 `BI_EVAL_HOLDOUT_FILE`，对照组再加 `BI_EVAL_DISABLE_CALIBER=1`，两者**都不得写进 `.env`**）；先 `--case 125` 核对 `leaked=0`，再两边各 2–3 轮全量 `--gap 15 --resume`。
- 统计：按题配对，单轮精确 McNemar、多轮按题重抽样 bootstrap，同时报 pass^k；92 题 Wilson 区间约 ±10 个百分点，**差距小于 10 个点不足以下结论**。
- 成本：约 400–600 次模型调用、2–2.5 小时，需重启 8787（当前服务正常运行中）。
- 同时观察：`cardTablesFromSql` 改变 `get_cards_for_table` / `get_related_cards` / 口径图输出后的影响，以及 `get_caliber_context` 对 JoinCorrect 的提升是否成立。
- 重跑前建议先把 11-12 未提交的改动整理提交，保证报告对得上代码版本（本仓库不自动提交）。

#### D. 待人工（非代码可完成）

- P0：`apps/agent-server/bi-semantic/fk-signoff.json` 的 18 条 FK 由具备 Metabase Admin 权限且熟悉业务的人员签字，重点是 §10.2 已定位的 7 条（3 死字段 / 2 父表空 / 1 自引用悬空 / 1 越权 #18）。
- B-2 的 5 张隐藏表是否暴露，需管理员在 Admin → Table Metadata 决策（技术侧已只读查证完毕）。
- 口径词典需要一位业务负责人（owner）逐条确认并在 `caliber-glossary.json` 里把 `status` 改为 `approved`；冲突卡片（§11.10）是否修改，由卡片作者决定。

#### E. 已决定暂缓 / 明确不做

- 真·结果集 EX（与金样结果集比对）：当前 EX 只表示「返回非空行」。
- 全量 GraphRAG 语义层：schema 层已有确定性 18 边 FK 图，口径层窄图离线检索有效，不需要 LLM 抽实体/关系（依据见 §11.10-4）。
- `eval-online.ts` 及 Agent 侧任何改动：超出本文档范围（§0）。

### 11.10 口径一致性、Schema 图与 GraphRAG 复核（2026-11-12）

> 起因：对照 `docs/engineering-optimization-review.md` 复核「Metabase 数据多 / 口径不一致 / Schema 图 / GraphRAG」四个问题。那份评审只覆盖前端、构建、CI 与文档对齐，**不含 BI**，本节是 BI 侧的对应结论。本轮未调模型、未改 Agent（含 `skills/business-data-query/SKILL.md`）。

#### 1. 数据多：大体解决

已落地：`get_database_schema` 默认只给表清单、传 `table` 才给字段；M-Schema 紧凑格式；两阶段定位提示；口径图只推 12 张表且前 5 张标 `primary`；ClickHouse 单查询 90 秒中断、结果上限 100 万行、超长结果截断。剩两个「默认关闭」：M-Schema 不是默认格式（模型要主动传 `mode=mschema`，用没用旧报告查不到，新 runner 记录工具参数，重跑后可见）；`with_values` 默认关，ClickHouse 上枚举只能信描述，而描述已证实会过期。

#### 2. 口径不一致：此前没有解决，本轮补了诊断与机制，口径取值待业务拍板

- **诊断**：所谓「口径图」实际是**表共现图**，回答「该用哪些表」，不回答「同一指标怎么算」；MCP 脚本里此前没有任何口径定义。Agent 技能里有一段散文形式的口径知识（国家维度、会员存量、新增会员、默认按 uid 去重），MCP 读不到、也不可测。
- **卡片之间、卡片与技能之间都有冲突**（`node scripts/bi-caliber-audit.mjs`，离线扫 96 张带 SQL 的卡片）：

  | 口径 | 一致 | 冲突 |
  |---|---|---|
  | 已支付订单（状态 3 或 6） | 26 张 | #46、#473 只用 6；按状态分组算结算率的 #44/#45/#47 不过滤，不算冲突 |
  | 收入金额（`changeAmount`，字段描述明确要求） | 4 张 | #125、#121 用 `SUM(amount)` |
  | 时区（按 `Asia/Shanghai` 解释） | 85 张 | 0 张。29 张手写 SQL 没写时区，但只读查询 `SELECT timezone()` 证实服务器默认时区就是 `Asia/Shanghai`，结果等价（初版把它们误判为冲突，已修正） |
  | 国家维度（技能规定只认 `elt_user_full.countryCode`） | 0 张 | 4 张按 `elt_app_params.ipCountryCode` 分组：#125、#121（「国籍」）与 #126、#120（「设备分布」） |
  | 用户去重主键 | — | 技能默认 `uid`；卡片 `count(distinct)` 17 张按 `guid`、1 张按 `uid`（无法机检，只做定义） |

  Metabase 元数据里 `orderStatus` / `orderType` 没有任何字段描述，状态 3 与 6 的含义只能由业务方确认。
- **#125 更正**：模型按技能用 `elt_user_full.countryCode` 拆国籍，卡片用 `elt_app_params.ipCountryCode`；此前把它记为「模型真实漏表」不成立，是口径冲突。
- **口径词典草稿**（`apps/agent-server/bi-semantic/caliber-glossary.json`）：已支付订单、收入金额、报表时区、账号国家维度、设备 IP 所在国（§11.11 新增）、用户去重主键、会员存量、新增会员共 8 条，**全部 `status: draft`**。每条写明依据（卡片多数写法 / 字段描述 / Agent 技能）和需要业务方回答的问题（`openQuestions`），已支付订单、收入金额、时区、账号国家、会员存量 5 条带可机检规则。冲突证据由审计脚本现场算，不手写进词典。
- **线上提供方式**：新 MCP 工具 `get_metric_definitions` **只返回 `approved` 条目**；没有批准条目时不在 `tools/list` 里宣告（当前即如此，线上零变化）。进程级冒烟：草稿状态 21 个工具不含它；临时批准一条后出现，且只返回那一条；文件已还原。批准后需重启 agent-server（或 MCP 重载），工具列表才会刷新。

#### 3. Schema 图：已优化，本轮补上「核对结论回灌」

外键核对清单移到运行时目录 `apps/agent-server/bi-semantic/fk-signoff.json`（原 `tests/bi-fk-signoff.json`；MCP 不读 `tests/` 下的评测夹具）。`get_table_relationships` 对核对未通过的 7 条外键加 `verified: false` 与 `healthNote`（父表为空 / 子列从未写入 / 自引用悬空 / 越权无法核对），并附总提示；M-Schema 在对应 FK 后加 `[FK 核对未通过：…]`。11 条可信的外键输出不变。真实元数据冒烟：18 条里正好标出 7 条，`elt_film_order` 上标了 `activityId`、`srcOrderId`，`movieId`、`preOrderId` 不受影响。人工签字后在清单里填 `signoff.decision`，标注会改为「人工结论：…」。

#### 4. GraphRAG：不需要

- schema 层有确定性 18 边外键图；口径层用零 LLM 成本的共现图，问题改写为自然语言后留一法召回：前 5 张 86.1%、前 12 张 96.8%（热门基线前 5 张 61.0%），没触发「召回 < 70% 才上图」的闸门。
- 真正的瓶颈不在检索：34 例 JoinCorrect 失败里 20 例是「试对了又丢掉」（推理与答案组装）；另一类是口径定义（语义层问题）。微软式 GraphRAG 的强项是对大量非结构化文本做全局归纳，两类都不对路。业界对口径问题的通行做法是语义层 / 指标定义（Metabase Metrics & Models、dbt Semantic Layer、Snowflake Cortex Analyst 的语义模型）加「已认可查询」（Cortex Analyst 的 Verified Queries、Databricks Genie 的 trusted assets 与 instructions）——本轮的口径词典与 `get_metric_definitions` 是它在 MCP 层的最小形态。

#### 5. 评测补上口径维度（评分口径 v4）

`scoreCase` 按词典里可机检的规则（含草稿）查**最终 SQL**：`caliberOk`（无适用规则为 null）、`caliberViolations`；汇总报 `caliberOk` 与按规则分列的 `caliberByRule`（单条规则冲突多时不淹没其它口径）；报告 `meta.glossary` 记词典版本与状态，草稿口径下的结论只作参考。时区规则带 `serverTimezone`：不写时区按服务器默认时区解释，与约定一致即不算冲突，只有显式写了别的时区（如 `Asia/Kolkata`）才算。旧报告 v4 重评（时区规则修正后）：

| 规则 | 模型最终 SQL：检查 / 冲突 | 卡片自身（`--dry`）：检查 / 冲突 |
|---|---|---|
| 时区 | 73 / 0 | 85 / 0 |
| 已支付订单 | 18 / 3（#46、#57、#85） | 28 / 2 |
| 收入金额 | 7 / 3（#125、#44、#85） | 6 / 2 |
| 国家维度 | 1 / 0（#125 用了 `elt_user_full`） | 4 / 4 |
| **合计 `caliberOk`** | **68/73（93.2%）** | **80/86（93.0%）** |

模型 SQL 里 5 例冲突（#125、#46、#57、#44、#85），JoinCorrect 为真但口径冲突的 2 例。初版报的「caliberOk 21/73、36 例表对口径错」是时区误判造成的，已作废。#46 是模型照抄卡片的 `{6}`——卡片自己与草稿口径不一致，所以**口径要先拍板，评测才有统一标准**。

#### 6. 默认开关建议（待拍板，未改）

- **M-Schema 设为传 `table` 时的默认格式**：Agent 侧没有代码解析 `get_database_schema` 的 JSON（`src/` 只按工具名匹配），改默认不会弄坏代码，影响只在模型行为上。建议先看重跑报告里模型实际传了什么 `mode`，若多数没传，再改默认并在下一轮 A/B 观察。
- **`with_values`**：维持默认关。代价是每张表首拉约 +1 秒（缓存 5 分钟后约 1 毫秒），收益只在枚举过滤类问题上；建议等重跑后统计「过滤条件取值不存在 → 空结果」的次数再决定。

#### 7. 仍待业务 / 人工

1. 词典 8 条逐条拍板（尤其状态 3/6 的含义、`amount` 的单位、日切是否改加尔各答、「国籍」是账号注册国还是设备所在地、按 `guid` 去重的卡片是不是设备口径）。
2. 冲突卡片（#46、#473、#125、#121、#120、#126）是否修改，由卡片作者决定；改了之后重跑 `bi-golden-bootstrap.mjs` 与审计脚本。
3. 外键清单的人工签字（§11.9-D）。

### 11.11 对齐最佳实践的差距复核（2026-11-12，目标：text2sql 更准）

> 方法：逐项对照代码与离线数据（旧报告 `.data/bi-eval-full.rescored.json`、黄金集、真实元数据只读查询），不调模型。参照的业界做法：CHESS（值检索 + schema 裁剪）、DAIL-SQL / 动态 few-shot（按相似度取「问题 → SQL」样例）、Snowflake Cortex Analyst（语义模型、sample values、Verified Queries、歧义时追问）、Databricks Genie（trusted assets、instructions、值字典）、Metabase Metrics & Models、dbt Semantic Layer、Anthropic《Writing effective tools for agents》（工具少而不重叠）、CHASE-SQL / XiYan-SQL（多候选生成 + 选择）。

**一句话结论**：表选择与 Schema 呈现已基本对齐；剩下最大的准确率缺口是**取值链接**（问题里的渠道、素材、事件名对应到库里的具体值），现有指标完全没量到它；其次是口径规则散落三处、互相打架。GraphRAG 仍不需要。

#### 1. 本轮已修（离线、零线上影响）

- **时区规则误判**：只读查询证实 ClickHouse 服务器默认时区与 Metabase `results_timezone` 都是 `Asia/Shanghai`，不写时区与显式写上海等价。规则加 `serverTimezone` 后，模型时区冲突 50 → 0、卡片 29 → 0；`caliberOk` 由 21/73 修正为 68/73，「表对但口径错」由 36 例修正为 2 例（§11.10-5 已同步）。
- 文档过时处：§2 工具表补注（现 22 个工具）、§11.3「业务表不在连接内」作废。

#### 2. 新发现，按对准确率的影响排序

| # | 问题 | 证据 | 对齐的做法 | 建议 | 改线上？ |
|---|---|---|---|---|---|
| 1 | **取值链接缺失**，且没有指标 | 96 题里 51 题的金样 SQL 按字符串值过滤（`INGoogle5`、`FoxA`、`VIP_intro_pageview`、素材 ObjectId 等）；旧报告可评的 48 题里，模型最终 SQL 把这些值**全部写对的只有 15 题（31%）**。JoinCorrect 与口径检查都量不到 | CHESS 值检索；Cortex Analyst 的 sample values 与字面值检索；Genie 值字典 | ① 评分加 `valueMatch`（金样过滤值是否出现在最终 SQL，纯离线）；② 口径词典加「实体别名」类条目（如 IN8、FOXA 对应的应用/渠道取值，**需业务确认**）；③ 新工具按值搜索：只对白名单维度列（应用、渠道、事件名、素材）缓存去重值，按问题里的词模糊匹配 | ①否 ②③是 |
| 2 | **黄金集题目隐含了范围条件** | 如 #64「会员订阅按地区、设备、套餐包的分布」，金样只算 `FoxA`；#96「Facebook 素材 Akhanda 2」，金样过滤 `INGoogle5`。题里没说，模型只能猜 | 评测题须自包含；隐含范围要么写进题，要么作为默认口径写进语义层 | 业务确认「印度板块默认看哪个应用」：是默认口径就进词典，不是就把范围补进题目。否则评测在考「猜题」 | 否 |
| 3 | **口径规则三处来源、互相打架** | ① Agent 技能文字；② `bi-query-guard.mjs` 硬编码拒绝 `ipCountryCode`、`vipExpireDay`；③ 口径词典草稿。查询闸门会直接拒绝含 `ipCountryCode` 的 SQL，所以 #120/#121/#125/#126（按设备 IP 国家统计）的金样口径**永远跑不出来**，这 4 题在评测里必失分 | 语义层是唯一真相源（dbt / Cortex 语义模型） | 词典作为唯一来源：闸门改为读已批准条目里 `enforce: "reject"` 的规则；「国家」拆成两个具名维度（账号注册国 `elt_user_full.countryCode`、设备 IP 国 `elt_app_params.ipCountryCode`），而不是一刀禁掉；评测给这 4 题打标单列。技能文字改为引用 `get_metric_definitions` 属于 Agent 侧，需你同意 | 是 |
| 4 | **已认可查询没有内联给模型** | `get_caliber_context` 只返回命中卡片的 id、名称、表，SQL 要模型再调 `get_card`；34 例 JoinCorrect 失败里 20 例是「试对了又丢掉」 | Cortex Verified Queries；DAIL-SQL 按相似度取「问题 → SQL」样例 | `get_caliber_context` 直接附前 1–2 张命中卡片的 SQL（截断约 1500 字），并提示「按此改写，不要从零写」；需 A/B 验证，token 会增加 | 是 |
| 5 | **口径图检索只看卡片名 + 表名** | 中文问题与英文表名几乎匹配不上；58 张表的中文表描述、207 个字段描述、词典别名都没进索引，与卡片不像的新问题只能靠热门度 | 两阶段 schema linking 用描述做检索；业务词典做词法替换 | 把表描述与词典别名加进口径图的匹配文本；用 `bi-caliber-eval.mjs` 离线验证召回（不调模型），召回不降再上线 | 是 |
| 6 | `search_columns` 与白名单口径不一致 | 只查 ClickHouse `system.columns` 的列名和注释（192 张表，含 Metabase 隐藏的 5 张与其它库），而业务描述在 Metabase 里，查不到 | 检索与暴露范围一致 | 同时匹配 Metabase 字段描述；对不在 58 张白名单里的表标「Metabase 未暴露」 | 是 |
| 7 | 元数据源头缺口 | `orderStatus` / `orderType` 没有任何描述；描述里的枚举已证实会过期（`clientType`、`result_type`） | 在语义源头修，LLM 起草描述、人工审 | 从卡片 SQL 统计「最常用但没描述的列」，出一张清单给业务在 Metabase Data Model 里补；这是每次查询都受益的改动 | 否（改 Metabase） |
| 8 | 歧义没有信号 | 「国籍」有两种口径、「新用户」按什么时间算等，MCP 不告诉调用方「这里有歧义」 | Cortex Analyst / Genie 遇歧义追问 | 词典条目加 `ambiguous` 与候选项，`get_metric_definitions` 返回时带上；是否追问由 Agent 决定 | 是（只加信号） |
| 9 | 工具面偏宽 | 22 个工具，其中 5 个执行入口功能重叠（`run_native_query`、`execute_sql`、`query`、`construct_query`、`execute_query`）；评测用的 `get_golden_set` 在生产也宣告 | 工具少而不重叠，描述互斥 | 先把 `get_golden_set` 改为仅评测 / 开发环境宣告；合并执行入口会影响 `src/chat.ts` 与 `decision-guardrail.ts` 的工具名匹配，属 Agent 侧，只记录 | 是 |
| 10 | 执行卡片的结果没有反馈行 | `execute_query` 与 `query(question_id)` 不输出 `-- [feedback]`，卡片捷径的行数与空结果不可评、也没有结构化信号 | 执行反馈闭环 | 两处补上 `buildQueryFeedback` | 是（只追加一行） |

#### 3. 评测体系的差距

- **真·结果集 EX**：仍按决定暂缓。但上表第 1、2 项说明，只有结果集比对能完整抓到「值写错 / 范围漏写」；金样卡片都能执行，至少聚合类题目可以先做。
- **题源单一**：97 题全部来自卡片，而卡片同时也是检索语料，所以必须靠留一法防泄题，也不代表真实用户的问法。业界做法是「评测飞轮」：从线上对话抽真实问题、把失败案例转成新题。建议请业务标注 20–30 道真实问题作为第二套集合。
- **反馈沉淀**：用户确认正确的查询沉淀为已认可查询（Cortex 的 verified query 建议、Genie 的 trusted assets），目前没有通道，列为后续。

#### 4. 明确不在 MCP 层做（记录，供 Agent 侧参考）

多候选生成 + 选择（CHASE-SQL、XiYan-SQL）、自一致性投票、重试预算与「同错两次即降级」的编排、是否追问用户——都属于调用方编排，超出 §0 范围。MCP 侧已提供结构化反馈信号，第 8 项再补歧义信号。

#### 5. 建议顺序

1. 先做纯离线、不改线上的：第 1 项①（`valueMatch` 指标）、第 7 项（缺描述列清单）、第 10 项（反馈行，只追加）。
2. 业务拍板：第 2 项（默认应用范围）、第 3 项（国家拆两个维度）、§11.10 的 8 条口径、第 1 项②的实体别名。
3. 拍板后改线上：第 3 项（闸门读词典）、第 5、6 项（检索文本）、第 4 项（内联卡片 SQL）、第 1 项③（按值搜索），再按 §11.9-C 做 A/B 重跑；第 4 项和第 1 项③会改变 token 与调用轮数，必须用 A/B 看净收益。

#### 6. 本轮实施结果（2026-11-12，未调模型；旧报告按评分口径 v5 重评）

| 项 | 落地 | 结果 |
|---|---|---|
| 第 1 项① 过滤值指标 | `bi-eval-score.mjs`：`filterLiterals` + `valueMatch` / `missingValues`（评分口径 v5，区分大小写） | 金样 96 题中 51 题带业务过滤值；旧报告模型把值全部写对 **15/48（31.3%，95% 区间 19.9–45.3%）**；JoinCorrect 为真的 24 题里仍有 10 题值写错。漏得最多的是应用 / 渠道码（`INGoogle5` 11 题、`FoxA` 4 题）、埋点事件名、素材 id |
| 第 7 项 缺描述列清单 | `scripts/bi-metadata-gaps.mjs`（只读拉元数据）→ `.data/bi-metadata-gaps.json` | 781 个字段只有 207 个有描述；卡片用到却没描述的列 187 个。前列：`elt_film_order.orderStatus`（31 张卡片）、`elt_watch_detail.movieType`（25）、`elt_new_guid.channel`（21）、`elt_film_order.orderType`（20）、`elt_gp_install_referrer_log.channel` / `elt_watch_detail.channel`（18）、`gather.eventName`（17）、`elt_film_order.amount`（12）。`channel`、`eventName` 正是第 1 项过滤值所在的列，补描述与取值说明可同时缓解取值链接 |
| 第 10 项 卡片执行反馈行 | `metabase-mcp.mjs` 新增 `runCard`，`execute_query` 与 `query(question_id)` 共用，结果末尾附 `-- [feedback]` | 真实 BI 冒烟通过；评分对卡片捷径的行数改由反馈行读取 |
| 第 5 项 检索文本 | `bi-caliber-graph.mjs`：`tableSearchText`（表描述 + 字段描述）+ 已批准口径别名（`glossaryTableTerms`），IDF 加权，`textWeight` 默认 1；离线夹具 `bi-known-tables.json` 新增 `tableTexts`（`bi-metadata-gaps.mjs` 导出，bootstrap 保留） | 留一法召回：前 3 张 78.5% → **80.1%**、前 5 张 86.1% → **87.1%**、前 12 张 96.8% 不变，精确率 16.0% → 15.3%；权重 ≥ 2 开始下降。只用描述文本（不用卡片）前 5 张仅 36.7%，低于热门基线 61.0%——元数据太稀疏（58 张表只有 3 张有表描述），这也是第 7 项要补描述的理由 |
| 第 4 项 内联卡片 SQL | `get_caliber_context` 给前 2 张命中卡片附 `sql`（每张 ≤ 1500 字），`BI_CALIBER_INLINE_SQL=0` 关闭（A/B 对照用，命令行设置） | 真实 BI 冒烟：「IN8 的日活设备分布」命中 #120、#126 并附 SQL。对 token 与轮数的净影响待 A/B |
| 第 3 项 闸门读词典 | `bi-query-guard.mjs`：内置两条硬规则按 id 对应词典条目，同 id 条目**批准后**由词典接管；`enforce: reject / warn / 不拦`；`bi-semantic.mjs` 新增 `forbidden_tokens` 规则；词典新增 `device_ip_country` 草稿，`country_dimension`、`member_stock` 标 `enforce: reject`（草稿，未生效） | **当前词典无批准条目，线上拦截行为与之前一致**；唯一的行为修正是内置国家规则先剥离 Metabase 透传投影，#59、#486 这类只透传不分组的 SQL 不再被误拒（外层引用照样拒）。评分新增 `goldBlocked` 与 `joinCorrectReachable` |

新发现（实施中查出）：

- **金样被线上闸门拒绝的有 6 题**，而不是预想的 4 题：#120、#121、#125、#126 是国家口径冲突；#55、#179 是**只读检查的关键词黑名单误判**——#55 的 SQL 里有列别名 `as call`，#179 用了 ClickHouse 函数 `truncate`（且带 Metabase 模板变量，本身也不能原样执行）。`sql-readonly-common.mjs` 与服务端 `src/sql-readonly.ts` 共用、属安全闸门，本轮**未改**；`replace(`、`set`、`load`、`copy` 等同类词在列名 / 函数名里也会误判，是否改为「只在语句级关键词位置判定」需单独评审。剔除这 6 题后旧报告 JoinCorrect 为 **57/87（65.5%，55.1–74.7%）**。
- **会员存量口径在代码里自相矛盾**：闸门内置提示写「vipType=2 且 startDate<=统计日 且 endDate>=统计日，逐日扫描」，词典（来自 Agent 技能）写「历史某日存量不能用 startDate/endDate 反推，须用开通流水重建」，已写进 `member_stock.openQuestions`。

验证：全量 `npx vitest run` 131 文件 / 914 测试通过（BI 相关 18 文件 / 149 测试）；真实 BI 只读冒烟（stdio 直连）：工具 21 个、口径检索附 SQL 与文本分、卡片执行带反馈行、透传列放行、按 `ipCountryCode` 分组仍拒。

仍待业务：第 1 项②（IN8 / FOXA 等与 `INGoogle5` / `FoxA` 的对应关系）、第 2 项（默认应用范围）、`device_ip_country` 是否保留、`member_stock` 两种写法以哪个为准、第 7 项清单在 Metabase 里补描述。仍待开发（需拍板后做）：第 1 项③按值搜索工具、第 6 项 `search_columns` 匹配 Metabase 描述、第 8 项歧义信号、第 9 项 `get_golden_set` 仅评测宣告。
