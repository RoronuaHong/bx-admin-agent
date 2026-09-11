/**
 * Demand–Capability Gate：Structure 声明的 ops/metric ⊆ pack.capabilities。
 * LLM 声明（+ pack 配置的 groundSignals 补漏）→ 代码集合校验；禁止静默丢掉超纲语义。
 */

import type { AnalyticsPack } from "./semantic-layer.js";
import type { StructuredAskOk, StructuredAskResult } from "./conversation-structure.js";

export type CapabilityGateOk = {
  status: "ok";
  ops: string[];
  notes: string[];
};

export type CapabilityGateRefuse = {
  status: "refuse";
  reason: string;
  message: string;
  unsupportedOps: string[];
  notes: string[];
};

export type CapabilityGateClarify = {
  status: "clarify";
  reason: string;
  message: string;
  unsupportedOps: string[];
  notes: string[];
};

export type CapabilityGateResult = CapabilityGateOk | CapabilityGateRefuse | CapabilityGateClarify;

function hintEntry(
  raw: string | { hint: string; groundSignals?: string[] } | undefined,
): { hint: string; groundSignals: string[] } {
  if (!raw) return { hint: "", groundSignals: [] };
  if (typeof raw === "string") return { hint: raw, groundSignals: [] };
  return { hint: raw.hint || "", groundSignals: raw.groundSignals || [] };
}

/** Default supported set when pack omits capabilities (backward compatible). */
export function resolvePackCapabilities(pack: AnalyticsPack): {
  ops: Set<string>;
  metrics: Set<string>;
  unsupportedHints: Record<string, { hint: string; groundSignals: string[] }>;
  downgradePolicy: "strict" | "ask_downgrade";
} {
  const caps = pack.capabilities;
  const metrics = new Set<string>(
    caps?.metrics?.length
      ? caps.metrics
      : [
          "uniq_users",
          "sum_watch_second",
          "avg_watch_second_per_user",
          "avg_max_progress",
        ],
  );
  // Also allow metricDefs option ids
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      if (opt.compile?.kind) metrics.add(opt.id);
    }
  }
  const ops = new Set<string>(
    caps?.ops?.length ? caps.ops : ["base_aggregate", "pivot_wide", "pivot_long"],
  );
  const unsupportedHints: Record<string, { hint: string; groundSignals: string[] }> = {};
  for (const [id, raw] of Object.entries(caps?.unsupportedOpsHint || {})) {
    unsupportedHints[id] = hintEntry(raw);
  }
  return {
    ops,
    metrics,
    unsupportedHints,
    downgradePolicy: caps?.downgradePolicy === "ask_downgrade" ? "ask_downgrade" : "strict",
  };
}

/** Infer demanded ops from NL using pack-configured groundSignals (not hardcoded in gate). */
export function groundOpsFromNl(
  nl: string,
  unsupportedHints: Record<string, { hint: string; groundSignals: string[] }>,
): string[] {
  const text = String(nl || "");
  if (!text.trim()) return [];
  const hit: string[] = [];
  for (const [opId, meta] of Object.entries(unsupportedHints)) {
    for (const sig of meta.groundSignals) {
      const s = String(sig || "").trim();
      if (!s) continue;
      try {
        const re = new RegExp(s, "i");
        if (re.test(text)) {
          hit.push(opId);
          break;
        }
      } catch {
        if (text.toLowerCase().includes(s.toLowerCase())) {
          hit.push(opId);
          break;
        }
      }
    }
  }
  return [...new Set(hit)];
}

function normalizeDeclaredOps(ops: string[] | undefined, layout?: string): string[] {
  const out = new Set<string>();
  for (const o of ops || []) {
    const id = String(o || "").trim();
    if (id) out.add(id);
  }
  if (!out.size) out.add("base_aggregate");
  if (layout === "wide") out.add("pivot_wide");
  if (layout === "long") out.add("pivot_long");
  return [...out];
}

