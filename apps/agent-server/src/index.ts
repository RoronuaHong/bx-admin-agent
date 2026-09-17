import "./load-env.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, defaultModel, listModels } from "./config.js";
import { listEnabledMcpServers } from "./conversations.js";
import { connect, disconnectAll } from "./mcp/hub.js";

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
  // 任意对话启用了的 MCP 服务器：启动后自动重连，否则面板会一直显示"未连接"，与勾选状态矛盾。
  void listEnabledMcpServers().then((ids) => {
    for (const id of ids) void connect(id);
  });
});
