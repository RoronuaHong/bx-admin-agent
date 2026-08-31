# Agent 架构现状审计（2026-08-19）

本文档用于对照行业常见的完整 Agent 形态，审计 `bx-admin-agent` 当前实现状态，并给出下一步落地优先级。

## 一句话结论

`bx-admin-agent` 当前属于 **LLM + Tools 的 MVP 骨架**，已具备基础 ReAct 工具循环能力，但尚未达到“完整 Agent”标准。

---

## 1. 五层架构对照结果

| 层级 | 行业定义 | 当前状态 | 结论 |
|---|---|---|---|
| 一、大脑（LLM） | 理解目标、推理、输出动作 | 已支持 Anthropic/OpenAI/Ollama，多模型自动选择与工具调用 | ✅ EXISTS |
| 二、记忆层（Memory） | 短时/长时/实体记忆 | 仅有会话短时记忆（JSON 持久化）；无向量记忆、无实体记忆 | ⚠️ PARTIAL |
| 三、规划调度层 | ReAct / Plan-and-Execute / 图编排 | 有简单 ReAct for-loop；无 Plan-and-Execute、无图调度 | ⚠️ PARTIAL |
| 四、工具层（Tools） | 文件、Shell、API、检索、业务工具 | 仅 3 个只读工具：`list_dir`/`read_file`/`fetch_url`；无业务 API 工具 | ⚠️ PARTIAL |
| 五、终止与校验层 | 终止条件、防死循环、结果验收 | 有最大轮次和中断机制；缺结果校验与写操作确认流 | ⚠️ PARTIAL |

---

## 2. 关键代码证据（按层）

### 2.1 LLM 大脑

- `apps/agent-server/src/models.ts`
  - `callAgent()` 统一适配多 provider
  - 支持 function calling / tool_use
- `apps/agent-server/src/chat.ts`
  - `pickAutoModel()` 按图片/上下文长度选模型

### 2.2 记忆层

- `apps/agent-server/src/session.ts`
  - 会话历史持久化到 `.data/sessions.json`
- `apps/agent-server/src/chat.ts`
  - `MAX_HISTORY_TURNS = 16`，只取最近若干轮
- 现状缺失
  - 无 `kb` 向量检索落地
  - 无实体记忆存储（用户偏好/业务参数）

### 2.3 调度层

- `apps/agent-server/src/chat.ts`
  - `for (round = 0; round < MAX_TOOL_ROUNDS; round++)` 的 ReAct 循环
  - 工具结果回填后再次调用模型
- 现状缺失
  - 无 plan 生成/执行/修订流程
  - 无条件分支并行图编排（LangGraph 类）

### 2.4 工具层

- `apps/agent-server/src/tools.ts`
  - 已注册：`list_dir`、`read_file`、`fetch_url`
- `apps/agent-server/src/mcp.ts`
  - MCP 出口复用同一套工具
- 现状缺失
  - Shell 执行工具
  - 企业业务 API 白名单工具（G1 目标）
  - 知识库读写工具（G2 目标）

### 2.5 终止与校验

- `apps/agent-server/src/chat.ts`
  - `MAX_TOOL_ROUNDS = 12`，具备防死循环硬限制
  - 支持 `AbortSignal` 取消
- 现状缺失
  - 缺结果结构化校验（output schema / critic）
  - 缺写操作前确认（human approval）代码闭环

---

## 3. 外围配套能力评估

| 配套项 | 状态 | 说明 |
|---|---|---|
| Prompt 工程 | ✅ EXISTS | `DEFAULT_CHAT_GUIDE` + skills 注入 |
| 权限与安全 | ⚠️ PARTIAL | 有登录门禁和文件大小限制；但无完整沙箱策略 |
| 可观测性 | ⚠️ PARTIAL | 以基础日志为主，缺结构化 tool trace |
| Human-in-the-loop | ❌ MISSING | 前端类型有预留，服务端确认流未闭环 |

---

## 4. 与 CHARTER 目标差距

`docs/CHARTER.md` 已定义完整路线（G1/G2/G3/G4），但当前代码仍处于早期阶段：

- 已落地：G3 多模型切换、G4 内容源读取
- 未落地：G1 企业接口工具化（含写操作确认）
- 未落地：G2 知识库（检索 + 写入 + 分类）

---

## 5. 阶段性定位

当前更准确的工程定位是：

> **“可用的企业助手 MVP（工具增强聊天）”**，而非“完整 Agent Framework”。

---

## 6. 下一步落地优先级（建议）

1. **先补 G1：企业 API 工具层**
   - 落地 `data/apis/*.yaml` 白名单
   - 增加参数校验与鉴权注入
   - 对写操作加确认流（HITL）
2. **再补 G2：知识库能力**
   - 先用 SQLite FTS5 关键字检索
   - 后续再补 embedding 向量检索
3. **增强可观测性**
   - 统一记录 tool_call/tool_result 链路
   - 输出结构化 trace 便于排障
4. **补结果校验层**
   - 重要任务增加 schema 校验与失败重试
5. **直接落地 LangGraph 图编排（当前阶段启动）**
   - 以 LangGraph 作为统一调度内核，替代当前手写 ReAct `for-loop`
   - 首批节点建议：`intent_router`、`tool_executor`、`kb_retriever`、`api_executor`、`validator`、`finalizer`
   - 首批能力建议：条件分支、失败重试、人工确认断点（HITL）、可恢复 checkpoint
   - 与现有 `chat.ts` 的迁移策略：先做兼容包装层，再逐步把循环逻辑迁到图节点

---

## 8. 架构决策更新（ADR）

### ADR-0001：调度框架采用 LangGraph（已决定）

- 决策时间：2026-08-19
- 决策结论：**不再等待“流程复杂后再评估”，当前即采用 LangGraph 进行图编排重构。**
- 决策原因：
  1. 现有手写循环可用但扩展性有限，难以稳定支持多分支与恢复。
  2. G1/G2 将引入更多工具与确认流，图编排更利于控制复杂度。
  3. LangGraph 原生支持状态流转、条件跳转、checkpoint 和 HITL 断点。
- 影响范围：
  - `apps/agent-server/src/chat.ts`：从单循环迁移到 graph runtime 入口
  - `apps/agent-server/src/tools.ts`：保持工具契约不变，作为图节点执行单元
  - SSE 事件：补齐 `tool_use`、`tool_result`、`confirmation_required`、`state_transition`
- 验收要求：
  - 至少 1 条业务流程跑通（含写操作确认）
  - 支持中断后恢复（checkpoint replay）
  - 可观测链路可追踪每个节点输入输出

---

## 7. 验收标准（更新建议）

当满足以下条件时，可认为进入“完整 Agent”阶段：

- 支持跨会话知识检索（长时记忆）
- 至少一类企业业务 API 工具可稳定闭环（含写操作确认）
- 具备可追踪的工具执行链路与失败回滚策略
- 具备明确终止、校验与重试策略

