# Multi-Agent 架构规划

> **建立时间**：2026-09-02
> **需求来源**：用户提出未来会有一批领域 Agent（多个后台管理系统 API、知识库查询、财务、客服咨询、数据库等），需要从单 Agent 演进为 multi-agent
> **定位**：本文件是 multi-agent 演进的需求→现状→设计→落地路径的唯一入口

---

## 1. 需求拆解

用户设想的 Agent 清单（按领域/系统划分）：

| Agent | 说明 |
|---|---|
| 后台管理系统 API Agent ×N | 多个后台系统，**每个系统分测试/生产两套环境** |
| 知识库查询 Agent | 查企业文档（本地 RAG + 钉钉文档），给引用出处 |
| **观影助手 Agent（高优）** | C 端找片/推荐；**Web 先行、不做 App**；详见 [VIEWING_ASSISTANT_AGENT.md](./VIEWING_ASSISTANT_AGENT.md) |
| 财务 Agent | 财务域查询/报表 |
| 客服咨询 Agent | 面向用户的咨询问答 |
| 数据库 Agent | 直查数据库/SQL（待明确，可能归后台 API Agent） |

**关键约束（环境维度）**：后台管理系统是**测试环境 / 生产环境**两套部署，API 地址、数据、权限都不同。查询必须能区分环境，不能混。

---

## 2. 现状盘点（2026-09-02）

| 能力 | 现状 | 说明 |
|---|---|---|
| 单 Agent + 工具循环 | ✅ | LangGraph：START → preprocess → understand ⇄ tool → final → END（`chat.ts`） |
| 工具集 | 22 个全量注入 | `tools.ts` listAgentTools；模型自主选路 |
| 多项目切换 | ✅ | `set_project` + `clarification-policy.json` 的 project 槽位（bx-film-admin / global） |
| 项目代码环境 | 🟡 半区分 | `branch` 字段分 dev/master（代码仓库维度），但未接 API 环境 |
| API 调用环境 | ⚠️ 未显式建模 | `.env` `COUNTRY_*_URL` 目前指向线上内网域名（生产）；`ALLOWED_API_HOSTS` 含 localhost:3100（本地开发）；无「测试/生产」显式环境标识 |
| 领域隔离 | ❌ 无 | 全部工具一个 Agent 可见，无领域上下文裁剪 |
| 权限隔离 | ⚠️ 未做 | session 无 roles / allowedProjects；P2 待办 |
| 并发 | ❌ 串行 | 单 Agent 一轮一轮跑 |

---

## 3. 架构设计

### 3.1 核心思想：Worker = 配置化上下文，不是独立进程/模型

**关键设计决策**：Multi-agent 不等于「每个 Agent 一个模型实例/一个进程」。当前单 Agent 的成本不在模型调用，而在**工具集全量注入（22 个）+ 无领域上下文裁剪**导致模型选错工具。因此：

> **Worker = 工具子集（whitelist）+ 领域系统提示 + 环境/项目配置的声明式组合。** 所有 Worker 共享同一个模型池、同一个 LangGraph 执行引擎，只是每次请求按路由结果「装配」不同的上下文。

这个设计带来：
- **零新增常驻服务**（不破现有 PM2 单进程哲学）
- **路由错误可回退**（Supervisor 判错 → 模型在 worker 内可换工具/重新路由）
- **配置驱动扩展**（新增领域 = 加一个 WorkerDef，不改引擎）

### 3.2 总体图结构：Supervisor 路由 + Worker 执行

```
用户输入
   ↓
[ preprocess ]  ← 现有：静态引导、rules、项目上下文（不变）
   ↓
[ route ]  ← 新增节点（M1）：轻量模型判（domain × environment × project）
   │         输出走 route_to_agent 工具（函数调用通道，模型判断不写死词形）
   ↓
[ understand ⇄ tool → final ]  ← 现有循环，但注入的是「裁剪后的工具集 + 领域系统提示」
   │                              + 环境配置（API base / token / 确认策略）
   ↓
[ END ]
```

