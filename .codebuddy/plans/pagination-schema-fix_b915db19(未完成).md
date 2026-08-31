---
name: pagination-schema-fix
overview: 修复 submit_understood_intent 工具 schema 缺失 pagination 字段的问题：在 inputSchema.properties 补上 pagination 字段定义（含四种 mode 的语义说明），让模型能正确产出分页意图，从而让已存在的多页执行器真正跑通"前3页/第M-N页/前N条/最后N页"等分页查询。
todos:
  - id: add-pagination-schema
    content: 在 getSubmitUnderstoodIntentTool 的 inputSchema.properties 补 pagination 字段定义（tools.ts summary 之后），语义采用 Cursor 式模型自主判断，不写死中文词路由
    status: completed
  - id: lint-verify-parse
    content: lint 检查 tools.ts，并跑 parsePaginationPlan/parseUnderstoodIntent 验证脚本确认补字段后正确解析四种分页结构
    status: completed
    dependencies:
      - add-pagination-schema
  - id: restart-service
    content: 重启 agent-server-dev（pm2 delete + 确认 8787 释放 + start），确认端口与启动日志正常
    status: completed
    dependencies:
      - lint-verify-parse
  - id: e2e-verify-pages
    content: 用 UTF-8 编码端到端测试"用户列表前3页的数据"，确认模型产出 pagination 且多页执行器拉取 3 页数据
    status: completed
    dependencies:
      - restart-service
  - id: regression-default-page
    content: 回归测试"用户列表"普通查询仍默认返回第 1 页，确认无分页回归
    status: pending
    dependencies:
      - e2e-verify-pages
---

## 需求概述

用户用"用户列表前3页的数据"实测发现：链路能走通（submit → search → read → call_api → 表格渲染），但**只返回第 1 页数据**，未按"前3页"返回。要求修复分页意图，使其与 Cursor"模型自主判断数据量"的哲学一致。

## 核心功能

- 修复 `submit_understood_intent` 工具 schema，使模型能产出 `pagination` 字段
- 用户明确提到分页/数量（如"前3页"、"第2页"、"前20条"、"最后2页"）时，模型正确填四种分页结构之一
- 多页需求由工作流循环拉取拼接，不要求模型多次调 call_api
- 普通"列表"查询无分页意图时仍默认返回第 1 页，不回归

## 技术方案

### 技术栈
- 维持现有 LangGraph 架构（`chat.ts` 的 `StateGraph` + 条件边）
- 不改动已正确的基础设施：`PaginationPlan` 类型、`parsePaginationPlan`、`parseUnderstoodIntent`、多页执行器（`workflow-orchestrate.ts` 1054-1093 行）

### 根因（已确认）
`getSubmitUnderstoodIntentTool`（`apps/agent-server/src/tools.ts` 187-219 行）的 `inputSchema.properties` 定义了 8 个字段（isBusinessRequest/project/module/value/operation/operationType/operationHint/summary），**唯独缺失 `pagination` 字段**。OpenAI 兼容 function calling 的模型只填 schema properties 里定义的字段，描述文本虽有 pagination 说明但 schema 未定义 → 模型不产出 pagination → `pagePlan = undefined` → 多页执行器走默认分支只拉第 1 页。

### 实施要点
1. 在 `getSubmitUnderstoodIntentTool` 的 `inputSchema.properties` 中（`summary` 字段之后、对象闭合 `}` 之前）补上 `pagination` 字段定义，语义说明采用 Cursor 式"模型自主判断"，不写死中文词路由。
2. `pagination` 为可选字段，不加入 `required`（仅当用户明确提到分页/数量时才填，普通列表查询省略）。

### 关键代码结构（新增字段）
```ts
pagination: {
  type: "object",
  description:
    "（可选）当用户对列表查询明确提到分页/数量时填，否则省略。结构（由你理解自然语言产出）：" +
    "{ mode:'limit', count:N } 固定条数（如"前20条"）；" +
    "{ mode:'page', page:N, size?:M } 某一页（如"第2页"）；" +
    "{ mode:'pages', from:M, to:N } 连续页区间（如"第1到3页"→from:1,to:3，"前3页"→from:1,to:3）；" +
    "{ mode:'lastPages', count:N } 末尾N页（如"最后2页"）。" +
    "多页需求你只需给出区间，工作流负责循环拉取拼接，不要自己多次调 call_api。",
},
```

### 红线合规
- 不改多页执行器（已正确）、不新建写死 skill、不推翻 LangGraph 架构。
- schema 描述为"模型自主判断语义"（对齐 Cursor 让模型自主决定数据量的哲学），不写死中文词路由。

### 验证
1. `parsePaginationPlan` / `parseUnderstoodIntent` 对补字段后的 schema 正确解析。
2. 重启 `agent-server-dev`（pm2 delete + netstat 确认 8787 释放 + start）。
3. UTF-8 端到端测试"用户列表前3页的数据"，确认模型产出 `pagination:{mode:'pages',from:1,to:3}`，多页执行器拉取 3 页（30 条），而非只第 1 页。
4. 回归测试"用户列表"普通查询仍默认第 1 页正常返回。

# Agent Extensions
无适用的 Agent 扩展（该任务为纯后端 schema 字段补充，不涉及浏览器调试、知识库检索或文档查询）。
