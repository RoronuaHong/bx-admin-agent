---
name: steps 上下文膨胀优化（Micro-compact + token 闸门 + 探索折叠）
overview: 在 chat.ts understand 节点对注入模型的 llmSteps 做「只读投影裁剪」：仿 Claude Code Micro-compact 保留最近 3 轮完整工具结果、更早的替换占位符，加 token 预算闸门与中间探索步骤折叠，配合诊断日志验证，目标将「账号合并」类 7-8 轮查询的总耗时降 40-60%，零额外模型调用。
todos:
  - id: implement-compact
    content: 在 chat.ts 实现 compactStepsForModel 只读投影压缩函数（占位符替换/窗口保留/白名单/预算回退）
    status: completed
  - id: wire-understand
    content: understand 节点 llmSteps 构造处接入压缩（含 forceAnswer 分支）+ [chat:compact] 诊断日志
    status: completed
    dependencies:
      - implement-compact
  - id: verify-unit
    content: 新增 verify-steps-compact.mjs 单测：占位符/白名单/窗口/预算回退/消息配对 5 类断言并跑通
    status: completed
    dependencies:
      - implement-compact
  - id: regression
    content: lint + 重跑 translation-lookup verify + 按规范重启 agent-server-dev（pm2 delete/start 确认 8787 独占）
    status: completed
    dependencies:
      - wire-understand
      - verify-unit
  - id: e2e-validate
    content: 用 [skill:agent-browser] + [mcp:chrome-devtools] 端到端回归账号合并/优惠活动配置/用户列表，对比耗时与注入字符数
    status: completed
    dependencies:
      - regression
---

## 产品概述
优化 bx-admin-agent 聊天智能体「结果返回慢」问题：当前模型为 nemotron-3-ultra-free（OpenCode Zen 免费链，单次 4.7s+），「账号合并」类查询走 LangGraph 多轮工具循环（7-8 轮模型调用），每轮把累积的 steps 全量注入模型，上下文线性膨胀导致「越到后面越慢」。本次落地业界已验证的**零额外模型调用**压缩方案（Cursor「Dynamic context discovery」+ Claude Code「Micro-compact」同款实践），在不改变功能正确性的前提下收敛每轮注入量，缩短单轮生成时间。

## 核心功能
- understand 节点注入模型前，对 steps 做**只读投影压缩**：旧轮次工具结果替换为 `[Previous: used ${toolName}]` 占位符（不删消息、不改 state.steps，对齐 OpenAI 消息配对约束与 Claude Code 只替换工具结果、保留 assistant 推理轨迹的原则）
- 保留策略：最近 3 轮 toolResult 完整 + 数据类白名单（call_api/normalize_output/render_table）最近一次完整 + system 与 toolCalls（推理轨迹）全保留
- token 预算兜底：压缩后总字符仍超阈值时逐轮缩减保留窗口（3→2→1 轮），保证注入量有硬上限
- 诊断日志：注入前打印压缩前后步骤数/字符数/折叠数，与耗时对照验证收敛
- 保持现有持久化机制（persistToolOutput 4K/persistRawToolOutput 2K 落盘）不变，被折叠的工具结果仍可由 read_file 按需找回


## 技术栈
- 沿用现有 Node.js + TypeScript + LangGraph（apps/agent-server/src/chat.ts 既有架构），不改依赖、不新增库
- 压缩为纯函数实现，零额外模型调用（免费链下摘要方案会净增 4.7s/次延迟，明确排除）

## 实现方案
### 核心思路
在 understand 节点构造 `llmSteps`（唯一注入模型的入口，chat.ts:1117-1133）之前，插入 `compactStepsForModel()` 只读投影。**state.steps 保持完整**（rulesGateBeforeCallApi、forcedReply、get_page_schema 解析等依赖完整步骤），仅压缩「模型看到的视图」——对齐 Claude Code Context Collapse「模型看到的 ≠ 底层存储的」思想。

### 关键决策
1. **只读投影而非改状态**：tool 节点追加逻辑（chat.ts:1228-1230）与白名单持久化机制不动，规避对后续节点（rulesGate/渲染）的副作用，爆炸半径最小。
2. **替换 content 而非删除消息**：callOpenAiAgent（models.ts:195-197）将 toolCalls 映射为 assistant 消息、toolResult 映射为 user 消息；删消息会破坏 OpenAI 消息配对校验，替换 content 则安全。
3. **保留策略（Claude Code KEEP_RECENT=3 经验值）**：
   - `system` 步骤与 `toolCalls` 步骤（assistant 推理轨迹）全部保留
   - `toolResult` 步骤：最近 3 轮内完整保留；数据类白名单（call_api/normalize_output/render_table）取最近一次完整保留（即使恰在窗口边缘，防 final 收束无数据）
   - 其余 `toolResult` 替换为 `[Previous: used ${toolName}]`（toolName 由 toolCallId 反查 toolCalls 步骤的 calls 数组）
