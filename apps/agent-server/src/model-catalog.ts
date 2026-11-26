// 运行时模型目录发现 + 「全挂后重检」。
//
// 解决什么：模型名单静态来自 env（config.ts 的 listModels），免费模型却随时上架 / 下架 / 转付费；
// 候选链把 402 / 404 的模型冷却后，一个 UTC 日内不会重打——但额度可能在日切前回充、下架模型可能
// 重新上架。本模块在「所有候选都失败」之后被调用，做两件事：
//   ① 强制刷新额度预检缓存（/api/v1/key）：确认当日免费额度已回充的，清掉 402 冷却；
//   ② 拉 OpenRouter 目录（/api/v1/models）：新上架的免费模型动态补进候选，已下架 / 转付费的冷却；
// 结果合并后由 chat.ts 重排候选再跑一轮（只跑一次，避免死循环）。
//
// 设计纪律：fail-open——目录 / 额度端点任何失败都返回「无变化」，绝不因为重检本身把对话打断；
// 只认 OpenRouter 端点（其它网关的目录形状未经验证，不猜）；发现模型的凭据复用同 host 的已注册模型。
import type { ModelEntry } from "./config.js";
import {
  clearModelCooldown,
  noteDailyQuotaExhausted,
  noteDownFailure,
  quotaCooldownStatus,
} from "./model-availability.js";
import {
  invalidateQuotaPreflightCache,
  preflightKeyQuota,
  quotaExhausted,
} from "./model-quota.js";

/** 目录里一个可免费调用的模型（只收 chat 端点：`:free` 后缀或 openrouter/free 聚合路由）。 */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextLength: number;
}

/** 本次重检的结果；`changed` 表示候选名单确实变了（值得再跑一轮）。 */
export interface ModelRecheckResult {
  models: ModelEntry[];
  /** 因额度回充 / 重新上架而清除冷却的模型 id。 */
  recovered: string[];
  /** 已被目录移除或转付费、本次新冷却的模型 id。 */
  delisted: string[];
  /** 目录里新发现、动态补进候选的模型 id（注册表 id）。 */
  added: string[];
}

const EMPTY: ModelRecheckResult = { models: [], recovered: [], delisted: [], added: [] };

/** 重检总开关：`MODEL_CATALOG_DISCOVERY=off` 回滚到「静态名单 + 日切冷却」的旧行为。 */
export function catalogDiscoveryEnabled(): boolean {
  return (process.env.MODEL_CATALOG_DISCOVERY || "on").trim().toLowerCase() !== "off";
}

function timeoutMs(): number {
  return Math.max(500, Number(process.env.MODEL_CATALOG_TIMEOUT_MS || 3000));
}

/**
 * 只认 OpenRouter 端点：目录与 /api/v1/key 的形状都是它自己的契约，不泛化到别的网关。
 * HOSTS 可覆盖（测试用本地 mock、自建同款网关）：默认 openrouter.ai，与额度预检的主机开关同风格。
 */
export function catalogHosts(): string[] {
  return (process.env.MODEL_CATALOG_HOSTS || "openrouter.ai")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return catalogHosts().some((part) => host.includes(part));
  } catch {
    return false;
  }
}

/** 与 chat.ts 的 isFreeTierModel 同口径（不 import 它以免 chat ↔ catalog 成环）。 */
export function looksFreeTier(model: Pick<ModelEntry, "id" | "name" | "label">): boolean {
  const blob = `${model.id}\n${model.name || ""}\n${model.label || ""}`;
  return blob.includes("免费") || /:free\b|\/free\b|-free\b|\bfree\b/i.test(blob);
}

/**
 * 纯函数：解析 OpenRouter 目录响应，只留 token 单价为 0 的 chat 模型。
 * 价格字段在 API 里是字符串；用 Number 比较容忍数字形态，但 null / 缺失一律不当免费。
 */
export function parseOpenRouterCatalog(payload: unknown): DiscoveredModel[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: DiscoveredModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    // 排除生图 / 生音等「token 免费但按次收费」的端点：它们没有 :free 后缀，也不是 chat 模型。
    if (!/(:free$|^openrouter\/free$)/i.test(id)) continue;
    const prompt = item.pricing?.prompt;
    const completion = item.pricing?.completion;
    if (prompt == null || completion == null) continue;
    if (Number(prompt) !== 0 || Number(completion) !== 0) continue;
    const len = Number(item.context_length);
    out.push({
      id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      contextLength: Number.isFinite(len) && len > 0 ? Math.floor(len) : 128000,
    });
  }
  return out;
}

let inflight: Promise<DiscoveredModel[]> | null = null;

