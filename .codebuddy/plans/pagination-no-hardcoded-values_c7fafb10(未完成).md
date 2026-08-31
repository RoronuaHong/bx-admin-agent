---
name: pagination-no-hardcoded-values
overview: 删掉分页链路中所有业务相关的服务端写死值（分页参数键名默认、每页条数默认、默认页码、limit固定page、详情参数键名、MAX_ROWS），参考 Cursor"模型自主决定数据量"的哲学，让模型在 submit_understood_intent 里提供完整分页参数；模型没填分页时服务端交回模型/澄清，不兜底默认值。
todos:
  - id: remove-pagination-defaults
    content: 删除 workflow-orchestrate.ts 多页执行器的业务默认值（defaultSize、pageKey/sizeKey 默认、默认页码、limit 固定 page1、MAX_ROWS），模型没填分页时改为返回澄清
    status: pending
  - id: clean-list-params-detail
    content: 重构 listParamsFromPagination 与 resolveModuleDetail，删 pageKey/sizeKey 默认与详情参数 id 键名，改用模型提供值
    status: pending
    dependencies:
      - remove-pagination-defaults
  - id: strengthen-schema-description
    content: 强化 tools.ts submit_understood_intent 的 pagination schema 描述，引导模型总是填完整分页参数（对齐 Cursor 自主决定 top-k），并更新 understood-intent.ts PaginationPlan 注释
    status: pending
  - id: lint-verify-parse
    content: lint 检查改动文件，跑 verify-pagination-schema.mjs 确认无默认值后分页解析与澄清行为正确
    status: pending
    dependencies:
      - remove-pagination-defaults
      - clean-list-params-detail
      - strengthen-schema-description
  - id: restart-service
    content: 重启 agent-server-dev（pm2 delete + netstat 8787 释放 + start），确认端口与启动日志正常
    status: pending
    dependencies:
      - lint-verify-parse
  - id: e2e-verify
    content: 端到端测试"用户列表前3页的数据"与"用户列表"（无分页），确认模型填完整分页或触发澄清，无默认值兜底
    status: pending
    dependencies:
      - restart-service
---

## 需求概述
用户用"用户列表前3页的数据"实测发现只返回第 1 页。排查确认根因有两层：
1. `submit_understood_intent` 工具 schema 缺失 `pagination` 字段（已补，模型现在会填该字段，但当前填了空对象 `{}`）。
2. 更深层：分页链路存在大量服务端**业务相关写死值**（默认分页参数键名、默认每页条数、默认页码、最大行数、详情参数键名），违背用户"禁止写死任何值，不只是中文词"的红线。

## 核心功能
- 删除分页链路所有业务相关的服务端写死值，全部参考 Cursor 范式（模型自主决定数据量，服务端不预设默认值）
- 强化 `submit_understood_intent` 的 `pagination` schema 描述，引导模型像 Cursor 决定 top-k 一样，总是提供完整分页参数（mode + pageKey/sizeKey/size + from/to/count）
- 模型没填分页参数时，服务端**交回模型/澄清**，不自动用默认第 1 页
- 普通"用户列表"（无分页意图）时，模型也判断一个合理分页参数填入，否则服务端澄清
- 保持 LangGraph 架构不变、不新建 skill、不写死中文词

## 技术栈
- 维持现有 LangGraph（`chat.ts` 的 `StateGraph` + 条件边）与 `workflow-orchestrate.ts` 执行器
- 不新建 skill、不引入新依赖
- 核心改动集中在 `workflow-orchestrate.ts`、`tools.ts`、`understood-intent.ts`

## 根因（已确认）
OpenAI 兼容 function calling 模型只填 schema `properties` 里定义的字段；且服务端执行器写死了分页默认值，导致模型即便填了分页语义，服务端也可能因 `parsePaginationPlan({})` 返回 undefined 而回退默认第 1 页。

## 架构设计
### 现状 vs 目标（参考 Cursor）
- Cursor 由**模型自主决定 top-k**（数据量），服务端无预设默认值。
- 本仓库目标：模型在 `pagination` 里提供完整分页参数，服务端只按模型给的结构执行；**模型没填分页或参数不完整 → 返回澄清**，不兜底默认值。

