/**
 * Multi-Intent plan: parse + capability check + deterministic side_by_side / ratio exec.
 * YoY / MoM = current window + prior window (timeOffset) + merge_ratio.
 */

import type { AnalyticsPack } from "./semantic-layer.js";
import type { AnalyticsIntent } from "./intent.js";
import { buildAnalyticsIntentFromStructure } from "./intent.js";
import { compileAnalyticsIntent } from "./sql-compile.js";
import { evaluateCapabilityGate } from "./capability-gate.js";
import type { StructuredAskOk } from "./conversation-structure.js";
import { extractLocalesFromText } from "./conversation-structure.js";
import { extractCodesFromText, type DimLexicon } from "./dim-lexicon.js";
import { extractChannelsFromNl } from "./intent.js";
import { inferOutputDimsFromNl } from "./metric-infer.js";
import { wantsMultiQuerySplit } from "./named-entities.js";

export type PlanStep = {
  id: string;
  metricId: string;
  ops?: string[];
  filters?: Record<string, string[]>;
  outputDims?: string[];
  layout?: "wide" | "long";
  pivotDim?: string;
  /** Relative window hint — e.g. yoy_window / mom_window */
  timeOffset?: string;
};

export type AskPlan = {
  steps: PlanStep[];
  merge: {
    kind: "side_by_side" | "ratio" | "diff";
    left: string;
    right: string;
  };
};

export function parseAskPlan(raw: unknown): AskPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const stepsRaw = o.steps;
  const mergeRaw = o.merge;
  if (!Array.isArray(stepsRaw) || stepsRaw.length < 2) return null;
  if (!mergeRaw || typeof mergeRaw !== "object") return null;
  const merge = mergeRaw as Record<string, unknown>;
  const kind = String(merge.kind || "");
  if (kind !== "side_by_side" && kind !== "ratio" && kind !== "diff") return null;
  const steps: PlanStep[] = [];
  for (const s of stepsRaw.slice(0, 4)) {
    if (!s || typeof s !== "object") continue;
    const st = s as Record<string, unknown>;
    const id = String(st.id || "").trim();
    const metricId = String(st.metricId || "").trim();
    if (!id || !metricId) continue;
    steps.push({
      id,
      metricId,
      ops: Array.isArray(st.ops) ? st.ops.map(String) : undefined,
      filters:
        st.filters && typeof st.filters === "object"
          ? Object.fromEntries(
              Object.entries(st.filters as Record<string, unknown>).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.map(String) : [],
              ]),
            )
          : undefined,
      outputDims: Array.isArray(st.outputDims) ? st.outputDims.map(String) : undefined,
      layout: st.layout === "wide" || st.layout === "long" ? st.layout : undefined,
      pivotDim: st.pivotDim ? String(st.pivotDim) : undefined,
      timeOffset: st.timeOffset ? String(st.timeOffset) : undefined,
    });
  }
  if (steps.length < 2) return null;
  return {
    steps,
    merge: {
      kind,
      left: String(merge.left || steps[0]!.id),
      right: String(merge.right || steps[1]!.id),
    },
  };
}

export type PlanTuple = {
  channels: string[];
  contentLangs: string[];
  outputDims: string[];
};