4. **预算兜底**：压缩后总字符 > `STEPS_CHAR_BUDGET`（建议 60K ≈ 15K token）时，保留窗口从 3 轮逐级减到 1 轮，仍超则把窗口内白名单外的内容也折叠——注入量硬上限，杜绝极端大结果顶满上下文。
5. **诊断可观测**：understand 注入前输出 `[chat:compact] steps=N chars=X(→Y) tok≈Z collapsed=M kept=K`，与 `[chat:understand]` 时间戳间隔对照，验证「注入变小→单轮变快」的因果。

### 性能分析
- 时间复杂度：单次 O(steps) 遍历，每轮一次，可忽略
- 文本效果：N 轮后注入量从「全量累积 O(N×avg)」收敛为「O(最近3轮 + 常量)」，多轮场景降 50-70%
- 时间效果：每轮生成时间随输入 token 线性下降（LLM 解码速度决定），预估「账号合并」7-8 轮场景总耗时降 40-60%，且零额外模型调用成本
- 不引入摘要模型调用（免费链净增延迟）、不引入向量库、不改变消息存储结构

### 回归防护
- 白名单数据类工具结果必须保留：曾因统一写文件导致模型无数据可 render 伪 tool_call 的教训（chat.ts:45-46 注释），本次压缩同样不得触碰最近一次 call_api/normalize_output 完整内容
- forceAnswer 分支（outputReady=true）同样走压缩，但保留窗口内数据类内容覆盖「基于工具结果总结」场景
- 首轮理解结果（submit_understood_intent）在窗口内自然保留；窗口外被折叠时模型可通过重新调用工具自愈（工具幂等）

## 架构设计
### 模块划分（改动集中在 chat.ts）
- `compactStepsForModel(steps, opts)`：纯函数，无状态，输入完整 steps → 输出压缩后 steps（只读投影）
  - 内部子逻辑：toolCallId→toolName 索引构建、轮次定位（按 toolCalls 步骤计数轮）、保留判定、占位符替换、预算回退
- understand 节点接入：`const llmSteps = compactStepsForModel(steps)`（forceAnswer 分支同样包裹）
- 诊断日志：压缩前后字符数对比

### 数据流
```
tool 节点追加 steps（state.steps 完整累积）
  → understand 节点 baseSteps = [...state.steps]
  → compactStepsForModel()（只读投影：旧 toolResult→占位符，窗口内/白名单保留）
  → llmSteps 注入 callAgentSafe
  → 模型只看到压缩视图（state 未被污染）
```

## 目录结构
```
apps/agent-server/
├── src/
│   └── chat.ts                      # [MODIFY] 新增 compactStepsForModel 纯函数 + understand 节点接入（llmSteps 构造处 1117-1133）+ [chat:compact] 诊断日志；常量 STEPS_CHAR_BUDGET、KEEP_RECENT_ROUNDS、STEPS_KEEP_FULL 白名单
└── scripts/
    └── verify-steps-compact.mjs     # [NEW] 单测 verify 脚本：构造模拟 steps 序列断言 ①旧轮 toolResult 替换占位符、②最近3轮+数据类白名单完整保留、③toolCalls/system 不动、④预算超限逐轮回退、⑤消息配对不破坏（不删消息）
```

## 关键代码结构
```ts
/** 只读投影压缩：注入模型前将旧轮次工具结果替换为占位符（Claude Code Micro-compact 同款）。
 *  state.steps 不动；仅改「模型看到的视图」。不删消息（OpenAI 消息配对约束）。零模型调用。 */
function compactStepsForModel(
  steps: AgentStep[],
  opts?: { keepRecentRounds?: number; charBudget?: number },
): AgentStep[] {
  // 1. 遍历 toolCalls 步骤建立 toolCallId → toolName 映射（含每轮边界）
  // 2. 保留：system 全量；toolCalls 全量（assistant 推理轨迹）；最近 keepRecentRounds 轮内 toolResult 完整；
  //    数据类白名单（call_api/normalize_output/render_table）最近一次完整
  // 3. 其余 toolResult.content 替换为 `[Previous: used ${toolName}]`
  // 4. 若压缩后总字符仍 > charBudget：keepRecentRounds 逐级减 1（3→2→1）重试
  // 5. 返回压缩视图（不影响调用方 steps）
}
```


## Agent 扩展
### MCP
- **chrome-devtools**
  - 用途：端到端验证阶段在浏览器中确认聊天页面正常渲染，观察「账号合并」等查询返回结果的表格与耗时表现
  - 预期产出：页面无报错、查询结果正常上屏，验证压缩改动未破坏前端链路

### Skill
- **agent-browser**
  - 用途：端到端回归——向 /chat 发送「账号合并 5585230699772928」等查询，等待返回并对比耗时与注入字符数（[chat:compact] 日志）
  - 预期产出：与优化前（13:43-13:46 三分钟 30 轮、间隔 5-15s）对照，单轮间隔显著下降、总耗时下降，且返回结果（10 列中文表头）无回归
