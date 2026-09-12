# Analytics 子系统架构评审（含覆盖率真相与主流对比）

> 日期：2026-09-13
> 范围：`apps/agent-server/src/analytics/**` + `apps/agent-server/config/analytics/**`
> 触发：对「EX=100%」评测结果的质疑 → 追查 gold 的能力边界 → 发现 1/71 表覆盖率问题
> 结论：**架构形状主流且多处领先，但 6 个 ❌ 全部长在同一条根上——语义表面是「手工 + 单表」的。**

---

## 0. 结论摘要（TL;DR）

| 项 | 结论 |
|---|---|
| EX=100% 是否为真 | **为真**，算法正确（执行结果比对，非字符串匹配） |
| 但它意味着什么 | 仅在 **1 张表 / 8 个字段 / 24 个人工审定用例** 上与手写 gold 结果一致 |
| 真实覆盖面 | Metabase db 2 共 **71 张表**（3 schema），已建模 **1 张**（`elt_watch_detail`）→ **1/71** |
| 字段级覆盖 | `elt_watch_detail` 实际 **23 个 active 字段**，pack 只列 8 个 → **8/23** |
| gold 该不该存在 | **该**。作为「确定性编译的 golden-master 回归锁」是正当且主流的 |
| gold 的陷阱 | 它**结构上无法测量覆盖率**，因此不能被当作能力证明 |
| 最大隐藏风险 | 代码中写死中文业务正则，**违反本项目自身最高红线** |

---

## 1. 覆盖面真相：71 张表 vs 1 张模型

通过 Metabase 原生接口实测（脚本：`apps/agent-server/scripts/enumerate-metabase-tables.mjs`）：

```
GET /api/database/2/metadata?include_hidden=true
```

| schema | 表数 |
|---|---|
| `film_report` | 58 |
| `gather` | 12 |
| `metabase_upload` | 1 |
| **合计** | **71** |

当前语义层只有一个 pack：

```
apps/agent-server/config/analytics/watch-detail.pack.json
  tables: [ { name: "elt_watch_detail", fields: [8 个字段] } ]
```

全仓库 `*.pack.json` 搜索结果 = **唯一 1 个**。加载入口写死默认 id：

```ts
// semantic-layer.ts:137
export function loadAnalyticsPack(id = "watch-detail"): AnalyticsPack
```

且 `assertTableAllowed`（`semantic-layer.ts:142-146`）对任何白名单外的表直接 `throw table not in whitelist`，**物理封死其余 70 张表**——连「答错」都做不到，只能被拦或拒答。

> 附带发现：`elt_watch_detail` 在 Metabase 实际有 **23 个 active 字段**，pack 只声明 8 个，说明 pack 本身是手工挑选的子集而非全字段。

---

## 2. 当前架构全链路

```
用户 NL
  ↓ ①  入口          analytics-tools.ts → pipeline.ts analyticsAsk
  ↓ ②  Pack 加载      loadAnalyticsPack(packId || "watch-detail")   ← semantic-layer.ts:137
  ↓ ③  多轮上下文      ask-state.ts / context-pack.ts / input-guard.ts（UNTRUSTED 原文隔离）
  ↓ ④  Schema Agent   schema-agent.ts  LLM 工具循环 → StructuredAskResult(JSON)
  │        · catalog 表写死 pack.tables[0]        ← schema-agent.ts:84-86
  │        · probe SQL 写死 lastWatchTime          ← schema-agent.ts:192
  │        · system 写死 contentLang/movieType     ← schema-agent.ts:215-242
  ↓ ⑤  能力闸门        capability-gate.ts   ops 白名单 vs known-but-unsupported → refuse/降级
  ↓ ⑥  Intent 组装     intent.ts   table = pack.tables[0]   ← intent.ts:138
  ↓ ⑦  SQL 编译        sql-compile.ts   `FROM ${intent.table}`   ← sql-compile.ts:261
  ↓ ⑧  SQL 守卫        sql-guard.ts + sql-ast.ts   AST 只读单 SELECT / 表白名单 / requireWhere / lintSql
  ↓ ⑨  执行            metabase-client.ts runNativeDataset
  ↓ ⑩  接地与对账      grounding-gate.ts / dim-resolve.ts / dim-reconcile.ts / scan/*
  ↓ ⑪  交付            delivery.ts（zero_fill）/ local-chart.ts
  ↓ ⑫  评测            seed-v1.json goldSqls 实跑 + soft-EX 比对 → GATE_*
```

