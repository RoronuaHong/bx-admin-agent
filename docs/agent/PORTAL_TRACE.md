# 门户 Trace（多 Agent 共用观测）

> 定稿对齐：`MULTI_AGENT_ARCHITECTURE.md` §可观测 + `PORTAL_SUPERVISOR_AGENT.md`（Trace ≠ 对话子 Agent）。

## 结论

- **Trace 是门户级观测面**，不是后台管理 Agent 的附属页。
- **各对话 Agent 独立鉴权、各自写入** run/span（`meta.agentId`）。
- **查看权限独立**：`/trace/login` 为观察者入口（当前复用运营账密 + `canViewTrace` 白/黑名单），**不**等于「进入后台工作台」。

## 写入

| agentId | 来源 | run name |
| --- | --- | --- |
| `admin` | `/chat` 流（`chatStream` → `beginRun`） | `admin.run` |
| `analytics` | `/analytics/ask`（`analyticsAsk` → `beginRun` + llm/tool span） | `analytics.run` |
| （后续）`knowledge` / `viewing` | 正式对话落地后同样 `beginRun({ agentId })` | `*.run` |

旧 JSONL 无 `agentId` 时，列表侧按 `admin` 兼容。

## 查看

1. 路由：`/trace`（`requiredPortalEntry: trace`），未登录 → **`/trace/login`**（非 `/agents/admin/login`）。
2. 权限：仍用 `resolvePortalPermissions` → `canViewTrace`（`TRACE_ALLOWED_*` / `TRACE_DENIED_*`）。
3. 列表：`GET /trace/runs?agentId=admin|analytics` 可过滤；前端 Tab「全部 / 后台管理 / 问数」。

## 明确不做

- 不用 Trace 登录去开门问数 / 知识库 / 观影。
- 不把 Trace 做成对话子 Agent。
- 知识库 / 观影占位页暂不伪造 trace 写入。
