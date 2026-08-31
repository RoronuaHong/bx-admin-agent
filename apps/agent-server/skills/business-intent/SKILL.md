---
name: business-intent
description: 业务查询与接口调用路由的骨架引导（已停用，保留文件可追溯）。
version: 0.2.0
enabled: false
# 已由 .cursor/skills/pc-agent-crud-router/SKILL.md 替代（确定性路由骨架）：
# 保留本文件仅为可追溯，运行时不再加载/触发。
---

# 业务意图处理（LLM 先行）

处理用户对 PC 后台的查询/操作时，按下列顺序，**由你主动调工具**，不要空口猜接口。

## 1. 理解

- 调用 `submit_understood_intent`，填四元组语义：project / module（可中文）/ value / operationType / operationHint。
- 不确定就留空或 `unknown`，不要猜。

## 2. 检索（MCP/tools）

- `grep_codebase`：用用户说的中文菜单名搜仓库（如「白名单管理」）。
- `search_api_module`：把中文模块落到 `user/white_list` 等内部 key。
- `read_api_module`：确认具体函数名（如 `getWhiteListManage`，不要死猜 `getList`）。

## 3. 澄清

- 关键槽位仍缺：`request_clarification`，一次只问一个，给 2–4 个选项。
- **不要问 project**：会话已绑定「影视后台管理系统」时，project 视为已定，直接填 `bx-film-admin`。

## 4. 执行前（规则门）

- 整理好后再 `call_api`（优先 `operation`，如 `user/white_list.getWhiteListManage`）。
- 服务端会对 `call_api` 做规则校验；写操作 `confirm=true`。
- 拿到数据后必须 `normalize_output`，列表再用 `render_table`（可先 `get_list_columns` 对齐表头；树表/表尾用 tree、footer）。
- 用户要下载时 `export_dataset`（xlsx/pdf），聊天会预览并出现下载按钮。
- 不确定页面形态时先 `get_page_schema`。
- 图表/报表用 `summarize_chart_data`；写操作 `confirm=true`。

## 禁止

- 未检索就 `call_api`。
- 用户已说清模块（如「白名单管理」）却再问「影片还是片段」。
- 再问「你要操作哪个项目」（已有默认项目时）。
- 编造业务 JSON。
- 直接透传英文字段名给用户。
