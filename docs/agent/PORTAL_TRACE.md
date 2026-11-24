> ⚠️ **历史快照 · 与当前代码已脱节**：本文件描述的是已移除的「PC 后台管理 Agent」（`bx-film-admin-in2` 集成：`search_api_module` / `call_api` / `render_table` / `get_list_columns` 等工具）。当前 `apps/agent-server/src` 已重构为通用 **deep-agent 框架**（roles 角色 / 子 Agent 委派 / 虚拟文件系统 / todo 规划 / web 检索 / 钉钉文档 / sql-readonly BI 只读闸 / grounding 接地门禁 / 审计 / 限流 / 异步定时任务）。本文件仅作历史参考，当前架构以 [./CURRENT_ARCHITECTURE.md](./CURRENT_ARCHITECTURE.md) 为准。

# 门户 Trace（多 Agent 共用观测）

> 定稿对齐：`MULTI_AGENT_ARCHITECTURE.md` §可观测 + `PORTAL_SUPERVISOR_AGENT.md`（Trace ≠ 对话子 Agent）。
> **2026-11-23 状态对齐**：文内 `meta.agentId` 多 Agent 写入、`/trace/login` 与 `canViewTrace` 白/黑名单均为历史设计；当前 trace 仅按 ownerKey 过滤，无对应权限投影。

## 结论

- **Trace 是门户级观测面**，不是后台管理 Agent 的附属页。
- ~~**各对话 Agent 独立鉴权、各自写入**~~（历史设计，未落地）：当前 trace 无 `meta.agentId` 多 Agent 写入。
- **查看权限独立（历史设计）**：曾规划 `/trace/login` 为观察者入口（复用运营账密 + `canViewTrace` 白/黑名单，均未落地），**不**等于「进入后台工作台」。

## 写入

| agentId | 来源 | run name |
| --- | --- | --- |
| `admin` | `/chat` 流（`chatStream` → `beginRun`） | `admin.run` |
| `analytics` | `/analytics/ask`（`analyticsAsk` → `beginRun` + llm/tool span） | `analytics.run` |
| （后续）`knowledge` / `viewing` | 正式对话落地后同样 `beginRun({ agentId })` | `*.run` |

旧 JSONL 无 `agentId` 时，列表侧按 `admin` 兼容。

## 查看

1. 路由：`/trace`（`requiredPortalEntry: trace`），未登录 → **`/trace/login`**（非 `/agents/admin/login`）。
2. 权限（历史设计，未落地）：当时规划 `resolvePortalPermissions` → `canViewTrace`（`TRACE_ALLOWED_*` / `TRACE_DENIED_*`）；当前仅按 ownerKey 过滤。
3. 列表：`GET /trace/runs?agentId=admin|analytics` 可过滤；前端 Tab「全部 / 后台管理 / 问数」。

## 明确不做

- 不用 Trace 登录去开门问数 / 知识库 / 观影。
- 不把 Trace 做成对话子 Agent。
- 知识库 / 观影占位页暂不伪造 trace 写入。
