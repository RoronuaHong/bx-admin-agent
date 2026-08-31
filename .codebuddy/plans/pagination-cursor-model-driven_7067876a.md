---
name: pagination-cursor-model-driven
overview: 彻底对齐 Cursor：删掉 PaginationPlan 结构、parsePaginationPlan、submit_understood_intent 的 pagination 字段、服务端多页执行器，让模型在 LangGraph tool-loop 里自己多次调 call_api 拉取拼接（像 Cursor 的模型驱动分页），服务端不再有分页结构/多页循环/默认值。
todos:
  - id: remove-pagination-structure
    content: 删除 understood-intent.ts 的 PaginationPlan 类型、parsePaginationPlan 与 UnderstoodIntent.pagination 字段及解析调用
    status: completed
  - id: clean-tools-schema
    content: 删除 tools.ts 中 submit_understood_intent 的 pagination schema 字段与描述，改 call_api 分页描述为模型多次调并引导模型自主分页
    status: completed
  - id: refactor-orchestrate
    content: 改造 workflow-orchestrate.ts：删 listParamsFromPagination、inferCallOperation 的 pagination 参数、多页执行器改单次调用、resolveModuleDetail 删 id 键名
    status: completed
    dependencies:
      - remove-pagination-structure
  - id: lint-verify-removal
    content: lint 检查改动文件，新建验证脚本确认 schema 无 pagination、无 PaginationPlan/多页执行器残留引用
    status: completed
    dependencies:
      - clean-tools-schema
      - refactor-orchestrate
  - id: restart-service
    content: 重启 agent-server-dev（pm2 delete + netstat 8787 确认释放 + start），确认端口与启动日志正常
    status: completed
    dependencies:
      - lint-verify-removal
  - id: e2e-verify-model-driven
    content: 端到端测试"用户列表前3页的数据"与"用户列表"，观察模型是否自主多次调 call_api 拼接分页（Cursor 方式）
    status: completed
    dependencies:
      - restart-service
---

## 需求概述

用户调研 Cursor 分页实现后明确选择"完全照 Cursor 方式"：Cursor 没有专门的分页引擎，当用户说"接口前3页"这类需求时，**模型读接口契约后自己决定怎么调**——支持页码就自己循环调 page=1/2/3 拼接，支持游标就跟 cursor 走。分页逻辑完全在模型手里，服务端无 PaginationPlan 结构、无多页执行器、无预设默认值。

用户要求**除循环控制（保留 LangGraph）外，其余全部照 Cursor 实现**。

## 核心功能
- 删除服务端分页结构：`PaginationPlan` 类型、`parsePaginationPlan`、`UnderstoodIntent.pagination` 字段、`submit_understood_intent` 的 `pagination` schema 字段与描述
- 删除服务端多页执行器（`workflow-orchestrate.ts` 1054-1130 行循环拉取拼接），改为单次 `call_api`
- 删除 `listParamsFromPagination` 与 `inferCallOperation` 的 `pagination` 参数
- 分页由**模型在 LangGraph tool-loop 里自己多次调 `call_api`** 拉取拼接（Cursor 方式），服务端不兜底循环
- 修正 `call_api` 工具描述中"禁止逐页多次调用同一接口"的写死规则，改为模型按需多次调
- `resolveModuleDetail` 删除详情参数键名 `id` 的硬编码，由模型读接口源码提供

## 视觉/交互效果
纯后端逻辑重构，无 UI 变更。交互上：分页查询改为模型自主多次调用接口拼接展示，服务端不再自动循环拉取。

## 技术栈
维持现有 LangGraph（`chat.ts` 的 `StateGraph` + 条件边）与 `workflow-orchestrate.ts` 执行器；不引入新依赖、不新建 skill。

## 技术方案

### 核心思路
Cursor 的分页是"模型 + 接口契约驱动"：模型读接口 schema（支持 page 还是 cursor）后自己决定怎么调。本方案照此执行——**删除服务端所有分页结构，分页逻辑完全交还模型主路径**（模型在 LangGraph tool-loop 里多次调 `call_api`）。服务端兜底路径退化为单次调用。

### 数据流（改造后）
用户输入"前3页" → 模型 `submit_understood_intent`（不再有 pagination 字段）→ 主路径模型在 tool-loop 里多次调 `call_api(page=1)`、`call_api(page=2)`、`call_api(page=3)` 自行拼接 → 展示。服务端兜底路径（`orchestrateBusinessQuery`）只做单次 `call_api`，不循环。

### 关键实现要点

