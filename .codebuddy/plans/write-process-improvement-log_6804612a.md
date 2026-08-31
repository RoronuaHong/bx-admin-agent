---
name: write-process-improvement-log
overview: 把 2026-08-24 三个业务查询修复（模型文本工具调用提取器、PC 列渲染保留、rg 环境安装）记入 docs/agent/README.md 流程改进日志，并按项目机制在 AGENT_CHARTER.md 沉淀检查项。
todos:
  - id: update-readme-log
    content: 在 docs/agent/README.md 流程改进日志表新增 2026-08-24 行：工具调用提取器多形态兼容/列渲染修复/ripgrep 安装
    status: completed
  - id: update-charter-lessons
    content: 在 docs/agent/AGENT_CHARTER.md Bug 修复标准流程补环境前置检查与流式输出格式反例（三不原则实例）
    status: completed
    dependencies:
      - update-readme-log
---

## 用户需求
用户确认将本次「三个业务查询（用户列表/账号合并/优惠活动配置）全失败」的排查与修复工作写入项目流程改进日志：①在 `docs/agent/README.md` 的「流程改进日志」表新增一行记录（日期/模块/问题要点/改了什么文件）；②按项目持续改进机制（记忆 45289390：发现 Bug 后直接改规范文件正文，加检查项/门禁/反例），把本次教训沉淀进 `docs/agent/AGENT_CHARTER.md` 的「Bug 修复标准流程」。

## 核心内容（需写入的本次事实）
- **A 层（决定性根因）**：zen 免费链模型不走 function calling 通道，把工具调用以纯文本 `[[{name,parameters}]]`（裸嵌套数组、常残缺未闭合）输出；原流式解析器只认 `{tool_calls:[...]}` 对象 + 完整 JSON.parse → 静默提取失败 → 整轮 toolCalls=0 → 三个查询全部调不起工具。修复：models.ts `extractToolCallsFromJson`（对象/裸数组/嵌套数组/单对象 4 形态）+ `extractToolCallsViaRegex` 括号配平兜底；状态机进入条件支持 `[` 开头（4 处）。
- **B 层**：workflow-orchestrate.ts `pickRowsByPcColumns` 严格 `if (k in sample)` 过滤 PC 列，点路径 dataIndex（`userVipInfoRes.vipType` 等）不匹配扁平 row key → 用户列表只渲染 4 列。修复：无条件保留所有 PC 列 + renderCell 点路径嵌套取值。
- **C 层**：chat.ts `isToolPlanText` 不识别裸数组 JSON 形态 → 残留 JSON 上屏。修复：补数组形态识别。
- **环境**：rg 缺失导致 grepCodebaseNative 全量递归回退（分钟级慢 + 日志刷屏）。修复：winget 安装 ripgrep 15.2.0（`--source winget` 绕过 msstore 证书错误），重启 agent-server-dev 继承新 PATH。
- 验证：verify-text-toolcall.mjs 6/6；execGetListColumns({module:"user"}) 返回 account/user 10 列；端到端 toolCalls=1-4 每轮正常。

## 技术方案
本任务为纯文档更新（流程改进日志），不涉及代码实现。

### 目标文件
1. **`docs/agent/README.md`**（第 29-45 行「## 流程改进日志」表）：
   - 在表格末尾新增一行，格式对齐现有 12 行（`| 日期 | 模块 | 问题要点 | 改了什么 |`）。
   - 内容：日期 2026-08-24、模块（流式工具调用提取 + 列渲染 + 环境）、问题要点（三个查询全失败的 3 层根因 + rg 缺失）、改了什么（models.ts 多形态提取器 + 括号配平兜底、workflow-orchestrate.ts 无条件保留 PC 列 + 点路径、chat.ts isToolPlanText 数组形态、winget 安装 ripgrep 15.2.0 + 重启）、验证结果（6/6 单测 + 10 列 + 端到端 toolCalls 正常）。

2. **`docs/agent/AGENT_CHARTER.md`**（第 8-39 行「〇、Bug 修复标准流程」）：
   - 在「三不原则」与「服务端护栏补全原则」之间或三不原则内部，新增本次教训的检查项/反例：
     - **环境前置检查**：Step 1 复现前先验证外部工具依赖（rg 等）与模型通道是否就位，避免把环境问题误判为模型/代码问题（本次 rg 缺失导致 grep 慢 + 日志刷屏，曾被误判为模型波动）。
     - **流式输出格式反例（2026-08-24）**：模型输出 `[[{name,parameters}]]` 裸数组/残缺 JSON 是端点 function calling 不稳定时的自由发挥，解析器假设过窄（只认 `{tool_calls}` 完整对象）导致静默失败、整轮 toolCalls=0——治本是解析器兼容多形态 + 括号配平兜底 + 提取失败时诊断日志，不得归咎「模型行为方差」（呼应三不原则第 1 条）。

### 约束
- 遵循现有表格格式（`|---|---|` 分隔，单元格内用分号/换行分隔要点），不改变表格结构。
- AGENT_CHARTER.md 新增内容保持「检查项/反例」文体，与现有「五步断层定位法」「三不原则」风格一致，不引入新章节标题级别。
- 本仓库无 guidelines.md / CODEBUDDY.md / _template 目录（已确认），规范文件即 docs/agent/ 下文档，无需同步其他文件。