**M1 阶段不拆子图**：`route` 节点只是给 state 写 `activeWorker`，后续 understand/tool/final 节点**读取**该值来装配上下文。图结构从 5 节点变为 6 节点，改动最小、回退最容易。

**M2 阶段可升级为子图**：LangGraph 支持子图嵌套，届时每个 worker 的 understand⇄tool→final 可包成独立子图（`compile` 子图后作为父图节点调用），但**执行引擎和装配逻辑不变**——子图只是代码组织方式，不是运行时隔离。

### 3.3 Worker 定义（配置化）

```ts
interface WorkerDef {
  id: string;                     // 唯一标识，如 backend-api-bx-film-admin-test
  domain: "backend-api" | "knowledge" | "finance" | "customer-service" | "database";
  label: string;                  // 展示名
  project?: string;               // backend-api 类必填（如 bx-film-admin）
  environment?: "test" | "prod";  // backend-api 类必填
  toolWhitelist: string[];        // 工具子集（从 listAgentTools() 过滤）
  systemPrompt?: string;          // 领域系统提示（覆盖/追加 buildStaticGuide）
  apiBase?: Record<string, string>;  // backend-api：{ backend, user, film, gather } 域名
  allowedHosts?: string[];        // call_api 主机白名单（按环境收紧）
  writeConfirmPolicy?: "always" | "normal";  // prod 强制 always
  permissions?: { read: boolean; write: boolean };  // M3 启用
  preferredModel?: string;  // 可选：该 worker 优先/强制使用的模型 id（覆盖默认）；M1+ 增强，详见 §3.8
}
```

**第一批 Worker 清单**：

| Worker id | 领域 | 项目 | 环境 | 工具子集（示意） |
|---|---|---|---|---|
| `backend-api-bx-film-admin-test` | backend-api | bx-film-admin | test | search_api_module / read_api_module / call_api / grep_codebase / get_list_columns / render_table / export_dataset / submit_understood_intent … |
| `backend-api-bx-film-admin-prod` ✅ | backend-api | bx-film-admin | prod | 同上 + writeConfirmPolicy=always；域名走 `COUNTRY_*_PROD_*_URL` |
| `knowledge` | knowledge | - | - | search_knowledge_base / fetch_url / read_file / list_dir / get_current_time |
| **`consumer-viewing`（高优·方案已定）** | **consumer-viewing** | - | - | search_titles / recommend_titles / render_media_cards / open_title …；**Web only**；多语言跟聊；见 [VIEWING_ASSISTANT_AGENT.md](./VIEWING_ASSISTANT_AGENT.md)（代码未实现） |
| `finance` | finance | - | - | call_api（财务模块）+ 报表工具（待财务模块明确） |
| `customer-service` | customer-service | - | - | search_knowledge_base + 纯问答（可配弱模型） |
| `database` | database | - | - | 待明确（SQL 直查 vs 归 backend-api） |

**通用工具（所有 worker 保留）**：request_clarification / set_project（或 route_to_agent）/ get_current_time / normalize_output / render_table（收束必需）。

### 3.4 路由设计（不写死词形，红线合规）

- 新增 `route_to_agent` 工具（复用 `set_project` 的机制与实现风格）：输入 `{ domain, project?, environment? }`，模型**函数调用通道**提交
- 服务端校验 `domain×project×environment` 是否命中已注册 WorkerDef（白名单），命中则装配上下文；未命中返回候选清单交模型重选（同现有 `search_api_module` 的 MODULE_RETRY 模式）
- **Supervisor 判定完全交模型**：系统提示只说明「根据用户请求的领域与场景选择路由目标」，不含任何业务词 → 领域判断的 if/else（红线：禁止词形路由）
- `environment` 走工具 schema 的 enum（`test`/`prod` 是通用终端语义，非业务词，合规）
- **不确定时反问**：模型对 domain 模糊（如"查一下"）→ 复用现有 `request_clarification` 收敛，禁止硬猜路由
- **模型选择装配（M1+ 增强）**：`resolveWorker` 命中 WorkerDef 后，若该 worker 配 `preferredModel`，后续 understand/final 的模型调用使用该模型（详见 §3.8）；未配则沿用默认模型池。模型选择是 worker 的「装配属性」，不改变「Worker 共享执行引擎」的核心设计

