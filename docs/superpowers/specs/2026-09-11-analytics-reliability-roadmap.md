# Analytics Agent 可靠性增强：诉求一致性 · 多步规划 · 用户记忆 · 宽表/多指标

> **状态**：P0 已落地；P1 YoY + MoM（等长前窗）+ merge_ratio 已落地；P2 prefs MVP 已落地；**AskState P0/P1 + P2 线性栈/Undo** 见 [`2026-09-11-analytics-askstate-design.md`](./2026-09-11-analytics-askstate-design.md) / [`2026-09-11-analytics-askstate-p2-design.md`](./2026-09-11-analytics-askstate-p2-design.md)  
> **日期**：2026-09-11  
> **实现**：`capability-gate.ts`；`ask-plan.ts`（yoy_window / mom_window / merge_ratio）；`analytics-prefs.ts`；AskState/TurnIntent 见专文；pack 以 `config/analytics/watch-detail.pack.json` 当前 version 为准（曾用 `2026-09-11.10`）  
> **宿主**：`apps/agent-server` Analytics 语义层路径（Structure → Intent → sql-compile → AST/lint → Metabase）  
> **关联**：  
> - [`2026-09-09-metabase-analytics-agent-design.md`](./2026-09-09-metabase-analytics-agent-design.md)（总定稿；质量门禁 EX / RefuseRecall / CWR）  
> - [`2026-09-10-analytics-ambiguity-gate-design.md`](./2026-09-10-analytics-ambiguity-gate-design.md)（消歧闸门；与本文件互补）  
> **原则红线**：通用机制优先——**LLM 声明诉求 / 能力缺口**，**代码校对是否可建模**；禁止靠无限追加业务词黑名单、手维枚举表当主路径。

---

## 0. 一句话

要把「能跑通的问数 Agent」升级成「可靠的 Agent」，必须先堵住 **静默降级（CWR）**：用户要的语义若不在 pack 已建模能力集内，只能 **`refuse` / `clarify`**，绝不能悄悄改成基础指标再 `ok`。

其后按「更像 Agent」递进：多步 Intent 规划 → 用户级记忆 → 宽表 pivot 修好后多指标并行。

---

## 1. 问题与动机

### 1.1 已暴露缺陷（评测摘要）

| ID | 严重度 | 现象 | 根因类型 |
|----|--------|------|----------|
| C6 | 红 | 问「各渠道观看人数的**同比增长率**」→ `ok`，SQL 仅 `uniq(guid)` | **诉求 vs 产出不一致**；超纲语义被丢掉 |
| C2 | 红 | 宽表 pivot → `refuse: missing_where`；且 `contentLang` 重复、外形非真宽表 | AST 只看外层 WHERE；宽表编译路径有误 |
| C4 | 黄 | 「电影」→ 澄清选项为裸码 `1,7,2…` | probe 只有码；clarify 未接 Metabase 词表（部分已修：`metabase_lexicon`） |

附带：单次问数偏慢；grain 元数据偶发不准。

### 1.2 为什么「写死同比正则」不够

| 做法 | 短期 | 长期 |
|------|------|------|
| 同比/环比/增长率/TopN 词表拒答 | 能挡 C6 | 词表永远长；漏词即 CWR；与「通用 Agent」相反 |
| LLM 填 **能力声明** + pack **能力目录** + 代码 **子集校验** | 同比/环比/TopN/百分位同一闸门 | 扩能力 = 加 compile 配方进 pack，不改闸门内核 |

**消歧闸门**（Ambiguity Gate）管「槽位未接地」；**本文件的一致性闸门**管「槽位虽满，但声明的语义超纲」。二者串联，缺一不可。

### 1.3 与现行流水线的位置

```
NL
 → Time resolve
 → Structure（LLM 填槽 + 可选 tool-loop）
 → Ambiguity / 枚举接地（clarify）
 → ★ Demand–Capability Gate（本设计 P0）★
 → Dim lexicon resolve（Metabase 字段词表）
 → Intent build → sql-compile
 → AST/lint（含穿透 WHERE）
 → Exec → Verify → 交付
```

静默降级发生在「Structure 把同比落成 `uniq_users`」且无人校对声明的环节——故闸门必须在 **compile 之前**、最好在 **Intent 组装前**。

---

## 2. 设计原则（强制）

