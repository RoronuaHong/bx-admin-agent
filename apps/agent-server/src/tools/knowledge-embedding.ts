/**
 * 知识库 Embedding 适配器（OpenAI 兼容 /embeddings）
 * ----------------------------------------------------------------
 * 目标：为 knowledge-base 提供向量化能力，支持语义检索。
 *
 * 设计：
 *  - 协议：OpenAI 兼容 POST {base}/embeddings（TokenHub Kinfra、OpenAI、Ollama 均支持此协议）。
 *  - 配置（环境变量，均可缺省）：
 *      KB_EMBEDDING=on|off          总开关（默认 off，避免无凭证时报错干扰主流程）
 *      KB_EMBEDDING_BASE_URL        端点（默认 https://tokenhub.tencentmaas.com/v1）
 *      KB_EMBEDDING_MODEL           模型名（默认 kinfra-text-embedding-0.6b）
 *      KB_EMBEDDING_API_KEY         API Key（TokenHub 必填；本地 Ollama 可空）
 *      KB_EMBEDDING_DIM             向量维度（默认 1024，用于校验/占位）
 *      KB_EMBEDDING_TIMEOUT_MS      超时（默认 30000）
 *  - 降级：任何失败（未配置/网络错误/限流）都抛错由上层捕获回退词法，绝不阻断对话。
 */
import { config } from "../config.js";

export interface EmbeddingResult {
  vector: number[];
  model: string;
}

/** 读取 embedding 配置（环境变量，惰性读取） */
export function embeddingConfig() {
  const enabled = (process.env.KB_EMBEDDING || "").trim().toLowerCase() === "on";
  return {
    enabled,
    baseUrl: (process.env.KB_EMBEDDING_BASE_URL || "https://tokenhub.tencentmaas.com/v1").replace(/\/+$/, ""),
    model: process.env.KB_EMBEDDING_MODEL || "kinfra-text-embedding-0.6b",
    apiKey: process.env.KB_EMBEDDING_API_KEY || "",
    dim: Number(process.env.KB_EMBEDDING_DIM || 1024),
    timeoutMs: Number(process.env.KB_EMBEDDING_TIMEOUT_MS || 30000),
  };
}

/** 是否启用 embedding */
export function isEmbeddingEnabled(): boolean {
  return embeddingConfig().enabled;
}

/** 将一段文本向量化（单条，失败抛错由上层降级） */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
  const cfg = embeddingConfig();
  if (!cfg.enabled) {
    throw new Error("KB_EMBEDDING 未开启");
  }
  const response = await fetch(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: Array<{ embedding: number[] }>;
  } | null;
  if (!response.ok) {
    const detail = body ? JSON.stringify(body).slice(0, 300) : `http ${response.status}`;
    throw new Error(`embedding http ${response.status}: ${detail}`);
  }
  const vectors = (body?.data || []).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new Error(`embedding 返回数量不匹配（期望 ${texts.length}，实得 ${vectors.length}）`);
  }
  return vectors.map((vector, i) => ({ vector, model: cfg.model }));
}

/** 单个文本向量化（便捷封装） */
export async function embedText(text: string): Promise<EmbeddingResult> {
  const results = await embedTexts([text]);
  return results[0];
}

/** 余弦相似度（[-1,1]，越大越相关） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 归一化向量（单位向量，优化批量余弦比较性能） */
export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (!norm) return vec;
  return vec.map((v) => v / norm);
}

/**
 * 批量生成向量（分批并发，控制 TokenHub 请求体大小与并发）。
 * onBatch 可选回调：报告已处理批次（进度）。
 */
export async function embedTextsBatched(
  texts: string[],
  batchSize = 16,
  concurrency = 4,
  onBatch?: (done: number, total: number) => void,
): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = new Array(texts.length);
  let cursor = 0;
  async function worker() {
    while (cursor < texts.length) {
      const start = cursor;
      const batch = texts.slice(start, start + batchSize);
      cursor = start + batchSize;
      const batchResults = await embedTexts(batch);
      for (let i = 0; i < batch.length; i++) results[start + i] = batchResults[i];
      onBatch?.(cursor, texts.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, Math.ceil(texts.length / batchSize))) }, () => worker()));
  return results;
}

// 兼容导出：模块级复用 config（避免未使用导入告警）
export const _kbConfig = config;
