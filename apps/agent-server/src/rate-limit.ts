// 入口限流（agent-infrastructure §5/§13 最小版）：滑动窗口计数，进程内存、单实例。
// 只拦「贵」的入口（/chat/stream）；key = owner cookie（与归属隔离同一身份）。
// 配 0 = 关闭；单机部署够用，多实例时换 Redis 再说。
const windows = new Map<string, number[]>();
let lastGcAt = Date.now();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 被拒时给前端的建议等待秒数（Retry-After）。 */
  retryAfterSec: number;
}

/**
 * 滑动窗口限流：windowMs 内最多 limit 次；超限返回 false 与建议等待秒数。
 * 偶发 GC：每 10 分钟清一次完全过期的 key，防内存缓慢膨胀。
 */
export function hitRateLimit(key: string, limit: number, windowMs = 60_000, now = Date.now()): RateLimitResult {
  if (limit <= 0) return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0 };
  const stamps = (windows.get(key) || []).filter((t) => now - t < windowMs);
  if (stamps.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((stamps[0]! + windowMs - now) / 1000));
    windows.set(key, stamps);
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  stamps.push(now);
  windows.set(key, stamps);
  if (now - lastGcAt > 600_000) {
    lastGcAt = now;
    for (const [k, v] of windows) {
      const alive = v.filter((t) => now - t < windowMs);
      if (alive.length) windows.set(k, alive);
      else windows.delete(k);
    }
  }
  return { allowed: true, remaining: limit - stamps.length, retryAfterSec: 0 };
}

/** 测试用：清空窗口。 */
export function resetRateLimits(): void {
  windows.clear();
}
