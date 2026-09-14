# Analytics 混合问数：语义层编译 + LLM 写 SQL（设计待确认）

> **状态**：设计已写完并完成作者校对；**用户确认前不得实现**  
> **日期**：2026-09-13  
> **宿主**：`apps/agent-server` Analytics 问数（`/analytics`）  
> **取代**：[`2026-09-09-metabase-analytics-agent-design.md`](./2026-09-09-metabase-analytics-agent-design.md) §1「B（LLM 写 SQL）为非目标」——本文把 B 升为**第三条受控路径**，不再是非目标。A（语义层编译）仍是 KPI 权威。  
> **不取代**：AskState / 时间 resolve / 歧义闸 / capability-gate / gold EX 机制。那些继续有效，只是前面多一层**路由**。  
> **关联**：`ANALYTICS_CATALOG_DIGEST.md`（活目录）、`watch-detail.pack.json`（overlay 配方）、本文 §10 对 `ANALYTICS_ARCHITECTURE_REVIEW.md` 过时结论的更正。

---

## 0. 一句话

问数 Agent 必须能**自己写出规范、只读的 ClickHouse SQL** 去查 Metabase 可答表；已建模 KPI 仍走确定性编译，避免同一口径每次被模型写歪。三条路径：`intent_compile`（可信）→ `verified_query`（金样绑槽）→ `llm_sql`（模型写 SQL，带水印）。

---

## 1. 产品需求（锁定）

最大需求：**这是 AI Agent 应用**。模型主导去理解问题、读表文档、写出可执行的规范 SQL，查 Metabase 里有文档/可答的表。

同时要对齐 2026 主流：KPI / 周报口径不能靠模型现场发明 JOIN 和分母。dbt 2026 已建模问题上语义层 98–100%、同库纯 Text2SQL 84–90%；失败时语义层拒答，Text2SQL 会给能跑的错数。Cortex Analyst 允许模型写 SQL，但必须对着语义模型，且**未声明 relationship 不准 join**，常用问句走 verified query。

因此本文不是「推倒编译器改成纯 Text2SQL」，也不是「继续禁止模型写 SQL」。而是把两条路接进同一条问数管线。

| 用户原话 | 本文落点 |
|---|---|
| LLM 主导写规范 SQL 查表 | Path C `llm_sql`：模型输出完整 SELECT / WITH…SELECT |
| 通用自然语言查有文档的表 | Path C + 已有单表泛化编译；不写 71 份 pack |
| 人均 / 起播 / 完播 / 付费 / 留存 | 先 Path B 金样可跑；再收成 Path A 的 kind（宽表 / ratio / retention） |
| 再问别的会不会无限加配方 | 不会。新形状才加 kind；其余走 C |

---

## 2. 现状（以今日代码为准，不以 09-13 评审文为准）

| 项 | 今日 |
|---|---|
| Metabase db2 | 71 表；可答 67；隐藏 4（`_tmp` / `_dict` / `upload_*`） |
| 白名单 | `allowedTableNames` = pack.tables ∪ warehouse.tables，**已不是 1/71** |
| LLM | schema-agent **只出 JSON 槽位**，`sqlSource` 只有 `intent_compile` |
| 单表泛化 | 非 overlay 可编 `count:*` / `uniq:field` / `sum:field` / `avg:field` |
| JOIN | AST 守卫已能抽出 FROM/JOIN 表名；**编译器永不产出 JOIN** |
| WITH | AST 已认 `with_select` |
| overlay | `elt_watch_detail` 上 `uniq_users` / `sum_watch_second` / `avg_watch_second_per_user` / `avg_max_progress`（wide 仅完播） |
| 泄漏 | probe / grounding-gate / dim-resolve / schema-agent 默认 table 仍钉 `pack.tables[0]`；`requireWhere` 全局强制 |

**不做**：为 67 张表各生成一份 pack。目录已经在 warehouse 里。

---

## 3. 目标与非目标

### 3.1 目标

- 用户用自然语言问，Agent 能对**可答表**取出数；SQL 对用户可见。
- 已建模 KPI 数字可重复、可回归（gold EX）。
- 未建模问题由模型写 SQL，失败形态是拒答或「未核验」水印，不是静默改成观看人数。
- 全表扩面 = 修泄漏 + 打开 Path C，不是堆配方。

### 3.2 非目标（本设计明确不做）

