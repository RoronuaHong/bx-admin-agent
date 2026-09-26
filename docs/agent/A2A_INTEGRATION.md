# A2A 接入方案（Agent2Agent：对外暴露 + 对外编排）

> **建立时间**：2026-09-03
> **需求来源**：用户要求「主 agent 与子 agent 之间的标准连通方式」接入业界 Agent 互操作协议
> **决策状态**：方案已确认（2026-09-03 用户确认三点），本文档为正式方案；代码落地待启动
> **关联文档**：[MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md)（内部 multi-agent 演进，本文档是其「对外标准通道」的补充）
> **协议依据**：A2A v1.0（2026-03-12 发布，Linux Foundation / Agentic AI Foundation 托管）；规范权威来源 = `a2a.proto`（Layer 1）+ 抽象操作（Layer 2）+ 协议绑定（Layer 3）

---

## 1. 决策记录（2026-09-03 用户确认）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 目标场景 | **两者都要**：语义 A（A2A Server，把本 agent 暴露给外部 agent 调用）+ 语义 B（A2A Client，主 agent 编排外部 agent，挂到 M3）|
| 2 | 调用方身份 | **其他自有 agent**（企业内部其它 agent，如知识库/客服/财务类），非第三方开放 |
| 3 | Agent Card 能力描述尺度 | **按占位符级别**（XX / 通用终端语义），守「禁止写死业务词」红线，不列具体业务菜单 |

---

## 2. 背景：A2A 生态全景（2026-09 时点）

Agent 互操作协议分层的业界共识（协议栈三件套）：

| 层 | 协议 | 定位 | 本项目状态 |
|---|---|---|---|
| Agent↔Agent 协调 | **A2A**（Agent2Agent）v1.0 | 任务级协作：发目标、agent 自主完成、长任务/流式/发现 | ❌ 未接入（本文档）|
| Agent↔工具/数据 | **MCP** | 函数级调用 | ✅ 已有 `/mcp` 出口（`mcp.ts`，Streamable HTTP）|
| Agent↔UI | **AG-UI / A2UI** | agent 输出渲染 | 不适用（自有 web 前端）|

其他候选协议均已收敛排除：ACP（IBM，已让位 A2A）、ANP（生态小）、AGNTCY/Agent Connect（生态不及 A2A）。**A2A 为事实标准**（150+ 组织、TSC 含 Google/Microsoft/Amazon、官方 Python + TypeScript SDK）。

### A2A v1.0 关键规范事实（已核实，与早期资料有差异，以本表为准）

| 项 | v1.0 结论 |
|---|---|
| Agent Card 托管路径 | `/.well-known/agent-card.json`（v0.1 曾为 `agent.json`，v0.3 起改）|
| Agent Card 必填字段 | `name` / `description` / `supportedInterfaces` / `version` / `capabilities` / `defaultInputModes` / `defaultOutputModes` / `skills` |
| AgentInterface | `url`（HTTPS 绝对 URL）+ `protocolBinding`（`JSONRPC` / `GRPC` / `HTTP+JSON`）+ `protocolVersion`（如 `"1.0"`）+ 可选 `tenant`；列表有序，第一项为首选 |
| capabilities | `streaming` / `pushNotifications` / `extensions` / `extendedAgentCard`（布尔）；**无早期资料里的 `task/sync` 等** |
| 操作方法（JSON-RPC 绑定同名）| `SendMessage` / `SendStreamingMessage` / `GetTask` / `ListTasks`（v1.0 新增，游标分页）/ `CancelTask` / `SubscribeToTask` / 推送通知 4 个 CRUD / `GetExtendedAgentCard` |
| 任务状态机 | `TASK_STATE_SUBMITTED` / `WORKING` / `COMPLETED` / `FAILED` / `CANCELED` / `REJECTED` / `INPUT_REQUIRED` / `AUTH_REQUIRED` |
| 交互模式 | `SendMessageConfiguration.returnImmediately`：false=同步阻塞至终态；true=立即返回 Task，客户端轮询/订阅/推送 |
| 数据模型 | Message（用于沟通，`messageId`/`role`/`parts`/`contextId`/`taskId`）；**任务结果用 Artifact 交付**（`artifactId`/`parts`）；Part 恰好一种：`text` / `raw` / `url` / `data` |
| 传输 | JSON-RPC 2.0 / gRPC / HTTP+JSON（REST）三绑定等价；JSON camelCase；`A2A-Version: 1.0` 头；媒体类型 `application/a2a+json` |
| 安全 | 5 种 SecurityScheme：APIKey / HTTPAuth / OAuth2 / OIDC / mTLS；任务中途可 `AUTH_REQUIRED` 升级 |
| TS SDK | 官方 `@a2a-js/sdk`（github `a2aproject/a2a-js`，npm 发布，2026-08 活跃），可建 A2A server 与 client |