**1. `understood-intent.ts`（删分页结构）**
- 删 `PaginationPlan` 类型（15-19 行）
- 删 `parsePaginationPlan` 函数（37-63 行）
- 删 `UnderstoodIntent.pagination` 字段（33 行）
- 删 `parseUnderstoodIntent` 中的 `pagination: parsePaginationPlan(input.pagination)`（94 行）

**2. `tools.ts`（删 schema 字段 + 修正描述）**
- 删 `TOOL_DESCRIPTIONS.submit_understood_intent` 的 pagination 描述（126-132 行）
- 删 `getSubmitUnderstoodIntentTool().inputSchema.properties.pagination`（217-226 行）
- `submit_understood_intent` 描述增加引导：列表分页由模型自己在 tool-loop 里多次调 `call_api` 拉取拼接（如"前3页"→调 page=1/2/3 三次后拼接展示），服务端不代劳
- 改 `call_api` 工具描述（89-90 行）：删除"一次调用拉够 size 100 / 禁止逐页多次调用同一接口"的写死规则，改为"分页由模型按需多次调 call_api 拉取拼接，每次传对应 page 参数"

**3. `workflow-orchestrate.ts`（删多页执行器 + 参数）**
- 删 `listParamsFromPagination`（75-84 行）
- 删 `inferCallOperation` 的 `pagination?: PaginationPlan` 参数（108 行）及 `const listParams = listParamsFromPagination(pagination)`（202 行）
- 删 992 行的 `llmIntent?.pagination` 实参
- **多页执行器改造**（1054-1130 行）：删 `pagePlan/pageSeq/defaultSize/MAX_ROWS/pageKey/sizeKey/fetchPage 循环`，改为**单次 `call_api`**（直接用 `callSpec.params` 调用一次拿 payload），保留 CLARIFICATION_REQUIRED/错误分支与下游渲染逻辑（get_page_schema/get_list_columns/normalize/render 不复用 mergedPayload，改用单次调用返回的 payload）
- `resolveModuleDetail`（89-99 行）：删 `params: { id }` 的 `id` 键名硬编码，详情参数名由模型通过 `api-interface-routing` skill 读接口源码提供

### 性能与风险
- 主路径模型自主多次调 call_api 是 Cursor 方式，但 zen 免费链能力弱，可能不会自主循环调 3 次（此前连 pagination 都填不对）→ 删多页执行器后，模型只调一次就只返回第 1 页。这是 Cursor 方式接受的行为，但"前3页返回3页"依赖模型能力，需在验证中重点观察。
- 服务端兜底路径（orchestrateBusinessQuery）删多页执行器后只做单次调用，无模型循环时只拉单页。
- 删 `resolveModuleDetail` 的 id 键名后，详情查询参数名依赖模型读源码，需靠 `api-interface-routing` skill 保证。

### 目录结构
```
apps/agent-server/src/
├── workflow-orchestrate.ts   [MODIFY] 删 listParamsFromPagination、多页执行器改单次调用、inferCallOperation 删 pagination 参数、resolveModuleDetail 删 id 键名
├── tools.ts                  [MODIFY] 删 submit_understood_intent 的 pagination 字段/描述；改 call_api 分页描述为模型多次调
├── understood-intent.ts      [MODIFY] 删 PaginationPlan、parsePaginationPlan、pagination 字段
└── scripts/
    └── verify-pagination-removal.mjs  [NEW] 验证脚本：schema 无 pagination、无 PaginationPlan/多页执行器残留引用
```

## 验证
- lint 检查改动文件（read_lints）
- 运行验证脚本确认：submit_understood_intent schema 无 pagination 字段、PaginationPlan 类型已删、无 listParamsFromPagination/多页执行器残留引用
- 重启 agent-server-dev（pm2 delete + netstat 8787 确认释放 + pm2 start）
- 端到端测试"用户列表前3页的数据"：观察模型是否自主多次调 call_api（Cursor 方式）拼接 3 页；普通"用户列表"单次调用正常

## Agent Extensions
### Skill
- **api-interface-routing**
  - 用途：引导模型在详情/分页查询时读接口源码，确定真实分页参数键名与详情参数名，替代服务端 `resolveModuleDetail` 硬编码的 `id` 键名和 `listParamsFromPagination` 的 `page`/`size` 默认。确保删掉服务端分页结构后，模型能正确提供接口契约参数并自主多次调 call_api。
  - 预期产出：模型读接口源码后自主填对 operation 与分页/详情参数，主路径模型驱动分页正常工作。
