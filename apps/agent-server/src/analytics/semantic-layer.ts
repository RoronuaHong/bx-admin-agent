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
  allowedValues?: string[];
  valueAliases?: Record<string, string>;
  /** NL 未提及时用 allowedValues / defaultMovieTypes，不反问 */
  defaultWhenAbsent?: boolean;
}

export interface MetricDefOption {
  id: string;
  label: string;
  groundSignals?: string[];
  /** 语义层编译配方（Intent→SQL）；有则走确定性编译 */
  compile?: {
    kind: "avg_of_max" | "uniq" | "sum";
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
  };
  examples: Array<{ nl: string; sqlHint: string }>;
  /** Optional acceleration: Metabase card id and/or sqlTemplate + matchAll tokens. */
  questionBindings?: import("./question-binding.js").QuestionBinding[];
  /** Ambiguity Gate：可枚举维（缺省则用代码内默认） */
  enumDimensions?: EnumDimensionDef[];
  /** Ambiguity Gate：指标口径（缺省则用代码内默认） */
  metricDefs?: MetricDef[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../config/analytics");

export function loadAnalyticsPack(id = "watch-detail"): AnalyticsPack {
  const raw = readFileSync(join(root, `${id}.pack.json`), "utf8");
  const pack = JSON.parse(raw) as AnalyticsPack;
  applyBindingQuestionIdEnvOverrides(pack);
  return pack;
}

/**
 * Optional ops overlay: set ANALYTICS_BINDING_QID_<bindingId> to a Metabase card id
 * (hyphens in id → underscores). Example: ANALYTICS_BINDING_QID_indiaA_day_users=123
 * Prefer real saved questions when BI creates them; sqlTemplate remains the default shortcut.
 */
function applyBindingQuestionIdEnvOverrides(pack: AnalyticsPack): void {
  if (!pack.questionBindings?.length) return;
  for (const b of pack.questionBindings) {
    const key = `ANALYTICS_BINDING_QID_${String(b.id).replace(/-/g, "_")}`;
    const raw = (process.env[key] || "").trim();
    if (!raw) continue;
    const qid = Number(raw);
    if (Number.isFinite(qid) && qid > 0) {
      b.questionId = qid;
    }
  }
}

export function assertTableAllowed(pack: AnalyticsPack, table: string): void {
  if (!pack.tables.some((t) => t.name === table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }
}