### 关于 JOIN（已核实，非推测）

守卫层**能**放行多表：`sql-ast.ts:107` 的正则是 `(?:from|join)\s+`，`sql-guard.ts:42-45` 也声明「Extract bare table names from FROM / JOIN clauses」。

但：`intent.table` 恒等于 `pack.tables[0].name`（`intent.ts:138`），编译只拼 `FROM ${intent.table}`（`sql-compile.ts:261` 单表），pack 内亦无 join 声明。

> **结论：守卫允许 JOIN，但编译器永远产不出 JOIN —— 实际是单表系统。**

---

## 3. 单表假设的渗透清单

`pack.tables[0]` 散落在以下位置，构成「单表」的硬约束：

| 文件 | 位置 | 内容 |
|---|---|---|
| `schema-agent.ts` | :84-86 | catalog 暴露 `tables[0].name` / `fields` |
| `schema-agent.ts` | :192 | probe SQL 写死 `toDate(lastWatchTime)` |
| `intent.ts` | :138 | `table = pack.tables[0].name` |
| `pipeline.ts` | :221-223 | probe 目标表 & 字段白名单 |
| `grounding-gate.ts` | :39 | `table = pack.tables[0].name` |
| `dim-resolve.ts` | :32 | `table = pack.tables[0].name` |
| `conversation-structure.ts` | :50 | packCatalogHint 取 `tables[0]` |
| `scan/metrics.ts` | :142-146 | 单表 + `DEFAULT_TABLE = elt_watch_detail` |
| `scan/freshness.ts` | :70-73 | 单表白名单校验 |

---

## 4. gold 机制解析

### 4.1 它怎么打分（执行比对，非字符串）

`analytics-eval-harness.mjs:92-212`：

1. 跑 agent（`analyticsAsk`）得到结果表；
2. **同时**把 case 的 `goldSqls` 真正执行一遍 Metabase（`runGoldTables`）；
3. `softExMatchTables` 比对两张结果表（`eval-score.ts:76-194`）：
   - 列按别名家族归并（`users/uv/cnt/count` 算同名）；
   - 数值带 **1.5% 容差**（`cellsClose`）；
   - 允许 pred 多出列/行（记 `soft` 而非 `strict`）。

> **这是正确的主流做法**（Spider/BIRD 早已从字符串匹配转向 execution accuracy）。

### 4.2 附带的好设计

- **`gold` / `provisional` 双状态 + 人工 promote**（`eval-score.ts:229-237`）：只有 `gold` 进 GATE 分母；harness:270-281 明确「no gold answerable cases → GATE_EX is n/a until humans promote」。
- **基线回归门禁**：`baseline.ex` 仅在 `seedVersion` 相同时比对，容差 3pp（harness:311-325），防止扩题改分母造成假回归。
- **拒绝/幻觉指标齐全**：RefuseRecall ≥0.95、RefusePrecision ≥0.8、CWR ≤0.1、over_refuse。

### 4.3 为什么会有 gold（三个原因，须分开看）

| 类别 | 原因 | 评价 |
|---|---|---|
| (a) | **确定性编译的 golden-master 回归锁**：NL→Intent→确定性编译成 SQL，改任何一行 compile/guard 都可能静默改变 SQL，gold 用来捕获漂移 | ✅ 正当、主流 |
| (b) | **校验「配方」实现**：语义层作者知道目标 SQL，gold 验证 compile 配方正确 | ✅ 正当 |
| (c) | **被当作能力证明** | ❌ 陷阱 |

### 4.4 能力边界（关键）

gold 是**手写**的，且只能写在**已建模表面之内**：24 条 gold SQL 全部 `FROM elt_watch_detail`。因此：

> **EX=100% 对另外 70 张表的信息量为 0。**
> gold 从来不是用来测覆盖率的——这正是它能一边 100%、一边实际 1/71 却毫无声响的原因。

---

## 5. 与主流对比表

