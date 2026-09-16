import "./load-env.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, defaultModel, listModels } from "./config.js";

const app = createApp();
serve({ fetch: app.fetch, port: config.port }, () => {
  const models = listModels();
  const summary = models.length ? models.map((m) => `${m.id}:${m.provider}/${m.name}`).join(", ") : "(none)";
  console.log(`agent-server http://localhost:${config.port} models=[${summary}]`);
  if (!defaultModel()) {
    console.warn("[警告] 未配置任何模型（MODEL_PROVIDERS），聊天将提示未配置。");
  }
});
