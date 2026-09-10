/**
 * Ambiguity Gate — 执行前消歧（确定性）。
 *
 * 通用规则：枚举维若角色为 filter_set 且取值未接地 → clarify；
 * group_by / top_n / absent(+default) 不拦。
 * 指标别名命中但口径未唯一 → clarify。
 *
 * 不把「三种/四种」写成特例；基数只作 filter_set 信号。
 */

import type { AnalyticsPack, EnumDimensionDef, MetricDef } from "./semantic-layer.js";

export type DimRole = "absent" | "group_by" | "top_n" | "filter_set" | "grounded_filter";

/** 多值过滤维不在输出维中时：宽表透视 vs 长表加维 */
export type ResultLayout = "wide" | "long";

export type AmbiguityGateOk = {
  ok: true;
  groundedFilters: Record<string, string[]>;
  groundedMetrics: string[];
  /** 用户声明的输出维（软 id：watch_date / channel / 字段名） */
  outputDims: string[];
  /** 多值过滤相对输出维的展示形态 */
  layout?: ResultLayout;
  /** 宽表时按哪个过滤维透视 */
  pivotDim?: string;
  notes: string[];
};

export type AmbiguityGateClarify = {
  ok: false;
  clarify: string;
  slot: string;
  priority: number;
  options?: Array<{ id: string; label: string }>;
};

export type AmbiguityGateResult = AmbiguityGateOk | AmbiguityGateClarify;

export type AmbiguityGateInput = {
  /** 上一轮澄清写入的槽位，如 { contentLang: ["te-IN","ta-IN"], result_layout: ["wide"] } */
  slotAnswers?: Record<string, string[]>;
};

const DEFAULT_ENUM_DIMS: EnumDimensionDef[] = [
  {
    id: "contentLang",
    field: "contentLang",
    aliases: ["语言", "语种", "小语种", "contentLang", "contentlang"],
    setSignals: ["\\d+种", "[一二三四五六七八九十两几多各]种", "几种", "多种", "各类", "小语种"],
    domain: "probe",
    valueAliases: {
      泰卢固: "te-IN",
      泰米尔: "ta-IN",
      马拉雅拉姆: "ml-IN",
      马拉雅拉姆语: "ml-IN",
      印地: "hi-IN",
      印地语: "hi-IN",
      英语: "en",
      英文: "en",
    },
  },
  {
    id: "movieType",
    field: "movieType",
    aliases: ["影片类型", "内容类型", "影片", "movieType", "movietype"],
    setSignals: ["\\d+种", "[一二三四五六七八九十两几多各]种", "几种", "多种", "各类"],
    domain: "pack",
    allowedValues: ["1", "2", "3", "4", "10", "11"],
    defaultWhenAbsent: true,
  },
];