- 模型改 dashboard / 写库 / 多语句 / `INTO OUTFILE`。
- 未声明 relationship 的自由 JOIN。
- 从列名自动发明「付费率」「留存」当可信 KPI。
- Best-of-N 采样选 SQL、向量库（V1 金样匹配用词面 + 表集合，不用新 embedding 服务）。
- 巡检 scan/freshness 改走 LLM SQL。
- 与 `/chat` 后台 Agent 混会话。

---

## 4. 三条路径

| 路径 | `sqlSource` | 谁写 SQL | 交付信任 | 何时走 |
|---|---|---|---|---|
| A 语义编译 | `intent_compile` | `sql-compile.ts` | `trusted` | overlay/pack 度量且 **A 已能编出该形状**；或单表泛化四则 |
| B 金样绑槽 | `verified_query` | 金样 SQL 模板；代码只替换时间/渠道/版本/语言列表 | `verified` | 命中 VQR，且 A **还编不出** 该条形状（缺 kind / 缺 wide / 缺 JOIN） |
| C 模型写 SQL | `llm_sql` | LLM 输出完整只读 SQL | `unverified` | A/B 都不走，且已链接到 ≥1 张可答表 |

**互斥**：一问只走一条。禁止 A 失败后偷偷改 metric 再 ok（capability-gate 红线保留）。A 编不出且未入 B → 转 C；C 也失败则 `refuse`，文案必须带原因。

**抢答优先级**：B 只吃「A 编不出的金样」；C **不得**抢已能编的 A（例如已点名最大进度的完播走 A，不交给模型另写）。同一句「完播率 + 语言宽表」今日 A 已能编 → 走 A，不进 B。

---

## 5. 路由（代码，不靠模型自觉）

顺序固定，全部在 `analyticsAsk` 前半段、现有时间 resolve 之后：

```
NL（护栏后原文）
 → 时间 resolve（代码；解不开 clarify time_range）
 → schema linking（点名 / 文档分 / overlay 观看词）
 → 隐藏表点名 → refuse
 → 表检索为空 → Path C（compact 目录，不反问锁表）
 → 命中 VQR 且 A 编不出该形状（§6.2）→ Path B
 → 命中 pack/overlay 度量且 A 可编 → Path A
 → 单表 + 泛化四则可编 → Path A
 → 已链接 ≥1 可答表 → Path C
 → 否则 clarify 或 refuse
```

选表规则（2026-09-13 更正：对齐 Cortex / Cube / Metabot 的 schema linking，**不要求用户先锁表**）：

- 点名可答表名 / 已建模 metric / overlay 观看问 / 文档分唯一 → 锁该表，可走 Path A。
- 多表高分接近 → `retrieved` top-k（≤6 张富字段），走 Path C，不反问选表。
- 检索为空 → compact 目录（67 张一行摘要）交给 Path C，不默认 overlay。
- 隐藏表仍 refuse。SQL 白名单 = 全部可答表；富字段只给 top-k。

Path C 的 retrieved 集合上限 6 张富字段。VQR 的 `tables` **只在走 B 时**成为本轮白名单；给 C 当 few-shot 时**不得**把金样表扩进可写范围。禁止把 67 张全字段塞进 prompt（一行目录可以）。

---

## 6. 各路径怎么写 SQL

### 6.1 Path A（保持并补泄漏）

- LLM 只填：`table`、`metricId`、`time`、`filters`、`outputDims`、`layout`。
- 编译器按 kind 编：现有 `uniq` / `sum` / `avg` / `count` / `avg_per_user` / `avg_of_max`。
- 后续加 kind（**不是一问一配方**）：
  - `conditional_wide`：人均 / 起播 / 完播共用语言宽表；
  - `ratio`：付费率等跨表比；
  - `retention_dn`：D+N 队列。
- JOIN 只允许出现在这些 kind 的编译结果里，且走 pack `relationships`。

实现前必须先修 §8 泄漏，否则 A 的非 overlay 路径会继续探错表。

### 6.2 Path B（Verified Query Repository）

配置：`apps/agent-server/config/analytics/verified-queries.json`（或 pack 内 `verifiedQueries` 数组，V1 用独立 JSON，避免把 6 条大 SQL 塞进 watch-detail pack）。

每条：

| 字段 | 含义 |
|---|---|
| `id` | 稳定 id，如 `watch_avg_per_user_lang_wide` |
| `aliases` | 中文/英文触发语（人均时长、起播人数、完播率、付费率、留存） |
| `tables` | 金样用到的表，必须 ⊆ warehouse |
| `sql` | 已人工审定的 ClickHouse SQL，占位符见下 |
| `slots` | 允许替换的槽：`start` `end` `channel` `appVersion` `langs` |
| `promoteTo` | 可选，将来对应 Path A 的 metricId |

