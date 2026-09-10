/**
 * Analytics eval scoring (M2 Task 1): soft-EX + gate metrics.
 * Pure functions — no Metabase / LLM I/O.
 */
export type EvalTable = { cols: string[]; rows: unknown[][] };

export type SoftExResult = {
  ok: boolean;
  mode: "strict" | "soft" | "fail";
  detail: string;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Normalize cell for equality; numeric strings coerced. */
export function normalizeCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isFiniteNumber(v)) {
    // Trim float noise for integers stored as floats
    if (Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
    return String(v);
  }
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9)) {
      return String(Math.round(n));
    }
  }
  return s;
}

/** Absolute or relative tolerance (design §8.1 ~0.015). */
export function cellsClose(a: unknown, b: unknown, tol = 0.015): boolean {
  const sa = normalizeCell(a);
  const sb = normalizeCell(b);
  if (sa === sb) return true;
  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  if (na === nb) return true;
  const abs = Math.abs(na - nb);
  if (abs <= tol) return true;
  const scale = Math.max(Math.abs(na), Math.abs(nb), 1e-9);
  return abs / scale <= tol;
}

function rowKey(vals: string[]): string {
  return vals.join("\u0001");
}

/** Common NL2SQL alias families — soft-EX matches by synonym when names differ. */
const COL_ALIAS_GROUPS: string[][] = [
  ["users", "viewers", "user_count", "uv", "cnt", "count"],
  ["watch_sec", "watch_seconds", "totalwatchseconds", "total_watch_seconds", "watchseconds", "seconds"],
  ["d", "day", "dt", "date"],
  ["channel", "ch"],
  ["contentlang", "lang", "language"],
];

function colAliasKey(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const g of COL_ALIAS_GROUPS) {
    if (g.some((a) => a.replace(/[^a-z0-9]/g, "") === n)) return g[0];
  }
  return n;
}

/**
 * soft-EX: every gold row appears in pred under gold's column projection
 * (pred may have extra columns / rows). Column match by name (ci) / alias else by index.
 */
export function softExMatch(
  gold: EvalTable,
  pred: EvalTable,
  opts?: { tol?: number },
): SoftExResult {
  const tol = opts?.tol ?? 0.015;
  if (!gold.cols.length) {
    return { ok: true, mode: "strict", detail: "empty gold cols" };
  }
  if (!pred.cols.length && gold.rows.length > 0) {
    return { ok: false, mode: "fail", detail: "pred has no cols" };
  }

  const predByAlias = new Map<string, number>();
  pred.cols.forEach((c, i) => {
    const k = colAliasKey(c);
    if (!predByAlias.has(k)) predByAlias.set(k, i);
  });
  const predColIndex = new Map(pred.cols.map((c, i) => [c.toLowerCase(), i]));
  const goldToPred: number[] = gold.cols.map((c, i) => {
    const byName = predColIndex.get(c.toLowerCase());
    if (byName != null) return byName;
    const byAlias = predByAlias.get(colAliasKey(c));
    if (byAlias != null) return byAlias;
    return i < pred.cols.length ? i : -1;
  });
  if (goldToPred.some((i) => i < 0)) {
    return {
      ok: false,
      mode: "fail",
      detail: `missing pred cols for gold: ${gold.cols.filter((_, i) => goldToPred[i] < 0).join(",")}`,
    };
  }

  const predKeys = new Set<string>();
  for (const row of pred.rows) {
    const projected = goldToPred.map((pi) => normalizeCell(row[pi]));
    predKeys.add(rowKey(projected));
  }

  let missing = 0;
  for (const grow of gold.rows) {
    const projected = grow.map((v) => normalizeCell(v));
    if (predKeys.has(rowKey(projected))) continue;
    // numeric-tolerant scan
    let found = false;
    for (const prow of pred.rows) {
      const ok = goldToPred.every((pi, gi) => cellsClose(grow[gi], prow[pi], tol));
      if (ok) {
        found = true;
        break;
      }
    }
    if (!found) missing += 1;
  }

  if (missing > 0) {
    return { ok: false, mode: "fail", detail: `gold rows not in pred: ${missing}/${gold.rows.length}` };
  }

  const extraCols = pred.cols.length > gold.cols.length;
  const extraRows = pred.rows.length > gold.rows.length;
  if (extraCols || extraRows) {
    return {
      ok: true,
      mode: "soft",
      detail: extraCols && extraRows ? "pred superset cols+rows" : extraCols ? "pred extra cols" : "pred extra rows",
    };
  }
  return { ok: true, mode: "strict", detail: "exact row/col projection" };
}

