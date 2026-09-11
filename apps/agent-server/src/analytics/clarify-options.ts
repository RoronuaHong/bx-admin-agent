/**
 * Clarify option formatting — shared by all analytics clarify slots.
 * Any clarify that returns selectable candidates MUST go through attachClarifyOptions
 * so message + clarifyOptions always carry 1-based sequence numbers.
 */

export type ClarifyOption = { id: string; label: string };

export const EMPTY_PROBE_TOKEN = "(empty)";
/** Generic empty label for non-lang dims. */
export const EMPTY_OPTION_LABEL = "\u7a7a\uff08\u672a\u6807\u6ce8\uff09"; // 空（未标注）
/** Business rule: blank contentLang means English. */
export const EMPTY_CONTENT_LANG_LABEL =
  "\u82f1\u8bed\uff08contentLang \u4e3a\u7a7a\uff09"; // 英语（contentLang 为空）

export function normalizeProbeToken(v: string, dimField?: string): ClarifyOption {
  const token = v.trim();
  if (!token || token === EMPTY_PROBE_TOKEN) {
    const label =
      dimField && dimField.toLowerCase() === "contentlang"
        ? EMPTY_CONTENT_LANG_LABEL
        : EMPTY_OPTION_LABEL;
    return { id: EMPTY_PROBE_TOKEN, label };
  }
  return { id: token, label: token };
}

/** Parse `dim: a, b, (empty)` probe summary lines into selectable options (empty kept). */
export function parseProbeValuesForDim(probeSummary: string, dimField: string): ClarifyOption[] {
  const line = probeSummary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(dimField.toLowerCase() + ":"));
  if (!line || /PROBE_FAILED/i.test(line)) return [];
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: ClarifyOption[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const opt = normalizeProbeToken(token, dimField);
    if (seen.has(opt.id)) continue;
    seen.add(opt.id);
    out.push(opt);
    if (out.length >= 15) break;
  }
  return out;
}

/** Attach 1-based sequence numbers (idempotent if already numbered). */
export function withOptionNumbers(options: ClarifyOption[]): ClarifyOption[] {
  if (!options.length) return options;
  if (options.every((o) => /^\d+\.\s/.test(o.label))) return options;
  return options.map((o, i) => ({ id: o.id, label: `${i + 1}. ${o.label}` }));
}

export function formatOptionHint(
  options: ClarifyOption[],
  opts?: { multiSelect?: boolean },
): string {
  if (!options.length) return "";
  const multi = opts?.multiSelect !== false;
  // 候选（可多选，回复序号或码）： / 候选（单选，回复序号或码）：
  const head = multi
    ? "\n\u5019\u9009\uff08\u53ef\u591a\u9009\uff0c\u56de\u590d\u5e8f\u53f7\u6216\u7801\uff09\uff1a\n"
    : "\n\u5019\u9009\uff08\u5355\u9009\uff0c\u56de\u590d\u5e8f\u53f7\u6216\u7801\uff09\uff1a\n";
  return head + options.map((o) => o.label).join("\n");
}

/**
 * Canonical clarify question text by slot.
 * Prefer this over LLM `clarify` when we already have selectable options,
 * so the UI never shows stale "候选示例：te-IN、…" copy from the model.
 */
export function slotClarifyMessage(slot: string | undefined): string | undefined {
  switch (slot) {
    case "contentLang":
      // 请确认要统计的具体内容语言（可多选）。请回复下方序号或语言码。
      return "\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1\u7684\u5177\u4f53\u5185\u5bb9\u8bed\u8a00\uff08\u53ef\u591a\u9009\uff09\u3002\u8bf7\u56de\u590d\u4e0b\u65b9\u5e8f\u53f7\u6216\u8bed\u8a00\u7801\u3002";
    case "movieType":
      // 请确认要统计的影片类型（可多选）。请回复下方序号或类型码。
      return "\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1\u7684\u5f71\u7247\u7c7b\u578b\uff08\u53ef\u591a\u9009\uff09\u3002\u8bf7\u56de\u590d\u4e0b\u65b9\u5e8f\u53f7\u6216\u7c7b\u578b\u7801\u3002";
    case "result_layout":
      // 请选择宽表或长表。
      return "\u8bf7\u9009\u62e9\u5bbd\u8868\u6216\u957f\u8868\u3002";
    case "metric":
      // 请确认指标口径。请回复下方序号。
      return "\u8bf7\u786e\u8ba4\u6307\u6807\u53e3\u5f84\u3002\u8bf7\u56de\u590d\u4e0b\u65b9\u5e8f\u53f7\u3002";
    case "channel":
      // 请确认渠道（可多选）。请回复下方序号或渠道名。
      return "\u8bf7\u786e\u8ba4\u6e20\u9053\uff08\u53ef\u591a\u9009\uff09\u3002\u8bf7\u56de\u590d\u4e0b\u65b9\u5e8f\u53f7\u6216\u6e20\u9053\u540d\u3002";
    default:
      return undefined;
  }
}

/**
 * Universal clarify formatter: number options + append hint to message.
 * Call this for every clarify response that has selectable options
 * (probe dims, layout, metrics, future slots).
 */
export function attachClarifyOptions(
  message: string,
  options?: ClarifyOption[] | null,
  opts?: { multiSelect?: boolean; slot?: string },
): { message: string; clarifyOptions?: ClarifyOption[] } {
  if (!options?.length) return { message };
  const numbered = withOptionNumbers(options);
  const base =
    (opts?.slot ? slotClarifyMessage(opts.slot) : undefined) ||
    stripEmbeddedCandidateJunk(message) ||
    message;
  return {
    message: `${base}${formatOptionHint(numbered, opts)}`,
    clarifyOptions: numbered,
  };
}

/** Drop model-appended「候选示例：…」 / inline locale lists so we only show numbered options. */
function stripEmbeddedCandidateJunk(message: string): string {
  let s = String(message || "").trim();
  if (!s) return s;
  // 候选示例：
  s = s.replace(/\n*\s*\u5019\u9009\u793a\u4f8b[：:].*$/u, "");
  s = s.replace(/\n*\s*\u5019\u9009[：:].*$/u, "");
  // （如 …）
  s = s.replace(/\uff08\u5982[^\uff09]*\uff09/g, "");
  s = s.replace(/\(e\.g\.[^)]*\)/gi, "");
  return s.trim();
}

/** Built-in layout choices (numbering applied by attachClarifyOptions). */
export function layoutClarifyOptions(): ClarifyOption[] {
  return [
    { id: "wide", label: "\u5bbd\u8868\uff08\u6bcf\u79cd\u8bed\u8a00\u4e00\u5217\uff09" },
    { id: "long", label: "\u957f\u8868\uff08\u8bed\u8a00\u4f5c\u4e3a\u884c\uff09" },
  ];
}

/** Optional: pack metric option list (numbering applied by attachClarifyOptions). */
export function metricClarifyOptions(
  metrics: Array<{ id: string; label?: string; name?: string }>,
): ClarifyOption[] {
  return metrics.slice(0, 15).map((m) => ({
    id: m.id,
    label: m.label || m.name || m.id,
  }));
}

/** Flatten pack.metricDefs.options into numbered clarify options. */
export function metricClarifyOptionsFromPack(pack: {
  metricDefs?: Array<{ options?: Array<{ id: string; label?: string }> }>;
}): ClarifyOption[] {
  const flat: ClarifyOption[] = [];
  for (const def of pack.metricDefs || []) {
    for (const o of def.options || []) {
      if (!o?.id) continue;
      flat.push({ id: o.id, label: o.label || o.id });
    }
  }
  return metricClarifyOptions(flat);
}