主流三个参照系：**受控语义层**（Looker+Gemini / Cube / dbt Semantic Layer / Databricks Genie）、**NL2SQL 评测基准**（Spider / BIRD）、**Agent Evals 实践**（LangSmith / Braintrust）。

| # | 维度 | 当前架构 | 主流做法 | 判定 |
|---|---|---|---|---|
| 1 | **度量/维度定义来源** | 手写 JSON pack（1 pack / 1 表 / 8-23 字段） | dbt Semantic Layer、Cube **自动派生**再微调 | ❌ 缺自动派生（1/71 根因） |
| 2 | **Schema 来源** | 手写在 pack；`/metadata` 仅用于取值词典 | warehouse 自动 introspect + fingerprint | ❌ 元数据未用于建包 |
| 3 | **多表 / JOIN** | 单表 `tables[0]`；守卫放过、编译器不产 JOIN | 星型模型 + join paths（Cube/dbt/LookML） | ❌ 实际单表 |
| 4 | **方言/去重函数归一** | `normalizeDistinctCount`（uniq/uniqExact） | 方言适配层 | ✅ 一致 |
| 5 | **LLM 角色** | LLM **只填槽位**，SQL 由确定性编译器产出 | Looker/Genie/Cube 同样受控，不让自由写 SQL | ✅ 主流且更保守 |
| 6 | **值接地 / 禁止编造词典** | probe 探值 + Metabase 词典 + 显式禁 LLM 自造 | 多数实现让 LLM 猜值 | ✅ **领先** |
| 7 | **安全护栏** | AST 只读单 SELECT + 表白名单 + maxRows 5000 + `forcedFilters`（RLS 钩子） | 只读 / 行数上限 / 行级权限 | ✅ **领先**（RLS 钩子加分） |
| 8 | **强制时间窗 requireWhere** | 全局强制必须有 WHERE | 通常只在事实表/事件时间场景 | ⚠️ 过严 |
| 9 | **多轮与澄清** | AskState + clarifySlot + probe + 工具循环 | 好产品支持多轮；基础 NL2SQL 多单轮 | ✅ 一致 |
| 10 | **能力协商 / 降级策略** | `capabilities.ops` + `downgradePolicy: strict`，超纲直接 refuse 不静默降级 | 多数直接静默降级或幻觉答 | ✅ **领先** |
| 11 | **评测比对方式** | 跑 gold SQL **比对执行结果**，soft-EX | Spider/BIRD 用 execution accuracy，已弃字符串匹配 | ✅ 正确且一致 |
| 12 | **gold 人工审定 + 回归门禁** | 人工 promote + 基线回归 3pp + refuseGold≥8 硬门禁 | LangSmith/Braintrust dataset + human review + CI | ✅ **领先** |
| 13 | **Held-out / 未见 schema 泛化** | **无**（新表被 `assertTableAllowed` 拦） | 学术基准专测 unseen schema；工业界 canary/held-out | ❌ **缺失** |
| 14 | **覆盖率 coverage 作为门禁维度** | GATE 只有 EX / CWR / RefuseRecall / RefusePrecision，**无 coverage** | 多按 per-database accuracy 报告 | ❌ **缺失**（1/71 隐形于此） |
| 15 | **拒答 / 幻觉指标** | RefuseRecall + RefusePrecision + CWR + over_refuse 全套 | 很多只有 accuracy | ✅ **领先** |
| 16 | **代码中是否写死业务词** | `intent.ts` / `sql-guard.ts` 含中文业务正则 | 受控语义层把业务语义放配置/模型层 | ❌ **违反自身红线** |

**汇总：9 项 ✅（其中 6 项领先）、1 项 ⚠️、6 项 ❌。**

---

## 6. 根因链：6 个缺口长在同一条根上

```
手工写 pack ─┬─► 不加机器   ⇒ 只能 1 张表            (#1 #2)
             ├─► 配置表达不了 ⇒ 业务语义漏进代码 ⇒ 违反红线 (#16)
             └─► 编译器只见 tables[0] ⇒ 无 JOIN       (#3)
手写表结构 ─┬─► 可答空间被穷举 ⇒ 无 held-out          (#13)
            └─► GATE 只有「对了没」 ⇒ 无 coverage      (#14)
```

