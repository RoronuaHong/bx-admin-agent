import "./load-env.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertBuiltinRiskCoverage } from "./builtins.js";
import { config, defaultModel, listModels } from "./config.js";
import { listEnabledMcpServers } from "./conversations.js";
import { connect, disconnectAll, startIdleSweeper } from "./mcp/hub.js";

// 启动断言：内置工具漏登记风险级别直接拒绝启动（否则会在运行时静默按「未知」兜底）。
assertBuiltinRiskCoverage();
if ((process.env.SUBAGENT_ALLOW_WRITE || "off").toLowerCase() === "on") {
  console.warn(
    "[安全] SUBAGENT_ALLOW_WRITE=on 已被忽略：子代理确认事件转发尚未实现，放开会让写操作静默挂起到超时。子代理保持只读。",
  );
}

const app = createApp();

// 进程退出前断开全部 MCP 连接（stdio 子进程随之回收）。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void disconnectAll().finally(() => process.exit(0));
  });
}
serve({ fetch: app.fetch, port: config.port }, () => {
  const models = listModels();
  const summary = models.length ? models.map((m) => `${m.id}:${m.provider}/${m.name}`).join(", ") : "(none)";
  console.log(`agent-server http://localhost:${config.port} models=[${summary}]`);
  if (!defaultModel()) {
    console.warn("[警告] 未配置任何模型（MODEL_PROVIDERS），聊天将提示未配置。");
  }
  // 周期回收空闲 MCP 连接（stdio 子进程不常驻），下次用到时自动重连。
  startIdleSweeper();
  // 任意对话启用了的 MCP 服务器：启动后自动重连，否则面板会一直显示"未连接"，与勾选状态矛盾。
  void listEnabledMcpServers().then((ids) => {
    for (const id of ids) void connect(id);
  });
});