---

## 3. 本架构接入设计（两种语义）

### 3.1 双语义总览

```
                         ┌────────────────────────────────────────────┐
   自有其他 agent ──A──► │ 本 agent = A2A Server（/.well-known/…）     │
   （知识库/客服等）        │  agent-card.json 发现 → SendMessage 任务     │
                         │  → 映射 chatStream 引擎 → Artifact 回结果    │
                         └────────────────────────────────────────────┘

                         ┌────────────────────────────────────────────┐
   本 agent = A2A Client │ （M3 阶段，跨进程 Worker 场景）               │
   Supervisor/Worker ─B─►│  主 agent 调外部自有 agent 的 A2A Server      │
                         └────────────────────────────────────────────┘

   内部 multi-agent（M0–M2，进程内装配）不需要 A2A：
   Supervisor 路由 + Worker = 工具子集+领域提示+环境配置，见 MULTI_AGENT_ARCHITECTURE.md
```

**边界声明**：A2A 是「对外标准通道」，不是内部 multi-agent 的必要件。M0–M2 的进程内 Worker 方案照旧（成本最低、回退最易）；A2A 语义 A 让外部 agent 能按标准调用本 agent；语义 B 在 M3 出现「独立部署 Worker」时才启用。

### 3.2 语义 A：A2A Server（把本 agent 暴露给自有其他 agent）

#### 3.2.1 出口与 Agent Card

- `GET /.well-known/agent-card.json` → Agent Card
- JSON-RPC 端点：`POST /a2a`（Hono 挂载，`A2A-Version: 1.0` 校验）

Agent Card（占位符级别，守红线；`<…>` 为部署时填）：

```json
{
  "name": "BX Admin Agent",
  "description": "企业内部后台业务查询/操作 agent：接收自然语言任务，自动定位模块与接口取数，返回整理后的文本/表格结果。仅限内部系统间调用。",
  "version": "1.0.0",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json", "text/markdown"],
  "capabilities": { "streaming": true, "pushNotifications": false, "extendedAgentCard": false },
  "skills": [
    {
      "id": "business-query",
      "name": "后台业务数据查询",
      "description": "用自然语言描述查询目标（模块/列表/详情/统计/筛选条件），agent 自主完成接口定位与取数。",
      "tags": ["query", "list", "detail", "statistics", "export"]
    }
  ],
  "supportedInterfaces": [
    {
      "url": "<https://agent-server 公网/内网地址>/a2a",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "securitySchemes": {
    "internal-bearer": {
      "type": "http",
      "scheme": "bearer",
      "bearerFormat": "opaque"
    }
  },
  "securityRequirements": [{ "internal-bearer": [] }]
}
```

> 说明：card 的 description/skills 是「对外能力声明」（性质同工具描述），但仍按用户决策用通用词，不落具体业务菜单词；自然语言任务进入后**全交给 chatStream 引擎判断**，A2A 层不新建任何语义/词形路由（红线）。

#### 3.2.2 JSON-RPC 方法最小集（一期）

| 方法 | 语义 | 一期 |
|---|---|---|
| `SendMessage` | 主交互：收消息 → 创建 Task → 同步/异步执行 | ✅（`returnImmediately=false` 同步为主，先最简单）|
| `SendStreamingMessage` | 流式变体（SSE 推 Task 状态/Artifact 更新）| 🟡 二期（本引擎已有 SSE 基建，成本低但先稳同步）|
| `GetTask` | 轮询任务状态 | ✅ |
| `CancelTask` | 取消任务（幂等）| ✅（映射 AbortController，即 `/chat/stream` 现有 signal 语义）|
| `ListTasks` | 列任务（v1.0 新增）| 🟡 二期 |
| 推送通知 4 CRUD | Webhook | ❌（自有 agent 场景轮询/流式够用）|
| `GetExtendedAgentCard` | 认证后扩展卡 | ❌（card 静态即可）|

