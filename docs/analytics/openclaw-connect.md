# Connect OpenClaw (小龙虾) to Analytics M1

> **Design reference:** [Metabase 数据分析 Agent 设计 §4.2](../superpowers/specs/2026-09-09-metabase-analytics-agent-design.md#42-与小龙虾openclaw的接入关系可选通道非替代主产品) — OpenClaw 可选接入通道、facade 边界与 `tools.allow` 隔离要求。

## Operator steps

1. **Ensure `agent-server` `/mcp` exposes `analytics_ask`.**  
   Start agent-server (default `PORT=8787`). Confirm the tool is listed on the MCP endpoint, e.g. `http://127.0.0.1:8787/mcp` (Streamable HTTP; localhost-only).

2. **Register the MCP server in OpenClaw.**

   ```bash
   openclaw mcp add analytics --url http://127.0.0.1:8787/mcp
   ```

   Use your deployed agent-server URL if not running locally. See [OpenClaw MCP](https://docs.openclaw.ai/cli/mcp).

3. **Restrict the analytics agent tool allowlist.**

   ```json
   "tools.allow": ["analytics_ask"]
   ```

   Do **not** mix `call_api` or other backend write tools — analytics must go through this facade only (design §4.2.3).

4. **Smoke test in an OpenClaw session.**

   Ask in natural language:

   > 八月二十到二十一印度A按天人数

   Expect a table/summary from the full P0 pipeline (time resolve → SQL → verify → Metabase), not a raw SQL guess.
