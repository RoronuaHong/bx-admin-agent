---
name: output-report-chart
description: 用户要查看报表/统计/趋势图表（报表、图表、折线、柱状、饼图、趋势）时使用。
version: 1.1.0
---

# 报表 / 图表输出

用户问「趋势、统计、收入、留存、观看时长、登录数据、Google 登录、BI」时使用。

## 流程

1. `get_page_schema` 判断 `analysis_chart` / `list` / `bi_iframe`
2. 普通报表列表：同列表链路 + 可附 KPI 一句话
3. 图表页：`call_api` 取数 → **服务端自动按 PC 口径呈现真 ECharts 折线图（`UI_CHART`）+ 数据表（`UI_TABLE`）+ 文字摘要**，无需模型手动拼图
   - 所有报表（含登录统计 `report.getLoginDataTotal`）统一走通用 `presentGenericChart`：服务端实时读 PC `configs.data.tsx` + `resolveI18nTitle` 还原中文列，自动推断 X 轴字段（cycle/date/time/period/statDate…）与数值序列，首序列默认选中。无任何按接口名写死的图表特例
   - 若 `call_api` 已自动呈现，**勿再空转检索**，直接用自然语言收束
4. BI iframe：只说明报告入口/名称，**不伪造 BI 数字**

## 强制

- 登录/报表分析页优先推送真实 canvas 图（ECharts），不要只给文字假装有图。
- 服务端自动出图后**立刻**自然语言收束，禁止再 grep / 重复调工具。
- 矩阵/宽表（留存、LTV）控制列数，必要时只展示最近 N 列并说明。

## 禁止

- 把图表接口原始 series 原样倾倒成无结构文本。
- 没有推送 `UI_CHART` 却声称「已画图」。
- 登录统计场景忽略 `cycle/successCount` 却只认 `date/value`。
- 服务端已自动呈现图表后仍空转调 `summarize_chart_data` / `render_table`。
