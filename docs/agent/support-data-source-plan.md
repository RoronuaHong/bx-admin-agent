# 客服助手数据源接入方案（订单 / 工单）

> 2026-09-28。目标：把客服助手（`support` 角色）的「查订单、跟工单」从**话术引导**升级为**真取数**。
> 引擎与前端零改动——全部发生在 `.env`（MCP 配置）+ `roles.ts`（角色默认启用）+ 人设（调用约定）三层，
> 对齐领域适配指南第 2 章「模式 B」。
>
> 在线会话（Zoho SalesIQ）不是本文件的订单/工单源。坐席侧查阅与起草见 `support-salesiq-plan.md`。

## 1. 现状与决策

真实订单/工单系统尚无可用凭证，因此**先用示例 MCP 源打通端到端闭环**（工具真调用、写操作真弹确认卡），
后续接真实系统时**只改一条 MCP 配置**，工具契约与角色配置零改动。

| 项 | 内容 |
|---|---|
| 示例源 | `scripts/order-mock-mcp.mjs`（stdio MCP，内存 mock 数据，进程重启即还原；数据显式标注「示例」） |
| 工具契约 | `order_search` / `order_get` / `ticket_list` / `ticket_get`（读）+ `ticket_create`（写） |
| 风险分级 | `.env` `toolRisks`：四个读工具 = `read`（不弹卡）；`ticket_create` = `write`（永远弹确认卡） |
| 启用范围 | 示例源 `orders` 未作为客服角色的默认 MCP。客服新建对话默认启用已经接好的 `zoho-salesiq`（见 `support-salesiq-plan.md`）。本表的订单契约留到真实订单源接入时再用 |
| 人设 | `SUPPORT_BASE_PROMPT`「数据源与调用约定」第 1/2 条：业务数据必须调工具、不猜状态；建工单前说明会弹确认 |

## 2. 接真实系统的三条路线（到时选一，只换配置）

| 路线 | 做法 | 适用 |
|---|---|---|
| A. 业务后端 API → 自建 MCP | 仿 `scripts/metabase-mcp.mjs` 写一个 stdio 适配器，转发后端订单/工单 REST API；凭据放 `.env`（stdio 子进程继承） | 有可用的内部 API 与凭证（最可控，推荐） |
| B. 复用 BI 只读查询 | `bi` 服务器已有 `run_native_query`（只读 SQL 硬校验 + 服务端双层拦截）；订单查询走 SELECT，工单创建走人工通道 | 只要「查」不要「建单」，且订单表已在 BI 库 |
| C. 厂商工单系统自带 MCP | 工单系统（客服云）官方提供 MCP 时直接挂 http/stdio 条目 | 选用的 SaaS 支持 |

切换步骤：① `.env` `MCP_BUILTIN_SERVERS` 里 `orders` 条目改 command/args（或 url）+ 凭据变量；② 视真实工具名在 `tools` 白名单映射或保持同名契约；③ `roles.ts`/人设/前端均不动。**建议真实适配器保持同一组工具名**，人设与验证脚本即可原样复用。

## 3. 边界与红线（沿用既有机制，不新增写死）

- 示例数据全部内存态，带 `note: "示例数据源（mock）"` 标注，模型回复不得冒充真实数据；
- 写操作仅 `ticket_create` 一枚，走服务端确认闸门（超时 = 拒绝，审计留痕 confirm_request/confirm_result）；不改任何真实库；
- 凭据只放服务端 `.env`，前端只见工具名（既有约定）；
- 示例源默认关闭，不进入通用对话的稳定前缀（`defaultEnabled:false` + 仅 support 角色默认启用，prompt cache 不被无关工具污染）。

## 4. 验证记录（2026-09-28，kimi27）

- 查订单：「帮我查订单 1002 的物流」→ `mcp__orders__order_get` → 已签收 + 运单号/时间线；
- 建工单：「订单 1003 有问题帮我建售后工单」→ `ticket_create` 弹确认卡 → 确认后返回新工单号（探针自动 POST /chat/confirm）；
- 不存在单号 → 如实说不存在、不编造（接地护栏与人设双保险）。
