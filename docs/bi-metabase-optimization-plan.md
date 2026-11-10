# BI MCP 能力增强评估（关联关系 / GraphRAG / Schema / 评测）

> 生成时间：2026-11-10（v4，已确认范围边界：仅 BI MCP 层能力增强，不改 Agent 部分；对齐 2025–2026 线上最佳实践）
> 数据来源：Metabase REST API（`https://bi.vmovs.com`，等价于 `bi-metabase` MCP 元数据接口，使用项目 `.env` 中 `BI_API_KEY` 实测）＋ `apps/agent-server/scripts/metabase-mcp.mjs` 源码核查
> 关联文档：`docs/agent/bi-mcp.md`、`docs/agent/RAG_INGESTION_PLAN.md`、`apps/agent-server/src/eval-online.ts`
> 状态：评估文档（待评审，未做任何代码改动）

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
| **P1** | `get_database_schema` 升级 **M-Schema 格式 + 取值域内联**（§4.3-1/2）；强化 `search_columns`+`get_database_schema` 两阶段 linking 提示（§4.3-3） | P0 | MCP 输出为 M-Schema 且含取值域；prompt 内表数可控 |
| **P2** | 新增「问题-表」关系图 resource/tool（§4.2-1，纯元数据抽取）；建黄金集 ≥30 题 + `bi-eval-runner.mjs` 三维评分（§4.4） | P0 | 窄图可用；跑分器出 ValidSQL/EX/Join 正确率基线 |
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
- P2：「问题-表」窄图 resource/tool 可用；黄金集 ≥30 题；`bi-eval-runner.mjs` 能跑出 ValidSQL / EX / Join 正确率三维分数与基线。
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

## 9. 待确认决策

1. **GraphRAG 路线（§4.2）**：是否认同"先窄图（问题-表图，零 LLM 成本）、后语义层、以评测 recall@k<70% 为闸门"？默认不上全量图。
2. **M-Schema 输出变更（§4.3）**：是否同意 `get_database_schema` 格式变更？建议新增 M-Schema 模式、保留旧输出过渡。
3. **评测夹具/跑分器位置（§4.4）**：放哪个目录（须明确不进 `apps/agent-server/src` 运行时）？是否接入 CI？— 强调：不改 `eval-online.ts`。
4. **B 项 FK 核查责任人（§4.1）**：谁在 Metabase 后台逐条确认 18 条 FK（尤其 `elt_film_order` 自引用与 `action.action→action_config.id`）？
5. **「问题-表」窄图暴露形态（§4.2）**：作为新 MCP resource 还是新 tool 暴露？由 MCP 侧实现细节定，Agent 无感。
