---
name: fix-chat-result-duplication-and-order
overview: 修复聊天结果中表格重复渲染、结果与分析顺序颠倒的问题：服务端渲染不再同时 emit table 事件和返回 markdown 表格，前端调整消息内 text/tables/toolResults 的渲染顺序。回归验证账号合并等查询场景。
todos:
  - id: remove-orchestrate-table-events
    content: 移除 workflow-orchestrate.ts 列表/详情分支的 table 事件推送
    status: completed
  - id: remove-chat-table-events
    content: 移除 chat.ts 主 graph 列表/详情分支的 UI_TABLE 推送
    status: completed
    dependencies:
      - remove-orchestrate-table-events
  - id: reorder-frontend-blocks
    content: 调整 ChatPage.vue 消息体顺序为 toolResults → tables → text
    status: completed
  - id: regression-test
    content: 运行端到端验证：账号合并、用户列表、优惠活动配置、报表、模型自主 render_table
    status: completed
    dependencies:
      - remove-orchestrate-table-events
      - remove-chat-table-events
      - reorder-frontend-blocks
---

## 问题描述
用户查询“账号合并 5585230699772928”后，助手消息呈现顺序与重复异常：
- 最上方出现 Markdown 表格（中文表头、已翻译值）
- 中间又出现 ResultTable 结构化表格（英文/原始值、列数不同）
- 最下方才出现“规则校验 / 检索代码 / 接口调用 / get_page_schema / 读取列定义”等分析 trace

## 核心诉求
1. 分析 trace 应置于上方
2. 最终结果表格应置于下方
3. 同一条记录只展示一次表格，禁止重复渲染

## 根因分析
- `apps/agent-server/src/workflow-orchestrate.ts` 的 `orchestrateBusinessQuery` 在列表/详情分支里同时做了两件事：推 `{ type: "table" }` 事件给 ResultTable，又返回 `normalizedText` Markdown 表格。
- `apps/agent-server/src/chat.ts` 主 graph 路径在 `call_api` 返回列表/详情后，再次调用 `renderListForAgent`/`renderDetailForAgent` 并推 `{ type: "table" }` 事件，同时把 `forcedReply` 设为 Markdown。
- `apps/web/src/pages/ChatPage.vue` 模板按 `text → tables → toolResults` 顺序渲染，导致最终文本表格在最上、ResultTable 居中、分析 trace 在最下。
- ResultTable 接收的是原始行对象，未经过 `renderCell` 翻译，因此出现 `false/true`、毫秒时间戳、额外列。

## 技术方案
### 策略
服务端受控渲染只保留 Markdown 作为最终回复，不再额外推送 `table` 事件；前端调整消息块顺序为 `toolResults → tables → text`，使分析 trace 在上、最终结果在下。模型自主路径通过 `UI_TABLE` 触发的 ResultTable 仍保留。

### 关键修改点
1. **`apps/agent-server/src/workflow-orchestrate.ts`**
   - 移除列表分支的 `ctx.emitEvent?.({ type: "table", table: tableView })`。
   - 移除详情分支的 `ctx.emitEvent?.({ type: "table", table: detailView })`。
   - 保留 `normalizedText` Markdown 返回与 system 提示。

2. **`apps/agent-server/src/chat.ts`**
   - 移除主 graph 列表分支中对 `renderListForAgent` 结果的 `emitUiPayloadsFromToolResult(UI_TABLE...)` 调用。
   - 移除主 graph 详情分支中对 `renderDetailForAgent` 结果的 `emitUiPayloadsFromToolResult(UI_TABLE...)` 调用。
   - 保留 `forcedReply = rendered.md` 与 `outputReady = true`，让最终文本承担表格输出。

3. **`apps/web/src/pages/ChatPage.vue`**
   - 调整消息体渲染顺序为：`toolResults` → `tables` → `text`（当前为 text → tables → toolResults）。
   - 保持 `charts`/`files` 等其它块位置不变或按视觉层级微调。

### 依赖与影响
- 模型自主 `render_table` 输出的 `UI_TABLE` 仍通过 `emitUiPayloadsFromToolResult` 上屏，不受影响。
- 报表/图表路径 `presentGenericChart` 仍按原逻辑推送 table/chart 事件，不受影响。
- `ResultTable.vue` 无需改动；服务渲染不再调用它，避免原始值展示问题。
- 需要回归验证：列表查询、详情查询、报表查询、模型自主 render_table 查询。

## 目录结构
```
apps/agent-server/src/workflow-orchestrate.ts  # [MODIFY] 移除 orchestrate 列表/详情的 table 事件推送
apps/agent-server/src/chat.ts                  # [MODIFY] 移除主 graph 列表/详情的 UI_TABLE 推送
apps/web/src/pages/ChatPage.vue                # [MODIFY] 调整消息块渲染顺序为 toolResults → tables → text
```