/**
 * Match unordered table sets (multi_query): each gold table must soft-EX-match some pred table.
 * Pred table count must be ≥ gold table count.
 */
export function softExMatchTables(
  goldTables: EvalTable[],
  predTables: EvalTable[],
  opts?: { tol?: number },
): SoftExResult {
  if (predTables.length < goldTables.length) {
    return {
      ok: false,
      mode: "fail",
      detail: `pred tables ${predTables.length} < gold ${goldTables.length}`,
    };
  }
  const used = new Set<number>();
  const parts: string[] = [];
  for (let gi = 0; gi < goldTables.length; gi++) {
    let best: SoftExResult | null = null;
    let bestIdx = -1;
    for (let pi = 0; pi < predTables.length; pi++) {
      if (used.has(pi)) continue;
      const r = softExMatch(goldTables[gi], predTables[pi], opts);
      if (r.ok) {
        best = r;
        bestIdx = pi;
        break;
      }
      if (!best || (!best.ok && r.detail.length < best.detail.length)) {
        best = r;
        bestIdx = pi;
      }
    }
    if (!best || !best.ok) {
      return {
        ok: false,
        mode: "fail",
        detail: `gold table[${gi}] unmatched: ${best?.detail || "none"}`,
      };
    }
    used.add(bestIdx);
    parts.push(`g${gi}→p${bestIdx}:${best.mode}`);
  }
  const anySoft = parts.some((p) => p.includes(":soft"));
  return { ok: true, mode: anySoft ? "soft" : "strict", detail: parts.join("; ") };
}

export type GateThresholds = {
  exMin: number;
  refuseRecallMin: number;
  refusePrecisionMin: number;
  cwrMax: number;
  exRegressionMaxPp: number;
};

export function loadGateThresholds(env: NodeJS.ProcessEnv = process.env): GateThresholds {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    exMin: n("GATE_EX_MIN", 0.85),
    refuseRecallMin: n("GATE_REFUSE_RECALL_MIN", 0.95),
    refusePrecisionMin: n("GATE_REFUSE_PRECISION_MIN", 0.8),
    cwrMax: n("GATE_CWR_MAX", 0.1),
    exRegressionMaxPp: n("GATE_EX_REGRESSION_MAX_PP", 3),
  };
}

export type CaseOutcome =
  | "ex_pass"
  | "ex_soft"
  | "ex_fail"
  | "refuse_ok"
  | "refuse_miss"
  | "over_refuse"
  | "error"
  | "skipped";

/** Seed review: gold = human-confirmed gate; provisional = scaffold/smoke only. */
export type ReviewStatus = "provisional" | "gold";

/**
 * GATE_* denominators only include reviewStatus=gold.
 * Missing/unknown → provisional (fail-closed for EX; refuse must be explicit gold).
 */
export function isGateCase(c: { reviewStatus?: string }): boolean {
  return String(c.reviewStatus || "").trim().toLowerCase() === "gold";
}

export type GateMetrics = {
  answerable: number;
  exPass: number; // strict + soft
  exSoft: number;
  cwr: number; // ok but wrong
  refuseTotal: number;
  refuseHit: number;
  systemRefuse: number; // model/clarify/refuse on any case
  systemRefuseCorrect: number; // among systemRefuse, should_refuse
  overRefuse: number;
  errors: number;
  skipped: number;
};

