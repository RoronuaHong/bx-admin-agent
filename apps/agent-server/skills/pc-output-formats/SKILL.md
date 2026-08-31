---
name: pc-output-formats
description: 用户要看列表/详情输出、字段对齐或表格渲染形态（表头、字段对齐、Markdown 表）时使用。
version: 1.0.0
---

# PC 输出形态（列表 / 详情 / 字段对齐）

用户要「看列表、看详情、对齐后台字段」时遵循本指南。对照文档：`docs/agent/PC_STRUCTURE_AND_OUTPUT_TYPES.md`。

## 推荐工具链

1. `get_page_schema(module)` — 确认是 list / edit / …
2. 列表：`get_list_columns`（用 PC title 作表头）→ `call_api` → `render_table`（columns.title 用 get_list_columns 返回的 PC 中文 title；字段中文化不在 normalize_output）
3. 详情：`call_api` → **两列表格（字段 | 值）**，字段顺序与 PC 端 `formSchema` 一致（服务端 workflow 已自动渲染表格事件 + Markdown，直接展示即可）
4. 字段/枚举中文映射：按 `pc-column-mapping` 技能读当前项目源码找（configs.data.tsx 列 title / useFormSchema options / locale zh-CN），不要编造；渲染规则（位掩码位值/图片/数组分隔）可 `read_field_mapping(module)`

## 详情（单条记录）强制

- 以**表格**呈现，两列：`字段` / `值`（不要裸 JSON、不要 `**label**：值` 长列表）。
- 字段集合与顺序 = PC 端 Edit 页 `formSchema`（服务端自动提取）。
- **空字段也要显示**：record 没有该字段时值占位 `-`，与 PC 端 Edit 页一致，不得省略。
- 详情中 record 存在但 formSchema 未覆盖的字段（如 id / createTime / updateTime / name）也需补在表尾，保证"所有相关字段"完整输出。

## 强制

- 展示前必须字段对齐：用 `get_list_columns` 的 PC 中文 title 作表头（经 `render_table` 的 columns.title）；字段/枚举英文时按 `pc-column-mapping` 技能读当前项目源码取中文映射。
- 禁止直接把英文字段名当最终答复甩给用户。
- 会话已绑定影视后台时不要再问 project。
- 列集合、表头、列序与 PC `configs.data.tsx` 一致：先 `get_list_columns` 取列定义，再按列渲染，禁止自造列。

## 列值渲染（对齐 PC 端 customRender，通用规则）

| 数据形态 | 渲染方式 |
|---|---|
| 布尔（woolUser 等） | `是` / `否` |
| 数字枚举 + 同记录 `XxxName`（memberLevel → memberLevelName） | 显示 `XxxName` 中文 |
| 时间戳（publishTime/onlineTime 等） | `YYYY-MM-DD HH:mm` |
| 图片字段（cover/image/poster/avatar，值为 URL） | Markdown 图片 `![封面](url)` |
| 数组字段（languages/tags/countries 等） | 简化 join（`、`） |
| 位掩码字段（terminalFlag 等，位或组合值） | 按位**全量**解析出命中项列表，禁止省略/缩写：`62 → Android、iOS、Web、H5、Windows`；`126 → Android、iOS、Web、H5、Windows、Android TV` |
| 标签组合列（tags 含类别/地区/分类） | 一行简化：`电影 · 印度 · 喜剧、恐怖` |
| 枚举（status 等） | 中文映射（上线/下架/审核中/审核不通过） |

> 具体模块的可覆盖配置在 `docs/agent/field-mapping.json` 的 `modules.<m>.renderRules`（superpower 层，改配置即生效，不改代码）。渲染规则优先读该配置，未配置时按上表通用推断。
> **位掩码注意**：通用兜底仅识别 `terminalFlag` 字段（掩码集 `2 Android, 4 iOS, 8 Web, 16 H5, 32 Windows, 64 Android TV`，对齐 PC `getClientTypeByOperatorOptions`）。**其他掩码集字段（如 `productFlag` 产品标识、banner 的 `terminalFlag` 无 Windows 位）必须在 `renderRules.bitmask` 显式配置**，禁止依赖通用兜底，否则位值解析结果与 PC 端不一致。

## 禁止

- 未 call_api 就编造列表数据。
- 列表页用长篇散文替代表格（超过 2 条优先 Markdown 表）。
- 把原始布尔 `true/false`、数字枚举、毫秒时间戳、超长 URL 直接甩给用户而不转换。