#### 3.2.3 Task → chatStream 映射（核心映射层，新建 adapter，不碰 chat.ts 引擎）

```
A2A Task(message) ──► 映射 ──► chatStream(session, text, {model, files}) ──► SSE 事件流
                                 │                                              │
                     session 绑定：按 token → 固定 country/project/environment    │
                                 │                                              ▼
                     （无交互式登录，见 3.2.4）                        聚合 final 文本 + markdown 表格
                                                                              │
                                                                              ▼
                                                       Task.status.state=COMPLETED
                                                       Task.artifacts[0].parts=[TextPart(总结)]
                                                       （可选 DataPart=表格结构化 JSON）
```

- **输入**：A2A Message 的 `parts[].text` → 引擎输入文本；`parts[].url`/`data` → 视作文件/附加上下文（一期仅 text，`url`/`data` 返 `ContentTypeNotSupportedError` 或忽略并说明）
- **输出**：SSE 事件流里的 `final` 文本 + UI_TABLE/表格渲染 → 聚合为 A2A `TextPart`（markdown 文本）；结构化表格可选 `DataPart`（JSON）——对齐「任务结果用 Artifact 交付」规范（不用 Message 装结果）
- **多轮/续聊**：A2A `contextId`/`taskId` → 映射内部 session 续接（复用现有会话历史），一期的 contextId = sessionId
- **写操作**：引擎 `confirmation_required` 事件（web 有人点确认）在 A2A 无界面场景下**不适用** → 见 3.2.4 只读策略
- **模型选择**：A2A 任务可用 `metadata`/扩展头指定模型 id（一期固定用配置默认模型，不给外部任意选）

#### 3.2.4 身份、环境与写操作策略（与 web 通道的本质差异）

| 维度 | web 通道（现状）| A2A 通道（新）|
|---|---|---|
| 身份 | 浏览器 cookie session（交互式登录）| **Bearer token**（配置化 API key 清单）→ 每 token 映射固定身份 |
| 环境 | 登录时选国家线（India/Brazil）| 每 token 配置固定 `country + project + environment`（默认 test 安全优先），请求不带环境参数 |
| 写操作 | `confirmation_required` 弹窗等人点 | **默认只读**：命中写意图/写 method 直接拒绝（Task FAILED/REJECTED + 说明）；仅标记可写角色的 token 才放行（放行后仍走服务端兜底确认策略 `writeConfirmPolicy`）|
| 并发 | 每会话一轮 | 每 Task 一次执行，可并行（token 粒度限流待定）|

- 认证实现：校验 `Authorization: Bearer <key>` 命中配置（`.env` 占位 `A2A_API_KEYS`，一期单 key 或多个 key→身份映射表），未命中 401
- `ALLOWED_API_HOSTS` 等环境收紧逻辑复用 worker 环境配置（MULTI_AGENT_ARCHITECTURE.md §3.5 的设计，A2A 通道直接消费同一套）
- **安全默认值**：A2A token 默认只读 + 默认 test 环境；生产环境需要写权限必须显式配置

### 3.3 语义 B：A2A Client（主 agent 编排外部自有 agent，挂 M3）

**触发条件**：仅当 M3 出现「独立部署/跨进程的 Worker」（如某领域 agent 是另一团队运维、或有独立权限边界）才启用。进程内 Worker（M0–M2）不需要。

设计要点：

- 在内部 multi-agent 路由（`route_to_agent`）之上增加一种 worker 类型：`kind: "remote"`，WorkerDef 增加 `a2a?: { agentCardUrl: string; apiKeyRef: string }`
- Supervisor 路由命中 `remote` worker → 主 agent（或该 worker 节点）作为 A2A Client 调外部 agent：先 `GET agent-card.json` 发现（缓存），再 `SendMessage` 发任务，轮询/流式收结果 → 结果以工具返回形式回喂主循环（对齐「数据回喂模型校验」模式：外部 agent 的结果是模型的「工具结果」，模型基于结果自主总结收束）
- 依赖：官方 `@a2a-js/sdk` 的 client 侧；错误码对齐 A2A 规范（`TaskNotFoundError -32001` 等）
- 写操作：外部 agent 的写操作由其自身安全策略负责；主 agent 对「调外部 agent 且可能产生写」同样走现有确认机制（A2A Client 调用本身是只读路由，具体业务写由远端判）