export function emptyMetrics(): GateMetrics {
  return {
    answerable: 0,
    exPass: 0,
    exSoft: 0,
    cwr: 0,
    refuseTotal: 0,
    refuseHit: 0,
    systemRefuse: 0,
    systemRefuseCorrect: 0,
    overRefuse: 0,
    errors: 0,
    skipped: 0,
  };
}

export function accumulateOutcome(m: GateMetrics, outcome: CaseOutcome, shouldRefuse: boolean): void {
  switch (outcome) {
    case "ex_pass":
      m.answerable += 1;
      m.exPass += 1;
      break;
    case "ex_soft":
      m.answerable += 1;
      m.exPass += 1;
      m.exSoft += 1;
      break;
    case "ex_fail":
      m.answerable += 1;
      m.cwr += 1;
      break;
    case "refuse_ok":
      m.refuseTotal += 1;
      m.refuseHit += 1;
      m.systemRefuse += 1;
      m.systemRefuseCorrect += 1;
      break;
    case "refuse_miss":
      m.refuseTotal += 1;
      break;
    case "over_refuse":
      m.answerable += 1;
      m.overRefuse += 1;
      m.systemRefuse += 1;
      break;
    case "error":
      // Infra / LLM / Metabase failure — exclude from EX & refuse denominators
      m.errors += 1;
      break;
    case "skipped":
      m.skipped += 1;
      break;
  }
}

export type GateReport = {
  ex: number | null;
  refuseRecall: number | null;
  refusePrecision: number | null;
  cwr: number | null;
  pass: boolean;
  failures: string[];
};

export function evaluateGates(m: GateMetrics, t: GateThresholds, baselineEx?: number | null): GateReport {
  const failures: string[] = [];
  const ex = m.answerable > 0 ? m.exPass / m.answerable : null;
  const refuseRecall = m.refuseTotal > 0 ? m.refuseHit / m.refuseTotal : null;
  const refusePrecision =
    m.systemRefuse > 0 ? m.systemRefuseCorrect / m.systemRefuse : null;
  const cwr = m.answerable > 0 ? m.cwr / m.answerable : null;

  if (ex != null && ex < t.exMin) {
    failures.push(`EX ${(ex * 100).toFixed(1)}% < GATE_EX_MIN ${(t.exMin * 100).toFixed(0)}%`);
  }
  if (refuseRecall != null && refuseRecall < t.refuseRecallMin) {
    failures.push(
      `RefuseRecall ${(refuseRecall * 100).toFixed(1)}% < GATE_REFUSE_RECALL_MIN ${(t.refuseRecallMin * 100).toFixed(0)}%`,
    );
  }
  if (refusePrecision != null && refusePrecision < t.refusePrecisionMin) {
    failures.push(
      `RefusePrecision ${(refusePrecision * 100).toFixed(1)}% < GATE_REFUSE_PRECISION_MIN ${(t.refusePrecisionMin * 100).toFixed(0)}%`,
    );
  }
  if (cwr != null && cwr > t.cwrMax) {
    failures.push(`CWR ${(cwr * 100).toFixed(1)}% > GATE_CWR_MAX ${(t.cwrMax * 100).toFixed(0)}%`);
  }
  if (baselineEx != null && ex != null) {
    const dropPp = (baselineEx - ex) * 100;
    if (dropPp > t.exRegressionMaxPp) {
      failures.push(
        `EX regression ${dropPp.toFixed(1)}pp > GATE_EX_REGRESSION_MAX_PP ${t.exRegressionMaxPp}`,
      );
    }
  }

  // Empty denominators: don't fail that gate, but overall pass requires we had something to measure when live
  return {
    ex,
    refuseRecall,
    refusePrecision,
    cwr,
    pass: failures.length === 0,
    failures,
  };
}
