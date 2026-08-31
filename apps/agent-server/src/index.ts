import "./load-env.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, defaultModel, listModels } from "./config.js";
import { getModel as legacyModel } from "./legacy.js";

const app = createApp();
serve({ fetch: app.fetch, port: config.port }, () => {
  const legacy = legacyModel();
  const models = listModels().length ? listModels() : legacy ? [legacy] : [];
  const summary = models.length ? models.map((m) => `${m.id}:${m.provider}/${m.name}`).join(", ") : "(none)";
  console.log(`agent-server http://localhost:${config.port} mock=${config.mockUpstream} models=[${summary}]`);
  if (!defaultModel() && !legacy) {
    console.warn("[警告] 未配置任何模型（MODEL_PROVIDERS 或 MODEL_PROVIDER/ANTHROPIC_AUTH_TOKEN），聊天将提示未配置。");
  }
});