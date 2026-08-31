---
name: fix-understand-retry-bounds
overview: 为 chat.ts understand 阶段加最大重试次数：修复条件边「无工具空转」与模型降级 while 循环两处无上限循环，防止模型连续失败时无限重试刷屏日志直至 OOM。
todos:
  - id: add-retry-constant
    content: 在 chat.ts 常量区（line 211 旁）新增 MAX_UNDERSTAND_RETRIES = 3 并注释用途
    status: pending
  - id: fix-conditional-edge
    content: 修复 understand 条件边：toolCalls 优先返回 "tool"，shouldContinue 追加 understandAttempts 空转上限
    status: pending
    dependencies:
      - add-retry-constant
  - id: fix-fallback-loop
    content: 修复 understand 节点降级 while 循环：triedFallbacks 集合保证同一备选最多尝试一次
    status: pending
  - id: verify-tsc
    content: 运行 tsc --noEmit 类型检查并静态核对两处修改的边界与终止性
    status: pending
    dependencies:
      - fix-conditional-edge
      - fix-fallback-loop
---

## 用户需求
修复 `apps/agent-server/src/chat.ts` 中 understand 阶段模型连续失败/空转时重试无上限的问题：当前会无限刷屏 `[chat:understand] raw output` 日志直至 OOM，需要为 understand 阶段增加最大重试次数上限。

## 产品概述
- 这是影视后台管理系统智能助手的服务端会话编排逻辑（LangGraph 图），不属于 UI 改动。
- 目标：在模型连续返回空结果（toolCalls=0、text=""）或连续降级失败时，有限次重试后收束，杜绝无限循环刷屏与内存堆积。

## 核心功能（修复目标）
1. **understand 条件边增加空转重试上限**：连续无工具空转（模型返回空文本/伪计划被清空）时最多重试 N 次，达上限走 final 兜底，不再无限回跳 understand。
2. **understand 节点模型降级循环保证有穷**：同一备选模型最多尝试一次，aborted/timeout 等可重试错误也必须推进降级链，杜绝 `while (alt)` 无限循环。
3. **保留正常多轮工具探索能力**：有工具调用的正常续探不受新上限影响，仍由 round/MAX_TOOL_ROUNDS 控制。

## 日志实证（apps/agent-server/logs/agent-server-dev.out-49.log）
- 15:08:55/15:08:56 连续两条 `raw output actionableQuery=true text="" toolCalls=0`（空转）。
- 15:09:08-15:14:41 单个「账号合并」请求产生 30+ 轮 `raw output`（understand 自循环刷屏，仅靠 recursionLimit=46 硬兜底，仍致数分钟延迟与 OOM 风险）。


## 技术栈
- 现有项目：Node.js + TypeScript + LangGraph（@langchain/langgraph）服务端编排，无新增依赖。
- 修改范围：仅 `apps/agent-server/src/chat.ts`，复用现有 state 字段 `understandAttempts` 与现有 `pickFallbackModel` 降级机制，不引入新状态字段或新架构。

## 根因（已确认）
### 根因 1：understand 条件边「无工具空转」自循环无上限（主因，即用户报的 bug）
- chat.ts line 1727-1733：`gaveFinalText = Boolean(text.trim()) && !modelAskedRetry && !state.toolCalls.length`；`shouldContinue = actionableQuery && !state.outputReady && state.round < MAX_TOOL_ROUNDS && !gaveFinalText`。
- 当模型连续返回 `toolCalls=0, text=""`（required 模式也会偶发空返回）或伪计划文本被 firstRoundPlan 清空时：`gaveFinalText=false` → `shouldContinue=true` → 回 understand。
- 关键缺陷：`round` 仅在 tool 节点末尾 +1（注释 line 1201 明确「round 仅在 tool 节点末尾+1」），空转时根本不进 tool 节点 → round 恒 0 → `round < MAX_TOOL_ROUNDS(12)` 恒成立 → 无限自循环。
- `understandAttempts` 每轮 +1（line 1329），但条件边从未使用它——与注释 line 1061「条件边据此防止首轮无工具调用时无限循环」实现与注释不符（字段本就为此设计，实现漏接）。
- 唯一兜底是 `recursionLimit = MAX_TOOL_ROUNDS * 3 + 10 = 46`（line 1758），但 46 次模型调用 = 数分钟刷屏 + 内存积累 → OOM。

### 根因 2：understand 节点降级 while 循环无上限（次因）
- chat.ts line 1278-1297：`pickFallbackModel` 只对 quota 错误封禁（line 1294 仅 `if (isQuotaErrorMsg(altMsg)) markModelExhausted(alt.id)`）；aborted/timeout 错误不封禁 → 每次 `pickFallbackModel` 返回同一备选 → `while (alt)` 无限循环。
- 此前实测「This operation was aborted」刷屏直至 OOM 正是此路径（nemotron 大请求 prematurely closed 卡死 5min+）。

## 实现方案
### 1. 常量区（line 211 MAX_TOOL_ROUNDS 旁）新增
```ts
const MAX_UNDERSTAND_RETRIES = 3; // 连续无工具空转/模型失败的最大理解重试次数，达上限走 final 兜底
```

### 2. understand 条件边（line 1710-1740）
- 在 `modelError/forcedReply/outputReady` 检查后、`shouldContinue` 计算前插入 `if (state.toolCalls.length) return "tool";`——有工具调用优先进入执行编排（落实注释 line 1736「有工具调用 → 进入执行编排」的设计意图，且避免 shouldContinue 在 toolCalls 存在时误判）。
- `shouldContinue` 增加空转上限：追加 `&& (state.understandAttempts || 0) < MAX_UNDERSTAND_RETRIES`。用已有 `understandAttempts` 计数（每轮 understand +1），只约束无工具空转/失败场景；有工具的正常多轮探索因上一条已提前返回 "tool"，仍由 round/MAX_TOOL_ROUNDS 控制，不受影响。

### 3. understand 节点降级循环（line 1278-1297）
- 新增 `const triedFallbacks = new Set<string>();`，`while (alt && !triedFallbacks.has(alt.id))`，循环体首行 `triedFallbacks.add(alt.id)`——同一备选模型最多试一次；aborted/timeout 不封禁但也会推进 tried 集合 → 整条降级链每个模型最多 1 次，循环必然有穷。

## 性能与可靠性
- 修复前最坏情况：单请求 46 次模型调用（数分钟延迟、日志刷屏、内存积累）。修复后：空转最多 3 次重试即收束；降级链每个备选最多 1 次尝试，时间复杂度 O(备选模型数 × 单次调用)。
- 不改变正常多轮工具探索路径（understand→tool 循环仍由 round/MAX_TOOL_ROUNDS 控制），无行为回归。

## 验证
- `tsc --noEmit` 类型检查（apps/agent-server）。
- 静态核对两处修改（条件边边界 + 降级循环终止性）。
- 真实端到端待模型链恢复后复测（当前模型 402/aborted 预存问题，无法实测成功路径）。
- 可选：临时脚本断言 shouldContinue 空转公式边界（understandAttempts >= MAX_UNDERSTAND_RETRIES 时不再续探）。

