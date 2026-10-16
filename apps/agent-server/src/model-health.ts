/**
 * 模型健康度：**只读在线评测已经打出的确定性分数**，不另设打分器、不调模型。
 *
 * 数据源：`.data/eval/eval-YYYYMM.jsonl`（`src/eval-online.ts` 每次运行收束时 append 的
 * 七维打分记录）。取最近 N 条、按 `model` 聚合 `stability` 维度的失败率：
 * 「不稳定」= 这一轮切过模型或重试过（`modelFallbacks` / `modelRetries` 超阈值）。
 *
 * 用途：自动模式下把**长期不稳**的模型排到候选链后面（事故复盘 §5 P0-3）。
 * 它不改「谁当默认模型」，只在同一条链里换序，组内仍沿用 `autoModelOrder` 的
 * 「免费优先」次序——所以它不会把「用免费额度」这件事推翻。
 *
 * **边界（必须诚实读，别把它当万能排序）**：
 * 1. 记录里的 `model` 是该轮的**实际服务模型**（候选链最后一个被尝试者）。
 *    某个模型「作为第一个候选被打死」这件事**不会**留在评测记录里，因此本模块
 *    对「开场探测」无感——那类一次性浪费要靠探测后的冷却（P0-1）兜底。
 * 2. 历史健康度对**配额突然耗尽**不敏感：配额按 UTC 日重置，昨天健康不代表今天可用。
 * 3. 样本不足一律按 unknown 处理（排中间），既不奖赏也不惩罚，避免新模型被误排到末尾。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(__dirname, "..", ".data", "eval");

/** 健康度分组：可用 → 未验证 → 不稳。排序只用这三档，不做连续打分。 */
export type HealthTier = "healthy" | "unknown" | "unhealthy";

export interface ModelHealth {
  /** 参与统计的运行数。 */
  samples: number;
  /** 其中 `stability` 维度未达标的次数。 */
  failures: number;
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 健康度开关：默认开。关掉即完全退回原「免费优先」排序（回滚口）。 */
export function healthOrderEnabled(): boolean {
  return String(process.env.MODEL_AUTO_STABLE_FIRST ?? "on").toLowerCase() !== "off";
}

/** 一条评测记录里判定「不稳定」的依据（只认 stability，不掺业务语义）。 */
export function rowIsUnstable(row: { failed?: unknown }): boolean {
  return Array.isArray(row.failed) && row.failed.includes("stability");
}

/**
 * 纯函数：把评测记录按模型聚合成健康度，按最近 `window` 条截断。
 * `rows` 约定为**时间正序**（落盘即追加），窗口取尾部。
 */
export function modelHealthFromRows(
  rows: readonly { model?: string; failed?: unknown }[],
  opts: { window?: number } = {},
): Map<string, ModelHealth> {
  const window = Math.max(1, Math.floor(opts.window ?? numEnv("MODEL_HEALTH_WINDOW", 50)));
  const recent = rows.slice(-window);
  const acc = new Map<string, ModelHealth>();
  for (const row of recent) {
    const id = String(row?.model || "").trim();
    if (!id) continue;
    const cur = acc.get(id) || { samples: 0, failures: 0 };
    cur.samples += 1;
    if (rowIsUnstable(row)) cur.failures += 1;
    acc.set(id, cur);
  }
  return acc;
}

/** 纯函数：分档。样本不足 → unknown（中性），不奖赏也不惩罚。 */
export function healthTier(
  health: ModelHealth | undefined,
  opts: { minSamples?: number; failRate?: number } = {},
): HealthTier {
  const minSamples = Math.max(1, Math.floor(opts.minSamples ?? numEnv("MODEL_HEALTH_MIN_SAMPLES", 3)));
  if (!health || health.samples < minSamples) return "unknown";
  const failRate = opts.failRate ?? numEnv("MODEL_HEALTH_FAIL_RATE", 0.5);
  return health.failures / health.samples >= failRate ? "unhealthy" : "healthy";
}

const TIER_RANK: Record<HealthTier, number> = { healthy: 0, unknown: 1, unhealthy: 2 };

/**
 * 纯函数：按健康度稳定重排（**稳定排序**：同档内保持入参次序）。
 * 包住 `autoModelOrder` 的结果即得「可用优先、组内仍免费优先」。
 */
export function orderByHealth<T extends { id: string }>(
  items: readonly T[],
  health: ReadonlyMap<string, ModelHealth>,
  opts: { minSamples?: number; failRate?: number } = {},
): T[] {
  const ranked = items.map((item, index) => ({ item, index, tier: healthTier(health.get(item.id), opts) }));
  ranked.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.index - b.index);
  return ranked.map((entry) => entry.item);
}

// ---- 落盘读取（best-effort，失败一律当作没有数据）----

let cache: { at: number; value: Map<string, ModelHealth> } | null = null;
const CACHE_MS = Math.max(5_000, Number(process.env.MODEL_HEALTH_CACHE_MS ?? 60_000));

function readEvalRows(): { at?: number; model?: string; failed?: unknown }[] {
  if (!existsSync(EVAL_DIR)) return [];
  const files = readdirSync(EVAL_DIR)
    .filter((f) => f.startsWith("eval-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  const rows: { at?: number; model?: string; failed?: unknown }[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(resolve(EVAL_DIR, file), "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { at?: number; model?: string; failed?: unknown };
        if (typeof row.at === "number") rows.push(row);
      } catch {
        /* 单行损坏忽略 */
      }
    }
    // 近月文件足够；再往前翻只会让「近期状态」被陈旧样本稀释。
    if (rows.length > 2000) break;
  }
  return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * 读一次并缓存（默认 60s）。**best-effort**：任何异常都返回空表（= 不排序 = 退回原次序），
 * 绝不因为评测文件读不了就让对话失败。
 */
export function readModelHealth(): Map<string, ModelHealth> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value = new Map<string, ModelHealth>();
  try {
    value = modelHealthFromRows(readEvalRows());
  } catch {
    value = new Map();
  }
  cache = { at: now, value };
  return value;
}

/** 仅供测试：清掉进程内缓存。 */
export function resetModelHealthCache(): void {
  cache = null;
}
