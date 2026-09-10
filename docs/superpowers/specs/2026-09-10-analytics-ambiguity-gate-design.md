# Analytics Ambiguity Gate（消歧闸门）

日期：2026-09-10  
状态：已实现（V1.1 去金句）

## 原则

- **结构通用**：未接地枚举过滤集 / 指标口径 / 宽·长表布局 → `clarify`，禁止查数。
- **禁止金 SQL**：`formatGroundedHint` 只描述维、过滤、口径、WIDE/LONG，不写 `sumIf` / 具体字段模板。
- 对照「正确形态」用规则：输出维 ∩̸ 多值过滤维 → 必须声明宽表或长表。

## 流水线

```
NL → Time resolve → Ambiguity Gate → Probe/Generate…
```

Gate priority：`filter_set` 成员(20) → 指标口径(30) → `result_layout` 宽/长(35)

## 代码

- `src/analytics/ambiguity-gate.ts`
- 前端多轮：`slotAnswers`（含 `result_layout`）+ 原问合并
- SQL UI：默认可折叠 + 复制按钮

## 非目标

- 手维金句、按题硬编码 ClickHouse 方言模板
