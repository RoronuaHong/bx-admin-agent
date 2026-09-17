// ---- 模型注册表 ----
// MODEL_PROVIDERS=modelA,modelB 注册模型 id（逗号分隔，第一个为默认）。
// 每个模型的环境变量前缀 MODEL_<ID>_：
//   PROVIDER  anthropic | openai | ollama
//   NAME      模型名（anthropic/openai 必填，ollama 可缺省）
//   BASE_URL  端点地址
//   API_KEY   anthropic/openai 必填
//   VISION    direct | ocr | none（图片处理）
//   CONTEXT_WINDOW  该模型上下文窗口（token），用于推导上下文预算；缺省用全局 MODEL_CONTEXT_WINDOW
export interface ModelEntry {
  id: string;
  label: string;
  provider: "anthropic" | "openai" | "ollama";
  name: string;
  baseUrl: string;
  apiKey: string;
  // 多 key 池：NVIDIA 端点模型共享全局 NVIDIA_API_KEYS；非 NVIDIA 模型退化为单 key。
  // models.ts 发请求时按 round-robin 从池中选 key，遇 429/5xx 自动切下一 key 重试。
  apiKeys: string[];
  vision: "direct" | "ocr" | "none";
  timeoutMs: number;
  /** 上下文窗口（token）。上下文预算由此推导，不再用与模型无关的固定字符数。 */
  contextWindow: number;
}

export function listModels(): ModelEntry[] {
  const ids = (process.env.MODEL_PROVIDERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) return [];
  const entries: ModelEntry[] = [];
  for (const id of ids) {
    const prefix = `MODEL_${id.toUpperCase()}_`;
    const provider = (process.env[`${prefix}PROVIDER`] || "anthropic") as ModelEntry["provider"];
    if (provider !== "anthropic" && provider !== "openai" && provider !== "ollama") continue;
    const defaultBase =
      provider === "ollama"
        ? "http://localhost:11434"
        : provider === "anthropic"
          ? "https://tokenhub.tencentmaas.com"
          : "https://api.openai.com";
    const vision = (process.env[`${prefix}VISION`] || "none") as ModelEntry["vision"];
    if (vision !== "direct" && vision !== "ocr" && vision !== "none") continue;
    const baseUrl = process.env[`${prefix}BASE_URL`] || defaultBase;
    const singleKey = (process.env[`${prefix}API_KEY`] || "").trim();
    // NVIDIA 端点模型共享全局 key 池（绕开单 key 限流）；非 NVIDIA 模型退化用各自单 key。
    const sharedPool = (process.env.NVIDIA_API_KEYS || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const isNvidia = baseUrl.includes("integrate.api.nvidia.com");
    const keys = isNvidia && sharedPool.length ? sharedPool : singleKey ? [singleKey] : [];
    entries.push({
      id,
      label: process.env[`${prefix}LABEL`] || id,
      provider,
      name: process.env[`${prefix}NAME`] || "",
      baseUrl,
      apiKey: keys[0] || "",
      apiKeys: keys,
      vision,
      timeoutMs: Number(process.env[`${prefix}TIMEOUT_MS`] || process.env.MODEL_TIMEOUT_MS || 120000),
      contextWindow: Number(
        process.env[`${prefix}CONTEXT_WINDOW`] || process.env.MODEL_CONTEXT_WINDOW || 128000,
      ),
    });
  }
  return entries;
}

export function getModel(id?: string | null): ModelEntry | null {
  if (!id) return null;
  return listModels().find((item) => item.id === id) || null;
}

// 默认模型 = 注册表第一个。
export function defaultModel(): ModelEntry | null {
  return listModels()[0] || null;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:5173",
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000),
  /** 单次回复输出上限（token）。上下文预算会为它预留空间，故必须与实际请求值一致。 */
  maxOutputTokens: Number(process.env.MODEL_MAX_OUTPUT_TOKENS || 8192),
};
