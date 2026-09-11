# SQL 风格样例（Prompt 参考，不是金句答案）

本目录文件供 **schema-agent（`analytics_load_sql_style`）→ Intent 编译** 参考「写法形状」。

- **不是**「某句 NL 的唯一正确 SQL」；占位符 `{start}/{end}/{channel}/{movieTypes}` 与具体 locale 必须来自对话或 `metabase_probe_dimension`。
- 主路径：结构化 schema → `sql-compile` 确定性生成；本目录用于形状对齐与诊断，**不再** LLM 直接写业务 SQL。
- `avg_of_max_wide.style.sql`：三种小语种完播率宽表（sumIf/countIf）参考。