### 3.5 环境如何落地到 call_api

- session 增加 `activeEnvironment`（默认 `test`，安全优先；随 `activeProject` 同生命周期）
- `call_api` 工具 schema 增加 `environment` 字段（可选，缺省用 session 值）——避免每轮都路由
- `resolveBaseUrl`（upstream.ts）从「country 单域名」升级为「country × environment 双键」：测试=xxbbc 内网、生产=海外公网（§4.1 表格即权威数据源）
- `ALLOWED_API_HOSTS` 按 worker 环境收紧（测试含内网，生产仅海外域名）
- 生产环境写操作（writeConfirmPolicy=always）→ R3 强制确认逻辑按 worker 配置生效

### 3.6 与现有机制的关系

- **不推翻**现有 `set_project`：演进为 `route_to_agent` 的子集（project 是路由的一个维度）；`clarification-policy.json` 的 project 槽位保留，新增 environment 槽位
- **复用**现有 understand⇄tool→final 全部护栏：伪调用检测 / Doom Loop / pseudoPlanExhausted / 确认弹窗 / 表格聚合——worker 只换上下文不换机制
- **buildStaticGuide 参数化**：`buildStaticGuide(session)` → `buildStaticGuide(session, workerDef)`，领域 systemPrompt 注入 system 前缀（保持 prompt cache 收益）
- **对外标准通道（A2A）**：worker 若需被/调外部 agent（自有其他 agent），走 [A2A_INTEGRATION.md](./A2A_INTEGRATION.md)——M0–M2 进程内 worker 不需要 A2A；M3 出现独立部署/remote worker 时启用（A2A Server 出口先行，A2A Client 编排挂 M3，见该文档决策记录）

### 3.7 工具分组（M0 先行，不拆 Agent）

即使不拆 Agent，先给 `tools.ts` 的 22 个工具加 `domain` 标注并按领域裁剪注入，收益：
- 模型选错工具概率下降（知识库场景看不到 call_api，后台场景看不到 search_knowledge_base）
- 系统提示按领域裁剪，上下文更干净

| 领域 | 工具子集（示意） |
|---|---|
| backend-api | search_api_module / read_api_module / call_api / grep_codebase / get_list_columns / render_table / export_dataset … |
| knowledge | search_knowledge_base / fetch_url / read_file / list_dir … |
| **consumer-viewing** | search_titles / recommend_titles / render_media_cards / open_title / add_to_watchlist …（与 admin 工具隔离） |
| finance | call_api（财务模块）+ 报表工具 … |
| customer-service | search_knowledge_base + 纯问答 … |
| 通用 | request_clarification / set_project / route_to_agent / get_current_time … |

---

### 3.8 可选增强：Worker 级模型选择（preferredModel，M1+）

**背景（2026-09-03 用户决策）**：用户希望「每个 Agent 可单独切换模型」。原 §3.1 设计为「所有 Worker 共享同一个模型池、同一个执行引擎」（强调不按进程/实例拆分模型）。本增强作为**可选**能力叠加，不推翻核心设计：

- `WorkerDef.preferredModel?: string`：路由命中 worker 后，该 worker 的 understand/final 模型调用改用 `preferredModel`（若存在），实现「按 Agent 维度选模型」。
- **语义澄清**：这是「按 worker 装配不同模型」，不是「每 worker 一个独立模型进程」。执行引擎、工具循环、护栏全部复用；仅模型 id 参数按 worker 替换（对齐 Cursor 的「per-agent model」配置风格）。
- **默认行为不变**：未配 `preferredModel` 的 worker 沿用全局默认模型（与现状一致），保证零影响回退。
- **A2A 通道**：A2A Server 侧（§3.2.3）一期「固定用配置默认模型，不给外部任意选」——`preferredModel` 仅作用于**本 Agent 内部 worker 路由**，不影响 A2A 对外暴露时的模型策略（外部调用方不跨 worker 选模型）。
- **红线合规**：`preferredModel` 是配置层模型 id（通用契约值，如 `nemotron-3-ultra-free`），非业务词；worker→模型的映射走配置，无词形推断。

