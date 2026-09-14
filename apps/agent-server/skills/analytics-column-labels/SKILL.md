---
name: analytics-column-labels
description: 问数结果表头仍是英文字段/SQL 别名（watchDate、channel、ml_IN）时，按用户输入框提到的名称一一对应改成展示名。用于自然语言问数表格、宽表语言列、人均时长按语种拆列。
version: 1.0.0
---

# 问数表头对齐用户原文

结果表的 `cols` 是 SQL 别名（`watchDate`、`te_IN`），展示名必须来自**当前用户问句里已经写出的叫法**，禁止凭经验另起中文名。

## 一一对应

| SQL 列（key，勿改） | 用户原文里的叫法（title） |
|---|---|
| `watchDate` | 「观看日期（由 lastWatchTime …）」→ **观看日期** |
| `channel` | 「渠道分组 / 渠道为」→ **渠道** |
| `en` / 空 `contentLang` | 「英语（contentLang=''）」→ **英语** |
| `te_IN` | 「泰卢固语（te-IN）」→ **泰卢固语** |
| `ta_IN` | 「泰米尔语（ta-IN）」→ **泰米尔语** |
| `ml_IN` | 「马拉雅拉姆语（ml-IN）」→ **马拉雅拉姆语** |

规则：`中文名（code 或字段）` 括号内码对上哪一列，标题就用括号外的中文名。问句没提到的列，保留 SQL 别名，不要编造。

## 实现

- 确定性代码：`src/analytics/column-labels.ts` 的 `relabelAnalyticsCols` / `withNlColumnTitles`
- 服务端给表带 `colTitles`（与 `cols` 等长）；前端 `title` 用 `colTitles`，`key` 仍用 `cols`
- Path A 编译 SQL **不要**把中文写进 `AS`（别名必须是标识符）；只改展示名
- Path C 写 SQL 同样：`AS te_IN` 即可，表头由代码按原文替换

## 禁止

- 不要用固定字典把 `ml_IN` 猜成「马拉雅拉姆」——必须以本轮输入为准
- 不要改 CSV/SQL 的物理列名
- 不要把筛选条件（如影片类型 1/2/3）当成结果列标题