1. **声明 ⊆ 能力**：Structure 输出中的 `ops` / `metricId` / `plan` 必须全部落在 pack 已声明、且存在 compile 路径的能力上；否则不得 `status=ok`。
2. **LLM 可输出、代码可校对**：模型负责识别「用户要同比」；代码只做集合包含与编译可达性检查，不维护业务同义词主表。
3. **失败可见**：超纲 → `refuse`（明确「当前未建模」）或 `clarify`（可降级为可建模问题时，须用户确认，禁止静默）。
4. **扩能力走 pack**：新增同比/环比 = 新 `metricDefs`/`ops` + compile 实现；闸门代码不变。
5. **非目标（本阶段）**：完整语义层指标平台、Best-of-N SQL、跨会话向量记忆库。

---

## 3. P0 — 诉求一致性闸门（Demand–Capability Gate）

### 3.1 目标

- C6 类题：**不得** `ok` 出基础 UV/时长；必须 `refuse` 或（可选）`clarify`「是否改为当前人数？」且默认倾向 refuse 当用户明确要增长率。
- 拒答召回上升；CWR 下降；与总定稿 §8 门槛对齐。

### 3.2 数据结构

#### 3.2.1 Pack：能力目录（写死的是「目录」，不是业务词）

在 `*.pack.json` 增加（示例，字段名实现时可微调）：

```json
{
  "capabilities": {
    "ops": ["base_aggregate", "pivot_wide", "pivot_long"],
    "metrics": ["uniq_users", "sum_watch_second", "avg_watch_second_per_user", "avg_max_progress"],
    "unsupportedOpsHint": {
      "yoy": "同比增长率尚未建模",
      "mom": "环比尚未建模",
      "growth_rate": "增长率尚未建模",
      "top_n": "TopN 排名尚未建模"
    }
  }
}
```

说明：

- `ops` / `metrics` = **白名单**（已支持）。
- `unsupportedOpsHint` = 可选文案表；**不是检测器**。检测靠模型声明的 `ops` id。
- 未来加 `yoy`：先实现 compile，再把 `yoy` 移入 `ops` 白名单。

#### 3.2.2 Structure：能力声明（LLM 输出）

在现有 schema JSON 上增加：

```json
{
  "status": "ok",
  "metricId": "uniq_users",
  "ops": ["base_aggregate", "yoy"],
  "askSummary": "各渠道观看人数的同比增长率",
  "...": "既有 time/filters/outputDims/layout"
}
```

约定：

| 字段 | 谁填 | 含义 |
|------|------|------|
| `ops` | LLM | 本题需要的运算/形态 id（可多选） |
| `metricId` | LLM | 主指标（须属于 pack.metrics） |
| `askSummary` | LLM | 一句话复述用户诉求（供审计与二次校验） |

**提示词约束（正向，少列业务词）**：

- 若用户要求相对历史窗口的变化率、排名截断、分位数等，必须把对应 **ops id** 写入 `ops`（id 列表来自 catalog 工具 / pack 摘要注入）。
- **禁止**在无法满足全部 `ops` 时仍输出 `status=ok` 且只保留基础聚合——应 `status=clarify|refuse` 或保留完整 `ops` 交给闸门。

Catalog 工具 `analytics_list_catalog` 须返回：`supportedOps`、`supportedMetrics`、`knownButUnsupportedOps`（来自 hint 键），供模型选 id，而不是默写中文。

### 3.3 闸门算法（确定性）

```
input: structure, pack.capabilities
1. if structure.status != ok → passthrough
2. metricId 不在 supportedMetrics → refuse(unsupported_metric)
3. for each op in structure.ops:
     if op 不在 supportedOps → refuse(unsupported_op:<op>)
        （或 clarify，若策略允许降级且用户未明确坚持）
4. if ops empty:
     // 保守：不因空 ops 用关键词补洞；可记 note ops_missing 供评测监控
     passthrough with note ops_missing
5. else ok → 进入 Intent
```

**降级策略（默认关闭静默）**：

| 策略 | 行为 | 默认 |
|------|------|------|
| `strict` | 任一 unsupported op → `refuse` | **生产默认** |
| `ask_downgrade` | clarify：「当前无法算同比，是否改为本期观看人数？」确认后去掉 op 再跑 | 可配置 |
| `silent_drop` | 丢掉 op 继续 | **禁止** |

### 3.4 与 Ambiguity Gate 的关系

| 闸门 | 管什么 | 典型出口 |
|------|--------|----------|
| Ambiguity | 槽位缺失 / 未接地枚举 / 宽长表未选 | `clarify` |
| Demand–Capability | 槽位齐了但语义超纲 | `refuse`（或 ask_downgrade） |

优先级建议：先消歧（用户说不清）→ 再一致性（说清了但做不到）。

### 3.5 回归与门禁

新增正式用例集（建议文件：`apps/agent-server/scripts/analytics-e2e-chain.test.ts` + `config/analytics/eval/consistency-v1.json`）：