占位符只允许：`{{start}}` `{{end}}` `{{channel}}` `{{appVersion}}` `{{langs}}`。**禁止**模型改写 SELECT/JOIN/口径。绑定后仍走 AST + 表白名单。

匹配阈值（**全部**满足才进 B）：

1. `aliases` 至少命中 1 条（子串或词面）；
2. 该条 `tables` 全部 ∈ warehouse 可答（禁止点到隐藏表）；**不要求**用户先点名这些表——金样自己带表，走 B 时 `linkedTables` := 该条 `tables`；
3. 该条形状 A **还不能编**（`promoteTo` 为空，或指向尚未落地的 kind，或需要语言宽表而当前 kind 不是已支持 wide 的 `avg_of_max`）；
4. 多条过线时取 `aliases` 命中字数最长的一条；仍平局 → clarify（列金样标题，不猜）。

V1 收入用户已给的 6 条（占位符化时间/渠道/版本后入库）。预期路由：

1. 人均时长语言宽表 → **B**（A 的 `avg_per_user` 尚无 `conditional_wide`）
2. 起播人数语言宽表 → **B**（A 的 `uniq` 尚无 wide）
3. 完播率语言宽表 → **A**（已有 `avg_of_max` + `layout=wide`）
4. 付费率 → **B**（无 `ratio` kind）
5. 留存1（语言拆列）→ **B**
6. 留存2（合计）→ **B**

已走 A 或 B 的问**禁止**再进 C。C 只处理金样未覆盖、编译也编不出的新问法。

观看三条的 VQR `aliases` 必须带「宽表 / 按语言拆列 / 小语种列」等形状词，避免把 seed-v1 里普通「人均观看时长」从 A 抢走。付费、留存可用短别名（A 本来编不出）。

### 6.3 Path C（LLM 写 SQL）

模型角色：数据分析 Agent。输入只含：

- 用户原文（不改写）；
- 已解析时间（代码，覆盖模型自己编的日期）；
- 已链接表的 Metabase/inferred 说明、字段名/类型/字段说明、推断时间列；
- pack `relationships`（允许的 join 对 + 键）；
- 至多 3 条最相近 VQR（few-shot 形状，**不是**授权改口径）；
- 硬约束（见下）。

模型输出：**仅 JSON** `{"sql":"...","tables":["..."],"notes":[]}` 或 `{"status":"clarify","clarifySlot":"...","clarify":"..."}`。禁止在 SQL 外夹解释。

硬约束（prompt + 代码双重执行）：

1. 单条 `SELECT` 或 `WITH … SELECT`；ClickHouse 方言。
2. 表必须 ∈ 本轮已链接集合 ∩ warehouse 可答表。
3. JOIN 的左右表必须是 pack 里已声明的一对 relationship；未声明 → 该 SQL 作废，clarify 或 refuse。
4. 有时间列的事实表必须带日期谓词；无时间列的维表允许无日期。
5. `LIMIT` ≤ pack `guards.maxRows`（5000）；未写则代码补。
6. 去重函数按 `guards.distinctCountFn` 归一（`normalizeDistinctCount`）。
7. 时间字面量：代码用已 resolve 的 `start/end` **覆盖**模型写的日期（与今日覆盖模型 `time` 同原则）。

执行失败（语法 / 超时 / 未知列）：**首次生成 + 至多 2 次纠错，共 3 次尝试**。把错误摘要和 AST 问题回灌模型改 SQL。三次仍失败 → `refuse`，附最后错误。禁止改走 A 的另一个 metric 冒充。

`ANALYTICS_LLM_SQL` 环境变量：缺省 `on`。设 `off` 则 C 整段关闭，路由在「应走 C」处 `refuse`（回滚开关，不是默认产品形态）。

---

## 7. 语义图（给 A 的 JOIN 和 C 的约束共用）

在 `watch-detail.pack.json`（或旁路 `relationships.json`，V1 放 pack 以免双源）增加：

