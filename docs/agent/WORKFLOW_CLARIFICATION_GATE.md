# Clarification Gate（完全去 Prompt 依赖）

## 目标

通过配置驱动与运行时路由，让 Agent 在“理解不充分”时主动反问，避免误解用户意图、误调用接口或误传参数。

## 执行总则（强制）

- 明确确立：**用“反问”精确范围**，作为所有项目的统一默认策略。
- 只要存在关键槽位缺失或意图歧义，先反问再执行，不允许直接猜测落地。
- 反问必须收敛范围（模块、操作、对象、约束），而不是泛泛追问。

该机制默认适配“菜单划分模块 + 操作级路由”的后台管理系统，并可扩展到其他企业内部项目。

## 放置位置（五层框架映射）

- `workflow`（主环）
  - 在 `llm 理解 -> 规则校验 -> tool routing` 之间插入 Clarification Gate。
  - 决策：`继续执行` / `先检索补全` / `发起反问` / `写操作确认`。
- `skill`
  - 固化问法模板：一次只问一个歧义点，提供 2-4 个候选项。
  - 禁止泛化追问（如“请再说清楚点”）。
- `MCP`
  - 在反问前先检索菜单、PC 端源码（方案 A：grep + read_file 定位接口）、索引兜底、知识库文档，能补全就不打扰用户。
- `tools`
  - 新增 `request_clarification` 工具协议（结构化字段，便于审计和复盘）。
- `superpower`
  - 策略中心化：阈值、风险级别、反问上限、确认规则均从策略文件读取。

## 去 Prompt 原则

- 不在系统提示词中硬编码业务规则、模块映射、风险边界。
- 不依赖“提示词命中”来决定是否反问。
- 仅依赖四类运行时输入：策略配置、状态机上下文、工具返回、MCP 检索结果。
- 所有行为可审计、可回放、可灰度，避免随着项目增长出现提示词耦合失控。

## 运行时路由策略

策略文件见 `docs/agent/clarification-policy.json`。

核心信号：

- `requestUncertainty`：需求是否缺关键信息。
- `actionConfidence`：当前操作和参数是否有足够把握。

推荐路由：

1. `requestUncertainty` 高 -> 调用 `request_clarification`。
2. `requestUncertainty` 低但 `actionConfidence` 低 -> 先检索后重试，不先问用户。
3. 写操作（create/update/delete/toggle/batch）-> 强制显式确认。
4. 同一意图反问达到上限 -> 输出排序候选方案让用户选。

## request_clarification 工具协议（建议）

```json
{
  "intentId": "string",
  "missingSlots": ["module", "operation", "id"],
  "question": "你要查看的是二级分类详情还是一级分类详情？",
  "options": [
    { "label": "二级分类详情", "value": "second_category.getById" },
    { "label": "一级分类详情", "value": "category.getById" }
  ],
  "riskLevel": "read",
  "defaultCandidate": "second_category.getById",
  "impactNote": "选错会调用到不同模块接口"
}
```

## 验收指标（必须量化）

- `wrong_tool_call_rate`：误调用率，目标持续下降。
- `clarification_resolution_rate`：反问后一次命中率，目标上升。
- `avg_clarification_turns`：平均反问轮次，控制在 1~2 轮。
- `write_confirmation_bypass_rate`：写操作绕过确认率，目标为 0。

## 最小接入步骤

1. 在编排层增加 Clarification Gate 节点（路由前执行）。
2. 接入 `clarification-policy.json` 的动态读取与热更新。
3. 新增 `request_clarification` 工具及日志字段。
4. 为每个菜单模块补全 `module.operation` 候选字典。
5. 增加批量评测：覆盖“模糊描述 -> 反问 -> 正确调用”路径。

## 注意事项

- 该机制不是“多问”，而是“只在必须时问”。
- 对低风险读操作优先自动补全；对高风险写操作优先确认。
- 反问文案必须说明“为什么问”，并明确每个选项的后果。
- 任何新增项目只需接入模块索引与策略文件，不需要新增业务 prompt。