### 3.4 红线合规检查（落地时逐条核对）

| 红线 | A2A 落地口径 |
|---|---|
| 禁止业务词写死（代码/正则/映射/配置/描述）| Agent Card description/skills 用通用词 + XX 占位；A2A 层**零语义判断**（路由/意图/参数全交引擎模型）；无词形正则 |
| 环境维度语义（test/prod）| 通用终端语义，合规；token→环境映射存配置，不写死域名 |
| 写操作安全 | A2A 通道默认只读 + 拒绝写；可写 token 显式配置且复用 writeConfirmPolicy |
| 协议结构护栏 vs 语义判断 | 方法名/状态机/Task 结构是协议契约（跨系统通用），允许；业务词不进协议层 |

### 3.4.1 双通道现实状态（代码层，2026-09-03 核实）

| 通道 | 协议层级 | 代码状态 | 证据 |
|---|---|---|---|
| **MCP** | 工具级（agent↔工具，函数调用）| **✅ 已实现**（`apps/agent-server/src/mcp.ts`，`attachMcp(app)` 挂 `/mcp`，Streamable HTTP）| 已注册 **28 个 MCP 工具**（submit_understood_intent / parse_intent / set_project / call_api / search_api_module / export_dataset / grep_codebase / search_knowledge_base / search_dingtalk_doc / get_list_columns / render_table 等），任何 MCP 客户端（Claude Desktop / Claude Code / opencode）连上即可当一个工具箱调用 |
| **A2A** | 任务级（agent↔agent，发目标自主完成）| **✅ A0 已实现**（2026-09-03，`apps/agent-server/src/a2a.ts` + `app.ts` 挂载；零新依赖最小自实现）| 已实现：Agent Card `/.well-known/agent-card.json` + JSON-RPC `/a2a`（`SendMessage` 同步 / `GetTask` / `CancelTask`）+ Bearer 鉴权 + Task→chatStream 映射 + 默认只读拒绝写；自测 `scripts/a2a-selfcheck.mjs` 6/6 通过 |

> **重要澄清**：MCP 出口当前暴露的是**工具函数**（单个能力），MCP 客户端拿到的是「可调用的 28 个函数」，而非「一个会自主跑任务的 agent」。它实现的是**工具级协作**（A 让 B 的一段代码/某函数替它干活），不是**任务级协作**（A 对 B 说「去把 XX 模块前 2 页查出来并总结」，B 自主决策调哪些工具）。任务级协作是 A2A 的事，尚未实现。

### 3.4.2 协作能力覆盖矩阵（回答「同等级 agent / 子 agent 能否通信」）

| 协作场景 | MCP（已实现）| A2A（方案）| 内部 Supervisor+Worker（MULTI_AGENT 规划）|
|---|---|---|---|
| **本 agent ↔ 同等级外部 agent（互相调）** | ✅ 工具级：对方把本 agent 当工具箱（调 call_api 等）| ✅ 任务级：对方发自然语言任务，本 agent 自主完成 | ❌ 不涉及（那是外部 agent 的事）|
| **本 agent ↔ 自己的子 agent（内部领域 worker）** | ❌ 不必要（进程内直接调用）| 🟡 仅当子 agent 独立部署/跨进程（M3 remote worker）时走 A2A Client | ✅ 主路径：进程内 state 装配，不走协议 |
| **本 agent 被外部 agent 编排** | ✅（作为工具箱被编排）| ✅（作为 agent 被派任务）| ❌ |
| **本 agent 编排外部 agent** | ❌（MCP 是 agent 接工具，不是 agent 接 agent）| ✅（A2A Client，B 挂 M3）| ❌ |

**结论**：
- 无论「同等级 agent」还是「子 agent」，当前**已经能用 MCP 实现工具级协作**（对方把本 agent 当能力库）。
- **任务级 agent 间协作（发目标自主完成）当前没有**——这是 A2A（A0 Server + B0 Client）要补的能力。
- 内部子 agent（领域 worker）**不走 A2A/MCP**，走 MULTI_AGENT 规划的进程内装配（M0–M2）；只有当 worker 需独立部署才升级为 A2A remote worker。