**落地关联**：
- M1 路由层（`route_to_agent` + `resolveWorker`）新增：命中 worker 后把 `preferredModel` 写入 `state.activeWorker`，`understand`/`final` 取模型时优先用该值。
- §6 待办新增「worker 级模型切换」实现项；§5 M1 行标注含此增强。

---

## 4. 环境建模（测试/生产）

### 4.1 现状盘点（2026-09-02 已确认）

**两个前端仓库的环境配置文件**：
- PC 端 `D:\Code\bx-film-admin-in2\.env.{dev,prod}-{india,brazil}`（4 个文件）
- H5 端 `D:\Code\bx-film-admin-h5\env\.env.{dev,test,prod}-{india,brazil}`（6 个文件，**多一套独立 test 环境**）+ 通用文件

**H5 项目 API 地址对照（关键：测试/生产域名完全不同！）**：

| 国家 | 环境 | 后台 API `BE_API_URL` | 用户 API `USER_API_URL` | 影片匹配 `MOVIE_MATCH_URL` |
|---|---|---|---|---|
| 印度 | 测试 | `http://inter-api.xxbbc.com:13100` | `http://inter-apiadmin.xxbbc.com` | `http://192.168.50.170:8086` |
| 印度 | **生产** | **`https://apiback.vmovs.com`** | **`https://apiadmin.vmovs.com`** | `https://pyapi.hwnue.com` |
| 巴西 | 测试 | `http://apiback.xxbbc.com:13100` | `http://apiadmin.xxbbc.com` | `http://192.168.50.170:8086` |
| 巴西 | **生产** | **`https://apiback.cinegatohd.tv`** | **`https://apiadmin.cinegatohd.tv`** | `https://pyapi.htocy.com` |

**核心结论：**
- ✅ **测试环境 = xxbbc.com 内网 HTTP 域名**（可直达，agent-server 现有 `COUNTRY_*_URL` 即对应这套）
- ✅ **生产环境 = 海外公网 HTTPS 域名**（vmovs.com / cinegatohd.tv），与测试完全不同
- 此前 in2 仓库 dev/prod 文件 API 域名相同，是因为 in2 的 prod 文件未更新生产域名（h5 的 prod 文件标注"对齐 bx-film-admin-in2"，但实际生产域名在 h5 中才有）
- agent-server 侧 `.env` `COUNTRY_*_URL` 当前配置 = 测试环境域名（`inter-api.xxbbc.com:13100` 等），**未配置生产域名**
- 生产域名需确认网络可达性（海外公网，可能需代理）与凭证（token）

### 4.2 设计要点

- 新增 **environment 配置**：每项目 × 环境（test/prod）→ { apiBase, token, allowedHosts, writeConfirmPolicy }
- session 增加 `activeEnvironment`（默认 test，安全优先）
- `call_api` 工具 schema 增加 environment 参数（可选，缺省用 session 值）
- **写操作在 prod 环境强制确认**（R3 已有，环境维度强化）
- ⚠️ **生产环境域名已确认存在且独立**（H5 env 文件为权威来源）：测试=xxbbc 内网、生产=海外公网 HTTPS。需进一步确认：①生产域名网络可达性（agent-server 服务器能否直连，是否需代理）；②生产环境 token 来源（见 §6）

---

## 5. 落地路径（渐进式）

| 阶段 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| **M0** | 工具按领域分组标记 + 系统提示按领域裁剪候选（不拆 Agent） | 零 | 无 |
| **M1** ✅ | 加 Supervisor 路由层：主管模型判（领域×环境）→ 交给对应上下文；含可选 worker 级模型切换（`preferredModel`）；2026-09-05 收尾（systemPrompt / prod Worker / 双域名） | 小 | 环境配置（test/prod URL） |
| **M2** | Worker 独立成子图，各自完整 understand⇄tool→final 循环 | 中 | M1 路由稳定 |
| **M3** | 并行 worker / 按 worker 隔离权限 / 独立审计；出现独立部署 worker 时经 A2A Client 编排（见 [A2A_INTEGRATION.md](./A2A_INTEGRATION.md) §3.3）| 大 | 权限体系 |