/** Clause split on punctuation / discourse connectors — not a business synonym list. */
export function splitAskClauses(nl: string): string[] {
  return String(nl || "")
    .split(/[，,。；;]|同时|以及|还有|并且|另外/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

export function inferPlanTuples(
  nl: string,
  lexicons?: Record<string, DimLexicon>,
  pack?: AnalyticsPack,
): PlanTuple[] {
  const channelLex = lexicons?.channel;
  const out: PlanTuple[] = [];
  for (const clause of splitAskClauses(nl)) {
    const fromLex = channelLex ? extractCodesFromText(clause, channelLex) : [];
    const channels = [...new Set([...fromLex, ...extractChannelsFromNl(clause, pack)])];
    const contentLangs = extractLocalesFromText(clause);
    const outputDims = inferOutputDimsFromNl(clause);
    if (!channels.length && !contentLangs.length && !outputDims.length) continue;
    out.push({ channels, contentLangs, outputDims });
  }
  return out;
}

function dimSig(dims: string[]): string {
  return [...new Set(dims.filter((d) => d !== "channel"))].sort().join("+");
}

function expandTuplesToSteps(input: {
  base: StructuredAskOk;
  tuples: PlanTuple[];
}): PlanStep[] {
  const steps: PlanStep[] = [];
  let i = 1;
  const metricId = String(input.base.metricId || "").trim();
  if (!metricId) return [];
  for (const t of input.tuples) {
    const dims = (t.outputDims.length ? t.outputDims : input.base.outputDims || []).filter(
      (d) => d !== "channel",
    );
    const channels = t.channels.length ? t.channels : [];
    const langs = t.contentLangs;
    const targets = channels.length ? channels : [""];
    for (const ch of targets) {
      const filters: Record<string, string[]> = { ...(input.base.filters || {}) };
      if (ch) filters.channel = [ch];
      else delete filters.channel;
      if (langs.length) filters.contentLang = langs;
      else if (!t.contentLangs.length && dimSig(dims) === "watch_date") {
        delete filters.contentLang;
      }
      steps.push({
        id: `s${i++}`,
        metricId,
        ops: ["base_aggregate"],
        filters,
        outputDims: dims.length ? dims : ["watch_date"],
      });
    }
  }
  return steps.slice(0, 4);
}

export function synthesizeEntityComparePlan(input: {
  base: StructuredAskOk;
  tuples: PlanTuple[];
}): AskPlan | null {
  const steps = expandTuplesToSteps(input);
  if (steps.length < 2) return null;
  return {
    steps,
    merge: { kind: "side_by_side", left: steps[0]!.id, right: steps[1]!.id },
  };
}

export type PlanCardinality =
  | { kind: "keep"; notes: string[] }
  | { kind: "plan"; plan: AskPlan; notes: string[] }
  | { kind: "clarify"; message: string; notes: string[] };

/**
 * One step = one (metric, filters, grain). 2+ incompatible tuples → plan or clarify.
 * Never fold mixed grains into a single IN + stacked outputDims.
 */
export function resolvePlanCardinality(input: {
  structure: StructuredAskOk;
  nl: string;
  lexicons?: Record<string, DimLexicon>;
  pack?: AnalyticsPack;
}): PlanCardinality {
  const notes: string[] = [];
  if ((input.structure.plan?.steps?.length || 0) >= 2) {
    return { kind: "keep", notes: ["plan_cardinality:llm_plan"] };
  }
  const tuples = inferPlanTuples(input.nl, input.lexicons, input.pack);
  const syn = synthesizeEntityComparePlan({ base: input.structure, tuples });
  const sigs = new Set(
    (syn?.steps || []).map((s) => dimSig(s.outputDims || [])),
  );
  const channels = input.structure.filters?.channel || [];
  const dims = input.structure.outputDims || [];
  const mixedCollapsed =
    channels.length >= 2 &&
    dims.includes("watch_date") &&
    dims.includes("contentLang");
  const wantSplit = wantsMultiQuerySplit(input.nl);

  if (syn && (sigs.size >= 2 || wantSplit || mixedCollapsed)) {
    notes.push(
      sigs.size >= 2
        ? "plan_cardinality:synthesized_mixed_grain"
        : wantSplit
          ? "plan_cardinality:synthesized_split"
          : "plan_cardinality:unfolder_mixed_dims",
    );
    return { kind: "plan", plan: syn, notes };
  }

  if (mixedCollapsed) {
    return {
      kind: "clarify",
      message:
        "问句里包含多组不同的筛选×粒度，无法安全折成一张表。请拆成两次查询，或确认统一用同一套分组维度。",
      notes: [...notes, "plan_cardinality:mixed_grain_clarify"],
    };
  }

  return { kind: "keep", notes };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseYmd(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Shift a YYYY-MM-DD by whole calendar years (clamp day for leap years). */
export function shiftYmdYears(iso: string, years: number): string {
  const p = parseYmd(iso);
  if (!p) return iso;
  const y = p.y + years;
  let d = p.d;
  const dim = daysInMonth(y, p.m);
  if (d > dim) d = dim;
  return `${y}-${pad2(p.m)}-${pad2(d)}`;
}

/** Shift a YYYY-MM-DD by whole days (UTC calendar arithmetic). */
export function shiftYmdDays(iso: string, days: number): string {
  const p = parseYmd(iso);
  if (!p) return iso;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Inclusive day count between two YYYY-MM-DD (same day → 1). */
export function inclusiveDaySpan(start: string, end: string): number {
  const a = parseYmd(start);
  const b = parseYmd(end);
  if (!a || !b) return 1;
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.max(1, Math.floor(ms / 86400000) + 1);
}

/** Equal-length window immediately before `start` (MoM prior for arbitrary ranges). */
export function resolveMomPriorWindow(base: { start: string; end: string }): {
  start: string;
  end: string;
  echo: string;
  spanDays: number;
} {
  const spanDays = inclusiveDaySpan(base.start, base.end);
  const end = shiftYmdDays(base.start, -1);
  const start = shiftYmdDays(end, -(spanDays - 1));
  return {
    start,
    end,
    echo: `${start}～${end} (MoM prior, ${spanDays}d)`,
    spanDays,
  };
}

export function resolvePlanStepTime(
  base: { start: string; end: string },
  timeOffset?: string,
): { start: string; end: string; echo: string; spanDays?: number } {
  if (!timeOffset) {
    return {
      start: base.start,
      end: base.end,
      echo: `${base.start}～${base.end}`,
      spanDays: inclusiveDaySpan(base.start, base.end),
    };
  }
  if (/yoy/i.test(timeOffset) || timeOffset.includes("\u540c\u6bd4")) {
    const start = shiftYmdYears(base.start, -1);
    const end = shiftYmdYears(base.end, -1);
    return { start, end, echo: `${start}～${end} (YoY prior)` };
  }
  if (/mom/i.test(timeOffset) || timeOffset.includes("\u73af\u6bd4")) {
    const prior = resolveMomPriorWindow(base);
    return {
      start: prior.start,
      end: prior.end,
      echo: prior.echo,
      spanDays: prior.spanDays,
    };
  }
  throw new Error(`timeOffset_not_compilable:${timeOffset}`);
}

function synthesizeRelativePlan(
  base: StructuredAskOk,
  priorId: string,
  timeOffset: string,
): AskPlan | null {
  const metricId = String(base.metricId || "").trim();
  if (!metricId || !base.time?.start || !base.time?.end) return null;
  const dims = base.outputDims?.length ? base.outputDims : ["channel"];
  return {
    steps: [
      {
        id: "current",
        metricId,
        ops: ["base_aggregate"],
        outputDims: dims,
        layout: base.layout,
        pivotDim: base.pivotDim,
      },
      {
        id: priorId,
        metricId,
        ops: ["base_aggregate"],
        outputDims: dims,
        layout: base.layout,
        pivotDim: base.pivotDim,
        timeOffset,
      },
    ],
    merge: { kind: "ratio", left: "current", right: priorId },
  };
}

/** Build a 2-step YoY growth plan from a single-intent structure. */
export function synthesizeYoyPlan(base: StructuredAskOk): AskPlan | null {
  return synthesizeRelativePlan(base, "prior_yoy", "yoy_window");
}

/** Build a 2-step MoM growth plan (equal-length prior window). */
export function synthesizeMomPlan(base: StructuredAskOk): AskPlan | null {
  return synthesizeRelativePlan(base, "prior_mom", "mom_window");
}

/**
 * Which relative-growth plan to synthesize.
 * mom wins over yoy when both appear; bare growth_rate defaults to yoy.
 */
export function relativeGrowthKind(ops: string[] | undefined): "yoy" | "mom" | null {
  const set = new Set((ops || []).map(String));
  if (set.has("mom")) return "mom";
  if (set.has("yoy") || set.has("growth_rate")) return "yoy";
  return null;
}

export function planNeedsYoy(ops: string[] | undefined): boolean {
  return relativeGrowthKind(ops) === "yoy";
}

export function planNeedsMom(ops: string[] | undefined): boolean {
  return relativeGrowthKind(ops) === "mom";
}

/** True when a plan step already carries the prior window for this growth kind. */
export function planHasRelativeWindow(plan: AskPlan | undefined, kind: "yoy" | "mom"): boolean {
  if (!plan?.steps?.length) return false;
  return plan.steps.some((s) => {
    const off = String(s.timeOffset || "");
    if (!off) return false;
    if (kind === "mom") return /mom/i.test(off) || off.includes("\u73af\u6bd4");
    return /yoy/i.test(off) || off.includes("\u540c\u6bd4");
  });
}

/** Synthesize unless the existing plan already has the matching prior window. */
export function growthKindToSynthesize(
  ops: string[] | undefined,
  plan?: AskPlan,
): "yoy" | "mom" | null {
  const kind = relativeGrowthKind(ops);
  if (!kind) return null;
  if (planHasRelativeWindow(plan, kind)) return null;
  return kind;
}

export type PlanGateOk = { status: "ok"; plan: AskPlan; notes: string[] };
export type PlanGateRefuse = { status: "refuse"; reason: string; message: string; notes: string[] };

/** Refuse unsupported merge / timeOffset rather than running only the first step. */
export function gateAskPlan(plan: AskPlan, pack: AnalyticsPack, base: StructuredAskOk): PlanGateOk | PlanGateRefuse {
  const notes: string[] = [];
  const supported = new Set(pack.capabilities?.ops || []);
  if (plan.merge.kind === "ratio" || plan.merge.kind === "diff") {
    const needOp = plan.merge.kind === "ratio" ? "merge_ratio" : "merge_diff";
    if (!supported.has(needOp)) {
      return {
        status: "refuse",
        reason: `unsupported_op:${needOp}`,
        message: `多步合并「${plan.merge.kind}」尚未建模，已拒绝执行（不会只返回单步结果以免答非所问）。`,
        notes: [`plan_gate:${needOp}`],
      };
    }
  }
  for (const step of plan.steps) {
    if (
      step.timeOffset &&
      (/yoy|mom/i.test(step.timeOffset) ||
        step.timeOffset.includes("\u540c\u6bd4") ||
        step.timeOffset.includes("\u73af\u6bd4"))
    ) {
      const op =
        /yoy/i.test(step.timeOffset) || step.timeOffset.includes("\u540c\u6bd4")
          ? "yoy"
          : "mom";
      if (!supported.has(op)) {
        return {
          status: "refuse",
          reason: `unsupported_op:${op}`,
          message: `计划步骤 ${step.id} 需要 ${op} 时间窗，当前语义层未建模，已拒绝。`,
          notes: [`plan_gate:timeOffset:${step.timeOffset}`],
        };
      }
    }
    const stepStruct: StructuredAskOk = {
      status: "ok",
      mergedNl: base.mergedNl,
      time: base.time,
      filters: { ...base.filters, ...(step.filters || {}) },
      outputDims: step.outputDims || base.outputDims,
      layout: step.layout || base.layout,
      pivotDim: step.pivotDim || base.pivotDim,
      metricId: step.metricId,
      ops: step.ops || ["base_aggregate"],
    };
    const g = evaluateCapabilityGate({ structure: stepStruct, pack, nl: base.mergedNl });
    if (g.status !== "ok") {
      return {
        status: "refuse",
        reason: g.status === "refuse" ? g.reason : g.reason,
        message: g.message,
        notes: [...notes, ...g.notes],
      };
    }
  }
  if (plan.merge.kind === "side_by_side") {
    if (!supported.has("side_by_side") && !supported.has("base_aggregate")) {
      return {
        status: "refuse",
        reason: "unsupported_op:side_by_side",
        message: "并排多步对比尚未纳入能力目录。",
        notes,
      };
    }
  }
  return { status: "ok", plan, notes };
}

export type CompiledPlanStep = {
  id: string;
  intent: AnalyticsIntent;
  sql: string;
  time: { start: string; end: string; echo: string; spanDays?: number };
};

export function compileAskPlanSteps(input: {
  plan: AskPlan;
  base: StructuredAskOk;
  pack: AnalyticsPack;
  fallbackNl: string;
}): { ok: true; steps: CompiledPlanStep[] } | { ok: false; reason: string } {
  const out: CompiledPlanStep[] = [];
  const baseTime = input.base.time;
  if (!baseTime?.start || !baseTime?.end) {
    return { ok: false, reason: "plan_missing_time" };
  }
  for (const step of input.plan.steps) {
    let stepTime: { start: string; end: string; echo: string; spanDays?: number };
    try {
      stepTime = resolvePlanStepTime(baseTime, step.timeOffset);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const built = buildAnalyticsIntentFromStructure({
      structure: {
        time: { start: stepTime.start, end: stepTime.end },
        filters: { ...input.base.filters, ...(step.filters || {}) },
        outputDims: step.outputDims || input.base.outputDims,
        layout: step.layout || input.base.layout,
        pivotDim: step.pivotDim || input.base.pivotDim,
        metricId: step.metricId,
      },
      pack: input.pack,
      fallbackNl: input.fallbackNl,
    });
    if (!built.ok) return { ok: false, reason: built.reason };
    const compiled = compileAnalyticsIntent(built.intent, input.pack);
    if (!compiled.ok) return { ok: false, reason: compiled.reason };
    out.push({ id: step.id, intent: built.intent, sql: compiled.sql, time: stepTime });
  }
  return { ok: true, steps: out };
}

function isDateLikeCol(name: string): boolean {
  return /watch_?date|date|dt|day/i.test(name);
}

export type DateAlign = { years?: number; days?: number };

function rowKey(
  cols: string[],
  row: unknown[],
  dimCount: number,
  align?: DateAlign,
): string {
  const parts: string[] = [];
  for (let i = 0; i < dimCount; i++) {
    const col = cols[i] || "";
    let v = row[i];
    if (align && isDateLikeCol(col) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      let d = v.slice(0, 10);
      if (align.years) d = shiftYmdYears(d, align.years);
      if (align.days) d = shiftYmdDays(d, align.days);
      v = d;
    }
    parts.push(String(v ?? ""));
  }
  return parts.join("\u0001");
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Growth rate = (left - right) / right.
 * Join on all columns except the last (measure). Optional date align on right keys.
 */
export function mergeRatioTables(input: {
  left: { cols: string[]; rows: unknown[][] };
  right: { cols: string[]; rows: unknown[][] };
  /** @deprecated use align */
  alignYoy?: boolean;
  align?: DateAlign;
  leftLabel?: string;
  rightLabel?: string;
}): { cols: string[]; rows: unknown[][] } {
  const leftCols = input.left.cols || [];
  const rightCols = input.right.cols || [];
  if (leftCols.length < 1 || rightCols.length < 1) {
    return { cols: ["growth_rate"], rows: [] };
  }
  const dimCount = Math.max(0, Math.min(leftCols.length, rightCols.length) - 1);
  const dimCols = leftCols.slice(0, dimCount);
  const leftMeasure = leftCols[leftCols.length - 1] || "current";
  const rightMeasure = rightCols[rightCols.length - 1] || "prior";
  const align: DateAlign | undefined =
    input.align || (input.alignYoy ? { years: 1 } : undefined);

  const rightMap = new Map<string, unknown>();
  for (const row of input.right.rows || []) {
    rightMap.set(rowKey(rightCols, row, dimCount, align), row[dimCount]);
  }

  const cols = [
    ...dimCols,
    input.leftLabel || `current_${leftMeasure}`,
    input.rightLabel || `prior_${rightMeasure}`,
    "growth_rate",
  ];
  const rows: unknown[][] = [];
  for (const row of input.left.rows || []) {
    const key = rowKey(leftCols, row, dimCount, undefined);
    const cur = toNum(row[dimCount]);
    const prior = toNum(rightMap.get(key));
    let growth: number | null = null;
    if (cur != null && prior != null && prior !== 0) {
      growth = Math.round(((cur - prior) / prior) * 10000) / 10000;
    }
    rows.push([...row.slice(0, dimCount), cur, prior, growth]);
  }
  return { cols, rows };
}
