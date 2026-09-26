# 能力 vs 需求文档匹配评估

> **需求文档**：`PC_STRUCTURE_AND_OUTPUT_TYPES.md`（输出类型清单 + §6 skills/tools）  
> **辅文档**：`AGENT_CHARTER.md`、`AGENT_PC_ALIGNED_WORKFLOW.md`  
> **评估日期**：2026-08-20（补齐 skills/tools 之后）

---

## 1. 本次补充清单

### Skills（`apps/agent-server/skills/` + `.cursor/skills/`）

| Skill | 作用 |
|---|---|
| `pc-output-formats` | 列表/详情/表头对齐/Markdown 表工具链 |
| `output-report-chart` | 报表、ECharts 摘要、BI 说明 |
| `write-confirm` | 写操作 confirm + 回读 |
| `media-bi-richtext` | 媒体 meta、富文本摘要、BI |
| `business-intent` | ⚠️ 已停用（`enabled:false`，2026-08-22 起由 Cursor 规则/技能取代） |
| `export-preview` | 导出预览：render_table + export_dataset |
| `pc-agent-crud-router`（`.cursor/skills/`） | Cursor CRUD 确定性路由指南（模型按需调用） |

另：`skills.ts` 支持 CRLF；关键词按空白拆分；单轮最多注入 **3** 个 skill；支持多目录扫描（`.cursor/skills/`）；`loadResidentRules()` 加载 `.cursor/rules/*.mdc` 常驻底线。

### Tools（`tools.ts` + `output-tools.ts` + MCP）

| Tool | 作用 |
|---|---|
| `get_list_columns` | 读 `configs.data.tsx` 列（title/dataIndex） |
| `get_page_schema` | 识别 list/edit/analysis_chart/bi_iframe… |
| `render_table` | API 数据 → 聊天预览表（可 tree / footer） |
| `summarize_chart_data` | 序列 → 趋势摘要 + 关键点表 |
| `read_field_mapping` | 按模块读 `field-mapping.json` |
| `export_dataset` | 真导出 xlsx/pdf；聊天预览+下载 |

---

## 2. 对照需求文档：是否匹配

| 需求（输出类型 / 能力） | 文档 ID | 匹配度 | 说明 |
|---|---|---|---|
| 标准列表 → 中文表 | T01 | **已匹配** | columns + normalize + render_table |
| 树表/嵌套子表 | T02–T03 | **已匹配** | `render_table`/`export_dataset` 支持 `tree`/`children` 缩进 |
| 可编辑行 | T04 | **部分** | 读可以；写走 write-confirm，无单元格编辑 UI |
| 表尾汇总 | T05 | **已匹配** | `footer`（sum/avg）+ 聊天预览表尾行 |
| 图表（折/柱/饼/雷达） | C01–C06 | **已匹配** | 服务端按 PC 口径自动呈现真 ECharts 折线图（UI_CHART）+ 数据表；登录统计为特例优先，其余报表经 `presentGenericChart` 自动推断字段后同源出图（见 §4） |
| KPI / 看板卡片 | K01–K05 | **基本匹配** | 文字 KPI；无卡片组件 |
| 矩阵/留存/LTV | M01–M03 | **基本匹配** | 表输出 + 控制列数约定 |
| 整页/弹窗表单读 | F01–F05 | **已匹配** | 详情分块 + normalize |
| 写操作/审核/开关 | I01–I04 | **已匹配** | write-confirm + call_api confirm |
| 媒体播放/上传 | V01–V04 | **已匹配（约定）** | meta/URL only |
| 富文本 | E01 | **已匹配（约定）** | 摘要，不倾倒 HTML |
| Excel / PDF 导出 | X01 | **已匹配** | `export_dataset`；chat 预览+下载 |
| BI iframe | X03 | **已匹配（约定）** | 说明入口，不伪造数 |
| 字段对齐 | 原则1 | **已匹配** | normalize + read_field_mapping + columns |
| 四元组 / 澄清 / 默认项目 | 章程 | **已匹配** | 既有链路 |
| 与 PC operation/日志对齐 | AGENT_PC_ALIGNED | **已匹配** | call_api + 源码定位（方案 A）+ operation 索引安全底座 + log 策略 |

### 总评

- **核心查询路径（列表 / 详情 / 字段对齐 / 澄清 / 调接口）**：**匹配需求**  
- **报表/图表**：**匹配**（服务端自动按 PC 口径推真 ECharts 折线图 + 数据表；登录统计为特例，其余报表经 `presentGenericChart` 自动推断字段同源出图）  
- **写/审核**：**匹配**（确认门）  
- **导出 Excel/PDF、树表、表尾汇总**：**已匹配**（`export_dataset` + `render_table`）  

**结论：对照 `PC_STRUCTURE_AND_OUTPUT_TYPES.md` 的 P0/P1（及已落地的导出增强）可视为「已匹配」；媒体播放器内嵌、BI 完整画布、单元格编辑 UI 仍按约定不做。**

---

## 4. 图表自动呈现（P0 落地说明）

登录统计（`report.getLoginDataTotal`）走特例 `presentLoginDataTotal`：硬编码 PC 三序列（成功数/总数/成功率）、默认 Google 登录、近 7 天。

其余 Analysis / 报表页（`pageKind === "analysis_chart"` 或命中 `isAnalysisReportOperation`）在 `call_api` 成功后由 `presentGenericChart` 自动呈现：
- 自动推断 X 轴字段（cycle/date/time/period/statDate…）与数值序列（排除汇总行、非指标字段），无需模型手动拼图；
- 产出 `UI_TABLE`（数据表）+ `UI_CHART`（真 ECharts 折线，首序列默认选中）+ 文字摘要，与 `ResultChart.vue` 渲染一致；
- 仅当返回数据无法推断数值序列时，才回退到「模型用 `summarize_chart_data` 出摘要」的旧提示。

> 即：登录统计的「特判自动画图」已抽成所有报表共用能力，模型侧不再需要为每个报表硬编码 series。

---

## 3. 建议验收话术

| 输入 | 期望工具痕迹（示意） |
|---|---|
| 需要看白名单管理的列表 | understand → grep 源码定位模块 → read_file 读接口源码 → call_api → normalize → render_table |
| 用户列表，{id}，看详情 | understand → … → call_api → normalize → 分块文案 |
| 看观看时长趋势 | get_page_schema(analysis) → call_api → summarize_chart_data |
| 帮我下架某影片 | write-confirm skill → call_api confirm=true → 回读 |

重启 `agent-server` 后用 UI 或 `scripts/walk-flow-example.mjs` 验证。
