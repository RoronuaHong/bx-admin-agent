import type { CountryConfig, CountryPublic } from "@bx/shared";

function readCountry(id: string, envKey: string): CountryConfig | null {
  const label = process.env[`COUNTRY_${envKey}_LABEL`] || id;
  const backendUrl = process.env[`COUNTRY_${envKey}_BACKEND_URL`] || "";
  const userUrl = process.env[`COUNTRY_${envKey}_USER_URL`] || "";
  const filmUrl = process.env[`COUNTRY_${envKey}_FILM_URL`] || "";
  const gatherUrl = process.env[`COUNTRY_${envKey}_GATHER_URL`] || "";
  const mock = process.env.MOCK_UPSTREAM === "true";
  if (!mock && !backendUrl) return null;
  return { id, label, backendUrl, userUrl, filmUrl, gatherUrl };
}

export function listCountries(): CountryConfig[] {
  return [
    readCountry("india", "INDIA"),
    readCountry("brazil", "BRAZIL"),
    readCountry("mexico", "MEXICO"),
  ].filter((item): item is CountryConfig => Boolean(item));
}

export function listPublicCountries(): CountryPublic[] {
  return listCountries().map(({ id, label }) => ({ id, label }));
}

export function getCountry(id: string) {
  return listCountries().find((item) => item.id === id);
}

// ---- 模型注册表 ----
// MODEL_PROVIDERS=hy3,ollama 注册模型 id（逗号分隔，第一个为默认）。
// 每个模型的环境变量前缀 MODEL_<ID>_：
//   PROVIDER  anthropic | openai | ollama
//   NAME      模型名（anthropic/openai 必填，ollama 可缺省）
//   BASE_URL  端点地址
//   API_KEY   anthropic/openai 必填
//   VISION    direct | ocr | none（图片处理）
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
  // 上下文能力（字符），MODEL_<ID>_CONTEXT 可声明；auto 模式长内容会优先大上下文模型。
  contextChars: number;
  // 是否支持 function calling（tools + tool_choice）；不支持的模型走纯文本 tool_calls 解析。
  tools: boolean;
  // 是否默认开启思考/推理模式（MODEL_<ID>_THINKING，默认 false）。思考模型（如 TokenHub
  // DeepSeek-V4-Pro）在开启 reasoning 时不允许 tool_choice != auto（实测报 400001）。标记后
  // 请求体显式传 thinking.type=disabled 关闭思考，从而恢复 tool_choice 的 required/auto 语义，
  // 让首轮强制工具调用机制（方案 C）对其完全生效；代价是不再输出 reasoning 思考链（业务 agent
  // 场景无影响，工具调用链另有 reasoning 事件展示）。
  thinking: boolean;
  // 是否具备 agent 能力（MODEL_<ID>_AGENT，默认 true；false = 不进多轮工具循环，走纯问答）。
  // 对齐 Cursor「Agent 模式对模型有硬性要求」：弱模型只开放普通对话，不开放多轮 agent。
  // 当前默认全部开启（zen 免费链下保持现状）；未来强模型可用时可按实测把弱模型标注为 false。
  agentCapable: boolean;
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
      timeoutMs: Number(process.env[`${prefix}TIMEOUT_MS`] || 120000),
      contextChars: Number(process.env[`${prefix}CONTEXT`] || 16000),
      tools: (process.env[`${prefix}TOOLS`] || "true") !== "false",
      thinking: (process.env[`${prefix}THINKING`] || "false") === "true",
      agentCapable: (process.env[`${prefix}AGENT`] || "true") !== "false",
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
  // 惰性读取，确保测试/运行时环境变量在任意时刻生效（避免模块加载期被冻结）。
  get mockUpstream() {
    return process.env.MOCK_UPSTREAM === "true";
  },
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000),
  modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 120000),
  // 本地文档白名单目录（Agent 可读的服务器本地文件目录），空则不启用。
  agentDocsDir: process.env.AGENT_DOCS_DIR || "",
  // 链接抓取限制。
  linkMaxBytes: Number(process.env.LINK_MAX_BYTES || 2 * 1024 * 1024),
  linkTimeoutMs: Number(process.env.LINK_TIMEOUT_MS || 15000),
  // 注入内容截断（字符）。
  contextMaxChars: Number(process.env.CONTEXT_MAX_CHARS || 20000),
  // 兼容旧配置：MODEL_PROVIDER / ANTHROPIC_*（仅当 MODEL_PROVIDERS 未配置时使用）。
  get legacyAnthropic() {
    return (
      (process.env.MODEL_PROVIDERS || "").trim() === "" &&
      (process.env.MODEL_PROVIDER || "") !== "" &&
      Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.MODEL_API_KEY)
    );
  },
  // call_api 工具允许访问的主机白名单（逗号分隔，空则允许所有 http/https，生产环境建议配置）。
  // 示例：ALLOWED_API_HOSTS=localhost:3100,api.internal.example.com
  get allowedApiHosts(): string[] {
    const raw = process.env.ALLOWED_API_HOSTS || "";
    return raw ? raw.split(",").map((h) => h.trim()).filter(Boolean) : [];
  },
  // OCR 转录器：本地 ollama 视觉模型
  visionOllamaUrl: process.env.VISION_OLLAMA_URL || "http://localhost:11434",
  visionOllamaModel: process.env.VISION_OLLAMA_MODEL || "qwen2.5vl",
  // OCR 转录器：远程 OpenAI 兼容视觉端点
  visionBaseUrl: process.env.VISION_BASE_URL || "https://api.openai.com",
  visionApiKey: process.env.VISION_API_KEY || "",
  visionModel: process.env.VISION_MODEL || "gpt-4o-mini",
  // 本 Agent 默认绑定影视后台；会话无 activeProject 时自动补齐，避免反复问「哪个项目」。
  get defaultProject(): { key: string; label: string } {
    return {
      key: (process.env.DEFAULT_PROJECT_KEY || "bx-film-admin").trim(),
      label: (process.env.DEFAULT_PROJECT_LABEL || "影视后台管理系统").trim(),
    };
  },
};