「LangGraph 方式接 A2A」存在，但分两类，**仅一类与本项目栈相关**：

#### 3.5.1 类别甲：LangGraph 框架/平台原生接 A2A 协议

| 路径 | 机制 | 栈要求 | 与本栈匹配 |
|---|---|---|---|
| **LangGraph Platform / LangSmith Agent Server 内置端点** | 部署 graph 后**自动**暴露 `/a2a/{assistant_id}` + 自动生成 Agent Card（`/.well-known/agent-card.json?assistant_id=…`）；`langgraph.json` 可 `"http": {"disable_a2a": true}` 关闭（官方文档 `docs.langchain.com/langsmith/server-a2a`）| 必须部署到 LangGraph Platform（Cloud 或 Self-hosted）；官方示例为 Python `langgraph-api>=0.13.0`，且 graph state 必须含 `messages` 键 | ❌ 不直接匹配：本项目是 **TS 手写 LangGraph 式图 + 自托管 Hono/PM2**，不运行 Agent Server，故**不会自动获得该端点** |
| **`a2a-langgraph`（PyPI，2026-04）** | 小型 opinionated 适配器：把 A2A 端点**直接挂载**到现有 Python LangGraph 图（`A2AServer` + `InMemoryTaskManager` + `StateGraph`）| Python langgraph 库 | ❌ 不直接匹配：本项目非 Python langgraph |
| **`langchain-samples/A2A-langgraph` 教程** | 官方示例：用 `A2AServer` + `InMemoryTaskManager` 包装 LangGraph StateGraph | Python | ❌ 同上 |

> **结论**：类别甲本质是「把 graph 交给 LangGraph 平台/库托管，由它发 A2A 端点」。我们**自托管 Hono + 手写图**，不享用此红利。若未来把引擎迁到 LangGraph Platform（云托管），可零代码获 A2A 能力——属**长期备选路线**，当前不采纳。

#### 3.5.2 类别乙：LangGraph 自带多 agent 编排（非 A2A 协议！）

| 机制 | 说明 | 与 A2A 关系 |
|---|---|---|
| `langgraph_supervisor` / `create_supervisor` | 分层 supervisor 模式（中央调度 + 子 agent 子图），进程内或 remote | 这是**框架内多 agent**，不依赖 A2A 协议 |
| LangGraph **Remote Graph**（`create_remote_graph` / Platform 远程调用）| 一个图调用另一个部署的图，走 LangGraph 私有 RPC | 属 LangGraph 私有协议，**不是** A2A |

> **边界澄清**：类别乙与我们 `MULTI_AGENT_ARCHITECTURE.md` 规划的「Supervisor 路由 + Worker 子图（M2）」是**同一思路**（LangGraph 式分层多 agent）。它解决的是「内部主-子 agent」，本方案 §1 语义 B 的 remote worker 若用 LangGraph 实现可走此路，但**不走 A2A 协议**。不要把「LangGraph supervisor / remote graph」与「A2A 协议」混为一谈：前者是 LangGraph 生态的私有编排，后者是跨厂商标准。**本项目的跨进程 worker（M3）若要被非 LangGraph 的外部 agent 调用，仍走本文档 §3.2 的 A2A Server/Client 标准通道。**

#### 3.5.3 本项目采用路径（定论）

- **A0（语义 A Server）**：采用 §3.2 的「**自建 Hono + `@a2a-js/sdk` 适配器**」——直接映射 `chatStream`，不依赖 LangGraph 平台/库。理由：栈匹配、零改造现有引擎、可控、合规红线清晰。
- **类别甲**作为「未来若迁 LangGraph Platform」的备选记录，不在 A0 实现范围。
- **类别乙**归入 `MULTI_AGENT_ARCHITECTURE.md` 的内部多 agent 设计，不在本 A2A 文档的协议接入范围。

---

## 4. 落地路径

| 阶段 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| **A0** | Agent Card + `/a2a` JSON-RPC 最小集（`SendMessage` 同步 / `GetTask` / `CancelTask`）+ Bearer 认证（只读）+ Task→chatStream 映射 | 小 | 官方 `@a2a-js/sdk` 引入或最小自实现；A2A_API_KEYS 配置 |
| **A1** | `SendStreamingMessage`（复用 SSE 基建）+ ListTasks + 多 token→身份/环境映射表 | 中 | A0 稳定 |
| **B0（挂 M3）** | remote worker 类型 + A2A Client 发现/发任务/收结果回喂 | 中 | M1/M2 路由稳定；外部 agent 有 A2A Server 端点 |

