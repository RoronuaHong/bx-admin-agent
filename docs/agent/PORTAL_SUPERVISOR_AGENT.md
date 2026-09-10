# 门户总 Agent 分发 + 子 Agent 独立鉴权（定稿建议）

> **状态**：设计定稿（按产品确认的建议写入；**待实现**）  
> **日期**：2026-09-10  
> **关联**：[`MULTI_AGENT_ARCHITECTURE.md`](./MULTI_AGENT_ARCHITECTURE.md)（进程内 Supervisor + Worker）；[`A2A_INTEGRATION.md`](./A2A_INTEGRATION.md)（跨进程远程子 Agent，挂阶段 C）；问数设计见 [`../superpowers/specs/2026-09-09-metabase-analytics-agent-design.md`](../superpowers/specs/2026-09-09-metabase-analytics-agent-design.md)  
> **产品目标**：门户点进去先进入**总 Agent**，由总 Agent **分发**到各子 Agent；**每个子 Agent 鉴权相互独立，禁止共用后台运营账密冒充。**

---

## 1. 已拍板决策（2026-09-10）

| # | 决策 | 取值 |
|---|---|---|
| D1 | 总 Agent 是否自带登录 | **阶段 A 不要**（只做路由台）。可选后续加「门户轻身份」（只记是谁，不含子域密码） |
| D2 | 有子域凭证时，结果展示在哪 | **默认总 Agent 气泡内展示**，并标注来源（如「来自：数据分析」）；提供「在子 Agent 中打开」深链 |
| D3 | 问数现阶段凭证 | **可分发调用**；凭证策略 = **暂可匿名或后续独立登录**；**永远不走后台运营账密**。Metabase 仍服务端服务账号代查 |
| D4 | 子 Agent 独立入口 | **保留**（`/analytics`、`/agents/admin/chat`、知识库/观影等可直达）；总 Agent 是默认总台，不是唯一入口 |
| D5 | 统一什么 / 不统一什么 | **统一**：门户入口、ChatShell 聊天框、分发协议与来源标注。**不统一**：账号密码、Cookie/session、登录页 |

---

## 2. 两层架构（必须分清）

```text
┌─────────────────────────────────────────────────────────────┐
│ 产品层（本文）                                                │
│  门户 → 总 Agent（路由台）→ 分发 → 子 Agent（独立鉴权）        │
│  UI：统一 ChatShell；会话按 Agent 隔离                        │
└─────────────────────────────────────────────────────────────┘
                              │ 调用
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 运行时层（MULTI_AGENT_ARCHITECTURE.md，已有 M1）               │
│  后台会话内：route_to_agent → WorkerDef 装配工具/提示/环境     │
│  Worker ≠ 独立进程；与「门户总 Agent」不是同一概念              │
└─────────────────────────────────────────────────────────────┘
```

- **门户总 Agent**：面向用户的「总台」产品入口与分发编排。  
- **后台内 Worker**：同一运营会话里的领域上下文裁剪（`backend-api` / `knowledge` / `analytics-bi` 等）。  
- 二者可衔接：总 Agent 分发到「后台子 Agent」后，后台会话内仍可再 `route_to_agent` 切 Worker；**不得**因此把运营 session 借给问数/知识库/观影。

---

## 3. 目标用户路径

```text
用户打开门户
  → 默认进入 /agents/home（总 Agent，ChatShell）
  → 自然语言提问
  → 总 Agent 路由判定 targetAgent（analytics | admin | knowledge | viewing | …）
  → 查 AgentCredentialStore[portalIdentity × targetAgent]
       ├─ 允许调用（有绑定 / 或该域策略为 anonymous）
       │     → 同页接力：调该域门面 API / Worker
       │     → 结果写回总 Agent 气泡（带来源标签）
       │     → 可选：「在子 Agent 打开」→ 子页 + 深链 q/from/to
       └─ 缺凭证
             → 引导该子 Agent 独立登录页（带 next + retryPayload）
             → 登录成功写回绑定
             → 自动重试原问题（仍回总 Agent 气泡，除非用户选择留在子页）
```

