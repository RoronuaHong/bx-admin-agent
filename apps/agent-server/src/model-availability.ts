// 模型可用性分类与冷却表（第 7 批抽出，Jev 纳入治理的前置）。
//
// **为什么抽出来**：这套分类原先长在 chat.ts 里，而客服分类器 Jev（第 7 批）要用同一套
// 「失败属于哪一类 → 冷却多久 → 记哪个状态码」的判据。若 Jev 自己再写一份，两份判据必然漂移
// （与第 1 批把 SQL 只读判定收口到 `sql-readonly-common.mjs` 是同一条纪律：**唯一可信来源**）。
// 反过来让 jev.ts import chat.ts 会成环（chat.ts 调 Jev），所以判据与共享状态都落到这里；
// chat.ts import 后再原样 re-export，既有引用方（app.ts / 既有单测）零改动。
//
// 冷却三档的口径（第 5 批 C2 限流三分层 + 第 1 批 P0-1 日切对齐）都在这里，语义不变：
//   · 每日配额型 429 → 下一个 UTC 日切 + 1min 缓冲（固定小时数会在同一 UTC 日内到期后又重打）
//   · plain 429（分钟级限流）→ 短冷却档（默认 90s）：既不「不冷却」，也不按小时冻
//   · 500 → 一个调度周期；402 / 未开通 / 鉴权 → 小时级
import { modelCooldownPersistenceEnabled, persistModelCooldown } from "./model-cooldown.js";

const QUOTA_COOLDOWN_MS = Number(process.env.MODEL_QUOTA_COOLDOWN_MS || 6 * 60 * 60 * 1000);
const TRANSIENT_COOLDOWN_MS = Number(process.env.MODEL_TRANSIENT_COOLDOWN_MS || 10 * 60 * 1000);

/**
 * 冷却表（进程内共享，键是模型 id；Jev 用 `jev` 这个键）。
 * 不是「对话模型专属」——任何走同一套判据的调用方都往这里写，冷却语义对所有调用方一致。
 */
export const quotaCooldownUntil = new Map<string, number>();
/** 冷却原因的状态码（402 / 429 …）。冷却表只有时刻没有原因；「定时运行跳过冷却 → 名单为空」时要靠它如实告知。 */
export const quotaCooldownStatus = new Map<string, ModelAvailabilityStatus>();

/** UTC 日切后的缓冲：宁可多等一分钟，也不要在边界上再打一次已耗尽的模型。 */
const DAILY_QUOTA_COOLDOWN_PAD_MS = 60_000;

/**
 * 每日配额型失败的冷却时长：**到下一个 UTC 日切 + 缓冲**。
 *
 * 为什么不能用固定小时数：这类配额按 UTC 日重置（当日 00:00 UTC 进入新周期），
 * 固定 6h/10h 的冷却会在同一 UTC 日内先到期，于是每个请求开场都把已耗尽的模型重打一遍
 * —— 2026-10-14 事故就是如此：开场连续 4 个候选 429，每个都付了「探测 + 换模型」的延迟。
 *
 * 覆盖：`MODEL_DAILY_QUOTA_COOLDOWN_MS` 显式给值时按它走（回滚 / 调试 / 自建网关口径不同）。
 */
export function dailyQuotaCooldownMs(
  now = Date.now(),
  override = Number(process.env.MODEL_DAILY_QUOTA_COOLDOWN_MS),
): number {
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const DAY_MS = 86_400_000;
  // +1ms 保证「恰好在日切瞬间」时给到下一个日切，而不是当前这一瞬（长度 0 = 不冷却）。
  const nextUtcMidnight = Math.ceil((now + 1) / DAY_MS) * DAY_MS;
  return nextUtcMidnight - now + DAILY_QUOTA_COOLDOWN_PAD_MS;
}

/**
 * 分钟级限流的冷却时长（调用时读 env：便于单测注入与按部署调整，不回退到模块加载期快照）。
 * 下限 5s——比这更短等于没冷却，调用方会在同一轮里反复撞同一个被限流的模型。
 */
export function rateLimitCooldownMs(): number {
  return Math.max(5_000, Number(process.env.MODEL_RATE_LIMIT_COOLDOWN_MS || 90_000));
}

/** 是否属「额度/未开通」类确定性失败（与 models.ts 的 402 判定同口径，不认厂商）。 */
function isQuotaFailure(failure: string | null): boolean {
  return /401008|402|额度|未开通|余额|quota/i.test(String(failure || ""));
}

/**
 * 当日免费额度用尽的 429。除了立刻换调用方，还要冷却到日切：短时间内再打同一个模型没有意义。
 * 其它 429 走分钟级短冷却档（上面 modelDownCooldownMs 分流），两者互不覆盖。
 */