**为什么 A0 先行**：已有 `/mcp` 出口先例 + `chatStream` 引擎 + Hono，A0 与 mcp.ts 同级工作量；先解决「外部 agent 能按标准调我们」，B 的收益依赖 M1 路由先落地。

---

## 5. 待确认 / 待办

- [ ] 引入官方 `@a2a-js/sdk`（npm）还是最小自实现 JSON-RPC（方法集很小，自实现可避免版本演进风险——待 A0 启动时按 SDK 成熟度定）
- [ ] agent-server 对外可达地址（本机/内网部署，外部 agent 需能访问 `/a2a`；生产可达性同 MULTI_AGENT_ARCHITECTURE.md §6）
- [ ] A2A token 签发清单：哪些自有 agent 给哪个 token → 固定哪个 country/project/environment
- [ ] A0 协议级自测方案（无真实外部 agent 时：用官方 SDK 写一个最小测试 client 打自己）
- [ ] contextId → session 续接的过期/回收策略（对齐 session TTL）
- [ ] 是否在 A0 就启用 streaming（成本低但增加一期面）

---

## 6. 进度记录

| 日期 | 进展 |
|---|---|
| 2026-09-03 | 全网调研 A2A 生态（A2A v1.0 为事实标准，ACP/ANP/AGNTCY 排除；MCP 已有 /mcp 出口，AG-UI 不适用）；核实 v1.0 规范细节（agent-card.json 路径、方法名、capabilities 结构、官方 @a2a-js/sdk）|
| 2026-09-03 | 用户确认三点：①双语义都做（A Server 先行 + B Client 挂 M3）；②调用方=自有其他 agent；③Agent Card 用占位符级别守红线。本方案文档建立 |
| 2026-09-03 | 可行性验证 + 影响评估（见 §7）：SDK 真实存在、引擎零 HTTP 依赖、事件映射齐全、零侵入挂载先例；对现有 web/MCP 通道零改动，会话/写确认/项目上下文三处共享点均可在设计层隔离。结论：可启动 A0 |
| 2026-09-03 | 补充 §3.5 实现路径对比：核实「LangGraph 方式接 A2A」两类 —— 类别甲（LangGraph Platform 自动 `/a2a/{assistant_id}` 端点 + `a2a-langgraph` 包 + langchain-samples 教程，均 Python/平台托管，与本 TS 自托管栈不直接匹配）；类别乙（langgraph_supervisor / remote graph，纯 LangGraph 私有编排，非 A2A 协议，归 MULTI_AGENT 内部设计）。定论：A0 仍采用自建 `@a2a-js/sdk` + Hono 适配器 |
| 2026-09-03 | 代码层核实：MCP 通道**已实现**（`mcp.ts` 注册 28 个 MCP 工具，挂 `/mcp`，Streamable HTTP）；A2A 通道**零代码**（src 下 grep a2a = 0 命中）。新增 §3.4.1 双通道现实状态 + §3.4.2 协作能力覆盖矩阵：同等级/子 agent 当前已可用 MCP 做工具级协作，任务级 agent 协作待 A2A 落地；内部子 agent 走 MULTI_AGENT 进程内装配不走协议 |

---

## 8. 实现记录（A0 落地，2026-09-03）

> 用户确认「先加上」后，A0 已落地代码（非仅方案）。

### 8.1 代码改动面

| 文件 | 改动 | 性质 |
|---|---|---|
| `apps/agent-server/src/a2a.ts` | 新建：Agent Card 常量 + `attachA2a(app)`（JSON-RPC 端点 + Bearer 中间件 + Task→chatStream 映射 + 默认只读拒绝写）| 纯新增，零侵入 |
| `apps/agent-server/src/app.ts` | 加 `import { attachA2a }` + 一行 `attachA2a(app)`（与 `attachMcp` 并列）| 一行挂载 |
| `apps/agent-server/scripts/a2a-selfcheck.mjs` | 新建：协议骨架自测（AgentCard / 鉴权 / 未配置 503 / 未知方法 / SendMessage 走通引擎），6/6 通过 | 测试 |