---

## 4. 鉴权模型（按域保险箱）

### 4.1 概念

| 概念 | 说明 |
|---|---|
| `portalIdentity` | 总台侧「是谁」。阶段 A 可为匿名设备态 / 本地 id；阶段 B 可为门户轻登录。**不含**子域密码 |
| `agentId` | `admin` \| `analytics` \| `knowledge` \| `viewing` \| … |
| `agentCredential[agentId]` | 该身份在该子 Agent 上的登录态（cookie 名、token、过期时间、authMode） |
| `authMode` | `none`（暂匿名可调）\| `session`（独立登录）\| `service`（仅服务端代查，用户无密码，如问数 Metabase） |

### 4.2 硬约束

1. **禁止**用 `admin` 运营 session 调用 `analytics` / `knowledge` / `viewing` 门面作为「已登录依据」。  
2. **禁止**单一 Cookie 通吃所有 Agent。  
3. 缺凭证时只提示**该域**重新登录，不影响其它域绑定。  
4. Trace 仍为门户观测能力，走既有 `canViewTrace`；不是对话子 Agent。

### 4.3 各子域默认策略（阶段 A）

| agentId | authMode（A） | 登录入口 | 分发调用 |
|---|---|---|---|
| `analytics` | `none`（可后续改为 `session`）+ 服务端 Metabase `service` | 暂无；未来 `/analytics/login` | `POST /analytics/ask` 等 |
| `admin` | `session` | `/agents/admin/login` | 既有 `/chat/stream` 或受限只读门面（A 可先「切页接力」） |
| `knowledge` | `none` 占位（不可真调） | 未来独立登录 | 未接线：返回「尚未接入」 |
| `viewing` | `none` 占位（不可真调） | 未来独立登录 | 未接线：返回「尚未接入」 |

---

## 5. 分发协议（逻辑契约）

```ts
/** 总 Agent → 子域 的一次分发请求（逻辑模型；实现时可 JSON） */
type DispatchRequest = {
  utterance: string;
  targetAgent: "admin" | "analytics" | "knowledge" | "viewing";
  /** 路由置信不足时先反问，禁止硬猜 */
  routeConfidence?: "high" | "low";
  /** 缺凭证登录回来后的重试载荷 id */
  retryId?: string;
};

type DispatchResult =
  | {
      kind: "ok";
      sourceAgent: DispatchRequest["targetAgent"];
      /** 展示在总 Agent 气泡 */
      message: string;
      tables?: unknown[];
      deepLink?: string; // 如 /analytics?q=...
    }
  | {
      kind: "auth_required";
      sourceAgent: DispatchRequest["targetAgent"];
      loginPath: string; // 该子域登录页 + next + retryId
    }
  | {
      kind: "unavailable";
      sourceAgent: DispatchRequest["targetAgent"];
      reason: string; // 占位未接线等
    }
  | {
      kind: "clarify";
      question: string; // 一次只问一个槽位
    };
```

路由红线：与章程一致——**禁止业务词形硬编码路由**；用模型工具通道（可复用/扩展 `route_to_agent` 语义到门户总台），不确定则 `clarify`。

---

## 6. 分发形态（可并存）

| 形态 | 何时用 | 行为 |
|---|---|---|
| **同页接力** | 有权调用且适合短答（尤其问数表结果） | 总 Agent 气泡展示结果 + 来源标签 |
| **切页接力** | 缺凭证需登录；或用户点「在子 Agent 打开」；或后台需要完整工具/多 Tab 工作台 | `router.push` 子 Agent 路径，带 `q` / `next` / `retryId` |

阶段 A 建议：

- **analytics**：优先同页接力（`analytics/ask`）。  
- **admin**：优先切页接力到 `/agents/admin/chat`（避免在总台重造整套工具流）；登录态已有则深链带上问题预填。  
- **knowledge / viewing**：`unavailable` 文案 + 链到占位 ChatShell 页。