export function isDailyQuotaFailure(failure: string | null): boolean {
  return /free-models-per-day|freeusagelimit|openrouter_free_tier_daily|free[_ -]?tier.{0,40}daily|当日.{0,12}(额度|限额)|免费额度/i.test(
    String(failure || ""),
  );
}

/** 500 可能是短故障，冷却一个调度周期。402 / 未开通 / 鉴权失败按小时冷却。 */
export function modelDownCooldownMs(failure: string | null, now = Date.now()): number {
  if (/model http 500\b/i.test(String(failure || ""))) return TRANSIENT_COOLDOWN_MS;
  if (isDailyQuotaFailure(failure)) return dailyQuotaCooldownMs(now);
  if (/model http 429\b/i.test(String(failure || ""))) return rateLimitCooldownMs();
  return QUOTA_COOLDOWN_MS;
}

/** 这个模型短时间不会自己好。调用方应冷却并换下一个。 */
export function isModelDownFailure(failure: string | null): boolean {
  // 只认状态码。正文里的「500」不能算（例如 400 的「max 500」），否则健康模型会被冷却。
  // 401 / 403 / 404 是这把钥匙或这个模型用不了，冷却。408 / 413 / 422 / 529 可能是这一次请求的问题，不冷却。
  // 429 也冷却（第 5 批 C2）：分钟级限流几十秒就恢复，短冷却档让压力散开；
  // 每日配额型 429 走日切档（上面 modelDownCooldownMs 分流），两者互不覆盖。
  return (
    isQuotaFailure(failure) ||
    isDailyQuotaFailure(failure) ||
    /model http (401|403|404|429|500)\b/i.test(String(failure || ""))
  );
}

/**
 * 模型接口的可识别状态码。同一模型不再重试，交给下一个候选。
 * 全部候选都失败时，对话和钉钉写这个码，不用笼统的「失败」。
 * 400 参数、401 鉴权、403 无权限、404 模型不存在、408 超时、413 过大、422 无法处理、529 过载，
 * 与 402 / 429 / 5xx 同一条链。各模型可以有自己的钥匙，所以 401 也换下一个，而不是认定整池都失效。
 */
export type ModelAvailabilityStatus =
  | "400"
  | "401"
  | "402"
  | "403"
  | "404"
  | "408"
  | "413"
  | "422"
  | "429"
  | "500"
  | "502"
  | "503"
  | "504"
  | "529";

export function modelAvailabilityStatus(failure: string | null): ModelAvailabilityStatus | null {
  const msg = String(failure || "");
  const http = msg.match(/model http (400|401|402|403|404|408|413|422|429|500|502|503|504|529)\b/i);
  if (http) return http[1] as ModelAvailabilityStatus;
  if (isDailyQuotaFailure(msg)) return "429";
  if (/模型服务暂时不可用/.test(msg)) return "503";
  if (isQuotaFailure(msg)) return "402";
  return null;
}

/** 某个键此刻是否在冷却中（对话模型与 Jev 共用同一张表，判据一致）。 */
export function isCoolingDown(modelId: string, now = Date.now()): boolean {
  return (quotaCooldownUntil.get(modelId) || 0) > now;
}

/** 记一次降级：写冷却表 + best-effort 落盘，返回实际冷却时长与状态码（非降级类失败返回 null）。 */
export function noteDownFailure(
  modelId: string,
  failure: string | null,
  now = Date.now(),
): { coolingMs: number; status: ModelAvailabilityStatus | null } | null {
  if (!isModelDownFailure(failure)) return null;
  const coolingMs = modelDownCooldownMs(failure, now);
  const until = now + coolingMs;
  quotaCooldownUntil.set(modelId, until);
  const status = modelAvailabilityStatus(failure);
  if (status) quotaCooldownStatus.set(modelId, status);
  // 冷却状态落盘（P0-2，best-effort）：重启后第一个请求不再把这个模型从头打一遍。
  // 失败只告警——冷却是优化，不是正确性依赖，绝不能因为它把对话打断。
  if (modelCooldownPersistenceEnabled()) {
    void persistModelCooldown({ modelId, until, ...(status ? { status } : {}), at: now });
  }
  return { coolingMs, status };
}

/** 按「每日配额型」把某个键冷却到 UTC 日切（额度预检判为耗尽时用；与 429 日切档同口径）。 */
export function noteDailyQuotaExhausted(modelId: string, now = Date.now()): number {
  const coolingMs = dailyQuotaCooldownMs(now);
  const until = now + coolingMs;
  quotaCooldownUntil.set(modelId, until);
  quotaCooldownStatus.set(modelId, "429");
  if (modelCooldownPersistenceEnabled()) {
    void persistModelCooldown({ modelId, until, status: "429", at: now });
  }
  return coolingMs;
}