- **零新依赖**：A0 自实现 JSON-RPC 层（方法集很小），未引入 `@a2a-js/sdk`（SDK vs 自实现待定项，自实现更可控、离线可跑）。
- **对现有功能零改动**：`chatStream` / `tools.ts` / `mcp.ts` / `/chat/stream` 全部未动；A2A 走独立路由。

### 8.2 已实现能力边界（A0）

- ✅ 对外暴露 Agent Card（占位符级别，守红线）
- ✅ `SendMessage` 同步执行：自然语言任务 → 构造独立 session（loginName 前缀 `a2a:` 隔离 web 会话）→ 驱动 `chatStream` → 聚合 final 文本为 Artifact 返回
- ✅ `GetTask` / `CancelTask`（任务可查、可取消，取消走 AbortController）
- ✅ Bearer 鉴权：`A2A_TOKENS`（JSON 数组，每项绑定 country/project/environment/readonly）
- ✅ 默认只读：token 未显式 `readonly:false` 时，引擎触发 `confirmation_required` 直接 `REJECTED`（无界面不可确认）
- 🟡 `SendStreamingMessage` / `ListTasks` / 推送通知 / extended card：留 A1（二期）
- 🟡 语义 B（A2A Client 编排外部 agent）：挂 M3；**B0 客户端骨架已建**（`src/a2a-client.ts`，纯协议客户端，可自环 A0，未集成进 multi-agent 路由），见 §8.4

### 8.3 验证结论

- 类型检查：`tsc --noEmit` 对 `a2a.ts` / `app.ts` 零错误（项目其余 pre-existing 错误与本次无关，tsx 运行时忽略）。
- 协议自测：6/6 通过，包括「SendMessage 真实驱动 chatStream 且不崩溃」（无模型环境返回 FAILED 属预期，证明链路通）。
- 影响评估维持 §7 结论：**对现有 Agent 功能零影响**（纯增量通道）。

### 8.4 实现记录（B0 Client 骨架，2026-09-03）

> 用户确认 B 的范围为「只建独立 A2A Client 模块」：因 B 在 §3.3 明确挂 M3，且内部 multi-agent 路由（M1 Supervisor / `route_to_agent`）当前无代码，集成版 B0（remote worker 接 Supervisor）现在无锚点；但协议客户端半边零依赖、可自洽，且能直连 A0 的 `/a2a` 做自环测试。

#### 8.4.1 代码改动面

| 文件 | 改动 | 性质 |
|---|---|---|
| `apps/agent-server/src/a2a-client.ts` | 新建：A2A v1.0 JSON-RPC 客户端（`fetchAgentCard` / `sendA2AMessage` / `getA2ATask` / `cancelA2ATask` / `extractTaskText` / `a2aRunTask` + `A2AClientError`），零新依赖（原生 fetch）| 纯新增，不碰引擎 |
| `apps/agent-server/scripts/a2a-client-selfcheck.mjs` | 新建：启动内置 A0 Server，用 client 走完整协议往返（发现/发消息/查任务/取消/聚合/鉴权失败）| 测试 |

#### 8.4.2 设计边界（守红线 + 不抢 M3 锚点）

- **零语义**：方法名 / 状态机 / Task 结构均为 A2A 协议契约（跨系统通用），代码与注释不含任何业务词；客户端只负责「发目标、收 Task」，任务判定全在远端。
- **不集成 multi-agent**：本模块不引用 `route_to_agent` / Supervisor（当前不存在），纯粹是「调用外部 A2A Server 的 HTTP 客户端」；M3 的 remote worker 类型可直接复用 `a2aRunTask` / `sendA2AMessage` 把结果回喂主循环。
- **自环可测**：`scripts/a2a-client-selfcheck.mjs` 同进程起 A0 Server + 跑 Client，6/6 通过（无模型环境 SendMessage 返回 FAILED 属预期，证明往返链路通）；`tsc --noEmit` 对 `a2a-client.ts` 零错误。

#### 8.4.3 待 M3 衔接项（不在本次范围）

- `WorkerDef` 增加 `a2a?: { agentCardUrl; apiKeyRef }` + `kind: "remote"` 类型（MULTI_AGENT_ARCHITECTURE.md §3.3）。
- Supervisor 路由命中 remote worker → 调 `a2aRunTask` 把远端 Artifact 作为「工具结果」回喂主循环（对齐「数据回喂模型校验」模式）。
- Agent Card 发现缓存 + 外部 agent 的写操作安全策略（远端自判，主 agent 仅控制「是否发起」）。

