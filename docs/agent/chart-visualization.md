# chart-visualization —— 图表可视化规范

> 现行（live）规范，对应 `skills/chart-visualization/SKILL.md`。注意：**图表出图不是外部 MCP 服务器**，而是「技能 + 内置工具 `render_chart`」——这与 `docs/deep-agents-plan.md` 提到的「chart 外置为 MCP」表述不同，当前实现是本地渲染。

## 1. 概述

当用户要求画图/可视化（饼图/柱图/折线/趋势/占比/结构/关系等）时：
- **先取数，再出图**：按被询问的主体走对应取数技能，拿到真实数据，再调 `render_chart` 透传。**禁止编造数据点**——图里每个数值都必须来自工具真实返回。
- **本地渲染、零外链**：`render_chart` 不在服务端出图、不调用任何外部渲染服务，图表由**浏览器用 AntV 现场绘制，数据不出本机**。因此**不需要数据外发确认卡**。
- 对应来源拿不到真实数据时，如实说明这个来源没有可用数据，**不用编造数据出图**，也不要改用另一个来源换主体。

## 2. 调用

`render_chart({ chartType, data, title?, encode?, options? })`：
- `chartType`：pie / bar / column / line / area / scatter / radar / treemap / funnel / boxplot / histogram / waterfall / dual_axes / sankey / mind_map / org_chart / network。
- `data`：行数组（多数图型；图结构类用 `{nodes,edges}` 或 `{name,children}`）。
- `encode`：`x`（分类/时间）、`y`（数值）必给；多条序列给分组字段（`series` 或 `color`）；`y1` 双轴。
- `options`：`xTitle`/`yTitle`（写中文）、`unit`（如 `%`）、`stack`、`bins`（直方图分箱）等。

## 3. 数据形态与卫生

- 建议 **≤50 个数据点**（上限 5000 行由服务端兜底截断）；先在查询侧聚合好维度与指标，不把明细行塞进图。
- 同一序列字段名保持一致（避免尾随空格使折线断裂）；时间/序号升序；序列名用可读名称。
- 饼图/矩形树/漏斗按分类给行数组（同分类多行自动合计），给原始值不要先算占比。
- 轴标题要用中文时写在 `options.xTitle` / `options.yTitle`，不要改 data 里的字段名。

## 4. 图型速查（需求 → chartType）

| 需求 | chartType |
|---|---|
| 占比 | pie |
| 横向/纵向对比 | bar / column |
| 趋势 | line / area |
| 相关性 | scatter |
| 多维 | radar |
| 层级/结构 | treemap |
| 转化 | funnel |
| 分布 | boxplot / histogram |
| 正负累计 | waterfall |
| 双指标 | dual_axes |
| 流量/关系/思维导图/组织架构 | sankey / network / mind_map / org_chart |

## 5. 与 BI / 取数的关系

图表本身不持有数据源：数据 100% 来自上游取数工具（典型是 `mcp__bi__*` 的 `run_native_query` / `get_card` 结果）。出图后，在回复里复述数据来源与关键数字（工具名 + 关键参数 + 数值），便于核对图与数一致。