**架构本身不需要推倒**——第 5、6、7、10、11、12、15 项优于平均，应保留。

---

## 7. 违反自身红线：代码中写死的业务词

项目最高红线（`AGENT_CHARTER.md`「禁止写死」）规定：**任何位置不得出现业务词形态正则**。主 orchestrate 链路已清理干净，但**后起的 analytics 子系统未清理**：

| 文件 | 行 | 写死的中文业务正则 / 字段 |
|---|---|---|
| `intent.ts` | :162 | `按天\|按日\|按.*日期\|每天\|观看日期` |
| `intent.ts` | :163 | `按.*渠道\|各渠道\|观看日期.*渠道\|渠道.*维度` |
| `intent.ts` | :144-158 | 硬编码 `channel` / `movieType` 字段 |
| `sql-guard.ts` | :26 | `不要没标\|排除空\|不要空语言` |
| `sql-guard.ts` | :29 | `只要第\|第一名\|top\s*1` |

**后果**：这不只是「黑话奶茶失 hygiene」问题——它意味着**加一张新表需要改 TS 代码**（往正则里塞新表的时间字段/维度名），而不是加配置。这是「扩到 71 张表」的结构性阻塞点，比「pack 少」更根深蒂固。

---

## 8. 改进方案（已选定：选项 B —— 元数据自动派生多 pack）

### 8.1 目标

改造语义层，使其从 Metabase metadata **自动派生**每表 pack（字段 → 维度/指标启发式），让 agent 真正能答多张表，再据此扩 gold。

### 8.2 分阶段计划与当前状态

| Phase | 内容 | 状态 |
|---|---|---|
| **0** | 元数据 → pack 生成器（含 soft money 修保例：时间字段/维度/指标）+ 71 张表产物 + manifest | ⚪ 未开始（`enumerate-metabase-tables.mjs` 已可用，产出 71 表清单；生成器本体待写） |
| **1** | `loadAnalyticsPack` 支持多 pack（子目录 `packs/`）+ 新增 **NL→表路由**（LLM 从多表 catalog 选表）；`watch-detail` 保留为手工精调默认，确保不退化 | ⚪ 未开始 |
| **2** | 放松守卫：`assertTableAllowed` / `sql-guard` allowedTables 改为元数据表全集；`requireWhere` 改为「仅当表含时间字段且 NL 含时段」；probeField 时间字段改读 `pack.time.field` | ⚪ 未开始 |
| **3** | 通用指标编译：`intent.resolveMetricCompile` 支持任意字段 sum/avg/uniq/count(\*)，替代 watch-detail 专属 `avg_of_max`；**同时清理 #16 写死的中文业务正则** | ⚪ 未开始 |
| **4** | 基于派生 pack 扩 gold：每表至少 1 条可答 + 跨表路由正确（选对表）；重测 `watch-detail` 回归 24/24 | ⚪ 未开始 |

### 8.3 建议同步做的两件事（低成本、高价值）

1. **把 coverage 做成 GATE 一等输出**：`tablesCovered/totalTables`（现在 1/71）、`fieldsCovered`（现在 8/23），与 EX **并列**输出。**让 100% 旁边永远同时写着分母。**
2. **补「未建模队列」的拒答精度测试**：对 70 张未建模表随机提问，验证系统**正确拒答、不跨表串答**（当前零覆盖，是真实生产风险）。

---

## 9. 遗留与风险

- **Phase 1+ 触碰运行时管线**，存在使 `watch-detail` 24/24 退化的风险，需以 red-green 回归为前提推进。
- `requireWhere` 全局强制（`sql-guard.ts:53`）对非日志类表表述可能造成误拒，Phase 2 需一并处理。
- 自动派生的启发式（时间字段 / 维度 / 指标判定）**必须人工抽检**，否则会把错误的语义固化进 71 个 pack。
- gold 应从「穷举手写」退化为「抽样验证」，否则 71 张表手写 gold 会重演今日问题。

---

## 附：复现命令

```powershell
cd apps/agent-server
node scripts/enumerate-metabase-tables.mjs     # 枚举 Metabase db 2 全部表，输出 71 表 + 覆盖率 1/71
```