```json
{
  "entities": [
    { "id": "device", "keys": ["guid"] },
    { "id": "account", "keys": ["uid", "_id"] }
  ],
  "relationships": [
    {
      "id": "user_order",
      "left": { "table": "elt_film_user", "key": "_id" },
      "right": { "table": "elt_film_order", "key": "uid" },
      "join": "inner"
    },
    {
      "id": "new_active",
      "left": { "table": "elt_new_guid", "key": "guid" },
      "right": { "table": "elt_active_guid", "key": "guid" },
      "join": "inner"
    },
    {
      "id": "gather_new",
      "left": { "table": "gather", "schema": "gather", "key": "guid" },
      "right": { "table": "elt_new_guid", "key": "guid" },
      "join": "inner"
    }
  ]
}
```

规则：

- 未出现在 `relationships` 的表对，Path C **禁止 JOIN**，Path A 的新 kind 也禁止偷偷 join。
- 需要新 join 路径 = 改配置，不改路由内核。
- 单表查询不需要 relationship。

V1 只收录上面三对（覆盖付费 + 两条留存）。其它跨表问 → C 若只有单表可链则单表写；否则 refuse「未建模关联，请点名单表或补关系」。

---

## 8. 全表扩面：只修泄漏，不写 71 pack

问数主路径里仍读 `pack.tables[0]` 的，一律改为「已解析 table」：

| 点 | 文件 | 改后 |
|---|---|---|
| probe | `pipeline.ts` | `FROM` 已解析表；时间列 `packTimeField(pack, table)`；维不在该表则 SKIP |
| channel 接地 | `grounding-gate.ts` | 目标表无文本 `channel` 则跳过 |
| 词典 | `dim-resolve.ts` | `findMetabaseField(db, 目标表, field)` |
| schema-agent 默认 | `schema-agent.ts` | `table`/`fields` 跟已解析表；warehouse 列表已有则保持 |
| `requireWhere` | `sql-guard.ts` / `sql-ast.ts` | 本轮用到的表**至少一张有时间列**才强制 WHERE；纯维表聚合不强制日期 |

scan/freshness **不改**（不是对话问数）。

`intent.ts` 里「按天/按渠道」中文正则：本设计实现时迁到 pack `enumDimensions` / dim aliases，禁止继续靠 TS 业务词扩表。这是章程红线，不是顺手重构。

---

## 9. 交付与质量

### 9.1 用户可见

- 一律展示 SQL（三条路径都给）。
- Path C 结果标题/脚注必须带 **「未核验口径」**；Path B 带 **「金样口径」**；Path A 不加水印。
- 前端 `analytics` 页读 `sqlSource` / `trust` 即可，不按 SQL 文本猜。

### 9.2 类型扩展

`AskResult` / types：

- `sqlSource`: `"intent_compile" | "verified_query" | "llm_sql"`
- `trust`: `"trusted" | "verified" | "unverified"`
- `linkedTables?: string[]`
- `verifiedQueryId?: string`

### 9.3 评测（不改 soft-EX 算法）

| 集合 | 测什么 |
|---|---|
| 现有 seed-v1 overlay 24 条 | Path A 回归，EX 不得掉出原基线容差 |
| 新增 VQR 6 条 | Path B：必须 `sqlSource=verified_query`，EX 对金样执行结果 |
| 单表点名 10 条（订单/日活/新增等） | Path A 泛化或 C；对则即可，**不**把 C 的 EX 并入 GATE 分母 |
| 隐藏表 / 无关系 JOIN | 必须 refuse，计入 RefuseRecall |

GATE：

- overlay gold EX、RefuseRecall、CWR 门槛沿用 09-09 定稿（EX≥85%，RefuseRecall≥95%，CWR≤10%）。
- **新增** `coverage` 输出：`answerableTables=67`、`hidden=4`，与 EX 并列打印，不进「EX=100%」的同一分母。
- Path C 单独报表 `llm_sql_ex` / `llm_sql_exec_ok`，**不**用它宣称发版正确率。

---

## 10. 对旧文档的更正（避免两套真相）

| 旧结论 | 更正 |
|---|---|
| 09-09：B（LLM 写 SQL）为非目标 | 本文：B/C 为正式路径，A 仍是 KPI 权威 |
| 09-13 评审：1/71、须生成 71 pack | 今日 warehouse 已 67 可答；禁止 71 pack |
| 09-13 评审 Phase 0–4 自动派生多 pack | **取消**。被本文 §5–§8 取代 |
| capability-gate「超纲只能拒」 | 超纲 A 之后可以走 B/C；**仍禁止**超纲时改用 `uniq_users` 冒充 |

`ANALYTICS_ARCHITECTURE_REVIEW.md` 文首应加指向本文的横幅；正文历史对比可留，计划以本文为准。

---