#### 8.4.4 验证结论

- 协议自测：6/6 通过（发现 / 发消息返回 task / 查任务一致 / 取消 / 文本聚合不抛错 / 错误 token 抛 `A2AClientError` code=-32000）。
- 类型检查：`a2a-client.ts` 零类型错误。



> 落地前论证。结论：**技术可行性高，对现有 Agent 功能影响极低（纯增量，不改任何现有代码路径）**。

### 7.1 可行性硬证据

| # | 验证项 | 证据（代码位置）| 结论 |
|---|---|---|---|
| 1 | A2A SDK 真实可用 | web 检索确认 `@a2a-js/sdk` 为官方 TS SDK（2026-08 发布，build A2A servers，npm/github `a2aproject/a2a-js`）| ✅ 可引入 |
| 2 | 引擎零 HTTP 依赖（最关键）| `chatStream(session, userText, opts, signal)`（`chat.ts:1220-1225`）内部仅用 `session.token/country/menus`（`chat.ts:1280-1283`）+ 模块级 `setCurrentProject`（`chat.ts:1303`）；**不引用任何 `c.req`/headers/cookie/HTTP 对象** | ✅ A2A 映射层只需构造 `Session` 即可复用引擎，无 HTTP 耦合 |
| 3 | 事件映射齐全 | `ChatEvent`（`packages/shared/src/index.ts:79-91`）含 `text`/`table`/`error`/`confirmation_required`；可聚合为 A2A `Artifact`（TextPart=总结、DataPart=表格）；`CancelTask` 直映 `signal: AbortSignal` | ✅ 映射层薄 |
| 4 | 零侵入挂载先例 | `mcp.ts` 的 `attachMcp(app)`（`mcp.ts:374`）一行挂到 Hono（`app.ts:370`），注释明确「本机服务 + DNS rebinding 防护，按需再加 token」| ✅ A2A 照搬 `attachA2a(app)` 风格，不改现有路由 |

### 7.2 对现有功能的影响评估

| 现有路径 | A0 是否改动 | 影响 |
|---|---|---|
| `/chat/stream`（web 通道）| **零改动**（A2A 走独立路由，不进该代码路径）| 无 |
| `/mcp`（MCP 出口）| **零改动** | 无 |
| `chatStream` 引擎 / `tools.ts` / `Session` 逻辑 | **零改动**（仅新增调用方）| 无 |
| 新增 `/a2a` + `/.well-known/agent-card.json` | 纯新增 | 独立路由，失败隔离 |

**三个共享注意点（均可在设计层隔离，非破坏现有功能）：**

1. **会话列表隔离**：`listConversations(ownerKey)` 按 `ownerKey = countryId:loginName` 过滤（`conversations.ts:42-45, 95-102`）。A2A 通道用**独立 user 标识**（如 `loginName: "a2a:<tokenId>"` + 固定 country），其会话不会出现在 web 用户列表、也不可被 web 端恢复。→ A0 设计约束（非 bug）。
2. **项目上下文进程级全局**：`setCurrentProject`（`chat.ts:1303`）是模块级状态（project-context.ts 已注释「多请求并发以最近设置为准」）。A2A 加剧此竞态但不引入新问题；scheme §3.2.4 已设计 token 绑定固定 project，单任务内一致，跨任务竞态与现状同级。
3. **写操作确认流隔离**：引擎 `confirmation_required` 事件在 web 走 `/chat/confirm`。A2A 无界面 → 映射层捕获该事件直接 `Task FAILED`（默认只读拒绝写），**不触发 web 确认流**。隔离干净。

### 7.3 结论

- **可启动 A0**：引入 `@a2a-js/sdk` + 新增 `a2a.ts`（Agent Card 静态常量 + JSON-RPC 端点 + Task→chatStream 映射 + Bearer 中间件）+ `app.ts` 一行 `attachA2a(app)`。
- **落地前唯一设计约束**：A2A session 的 `user.loginName` / `country` 必须用独立标识前缀，确保会话隔离（见 7.2-1）。
- **不修改**任何现有文件的核心逻辑；新增文件与一行挂载为唯一改动面。