| Case | NL 要点 | 期望 |
|------|---------|------|
| C6 | 各渠道观看人数**同比增长率** | `refuse` 或 clarify-downgrade；**禁止** ok+仅 uniq |
| C2 | te-IN/ta-IN 平均最大进度 **宽表分列** | 宽表修后 ok；修前至少不因假 missing_where 误杀（见 §6） |
| C4 | **电影**观看人数按天 | filters.movieType 含 `1` 或澄清选项含「电影」文案 |
| 基线 | IndiaA 区间按天人数 | ok + uniq |
| 基线 | 人均时长 | ok + avg_per_user |
| 超纲 TopN | 观看时长 Top 10 渠道 | refuse unsupported `top_n` |

评测指标：在原有 RefuseRecall / CWR 上增加 **ConsistencyMiss**（应拒却 ok 且 SQL 不含声明 op 语义）计入 CWR。

### 3.6 非目标（P0）

- 不在 P0 实现同比 SQL。
- 不用中文正则当主检测器（允许评测用弱启发式做 **漏报监控**，不进生产主路径）。

---

## 4. P1 — 多步问数规划（Multi-Intent Plan）

### 4.1 目标

「先算 A，再和 B 对比 / 合并」→ 拆成多个可编译 Intent，分别执行，再合并展示或二次派生（仍须在能力目录内）。

### 4.2 形态

Structure 扩展：

```json
{
  "status": "ok",
  "plan": {
    "steps": [
      {
        "id": "s1",
        "metricId": "uniq_users",
        "ops": ["base_aggregate"],
        "filters": {},
        "outputDims": ["channel"]
      },
      {
        "id": "s2",
        "metricId": "uniq_users",
        "ops": ["base_aggregate"],
        "timeOffset": "yoy_window"
      }
    ],
    "merge": {
      "kind": "side_by_side",
      "left": "s1",
      "right": "s2"
    }
  }
}
```

`merge.kind` 还可为 `ratio` / `diff`（须出现在 pack 能力目录中）。

规则：

1. **每步**单独过 Demand–Capability Gate + compile。
2. `merge.kind=ratio` 且表示「增长率」时，要求 pack 支持对应 merge/op——**未建模则整题 refuse**，不得只返回 s1。
3. 执行：并行跑可并行的 steps → 确定性 merge 函数（非 LLM 编 SQL）。
4. 审计：ledger 记录 `plan.steps[].sql` 与 `merge.kind`。

### 4.3 与「单 Intent 同比」的关系

- 短期：同比未建模 → P0 直接 refuse。
- 中期：可用两步（本期 / 去年同期）+ `merge.ratio` 作为 **第一种**同比实现，仍走能力目录，不写死中文。

### 4.4 非目标（P1）

- 任意 DAG / 循环依赖；最多 N 步（建议不超过 4）。
- 模型自由写 merge SQL。

---

## 5. P2 — 用户级记忆（Preferences）

### 5.1 目标

减少重复澄清：默认渠道、常用语言集、偏好布局（宽/长）、常用 movieType 集合等。

### 5.2 形态

| 项 | 说明 |
|----|------|
| 存储键 | `ownerKey`（与 chat 会话归属一致）或 analytics 专用 `analyticsPrefs` |
| 内容 | JSON：`defaultChannels[]`, `defaultContentLangs[]`, `preferLayout`, `recentMetricIds[]` |
| 写入 | 用户明确「以后默认 IndiaA」或连续确认同一过滤 N 次后可选写入（须可关闭） |
| 读取 | Structure 前注入 facts；**不得**覆盖用户本轮明文冲突值 |
| 澄清 | 仅当槽位缺失时用记忆预填，并在 UI 标明「已用你的默认偏好」 |

### 5.3 原则

- 记忆是 **默认值**，不是权限绕过。
- 不把记忆当枚举字典；维值仍走 probe / Metabase lexicon。
- PII / 跨用户隔离与现有 session 模型一致。

### 5.4 非目标（P2）

- 全量对话向量记忆；跨产品迁移。

---

## 6. P1b — 宽表 pivot 修复（先于多指标并行）

> 与 P1 并行可排期，但 **多指标并行依赖真宽表形态正确**，故标为 P1b，先于 §7。

### 6.1 缺陷拆解

1. **AST `missing_where`**：外层无 WHERE、WHERE 在子查询 → 误杀。  
   - **通用修法**：`requireWhere` 时递归检查任意子查询是否含 WHERE（或「主事实表扫描路径上存在 WHERE」），不按业务 SQL 形态白名单。
2. **重复 `contentLang`**：inner SELECT 维列表与 pivot 维未去重。  
   - **修法**：compile 时对 dims / entityKeys / pivot 去重。