/** 拉一次目录；失败 / 非 200 / 形状不对都返回空数组（fail-open）。并发请求合并成一次。 */
export function fetchOpenRouterCatalog(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const origin = new URL(baseUrl).origin;
      const res = await fetch(`${origin}/api/v1/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs()),
      });
      if (!res.ok) return [];
      return parseOpenRouterCatalog(await res.json().catch(() => null));
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 仅供测试：清掉在途查询引用（不取消请求本身）。 */
export function resetCatalogForTest(): void {
  inflight = null;
}

/**
 * 从已注册模型里挑一个 OpenRouter 端点作模板，用它自己的凭据调用目录 / 额度端点。
 * 不新造密钥、不猜端点——没有可用模板时重检直接 no-op。
 */
function openRouterTemplate(models: readonly ModelEntry[]): ModelEntry | null {
  return models.find((m) => isOpenRouterBaseUrl(m.baseUrl) && m.apiKey) || null;
}

/** 用目录模型 id 拼一个不冲突的注册表 id。 */
function registeredIdOf(catalogId: string, used: ReadonlySet<string>): string {
  const slug = catalogId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  let id = `orcat_${slug}`;
  for (let i = 2; used.has(id); i += 1) id = `orcat_${slug}_${i}`;
  return id;
}

/** 目录里发现的新模型 → 可调用的 ModelEntry（凭据、超时、协议全部沿用模板）。 */
function synthesize(model: DiscoveredModel, template: ModelEntry, used: ReadonlySet<string>): ModelEntry {
  return {
    id: registeredIdOf(model.id, used),
    label: `${model.name || model.id} (OR免费·动态发现)`,
    provider: template.provider,
    name: model.id,
    baseUrl: template.baseUrl,
    apiKey: template.apiKey,
    apiKeys: [...template.apiKeys],
    vision: "none",
    timeoutMs: template.timeoutMs,
    contextWindow: model.contextLength,
    disableThinking: template.disableThinking,
  };
}

/**
 * 全挂后的重检主入口（best-effort，任何一步失败都返回无变化的名单）。
 *
 * 顺序：① 作废额度缓存 → 查每个密钥的当日免费额度 → 回充的清 402 冷却；
 *      ② 拉目录 → 重新上架的清 404 冷却、下架 / 转付费的按 404 冷却、新模型合成进名单。
 */
export async function recheckModelAvailability(
  registered: readonly ModelEntry[],
  signal?: AbortSignal,
): Promise<ModelRecheckResult> {
  if (!catalogDiscoveryEnabled() || signal?.aborted) return { ...EMPTY, models: [...registered] };
  const template = openRouterTemplate(registered);
  if (!template) return { ...EMPTY, models: [...registered] };

  const recovered = new Set<string>();
  const delisted = new Set<string>();
  const added: ModelEntry[] = [];

  // ① 额度回充：强制刷新缓存，再按密钥查一次。同一密钥的多个模型共享额度（model-quota 单飞）。
  try {
    invalidateQuotaPreflightCache();
    const freeModels = registered.filter((m) => looksFreeTier(m) && isOpenRouterBaseUrl(m.baseUrl) && m.apiKey);
    const byKey = new Map<string, ModelEntry[]>();
    for (const m of freeModels) {
      const key = m.apiKeys.length ? m.apiKeys[0]! : m.apiKey;
      byKey.set(key, [...(byKey.get(key) || []), m]);
    }
    await Promise.all(
      [...byKey.entries()].map(async ([key, group]) => {
        if (signal?.aborted) return;
        const quota = await preflightKeyQuota(group[0]!.baseUrl, key);
        // 查不到（端点 404 / 超时 / 字段缺失）→ 不判恢复也不判耗尽，保持原冷却。
        if (!quota) return;
        for (const m of group) {
          if (quotaExhausted(quota)) {
            // 与开场预检同一口径：日额度耗尽冷却到 UTC 日切，不是笼统的 6 小时。
            noteDailyQuotaExhausted(m.id);
          } else if (quotaCooldownStatus.get(m.id) === "402") {
            if (clearModelCooldown(m.id)) recovered.add(m.id);
          }
        }
      }),
    );
  } catch (err) {
    console.warn(`[model:recheck] 额度重检失败（不影响候选）：${String((err as Error)?.message || err)}`);
  }

  // ② 目录：新上架 / 下架 / 转付费。目录拉取失败（空数组）时整段跳过——不能因为端点挂了就把
  //    健康模型全判成下架。
  try {
    if (signal?.aborted) return { models: [...registered], recovered: [...recovered], delisted: [], added: [] };
    const catalog = await fetchOpenRouterCatalog(template.baseUrl, template.apiKey);
    if (!catalog.length) {
      return { models: [...registered], recovered: [...recovered], delisted: [], added: [] };
    }
    const catalogIds = new Set(catalog.map((m) => m.id.toLowerCase()));
    const registeredNames = new Set(registered.map((m) => (m.name || "").toLowerCase()).filter(Boolean));

    for (const m of registered) {
      if (!looksFreeTier(m) || !isOpenRouterBaseUrl(m.baseUrl)) continue;
      const name = (m.name || "").toLowerCase();
      if (!name) continue;
      if (!catalogIds.has(name)) {
        // 目录中已无此免费端点：冷却 402（额度 / 免费端点了），并从恢复集合里撤掉。
        noteDownFailure(m.id, "model http 404: OpenRouter 目录已无此免费模型（重检）");
        if (quotaCooldownStatus.get(m.id) === "404") {
          delisted.add(m.id);
          recovered.delete(m.id);
        }
      } else if (quotaCooldownStatus.get(m.id) === "404") {
        // 之前被判下架、现在目录里又有了 → 重新上架，清掉 404 冷却。
        if (clearModelCooldown(m.id)) recovered.add(m.id);
      }
    }

    const used = new Set(registered.map((m) => m.id));
    for (const model of catalog) {
      if (registeredNames.has(model.id.toLowerCase())) continue;
      const entry = synthesize(model, template, used);
      used.add(entry.id);
      added.push(entry);
    }
  } catch (err) {
    console.warn(`[model:recheck] 目录重检失败（不影响候选）：${String((err as Error)?.message || err)}`);
  }

  return {
    models: [...registered, ...added],
    recovered: [...recovered],
    delisted: [...delisted],
    added: added.map((m) => m.id),
  };
}
