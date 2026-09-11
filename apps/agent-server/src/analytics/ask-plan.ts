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