3. **假宽表**：外层仍 `GROUP BY contentLang` 导致一行一语言。  
   - **修法**：wide 路径必须是「按非 pivot 维聚合 + 条件聚合多列」，外层 **不得** GROUP BY pivot 维（与现有 `avg_of_max` wide 配方对齐并修回归）。

### 6.2 验收

- C2：`status=ok`（或能力不足时明确 refuse），SQL 含多语言列、单行多列；AST 不报假 `missing_where`。
- 单测：嵌套 SELECT + 内层 WHERE → guard 通过；无任何 WHERE → 仍失败。

---

## 7. P3 — 多指标并行（Multi-metric）

### 7.1 前置

- §6 宽表正确。
- §3 能力目录含多 metric 声明（如 `ops` 含 `multi_metric` 或 `metrics` 为数组）。

### 7.2 形态

- Structure：`metricIds: string[]`（或多个 plan steps 同维不同指标）。
- Compile：同 WHERE/GROUP 下多聚合列；或并行多 SQL 再按维 join（确定性）。
- 超纲（未建模的组合）→ refuse，禁止只算第一个指标。

### 7.3 非目标

- 任意交叉表引擎；用户自定义公式 DSL。

---

## 8. 维值词表（与 C4 对齐，已部分落地）

| 机制 | 状态 | 说明 |
|------|------|------|
| Metabase `field/values` + `description` → lexicon | 已落地 | `dim-lexicon` / `dim-resolve` |
| clarify 选项显示中文 label | 应接线全路径 | 禁止长期依赖 pack 手维 `valueLabels` |
| probe Top-N | 保留 | 用于 contentLang 等 **literal** 维；remapped 维优先 lexicon |

原则不变：**文档在 Metabase，解析在代码，不在 prompt 里背字典。**

---

## 9. 实施顺序与里程碑

| 序 | 项 | 产出 | 验收 |
|----|----|------|------|
| **M0** | 本文定稿 + 回归用例清单落盘 | 本文；`consistency-v1.json` 草案 | 评审通过 |
| **M1** | Demand–Capability Gate + catalog 暴露 ops | `capability-gate.ts`；structure schema；pipeline 接入 | C6 类不得静默 ok；单测 + e2e |
| **M2** | AST 穿透 WHERE + 宽表 compile 去重/真宽 | `sql-ast` / `sql-compile` | C2 PASS |
| **M3** | Clarify 全路径 lexicon 标签 | pipeline clarify | C4 选项含「电影」 |
| **M4** | Multi-Intent plan（无增长率 merge 或仅 side_by_side） | plan 执行器 | 两步对比题可跑 |
| **M5** | 用户记忆 MVP | prefs CRUD + facts 注入 | 重复问减少澄清 |
| **M6** | 多指标并行 | multi metric compile | 同维双指标 ok |

**依赖**：M6 依赖 M2；增长率类 merge 依赖 M1 能力目录扩展 +（M4 或单 Intent yoy compile）。

---

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| 模型漏填 `ops`，超纲仍 ok | Catalog 强制注入 knownUnsupported 列表；评测 ConsistencyMiss；可选第二道 askSummary 与 metric/ops 一致性轻量校验（仍避免中文黑名单主路径） |
| 过度 refuse | `ask_downgrade` 配置；RefusePrecision 门禁 |
| 多步爆炸耗时 | steps 上限；并行；缓存 lexicon |
| 记忆误用 | 本轮明文优先；UI 明示默认来源 |

---

## 11. 文档与代码落点（实现时）

| 模块 | 路径（预期） |
|------|----------------|
| 闸门 | `apps/agent-server/src/analytics/capability-gate.ts` |
| Structure 类型 | `conversation-structure.ts` / schema-agent prompts |
| Pack | `config/analytics/*.pack.json` → `capabilities` |
| 回归 | `scripts/analytics-e2e-chain.test.ts` + `config/analytics/eval/consistency-v1.json` |
| AST | `sql-ast.ts` |
| 宽表 | `sql-compile.ts` |
| 记忆 | `analytics-prefs.ts` + 现有会话存储旁路 |

---

## 12. 决议摘要

1. **架构路线正确**；可靠 Agent 的缺口是 **诉求一致性**，不是再堆 Text-to-SQL。  
2. **P0 必须做**一致性闸门（声明 ⊆ pack 能力），禁止静默降级。  
3. **更像 Agent** 的递进：多步规划 → 用户记忆 →（宽表修好后）多指标并行。  
4. **通用性**：LLM 选能力 id；代码做集合校验；业务扩展进 pack/compile，不进闸门业务词 if-else。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-11 | 初稿：一致性闸门 + 多步规划 + 用户记忆 + 宽表/多指标优先级 |