const DEFAULT_METRICS: MetricDef[] = [
  {
    id: "completion_rate",
    aliases: ["完播率", "完播"],
    options: [
      {
        id: "avg_max_progress",
        label: "最大观看进度平均值",
        groundSignals: ["最大进度", "最大观看进度", "maxWatchProgress", "maxwatchprogress"],
      },
      {
        id: "pct_ge_threshold",
        label: "进度≥阈值占比",
        groundSignals: ["阈值", "大于等于", "≥", ">="],
      },
    ],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNl(nl: string): string {
  return String(nl || "").trim();
}

function enumDimsOf(pack: AnalyticsPack): EnumDimensionDef[] {
  return pack.enumDimensions?.length ? pack.enumDimensions : DEFAULT_ENUM_DIMS;
}

function metricDefsOf(pack: AnalyticsPack): MetricDef[] {
  return pack.metricDefs?.length ? pack.metricDefs : DEFAULT_METRICS;
}

function aliasHit(nl: string, aliases: string[]): string | null {
  const lower = nl.toLowerCase();
  for (const a of aliases) {
    if (!a) continue;
    if (/[a-z]/i.test(a)) {
      if (lower.includes(a.toLowerCase())) return a;
    } else if (nl.includes(a)) {
      return a;
    }
  }
  return null;
}

function anySignalHit(nl: string, signals: string[]): boolean {
  for (const s of signals || []) {
    try {
      if (new RegExp(s, "i").test(nl)) return true;
    } catch {
      if (nl.includes(s)) return true;
    }
  }
  return false;
}

/** setSignal 与维别名需共现（或信号本身即别名，如「小语种」），避免「三种指标」误伤语言维。 */
function filterSetSignalForDim(nl: string, dim: EnumDimensionDef): boolean {
  if (!anySignalHit(nl, dim.setSignals || [])) return false;
  if (aliasHit(nl, dim.aliases)) return true;
  // 信号词与别名重叠（小语种）
  for (const s of dim.setSignals || []) {
    const plain = s.replace(/\\d\+?/g, "").replace(/[\\^$.*+?()[\]{}|]/g, "");
    if (plain && dim.aliases.some((a) => a.includes(plain) || plain.includes(a))) {
      if (anySignalHit(nl, [s])) return true;
    }
  }
  return false;
}

function isTopNRole(nl: string, dim: EnumDimensionDef): boolean {
  const aliasPat = dim.aliases.map(escapeRegExp).join("|") || "语言";
  const patterns = [
    // 前3种语言 / top 3 语言 / 前3语言
    new RegExp(`(?:前|top)\\s*\\d+\\s*种?(?:的)?(?:${aliasPat})?`, "i"),
    new RegExp(`(?:${aliasPat}).{0,10}(?:前|top)\\s*\\d+`, "i"),
    // 最多的前3种 / 最多的3种语言
    new RegExp(`最多的?(?:前)?\\s*\\d+\\s*种(?:${aliasPat})?`, "i"),
    new RegExp(`(?:${aliasPat}).{0,10}最多的?(?:前)?\\s*\\d+`, "i"),
  ];
  return patterns.some((p) => p.test(nl));
}

function isGroupByRole(nl: string, dim: EnumDimensionDef): boolean {
  for (const a of dim.aliases) {
    const e = escapeRegExp(a);
    if (new RegExp(`按\\s*${e}`).test(nl)) return true;
    if (new RegExp(`各\\s*${e}`).test(nl)) return true;
    if (new RegExp(`分\\s*${e}`).test(nl)) return true;
    if (new RegExp(`${e}\\s*(?:维度|分布|分组|拆分)`).test(nl)) return true;
  }
  return false;
}

function extractLocaleCodes(nl: string): string[] {
  const out: string[] = [];
  for (const m of nl.matchAll(/\b([a-z]{2,3}-[A-Za-z]{2})\b/gi)) {
    out.push(m[1]);
  }
  // bare en / EN-ish short codes only when explicit contentLang context — skip bare to reduce FP
  return [...new Set(out)];
}

function extractGroundedValues(nl: string, dim: EnumDimensionDef, slotAnswers?: Record<string, string[]>): string[] {
  const fromSlot = slotAnswers?.[dim.id] || slotAnswers?.[dim.field] || [];
  const found = new Set<string>(fromSlot.map(String).filter(Boolean));

  if (dim.field === "contentLang" || dim.id === "contentLang") {
    for (const c of extractLocaleCodes(nl)) found.add(c);
  }

  const aliases = dim.valueAliases || {};
  for (const [name, code] of Object.entries(aliases)) {
    if (name && nl.includes(name)) found.add(code);
  }

  if (dim.allowedValues?.length) {
    for (const v of dim.allowedValues) {
      const re = new RegExp(`(?:^|[^\\d])(${escapeRegExp(String(v))})(?:[^\\d]|$)`);
      if (re.test(nl)) found.add(String(v));
    }
  }

  return [...found];
}

export function detectDimRole(
  nlRaw: string,
  dim: EnumDimensionDef,
  slotAnswers?: Record<string, string[]>,
): { role: DimRole; values: string[] } {
  const nl = normalizeNl(nlRaw);
  const values = extractGroundedValues(nl, dim, slotAnswers);
  const mentioned = Boolean(aliasHit(nl, dim.aliases));
  const filterSignal = filterSetSignalForDim(nl, dim);

  if (!mentioned && !filterSignal && values.length === 0) {
    return { role: "absent", values: [] };
  }

  if (isTopNRole(nl, dim)) {
    return { role: "top_n", values };
  }

  if (values.length > 0) {
    return { role: "grounded_filter", values };
  }

  // 基数/模糊集合 → filter_set（即使同时出现「按日期+渠道」也不取消）
  if (filterSignal) {
    return { role: "filter_set", values: [] };
  }

  if (isGroupByRole(nl, dim)) {
    return { role: "group_by", values: [] };
  }

  // 仅点名维、无集合信号：当作分组意图（「语言分布」类），避免滥问
  if (mentioned) {
    return { role: "group_by", values: [] };
  }

  return { role: "absent", values: [] };
}

function metricGrounded(nl: string, def: MetricDef): { grounded: boolean; optionId?: string; needClarify: boolean } {
  const hit = aliasHit(nl, def.aliases);
  if (!hit) return { grounded: true }; // 未提及该指标别名

  const matched: string[] = [];
  for (const opt of def.options) {
    if (aliasHit(nl, opt.groundSignals || []) || aliasHit(nl, [opt.label])) {
      matched.push(opt.id);
    }
  }
  if (matched.length === 1) return { grounded: true, optionId: matched[0] };
  if (matched.length > 1) return { grounded: false, needClarify: true };
  return { grounded: false, needClarify: true };
}

function clarifyMessageForDim(dim: EnumDimensionDef): string {
  const name = dim.aliases[0] || dim.id;
  return `请确认要筛选的具体${name}列表（可多选或直接列出取值）。未列出成员前无法统计「多种/几种」子集。`;
}

function clarifyMessageForMetric(def: MetricDef): string {
  const labels = def.options.map((o) => o.label).join(" / ");
  return `「${def.aliases[0] || def.id}」存在多种口径，请选择一种：${labels}。`;
}

/** 从 NL 抽输出维（「按…维度」），不含仅作筛选的集合。 */
export function detectOutputDims(nlRaw: string, pack: AnalyticsPack): string[] {
  const nl = normalizeNl(nlRaw);
  const out = new Set<string>();

  if (/按\s*(?:观看)?日期|观看日期\s*维度|按天|按日(?:统计|看|维度)?/.test(nl)) out.add("watch_date");
  if (/按\s*渠道|渠道\s*维度|(?:观看日期|日期)\s*[+＋和与、]\s*渠道/.test(nl)) out.add("channel");

  for (const dim of enumDimsOf(pack)) {
    if (isGroupByRole(nl, dim)) out.add(dim.field);
  }
  return [...out];
}

function resolveLayout(
  nl: string,
  slotAnswers?: Record<string, string[]>,
): ResultLayout | null {
  const raw = (slotAnswers?.result_layout || slotAnswers?.layout || [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  for (const a of raw) {
    if (a === "wide" || a === "宽表" || a.includes("一列")) return "wide";
    if (a === "long" || a === "长表" || a.includes("行")) return "long";
  }
  if (/宽表|每种.{0,6}一列|一列一种|分列展示|透视/.test(nl)) return "wide";
  if (/长表|作为行|下行展示/.test(nl)) return "long";
  return null;
}

function clarifyMessageForLayout(pivotLabel: string, outputDims: string[]): string {
  const dims = outputDims.length ? outputDims.join("+") : "当前维度";
  return (
    `输出维度是「${dims}」，同时筛选了多种${pivotLabel}。请确认结果形态：` +
    `宽表（每种${pivotLabel}一列指标）还是长表（${pivotLabel}作为分组行）？`
  );
}

/**
 * 确定性消歧闸门。
 * priority：枚举 filter_set(20) → 指标口径(30) → 宽/长表布局(35)
 */
export function runAmbiguityGate(
  nlRaw: string,
  pack: AnalyticsPack,
  input: AmbiguityGateInput = {},
): AmbiguityGateResult {
  const nl = normalizeNl(nlRaw);
  const notes: string[] = [];
  const groundedFilters: Record<string, string[]> = {};
  const groundedMetrics: string[] = [];
  const pending: AmbiguityGateClarify[] = [];
  const outputDims = detectOutputDims(nl, pack);
  if (outputDims.length) notes.push(`outputDims: [${outputDims.join(",")}]`);

  const multiFilterFields: string[] = [];

  for (const dim of enumDimsOf(pack)) {
    const { role, values } = detectDimRole(nl, dim, input.slotAnswers);
    if (role === "absent") {
      if (dim.defaultWhenAbsent) {
        const defs =
          dim.allowedValues?.length
            ? dim.allowedValues.map(String)
            : (pack.guards.defaultMovieTypes || []).map(String);
        if (defs.length) {
          groundedFilters[dim.field] = defs;
          notes.push(`${dim.id}: absent→default [${defs.join(",")}]`);
        }
      }
      continue;
    }
    if (role === "group_by" || role === "top_n") {
      notes.push(`${dim.id}: ${role} (pass)`);
      continue;
    }
    if (role === "grounded_filter") {
      groundedFilters[dim.field] = values;
      notes.push(`${dim.id}: grounded [${values.join(",")}]`);
      if (values.length > 1) multiFilterFields.push(dim.field);
      continue;
    }
    if (role === "filter_set") {
      pending.push({
        ok: false,
        slot: dim.id,
        priority: 20,
        clarify: clarifyMessageForDim(dim),
        options: (dim.allowedValues || []).map((v) => ({ id: String(v), label: String(v) })),
      });
    }
  }

  for (const def of metricDefsOf(pack)) {
    const m = metricGrounded(nl, def);
    if (!aliasHit(nl, def.aliases)) continue;
    if (m.grounded && m.optionId) {
      groundedMetrics.push(m.optionId);
      notes.push(`metric ${def.id}: ${m.optionId}`);
      continue;
    }
    if (m.needClarify) {
      pending.push({
        ok: false,
        slot: def.id,
        priority: 30,
        clarify: clarifyMessageForMetric(def),
        options: def.options.map((o) => ({ id: o.id, label: o.label })),
      });
    }
  }

  // 多值过滤维 ∉ 输出维 → 宽/长表未声明则反问（通用，不绑具体 SQL）
  let layout = resolveLayout(nl, input.slotAnswers);
  let pivotDim: string | undefined;
  for (const field of multiFilterFields) {
    if (outputDims.includes(field)) continue;
    // 输出维已声明且不含该过滤维，或至少声明了其它输出维
    if (!outputDims.length) continue;
    pivotDim = field;
    if (!layout) {
      const dimDef = enumDimsOf(pack).find((d) => d.field === field || d.id === field);
      const label = dimDef?.aliases[0] || field;
      pending.push({
        ok: false,
        slot: "result_layout",
        priority: 35,
        clarify: clarifyMessageForLayout(label, outputDims),
        options: [
          { id: "wide", label: `宽表（每种${label}一列）` },
          { id: "long", label: `长表（${label}作为行）` },
        ],
      });
    } else {
      notes.push(`layout: ${layout} pivot=${field}`);
    }
    break;
  }

  if (pending.length) {
    pending.sort((a, b) => a.priority - b.priority);
    return pending[0]!;
  }

  return {
    ok: true,
    groundedFilters,
    groundedMetrics,
    outputDims,
    layout: layout || undefined,
    pivotDim,
    notes,
  };
}

/**
 * 结构约束提示：只描述维/过滤/口径/宽长表，不写金 SQL / 方言模板。
 */
export function formatGroundedHint(gate: AmbiguityGateOk): string {
  const lines: string[] = [];
  if (gate.outputDims.length) {
    lines.push(`Output dimensions (outer GROUP BY): ${gate.outputDims.join(", ")}`);
  }
  for (const [k, vs] of Object.entries(gate.groundedFilters)) {
    if (vs.length) lines.push(`Filter ${k} IN (${vs.map((v) => `'${v}'`).join(", ")})`);
  }
  if (gate.groundedMetrics.includes("avg_max_progress")) {
    lines.push(
      "Metric avg_max_progress: average of per-entity max(progress); honor this definition only (no alternate completion formulas).",
    );
  }
  if (gate.groundedMetrics.includes("pct_ge_threshold")) {
    lines.push("Metric pct_ge_threshold: share of rows with progress >= threshold stated in the question.");
  }
  if (gate.layout === "wide" && gate.pivotDim) {
    const vals = gate.groundedFilters[gate.pivotDim] || [];
    lines.push(
      `Result layout WIDE: pivot filter dimension ${gate.pivotDim} into metric columns (one column per value).`,
      `Outer GROUP BY only the output dimensions; do not put ${gate.pivotDim} in the outer grain.`,
      `Inner aggregation grain must include ${gate.pivotDim}.`,
      vals.length ? `Pivot values: ${vals.join(", ")}` : "",
      "Do not collapse all pivot values into a single metric column.",
    );
  } else if (gate.layout === "long" && gate.pivotDim) {
    lines.push(
      `Result layout LONG: include ${gate.pivotDim} in GROUP BY together with output dimensions.`,
    );
  }
  const body = lines.filter(Boolean).join("\n");
  return body ? `Grounded slots (structural; must honor):\n${body}` : "";
}

export function parseProbeValuesForDim(probeSummary: string, dimField: string): Array<{ id: string; label: string }> {
  const line = probeSummary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(dimField.toLowerCase() + ":"));
  if (!line || /PROBE_FAILED/i.test(line)) return [];
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (!raw || raw === "(empty)") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 15)
    .map((v) => ({ id: v, label: v }));
}
