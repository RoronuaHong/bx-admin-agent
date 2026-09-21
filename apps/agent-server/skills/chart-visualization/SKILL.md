---
name: 图表可视化
description: 当用户要求画图、出图表、可视化数据分布/趋势/占比时，先取数再调用 render_chart 在对话内本地渲染（浏览器用 AntV 绘制，零外链、数据不出本机）。
default: true
---

# 图表出图流程（本地渲染，方案 D / 路线 3）

适用场景：用户要求「画个图」「可视化」「饼图/柱状图/折线图/趋势/占比/结构图/关系图」。

## 核心约定

- **先取数，再出图**：先调用取数工具（如 BI 查询）拿到真实数据，再调用 `render_chart` 把数据透传进去。**禁止编造数据点**——图里的每个数值都必须来自工具真实返回。
- **本地渲染、零外链**：`render_chart` 不在服务端出图、不调用任何外部渲染服务，图表由浏览器用 AntV 现场绘制，数据不出本机。因此**不需要数据外发确认卡**。
- **只画聚合后的序列**：建议 ≤50 个数据点（上限 5000 行由服务端兜底截断），先在查询侧聚合好维度与指标，不要把明细行塞进图。
- **禁止贴图片链接**：不要再输出 `![](url)` 或裸图片链接——`render_chart` 会让图表作为对话内卡片直接显示。

## 步骤

1. 取数：调用取数工具，拿到结构化结果（行数组，或图形所需的 {nodes,edges} / {name,children}）。
2. 选图型（见下表），确定 `chartType` 与字段映射 `encode`。
3. 调 `render_chart`：`{ chartType, data, title?, encode?, options? }`。
4. 出图后，用一两句话在回复里复述出图用的数据来源与关键数字（工具名 + 关键参数 + 数值），便于核对图与数一致。

## 图型与参数

| 需求 | chartType | data 形态 | encode 提示 |
|---|---|---|---|
| 占比 | `pie` | 行数组 | `color`=分类字段，`y`=数值字段 |
| 横向对比 | `bar` | 行数组 | `x`=分类，`y`=数值 |
| 纵向对比 | `column` | 行数组 | `x`=分类，`y`=数值 |
| 趋势 | `line` / `area` | 行数组 | `x`=时间/顺序，`y`=数值，`series`=分组 |
| 相关性 | `scatter` | 行数组 | `x`、`y`，`color`=分组 |
| 多维 | `radar` | 行数组 | `x`=维度，`y`=数值，`series`=对象 |
| 层级/结构 | `treemap` | 行数组 | `color`=分类，`y`=数值 |
| 转化 | `funnel` | 行数组 | `x`=阶段，`y`=数值 |
| 分布 | `boxplot` / `histogram` | 行数组 | `x`=分组，`y`=数值（boxplot 的 y 为五数数组） |
| 正负累计 | `waterfall` | 行数组 | `x`=项目，`y`=增减值 |
| 双指标 | `dual_axes` | 行数组 | `x`，`y` 与 `y1` 双轴 |
| 流量 | `sankey` | `{nodes,edges}` | — |
| 思维导图 | `mind_map` | `{name,children}` 或 `{nodes,edges}` | — |
| 组织架构 | `org_chart` | `{name,children}` 或 `{nodes,edges}` | — |
| 关系网络 | `network` | `{nodes,edges}` | — |

图形类（sankey/mind_map/org_chart/network）的 `data`：
- 邻接结构：`{ nodes:[{id,label}], edges:[{source,target,label?}] }`
- 层级结构：`{ name, children:[{ name, children:[...] }] }`（前端自动展开为节点/边）

## 注意

- 无法从工具拿到真实数据时，如实说明并给出取数建议，不要用编造数据出图。
- 字段名用数据里真实存在的英文/中文列名；若列名是英文，按项目 column-mapping 技能映射成中文展示（不影响 data 透传）。
