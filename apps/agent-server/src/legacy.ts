import type { ModelEntry } from "./config.js";

// 旧配置兼容：未用 MODEL_PROVIDERS 注册表、仍配了 MODEL_PROVIDER/ANTHROPIC_* 时，
// 合成一个默认模型条目，保证老 .env 无需改动也能用。
export function getModel(): ModelEntry | null {
  const provider = process.env.MODEL_PROVIDER || "";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MODEL_API_KEY || "";
  if (!provider || !apiKey) return null;
  const isOpenai = provider === "openai";
  return {
    id: "default",
    label: process.env.MODEL_NAME || "default",
    provider: isOpenai ? "openai" : "anthropic",
    name: process.env.MODEL_NAME || (isOpenai ? "gpt-4o-mini" : "hy3"),
    baseUrl: isOpenai
      ? process.env.MODEL_BASE_URL || "https://api.openai.com"
      : process.env.ANTHROPIC_BASE_URL || "https://tokenhub.tencentmaas.com",
    apiKey,
    vision: (process.env.MODEL_VISION || "none") as ModelEntry["vision"],
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 120000),
    contextChars: Number(process.env.MODEL_CONTEXT || 16000),
    tools: true,
  };
}