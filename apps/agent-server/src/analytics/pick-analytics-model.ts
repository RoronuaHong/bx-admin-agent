/**
 * Shared analytics LLM model preference (Structure / TurnIntent / pipeline).
 */

import { listModels, type ModelEntry } from "../config.js";

const EOL = /nvstepflash|step-3\.7-flash|stepflash/i;

function isDsFlash(m: ModelEntry): boolean {
  return (
    m.id === "dsflash" ||
    /deepseek[-/]flash/i.test(m.name) ||
    /deepseek[-/]?flash/i.test(m.label)
  );
}

function isGlm5Base(m: ModelEntry): boolean {
  return m.id === "glm5" || /^glm-5$/i.test(m.name) || /^glm-5$/i.test(m.label);
}

function hasKey(m: ModelEntry): boolean {
  return (m.apiKeys?.length || 0) > 0 || Boolean(m.apiKey);
}

/** 可调用模型 = 有 key 且未下线（EOL 模型不再被选中） */
function isUsable(m: ModelEntry): boolean {
  return hasKey(m) && !EOL.test(m.id) && !EOL.test(m.name);
}

/**
 * 候选排序（纯函数）：
 *   1) 显式指定（用户/上游选择）
 *   2) 本进程最近成功过的模型（谁跑通就用谁，可用性自愈）
 *   3) 配置偏好：envDefault → dsflash → glm-5 → glm5turbo → *flash → 其余
 *   4) 冷却中的模型排到最后（仍保留为最后手段，恢复后自动回到前排）
 * 无成功记录时，头部与旧版「单模型选择」完全一致。
 */
export function orderAnalyticsModels(
  models: ModelEntry[],
  opts: {
    modelId?: string;
    envDefault?: string;
    cooling?: ReadonlySet<string>;
    good?: ReadonlyMap<string, number>;
  } = {},
): ModelEntry[] {
  const usable = models.filter(isUsable);
  const taken = new Set<string>();
  const out: ModelEntry[] = [];
  const take = (m: ModelEntry) => {
    if (taken.has(m.id)) return;
    taken.add(m.id);
    out.push(m);
  };

  if (opts.modelId) {
    for (const m of usable) if (m.id === opts.modelId) take(m);
  }
  const good = opts.good;
  if (good?.size) {
    [...usable]
      .filter((m) => good.has(m.id))
      .sort((a, b) => (good.get(b.id) || 0) - (good.get(a.id) || 0))
      .forEach(take);
  }
  const matchers: Array<(m: ModelEntry) => boolean> = [
    (m) => Boolean(opts.envDefault) && m.id === opts.envDefault,
    isDsFlash,
    isGlm5Base,
    (m) => /glm5turbo/i.test(m.id),
    (m) => /flash/i.test(m.id),
    () => true,
  ];
  for (const match of matchers) {
    for (const m of usable) if (match(m)) take(m);
  }

  const cooling = opts.cooling;
  if (!cooling?.size) return out;
  return [...out.filter((m) => !cooling.has(m.id)), ...out.filter((m) => cooling.has(m.id))];
}

// ---- 可用性冷却 + 成功记忆：慢变量自愈，配置无需随模型上下线反复改 ----

const cooldownUntil = new Map<string, number>();
const lastGoodAt = new Map<string, number>();

/** 调用成功：解除冷却并记为「最近可用」（下次优先） */
export function markAnalyticsModelSuccess(id: string, now = Date.now()): void {
  if (!id) return;
  cooldownUntil.delete(id);
  lastGoodAt.set(id, now);
}

export function analyticsModelCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ANALYTICS_MODEL_COOLDOWN_MS || 300000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300000;
}

export function markAnalyticsModelUnavailable(id: string, now = Date.now(), ttlMs?: number): void {
  const ttl = ttlMs ?? analyticsModelCooldownMs();
  if (!id || ttl <= 0) return;
  cooldownUntil.set(id, now + ttl);
}

export function isAnalyticsModelCooling(id: string, now = Date.now()): boolean {
  const until = cooldownUntil.get(id);
  if (!until) return false;
  if (until <= now) {
    cooldownUntil.delete(id);
    return false;
  }
  return true;
}

export function clearAnalyticsModelCooldowns(): void {
  cooldownUntil.clear();
  lastGoodAt.clear();
}

function coolingIds(now = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const id of [...cooldownUntil.keys()]) {
    if (isAnalyticsModelCooling(id, now)) out.add(id);
  }
  return out;
}

/** 全部候选（按优先级）：首选失败时按此顺序换下一个 */
export function listAnalyticsModelCandidates(modelId?: string): ModelEntry[] {
  const models = listModels();
  if (!models.length) return [];
  return orderAnalyticsModels(models, {
    modelId,
    envDefault: (process.env.ANALYTICS_DEFAULT_MODEL || "").trim(),
    cooling: coolingIds(),
    good: new Map(lastGoodAt),
  });
}

/** Prefer ANALYTICS_DEFAULT_MODEL → dsflash → glm-5 → glm5turbo → flash → first usable. */
export function pickAnalyticsModel(modelId?: string): ModelEntry | null {
  return listAnalyticsModelCandidates(modelId)[0] || null;
}