### 数据流（改造后）
用户输入 → 模型 `submit_understood_intent` 提交含完整分页参数的 `pagination` → `parsePaginationPlan` 校验（非法返回 undefined）→ 执行器若拿到合法 `pagination` 则按其 mode 拉取拼接；若 undefined 则返回澄清交模型/用户补充。

### 目录结构与改动文件
```
apps/agent-server/src/
├── workflow-orchestrate.ts   [MODIFY] 多页执行器 + listParamsFromPagination + resolveModuleDetail 删业务默认值
├── tools.ts                  [MODIFY] submit_understood_intent 的 pagination schema 描述强化
├── understood-intent.ts      [MODIFY] PaginationPlan 注释更新（pageKey/sizeKey 由模型必填）
└── scripts/
    └── verify-pagination-schema.mjs  [NEW] 验证脚本（补分页解析 + 无默认值行为）
```

## 实施要点
### 1. `workflow-orchestrate.ts` 多页执行器（1054-1124 行）删业务默认值
- 删 `defaultSize = 20`、`pageKey = pagePlan?.pageKey || "page"`、`sizeKey = pagePlan?.sizeKey || "size"` 的默认回退 → 直接用模型提供的 `pagePlan.pageKey`/`pagePlan.sizeKey`/`pagePlan.size`
- 删"无分页意图时默认 page:1, size:20"分支：模型没填 `pagination` 或 `parsePaginationPlan` 返回 undefined → **返回澄清**（如 `CLARIFICATION_REQUIRED`，提示模型补充"要看哪几页/多少条"），不执行默认第 1 页
- 删 `MAX_ROWS = 500` 与相关截断逻辑（参考 Cursor 无服务端硬上限）
- `limit`/`page`/`pages`/`lastPages` 分支：直接用模型给的 pageKey/sizeKey/size，不再补默认

### 2. `listParamsFromPagination`（75-84 行）
- 删 `pageKey = p.pageKey || "page"`、`sizeKey = p.sizeKey || "size"` → 直接用 `p.pageKey`/`p.sizeKey`
- 模型没给键名 → 返回 `{}`（由调用方/执行器判空并触发澄清），不再补 "page"/"size"

### 3. `resolveModuleDetail`（89-99 行）
- 删 `params: { id }` 的 `"id"` 键名硬编码 → 详情参数名由模型通过 `api-interface-routing` skill 读接口源码提供（从用户原文/提交值提取真实参数名）

### 4. `tools.ts` `submit_understood_intent` pagination schema 描述强化
- 引导模型：列表查询时**总是**在 `pagination` 里给出完整结构（mode + pageKey/sizeKey + size + from/to/count），像 Cursor 决定 top-k 一样自主决定数据量
- 明确：服务端不提供默认分页参数，若缺省会返回澄清提示补充

### 5. `understood-intent.ts` PaginationPlan 注释
- 更新注释：`pageKey`/`sizeKey` 为模型必填的接口契约参数键名（不再有服务端默认），`parsePaginationPlan` 对缺 pageKey/sizeKey 的 plan 处理（交由执行器澄清）

## 安全/风险
- 删 `MAX_ROWS` 后模型/接口可能拉取超量数据——用户明确参考 Cursor（无服务端硬上限），接受
- 删默认值后模型没填分页会澄清——用户已确认"交回模型/澄清"可接受
- 详情参数 `id` 键名删掉后，详情查询参数名由模型读接口源码提供（`api-interface-routing` skill 已引导）

## 验证
- 验证脚本确认：`parsePaginationPlan` 对完整/缺失分页参数的解析行为；`getSubmitUnderstoodIntentTool()` 的 pagination schema 描述含"总是填/服务端不兜底"引导
- 重启 `agent-server-dev`（pm2 delete + netstat 8787 释放 + start）
- 端到端测试"用户列表前3页的数据"→ 模型填完整 `pagination` → 多页执行器拉取 3 页
- 测试"用户列表"（无分页）→ 模型填默认 page+size 或服务端澄清（预期行为变化）

## Agent Extensions
### Skill
- **api-interface-routing**：用于引导模型在详情/分页查询时读接口源码，确定真实分页参数键名（pageKey/sizeKey）与详情参数名，替代服务端 `resolveModuleDetail` 硬编码的 `id` 键名。确保改动后模型能正确提供接口契约参数。
- **pc-column-mapping**：不改动，但作为字段中文化的既有主路径，与分页改动无冲突，保持不变。