## 11. 落地顺序（确认文档后按此实现，不得跳步）

| 步 | 内容 | 完成定义 |
|---|---|---|
| **0** | §8 五处泄漏 + `requireWhere` 按表 | 点名 `elt_film_order` / `elt_new_guid` 走 A 泛化，probe 不再打观看表 |
| **1** | types + 路由骨架 + `ANALYTICS_LLM_SQL` | 未接 C 时，「应走 C」refuse 文案稳定；A 回归 24/24 |
| **2** | VQR JSON + Path B 绑槽 | 人均宽表 / 起播宽表 / 付费 / 两条留存走 B 且 EX 对金样；完播宽表仍走 A |
| **3** | Path C：schema linking prompt + JSON SQL + 2 轮纠错 + 水印 | 点名无金样的可答表能出只读 SQL；非法 JOIN refuse |
| **4** | pack `relationships` 三对；C 按图校验 | 付费/留存若未走 B，C 也只能用这三对 |
| **5** | （可后置）A 增加 `conditional_wide` / `ratio` / `retention_dn`，VQR `promoteTo` | 原 6 条从 B 升 A，trust 变 trusted |

步 0–4 做完 = 「结合完整」的 Agent 形态。步 5 是把高频金样收回编译器，不阻塞 Agent 先能查。

**步 5 进度（2026-09-13）**：观看宽表 + 付费 `ratio` + 留存 `retention_dn` 均已升 A。VQR 6 条均可 `compileCanCoverVerified`。对照清单：[`docs/agent/ANALYTICS_NL_TO_TABLE.md`](../../agent/ANALYTICS_NL_TO_TABLE.md)。

---

## 12. 主要改动面（实现时按此拆，本文不写代码）

| 模块 | 动作 |
|---|---|
| `pipeline.ts` | 路由；probe 跟表；C 的纠错循环；覆盖模型日期 |
| `schema-agent.ts` 或新 `sql-agent.ts` | Path C 专用：工具仍可 `describe_table` / probe；**最终产出 SQL JSON** |
| `documented-ask.ts` / `table-resolve.ts` | 保持；给路由提供锁表 |
| `sql-compile.ts` | 步 5 才加 kind；步 0–4 不改编译语义 |
| `sql-ast.ts` / `sql-guard.ts` | `requireWhere` 按是否存在时间列；JOIN 表对 ⊆ relationships（C/B） |
| `semantic-layer.ts` | 读 `relationships` / `entities` |
| `types.ts` | `sqlSource` / `trust` |
| `config/analytics/verified-queries.json` | 新建 |
| `apps/web` analytics 交付 | 水印与 `sqlSource` |
| 评测 seed | 增 VQR 6 + 单表点名 + refuse JOIN |
| 单测 | 路由真值表（A/B/C/clarify/refuse）必须先于接入 LLM |

---

## 13. 风险与回滚

| 风险 | 处理 |
|---|---|
| C 写出能跑的错口径 | 水印 + 不进 GATE EX；高频问法进 VQR 或升 A |
| C 成本/延迟 | 链接表 ≤6；纠错最多 2 轮；A/B 命中则不调写 SQL 的 LLM |
| overlay 回归 | 步 1 起每步跑 seed-v1 |
| 要关模型写 SQL | `ANALYTICS_LLM_SQL=off`，只留 A+B |

---

## 14. 作者校对（2026-09-13）

对照 brainstorming spec self-review：

1. **占位**：无 TBD/TODO。环境开关、VQR 路径、关系三对、纠错次数、表上限、GATE 分母均已写死。
2. **自洽**：B 只在 A 编不出时抢答；C 不得抢已能编的 A。A 内部仍禁止换指标冒充。完播宽表走 A、人均宽表走 B，与 seed-v1 普通人均走 A 不抢。
3. **范围**：一份设计覆盖路由 + 三路径 + 泄漏 + 评测；实现按 §11 五步，不在本文展开函数签名。
4. **歧义已拍板**：
   - 单表四则可编 → A，不走 C；
   - 6 条用户 SQL：完播宽表走 A；人均/起播宽表与付费、留存走 B（B 自带表，不靠用户点名）；
   - 观看 VQR 别名必须带宽表/按语言拆列，以免抢走 seed-v1 普通人均；
   - 默认打开 C（`on`）；
   - V1 不用向量检索；
   - 不生成 71 pack；
   - 步 5 后置，不挡 Agent 先可用。

若以上任一拍板要改，改文档后再实现，不要改着代码再改口径。