**为什么先 M0/M1**：multi-agent 最大坑是路由错误；先把路由调稳再拆子图，回退成本最低。

---

## 6. 待确认/待办

- [x] 测试/生产环境 API 地址盘点（2026-09-02，in2 4 个 env + h5 6 个 env，见 §4.1；地区维度=印度/巴西，墨西哥已去掉）
- [ ] ⚠️ 确认生产环境网络可达性：生产域名=海外公网 HTTPS（vmovs.com / cinegatohd.tv），agent-server 服务器能否直连/需代理
- [ ] 确认生产环境 token 来源（与测试环境是否同一登录体系）
- [ ] 数据库 Agent 语义确认：直查 SQL 还是归后台 API Agent
- [ ] 各领域 Agent 的权限边界（谁能用哪个 Agent / 哪个环境）
- [x] 是否现在启动 M0（工具分组）：**已启动（2026-09-03）**——tools.ts 全量工具加 `domain` 标注（backend-api/knowledge/common 三类当前有工具落入，finance/customer-service/database 为 M1+ 预留）、提供 `listAgentToolsForDomains` 过滤函数、`toolCatalogByDomain` 注入系统提示按领域呈现候选；实际「按请求裁剪」属 M1 路由层（需环境配置）。
- [x] M1 实现 worker 级模型切换（`preferredModel`）：命中后 understand 优先用该模型；未配则沿用默认（代码已挂钩；默认注册表暂未配具体模型 id）
- [x] **M1 收尾（2026-09-05）**：`systemPrompt` 注入 + `backend-api-…-prod` + `session.activeEnvironment` / `call_api.environment` + `resolveBaseUrl(country×env)` + META 始终可见
- [x] **M1 路由完善（2026-09-05）**：未路由仅 META；自然问法评测 `eval-m1-routing-natural.mjs`（知识库/后台/模糊）实跑通过
- [x] **观影助手 Worker 方案（高优）**：2026-09-05 定稿 [VIEWING_ASSISTANT_AGENT.md](./VIEWING_ASSISTANT_AGENT.md)——Web 先行、不做 App；Worker id=`consumer-viewing`；MVP 必补 + 多语言跟聊；**代码未开工**

---

## 6.1 Trace 透传契约（通用追踪，跨主/子 Agent）

> 适用：M0/M1（Worker 与主 Agent 同进程同图）+ M2/M3（Worker 独立子图/远程 A2A）。
> 目标：让「一次用户请求」的调用栈能贯穿主 Agent → 子 Agent → 工具，形成完整 span 树。

**核心约束**：
1. **runId 由最外层（入口 Supervisor / chatStream）开**，通过 `beginRun` 生成，不依赖 AsyncLocalStorage（已验证 ALS 在 `yield*` 下不跨 await 传播）。
2. **显式透传优先**：主 Agent 的 `LoopState.traceRunId` 已贯穿 understand/tool/final 节点；任何子 Agent 入口（M2/M3 的独立子图或远程 A2A handler）**必须接收 `traceRunId` 参数**，并透传给自己的 `callAgentSafe(... {traceRunId})` 与工具 span，否则子 Agent 内部 LLM 轮次会脱离主 run 树。
3. **parentSpanId 建树**：子 Agent 入口处开一个 `trace.span(runId, "agent", workerId, {parentSpanId: 父spanId})` 作为子树根，子 Agent 内部 llm/tool span 的 `parentSpanId` 指向它 → inspect 脚本可渲染层级。
4. **进程内兜底（仅单并发调试）**：`trace.setCurrentRunId/ getCurrentRunId` 供独立子 Agent 函数退路使用；**多并发生产路径必须显式透传**，不得依赖 currentRunId（会串）。
5. **G2 越权断言可选**：有「执行层越权拒绝」机制的 Agent（如本仓库 M1 worker 白名单）用 `rejectMode:"observe"/"enforce"`；无此机制的 Agent 用 `"off"`（eval-core 的 assertTraceGates 已支持三态）。