export function refuseMessageForOps(
  unsupported: string[],
  hints: Record<string, { hint: string; groundSignals: string[] }>,
): string {
  const parts = unsupported.map((op) => {
    const h = hints[op]?.hint || `${op} 尚未建模`;
    return `${op}（${h}）`;
  });
  return `当前问数超出语义层已建模能力，无法安全作答，已拒绝执行：${parts.join("；")}。请改用已支持的指标/维度，或联系补充建模（系统不会降级成基础指标以免答非所问）。`;
}

/**
 * Gate a structured ok result. Clarify/other statuses pass through via caller.
 */
export function evaluateCapabilityGate(input: {
  structure: StructuredAskOk;
  pack: AnalyticsPack;
  /** Full transcript or mergedNl for groundSignals */
  nl?: string;
}): CapabilityGateResult {
  const caps = resolvePackCapabilities(input.pack);
  const notes: string[] = [];
  const metricId = String(input.structure.metricId || "").trim();
  if (!metricId) {
    return {
      status: "refuse",
      reason: "missing_metric",
      message: "缺少指标口径，无法执行问数。",
      unsupportedOps: [],
      notes: ["capability_gate:missing_metric"],
    };
  }
  if (!caps.metrics.has(metricId)) {
    return {
      status: "refuse",
      reason: `unsupported_metric:${metricId}`,
      message: `指标「${metricId}」不在当前语义层已建模能力内，已拒绝执行（不会改用其他指标冒充）。`,
      unsupportedOps: [],
      notes: [`capability_gate:unsupported_metric:${metricId}`],
    };
  }

  const declared = normalizeDeclaredOps(input.structure.ops, input.structure.layout);
  const grounded = groundOpsFromNl(
    input.nl || input.structure.mergedNl || input.structure.askSummary || "",
    caps.unsupportedHints,
  );
  if (grounded.length) notes.push(`capability_gate:nl_ground:${grounded.join(",")}`);
  if (!(input.structure.ops && input.structure.ops.length)) {
    notes.push("capability_gate:ops_defaulted_base_aggregate");
  }

  const demanded = [...new Set([...declared, ...grounded])];
  const unsupported = demanded.filter((op) => !caps.ops.has(op));
  if (!unsupported.length) {
    return { status: "ok", ops: demanded, notes };
  }

  const reason = `unsupported_op:${unsupported.join(",")}`;
  const message = refuseMessageForOps(unsupported, caps.unsupportedHints);
  if (caps.downgradePolicy === "ask_downgrade") {
    return {
      status: "clarify",
      reason,
      message: `${message}\n若只需本期基础聚合结果，请回复「降级为基础指标」确认；否则请更换问法。`,
      unsupportedOps: unsupported,
      notes: [...notes, reason],
    };
  }
  return {
    status: "refuse",
    reason,
    message,
    unsupportedOps: unsupported,
    notes: [...notes, reason],
  };
}

/** Convenience: only run gate when structure is ok. */
export function gateStructuredAsk(
  structure: StructuredAskResult,
  pack: AnalyticsPack,
  nl?: string,
):
  | { structure: StructuredAskOk; gate: CapabilityGateOk }
  | { structure: StructuredAskResult; gate: CapabilityGateRefuse | CapabilityGateClarify }
  | { structure: StructuredAskResult; gate: null } {
  if (structure.status !== "ok") return { structure, gate: null };
  const gate = evaluateCapabilityGate({ structure, pack, nl });
  if (gate.status === "ok") {
    return {
      structure: {
        ...structure,
        ops: gate.ops,
        notes: [...(structure.notes || []), ...gate.notes],
      },
      gate,
    };
  }
  return { structure, gate };
}

export function catalogCapabilitiesPayload(pack: AnalyticsPack): Record<string, unknown> {
  const caps = resolvePackCapabilities(pack);
  return {
    supportedOps: [...caps.ops],
    supportedMetrics: [...caps.metrics],
    knownButUnsupportedOps: Object.fromEntries(
      Object.entries(caps.unsupportedHints)
        .filter(([id]) => !caps.ops.has(id))
        .map(([id, m]) => [id, m.hint]),
    ),
    downgradePolicy: caps.downgradePolicy,
    rule: "Declare every required op id in structure.ops. If any op is unsupported, do NOT status=ok with only base_aggregate — leave ops intact for the gate or status=refuse/clarify.",
  };
}
