import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 可枚举维：Ambiguity Gate 用（filter_set 未接地则反问）。 */
export interface EnumDimensionDef {
  id: string;
  field: string;
  aliases: string[];
  /** 集合未列成员时的信号（与别名共现才触发该维） */
  setSignals?: string[];
  domain?: "probe" | "pack";
  /**
   * How filter tokens are grounded:
   * - metabase_lexicon: code↔label from Metabase field values/description
   * - probe: live Top-N values (contentLang)
   * - literal: tokens used as stored values as-is
   */
  valueDomain?: "metabase_lexicon" | "probe" | "literal";
  allowedValues?: string[];
  /** NL 未提及时用 defaultMovieTypes，不反问 */
  defaultWhenAbsent?: boolean;
}

export interface MetricDefOption {
  id: string;
  label: string;
  groundSignals?: string[];
  /** 语义层编译配方（Intent→SQL）；有则走确定性编译 */
  compile?: {
    kind: "avg_of_max" | "uniq" | "sum" | "avg_per_user";
    valueField?: string;
    entityKeys?: string[];
    distinctField?: string;
  };
}


/** 指标别名 → 多口径；未选中则 clarify。 */
export interface MetricDef {
  id: string;
  aliases: string[];
  options: MetricDefOption[];
}

export interface AnalyticsPack {
  version: string;
  id: string;
  datasource: { engine: string; metabaseDatabaseId: number };
  tables: Array<{ name: string; fields: string[] }>;
  probeDimensions: string[];
  required_filters: string[];
  time: { businessTimezone: string; missingYearDefault: string };
  guards: {
    distinctCountFn: "uniq" | "uniqExact";
    maxRows: number;
    maxProbeRounds: number;
    maxRewriteRounds: number;
    parallelism: number;
    defaultMovieTypes: number[];
    /** Metabase/CH 单次查询超时（毫秒）；缺省读 ANALYTICS_QUERY_TIMEOUT_MS 或 120000 */
    queryTimeoutMs?: number;
    /**
     * 行级强制过滤（RLS 钩子）：编译时 AND 进 WHERE，调用方/租户不可去掉。
     * 例：{ "channel": ["IndiaA"] }
     */
    forcedFilters?: Record<string, string[]>;
  };
  /** Ambiguity Gate / schema：可枚举维 */
  enumDimensions?: EnumDimensionDef[];
  /** 指标口径与 compile 配方 */
  metricDefs?: MetricDef[];
  /**
   * Demand–Capability：已支持能力白名单 + 已知但未建模的 op（供 LLM 声明、代码校验）。
   * 扩能力 = 实现 compile 后把 op/metric 移入白名单，不改闸门内核。
   */
  capabilities?: {
    ops: string[];
    metrics: string[];
    /**
     * opId → 用户可见说明；可选 groundSignals 供「模型漏填 ops」时从 NL 接地（配置在 pack，不在代码写死业务词）。
     */
    unsupportedOpsHint?: Record<
      string,
      string | { hint: string; groundSignals?: string[] }
    >;
    /** strict = 超纲 refuse；ask_downgrade = clarify 是否降级（默认 strict） */
    downgradePolicy?: "strict" | "ask_downgrade";
  };
  /** Post-exec delivery when requested members missing from result cells */
  delivery?: {
    missingChannel?: "zero_fill" | "explain";
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../config/analytics");

export function loadAnalyticsPack(id = "watch-detail"): AnalyticsPack {
  const raw = readFileSync(join(root, `${id}.pack.json`), "utf8");
  return JSON.parse(raw) as AnalyticsPack;
}

export function assertTableAllowed(pack: AnalyticsPack, table: string): void {
  if (!pack.tables.some((t) => t.name === table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }
}