**eval-core.mjs 是通用的**：`assertTraceGates` / `summarize` 纯函数，只认 span 通用字段（run/llm/tool/route + usage + status），不认识任何业务词/worker 语义/登录方式。业务项目只需写适配器（login + 触发请求 + 传 runId），红线断言零改动。

---

## 7. 进度记录

| 日期 | 进展 |
|---|---|
| 2026-09-02 | 建立本文档；明确二维划分（领域×环境）；确认单 Agent 现状与演进路径 |
| 2026-09-02 | 盘点 in2 环境配置（6 个 env 文件，含墨西哥）；§4.1 写入文档 |
| 2026-09-02 | 盘点 h5 环境配置（9 个 env 文件含墨西哥，多一套独立 test）；**发现生产=海外公网 HTTPS 域名，与测试完全不同**；§4.1 重写 |
| 2026-09-02 | 用户确认去掉墨西哥地区；§4.1 地区维度收敛为印度/巴西（in2: 4 个 env、h5: 6 个 env），API 表格与核心结论同步移除墨西哥 |
| 2026-09-03 | **M0 落地**：tools.ts 全量 23 个工具加 `domain` 标注（backend-api 15 / knowledge 5 / common 4；finance/customer-service/database 预留）+ `listAgentToolsForDomains` 过滤函数 + `toolCatalogByDomain` 注入 system 前缀；chat.ts buildStaticGuide 消费。实际按请求裁剪留 M1 路由。红线合规（领域为通用分类词，无业务词写死） |
| 2026-09-03 | **M0 提交推送**（commit 81a29b8）+ 新增 `scripts/m0-instance-check.mjs` 实例测试 11/11 通过；同日立项 **M1 可选增强：Worker 级模型切换（preferredModel）**，写入 §3.3/§3.4/§3.8/§5/§6（不推翻「共享模型池」核心设计） |
| 2026-09-03 | **Eval 通用化**：抽 `eval-core.mjs`（assertTraceGates/summarize 纯函数，不依赖登录/cookie/worker/业务词）；`eval-trace-gate.mjs` 退化为 bx-admin-agent 适配器；trace.ts 加 `currentRunId` 进程内兜底（单并发调试）+ `parentSpanId` 建树能力；§6.1 写入「trace 透传契约」（主→子 Agent runId 显式透传 + 黑名单 G2 三态） |
| 2026-09-05 | **观影助手方案定稿（文档 only）**：新增 [VIEWING_ASSISTANT_AGENT.md](./VIEWING_ASSISTANT_AGENT.md)；Worker 清单登记 `consumer-viewing`（高优）；Web 先行 / 不做 App / MVP 必补 / 多语言跟聊；代码未实现 |
| 2026-09-05 | **M1 收尾落地**：① Worker `systemPrompt` 经 `buildStaticGuide` + understand 动态注入；② 注册 `backend-api-bx-film-admin-prod`（`writeConfirmPolicy=always`）；③ `session.activeEnvironment` / `activeWorkerId` 持久化，`route_to_agent` 写入；④ `call_api.environment` + `resolveBaseUrl(country×env)`（prod 读 `COUNTRY_*_PROD_*_URL`）；⑤ 路由后工具菜单 = 白名单 ∪ META_TOOLS；⑥ `m1-instance-check.mjs` 扩覆盖。独立 `[route]` 节点仍不拆（路由仍在 understand⇄tool） |
| 2026-09-05 | **M1 路由完善**：未路由时工具菜单收紧为 **仅 META_TOOLS**（机制强制先 `route_to_agent`，杜绝默认全量绕过）；注入 `[workflow/m1-route]` 引导；`/chat/context/clear` 同步清空 Worker；新增自然问法评测 `eval-m1-routing-natural.mjs` |
