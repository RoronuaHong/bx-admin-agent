/**
 * HTTP 速率限制（进程内滑动窗口）—— 防滥用/刷 token。
 *
 * 设计：
 * - 零新依赖；阈值全走 env（RATE_LIMIT_*），0/负数 = 关闭该桶。
 * - 键：登录态用 ownerKey；匿名登录用客户端 IP（x-forwarded-for / x-real-ip）。
 * - 不做 Redis：与现有「单进程任务」部署模型一致；多实例需入口层另限。
 */

export type RateLimitBucket = "chat" | "login";

export interface RateLimitConfig {
  /** /chat/stream 每窗口允许次数；默认 20；≤0 关闭 */
  chatPerMin: number;
  /** /auth/login 每窗口允许次数；默认 30；≤0 关闭 */
  loginPerMin: number;
  /** 窗口毫秒；默认 60000 */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 生效上限（关闭时为 0） */
  limit: number;
  remaining: number;
  /** 建议等待秒数（允许时为 0） */
  retryAfterSec: number;
}

const hits = new Map<string, number[]>();

export function getRateLimitConfig(): RateLimitConfig {
  return {
    chatPerMin: numEnv("RATE_LIMIT_CHAT_PER_MIN", 20),
    loginPerMin: numEnv("RATE_LIMIT_LOGIN_PER_MIN", 30),
    windowMs: Math.max(1000, numEnv("RATE_LIMIT_WINDOW_MS", 60_000)),
  };
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function limitFor(bucket: RateLimitBucket, cfg: RateLimitConfig): number {
  return bucket === "chat" ? cfg.chatPerMin : cfg.loginPerMin;
}

/**
 * 检查并（若允许）记录一次命中。
 * 关闭（limit≤0）时恒允许且不记账。
 */
export function checkRateLimit(opts: {
  bucket: RateLimitBucket;
  key: string;
  now?: number;
  /** 单测注入；缺省读 env */
  limit?: number;
  windowMs?: number;
}): RateLimitResult {
  const cfg = getRateLimitConfig();
  const limit = opts.limit !== undefined ? opts.limit : limitFor(opts.bucket, cfg);
  const windowMs = opts.windowMs !== undefined ? opts.windowMs : cfg.windowMs;
  const now = opts.now ?? Date.now();
  const mapKey = `${opts.bucket}:${opts.key || "unknown"}`;

  if (limit <= 0) {
    return { allowed: true, limit: 0, remaining: 0, retryAfterSec: 0 };
  }

  const cutoff = now - windowMs;
  const prev = (hits.get(mapKey) || []).filter((t) => t > cutoff);

  if (prev.length >= limit) {
    const oldest = prev[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    hits.set(mapKey, prev);
    return { allowed: false, limit, remaining: 0, retryAfterSec };
  }

  prev.push(now);
  hits.set(mapKey, prev);
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - prev.length),
    retryAfterSec: 0,
  };
}

/** 从常见代理头解析客户端 IP（取 x-forwarded-for 第一段）。 */
export function clientIpFromHeaders(headers: {
  get(name: string): string | undefined;
}): string {
  const xff = headers.get("x-forwarded-for") || headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip") || headers.get("X-Real-Ip");
  if (real?.trim()) return real.trim();
  return "unknown";
}

/** 单测用：清空命中记录。 */
export function resetRateLimitState(): void {
  hits.clear();
}