---

## 7. 前端信息架构

| 路由 | 角色 |
|---|---|
| `/` | 门户卡片（保留）；CTA「进入总台」为主，各子 Agent 仍可直达 |
| `/agents/home`（新建） | **总 Agent**（默认从门户进入） |
| `/analytics` | 问数子 Agent（可直达） |
| `/agents/admin/chat` | 后台子 Agent |
| `/agents/knowledge` · `/agents/viewing` | 占位子 Agent |
| `/agents/admin/login` | **仅**后台子域登录（文案已标明不与其它域混用） |
| `/trace/login` | **Trace 观察者**登录（复用运营账密 API，不进工作台） |
| `/trace` | 门户观测（多 Agent run，`agentId` 过滤）；非对话子 Agent |

统一 UI：全部对话面使用既有 `ChatShell`（与 2026-09-10 门户壳统一一致）。

---

## 8. 落地阶段

### 阶段 A（优先实现）— 总 Agent 壳 + 硬分发

1. 新增 `/agents/home` 总 Agent 页（ChatShell）。  
2. 门户主 CTA / 默认路径指向总台（子卡仍可直达）。  
3. 实现分发：路由 → analytics 同页接力；admin 切页；knowledge/viewing 占位不可用提示。  
4. **不建**总 Agent 登录；问数保持可匿名调用；**不**用 admin session 给问数开门。  
5. 气泡带来源标签 + 「在子 Agent 打开」。  
6. 更新本文件验收清单勾选。

### 阶段 B — AgentCredentialStore

1. 按 `portalIdentity × agentId` 持久化绑定（分域加密，仅存 token/session 元数据）。  
2. 各子域独立登录页回写绑定；过期只失效该域。  
3. 问数若改为 `session`，新增 `/analytics/login`，与 admin 登录完全分离。

### 阶段 C — 真子图 / 远程子 Agent

1. 对接 MULTI_AGENT **M2** 子图与 **M3** / A2A remote worker。  
2. 跨进程必须显式传 `traceRunId` + **该域凭证**；禁止总台 cookie 顶替。  
3. 见 `A2A_INTEGRATION.md` 语义 B。

---

## 9. 明确不做什么

- 不用后台运营账密统一登录所有 Agent。  
- 不取消子 Agent 独立入口。  
- 不在阶段 A 实现完整凭证保险箱与门户强制登录。  
- 不把 Trace 做成对话子 Agent。  
- 不把「门户总 Agent」与「后台内 Worker」两个概念写成同一个东西。

---

## 10. 与现有实现的衔接

| 已有 | 用法 |
|---|---|
| `ChatShell.vue` | 总台与各子页统一聊天框 |
| `route_to_agent` + `WorkerDef` | 后台子会话内二次路由；总台路由可复用同类工具语义 |
| `POST /analytics/ask` | 总台同页接力问数 |
| `/agents/admin/login?next=` | 仅 admin 缺凭证；`guestRedirectAuth` 须尊重 `next` |
| 门户 `PORTAL_CARDS` | 增加/调整「总 Agent」主入口；子卡保留直达 |

---

## 11. 阶段 A 验收清单（实现时勾选）

- [ ] `/agents/home` 可打开，ChatShell 与其它 Agent 同框  
- [ ] 门户可一键进总台；子 Agent 仍可直达  
- [ ] 问数类问题可在总台同页出表，气泡标「来自：数据分析」  
- [ ] 后台类问题引导/切到 admin（需登录走 admin 登录，不混问数）  
- [ ] 知识库/观影返回尚未接入，不伪造可问  
- [ ] 任意路径均无「用 admin cookie 调用 analytics 鉴权」  
- [ ] 本文 D1–D5 与阶段划分未在实现中被静默改写  

---

## 12. 进度

| 日期 | 事项 |
|---|---|
| 2026-09-10 | 产品确认建议方案；本文落盘为定稿建议；**代码未开工** |
