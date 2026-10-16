// 模型额度预检（第 5 批 C4，对标 OpenRouter《Limits》「长任务开始前查剩余额度；非紧急请求排到下一个 UTC 日」）。
//
// 事故形态：候选链开场把 4 个当日免费额度已耗尽的模型各打一遍，每个都付「探测 + 429 + 切换」的延迟。
// 冷却表（P0-1 日切对齐 / P0-2 跨重启持久化）解决「同一个 UTC 日内不重打」，但**进程冷启动后的
// 第一个请求**仍要重新撞一遍——预检在排候选之前问一次密钥额度端点，把已耗尽的候选直接按
// 「每日配额型」冷却到 UTC 日切：交互式只是排到队尾（fail-open），无人值守整体跳过（排到下一个 UTC 日）。
//
// 设计取舍（诚实优先）：
// - **只对声明了额度端点的提供商生效**（默认 openrouter.ai，可用 MODEL_QUOTA_PREFLIGHT_HOSTS 增删主机子串）：
//   端点路径是提供商自有契约（OpenRouter：GET /api/v1/key），不猜不泛化；换提供商要么加主机要么关开关。
// - **best-effort + fail-open**：3s 超时、解析失败、网络不通一律当「没查」（不冷却、不阻断）——
//   预检是优化，不是正确性依赖，绝不能因为它把对话打断。
// - **按密钥聚合 + TTL 缓存 + 单飞**：免费日额度是**密钥级**的（不是模型级），同一密钥一次查询
//   回答所有候选；缓存默认 60s，防止每个请求都去打端点。
// - 判定只用 `remaining <= 0 && limit > 0`：没有分母（limit 缺失）时绝不判耗尽——那会把
//   「字段变了」误读成「额度没了」，把健康模型全部冷却掉。
import type { ModelEntry } from "./config.js";

/** 密钥当日免费额度快照（OpenRouter /api/v1/key 实测形状）。 */
export interface KeyQuota {
  used: number;
  limit: number;
  remaining: number;
}

/** 预检开关：`MODEL_QUOTA_PREFLIGHT=off` 整体关闭（回滚口）。 */
export function quotaPreflightEnabled(): boolean {
  return (process.env.MODEL_QUOTA_PREFLIGHT || "on").trim().toLowerCase() !== "off";
}

/** 生效主机子串（默认只认 OpenRouter——它的 /api/v1/key 是唯一已验证的契约）。 */
export function quotaPreflightHosts(): string[] {
  return (process.env.MODEL_QUOTA_PREFLIGHT_HOSTS || "openrouter.ai")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 纯函数：从 `/api/v1/key` 响应里取免费日额度。
 * 实测形状（2026-10-14 探测）：`{ data: { free_model_daily_requests: { used, limit, remaining } } }`。
 * 字段缺失/类型不对返回 null（fail-open：不判定）。
 */
export function parseKeyQuota(payload: unknown): KeyQuota | null {
  const data = (payload as { data?: unknown } | null | undefined)?.data as
    | { free_model_daily_requests?: { used?: unknown; limit?: unknown; remaining?: unknown } }
    | undefined;
  const quota = data?.free_model_daily_requests;
  if (!quota || typeof quota.remaining !== "number" || typeof quota.limit !== "number") return null;
  return {
    used: typeof quota.used === "number" ? quota.used : 0,
    limit: quota.limit,
    remaining: quota.remaining,
  };
}

/** 纯函数：是否已耗尽。limit 未知（<=0）时不判——没有分母的百分比没有意义。 */
export function quotaExhausted(quota: KeyQuota | null): boolean {
  return quota !== null && quota.limit > 0 && quota.remaining <= 0;
}

const CACHE_TTL_MS = Math.max(0, Number(process.env.MODEL_QUOTA_PREFLIGHT_CACHE_MS || 60_000));
const PREFLIGHT_TIMEOUT_MS = Math.max(500, Number(process.env.MODEL_QUOTA_PREFLIGHT_TIMEOUT_MS || 3000));

/** 查询结果缓存：key = origin|密钥指纹；null = 查过但不可用（同样缓存，防止每请求都打一个死端点）。 */
const cache = new Map<string, { at: number; quota: KeyQuota | null }>();
/** 单飞：同一密钥的并发查询合并成一次。 */
const inflight = new Map<string, Promise<KeyQuota | null>>();

function cacheKeyOf(baseUrl: string, apiKey: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!quotaPreflightHosts().some((host) => url.hostname.toLowerCase().includes(host))) return null;
    let hash = 0;
    for (let i = 0; i < apiKey.length; i += 1) hash = (hash * 31 + apiKey.charCodeAt(i)) | 0;
    return `${url.origin}|${hash}`;
  } catch {
    return null; // baseUrl 不是合法 URL：不猜，直接不预检
  }
}

/** 查一个密钥的当日免费额度（TTL 缓存 + 单飞 + 超时；任何失败都返回 null = 不判定）。 */
export async function preflightKeyQuota(baseUrl: string, apiKey: string): Promise<KeyQuota | null> {
  const key = cacheKeyOf(baseUrl, apiKey);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.quota;
  const running = inflight.get(key);
  if (running) return running;
  const task = (async (): Promise<KeyQuota | null> => {
    try {
      const url = new URL(baseUrl);
      const res = await fetch(`${url.origin}/api/v1/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const quota = parseKeyQuota(await res.json().catch(() => null));
      cache.set(key, { at: Date.now(), quota });
      return quota;
    } catch {
      // 失败也按 TTL 缓存「不可用」：端点不通时不让每个请求都去撞一次 3s 超时。
      cache.set(key, { at: Date.now(), quota: null });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/**
 * 预检目标（结构化最小集）：对话模型的 `ModelEntry` 与 Jev 这类「独立调用方」都满足它，
 * 于是额度预检不需要知道调用方是谁——同一把密钥的日额度是**密钥级**的，一次查询回答所有调用方。
 */
export interface QuotaTarget {
  id: string;
  baseUrl: string;
  apiKey: string;
}

/** 该 baseUrl 是否落在预检主机白名单内（不落白名单 = 不预检，直接返回 false）。 */
export function quotaPreflightApplies(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return quotaPreflightHosts().some((host) => url.hostname.toLowerCase().includes(host));
  } catch {
    return false;
  }
}

/**
 * 批量预检：返回「当日免费额度已耗尽」的 id 集合（best-effort，查不了就空集 = 不改变候选链）。
 * 同一密钥只查一次（额度是密钥级的），不同密钥并行。
 */
export async function findExhaustedQuotaTargets(models: readonly QuotaTarget[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!quotaPreflightEnabled() || !models.length) return out;
  const byKey = new Map<string, QuotaTarget[]>();
  for (const model of models) {
    if (!model.apiKey) continue;
    const key = cacheKeyOf(model.baseUrl, model.apiKey);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) || []), model]);
  }
  await Promise.all(
    [...byKey.entries()].map(async ([, group]) => {
      const first = group[0]!;
      const quota = await preflightKeyQuota(first.baseUrl, first.apiKey);
      if (!quotaExhausted(quota)) return;
      for (const model of group) out.add(model.id);
    }),
  );
  return out;
}

/** 兼容旧名（对话模型侧按 ModelEntry 调用，语义相同）。 */
export const findExhaustedQuotaModels = findExhaustedQuotaTargets;

/** 仅供测试：清空缓存与在途查询（避免用例之间互相命中）。 */
export function resetQuotaPreflightForTest(): void {
  cache.clear();
  inflight.clear();
}
