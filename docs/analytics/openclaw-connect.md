# 将 OpenClaw（小龙虾）接入 Analytics M1

> **设计参考：** [Metabase 数据分析 Agent 设计 §4.2](../superpowers/specs/2026-09-09-metabase-analytics-agent-design.md#42-与小龙虾openclaw的接入关系可选通道非替代主产品) — OpenClaw 为可选接入通道；须遵守门面边界与 `tools.allow` 隔离要求。

## 运维步骤

1. **确认 `agent-server` 的 `/mcp` 已暴露 `analytics_ask`。**  
   启动 agent-server（默认 `PORT=8787`）。在 MCP 端点确认工具已列出，例如 `http://127.0.0.1:8787/mcp`（Streamable HTTP；仅本机）。

2. **在 OpenClaw 中注册该 MCP 服务。**

   ```bash
   openclaw mcp add analytics --url http://127.0.0.1:8787/mcp
   ```

   非本机部署时换成实际 agent-server URL。参见 [OpenClaw MCP](https://docs.openclaw.ai/cli/mcp)。

3. **收紧 analytics Agent 的工具白名单。**

   ```json
   "tools.allow": ["analytics_ask"]
   ```

   **不要**混入 `call_api` 或其他后台写工具 — 取数必须只走本门面（设计 §4.2.3）。

4. **在 OpenClaw 会话中冒烟验证。**

   用自然语言提问：

   > 八月二十到二十一印度A按天人数

   期望得到完整 P0 流水线结果（时间解析 → SQL → Verify → Metabase）的表格/摘要，而不是模型直接猜的裸 SQL。

## 仓内就绪（2026-09-10）

- `analytics_ask` 已在 agent-server `/mcp` 注册（`apps/agent-server/src/mcp.ts`）。
- 本机需已安装 OpenClaw CLI 并按上文注册 MCP；**无 OpenClaw 时不算产品缺口**，HTTP `POST /analytics/ask` 与 Web `/analytics` 仍是主入口。