/**
 * 多轮对话 → 结构化 Intent 槽位（LLM）。
 * SQL 仍由 sql-compile 确定性编译；本模块只做 schema 填充与澄清。
 */

import type { AnalyticsPack } from "./semantic-layer.js";
import type { ResultLayout } from "./types.js";

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type StructuredAskOk = {
  status: "ok";
  /** 合并后的完整业务问句（供 verify / lint） */
  mergedNl: string;
  time?: { start: string; end: string };
  filters: Record<string, string[]>;
  outputDims: string[];
  layout?: ResultLayout;
  pivotDim?: string;
  metricId?: string;
  notes?: string[];
};

export type StructuredAskClarify = {
  status: "clarify";
  clarify: string;
  clarifySlot: string;
  mergedNl?: string;
  time?: { start: string; end: string };
  /** 已部分接地的过滤，供下一轮累积 */
  partialFilters?: Record<string, string[]>;
};

export type StructuredAskResult = StructuredAskOk | StructuredAskClarify;

function packCatalogHint(pack: AnalyticsPack): string {
  const table = pack.tables[0];
  const metrics: string[] = [];
  for (const def of pack.metricDefs || []) {
    for (const opt of def.options || []) {
      metrics.push(`${opt.id} (${opt.label})`);
    }
  }
  metrics.push(
    "uniq_users (观看人数/UV)",
    "sum_watch_second (观看时长合计)",
    "avg_watch_second_per_user (人均观看时长)",
  );
  return [
    `Table: ${table?.name || "elt_watch_detail"} fields: ${(table?.fields || []).join(", ")}`,
    `Probe dimensions: ${(pack.probeDimensions || []).join(", ")}`,
    `Enum dims (no value dictionaries — probe Metabase): ${(pack.enumDimensions || [])
      .map((d) => d.field)
      .join(", ")}`,
    `Known metrics: ${metrics.join("; ")}`,
    "outputDims soft ids: watch_date, channel, contentLang, movieType",
    "layout: wide|long only for avg_max_progress pivot cases",
  ].join("\n");
}

export function formatConversationTranscript(messages: ConversationTurn[]): string {
  return messages
    .map((m, i) => {
      const who = m.role === "user" ? "用户" : "助手";
      return `[${i + 1}] ${who}: ${String(m.text || "").trim()}`;
    })
    .filter((line) => !/:\s*$/.test(line))
    .join("\n");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1]!.trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json object");
  return JSON.parse(raw.slice(start, end + 1));
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

function normalizeFilters(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const vals = asStringArray(v);
    if (vals.length) out[k] = vals;
  }
  return out;
}

/** 归一 clarifySlot：layout → result_layout 等 */
export function normalizeClarifySlot(slot: string): string {
  const s = String(slot || "").trim();
  if (!s) return "unknown";
  const lower = s.toLowerCase();
  if (lower === "layout" || lower === "resultlayout" || lower === "result-layout") {
    return "result_layout";
  }
  if (lower === "lang" || lower === "language" || lower === "locale" || lower === "content_lang") {
    return "contentLang";
  }
  if (lower === "time" || lower === "timerange" || lower === "date_range") {
    return "time_range";
  }
  if (lower === "metric_id" || lower === "completion_rate") {
    return "metric";
  }
  return s;
}

/** 从对话文本抽出 locale 码（含 澄清选择：contentLang=…） */
export function extractLocalesFromText(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b([a-z]{2}-[A-Za-z]{2})\b/g)) {
    const [a, b] = m[1]!.split("-");
    found.add(`${a!.toLowerCase()}-${b!.toUpperCase()}`);
  }
  for (const m of text.matchAll(/contentLang\s*=\s*([^\n；;]+)/gi)) {
    for (const part of m[1]!.split(/[,，、\s]+/)) {
      const t = part.trim();
      if (/^[a-z]{2}-[A-Za-z]{2}$/i.test(t)) {
        const [a, b] = t.split("-");
        found.add(`${a!.toLowerCase()}-${b!.toUpperCase()}`);
      }
    }
  }
  return [...found];
}

/** 去掉助手行，避免把反问话术里的示例 locale 当成用户已确认 */
function userFacingTranscript(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => {
      if (/^\s*\[\d+\]\s*助手:/.test(line) || /^\s*助手:/.test(line)) return false;
      if (/^\s*assistant\s*:/i.test(line)) return false;
      return true;
    })
    .join("\n");
}

/** 「三种小语种/几种语言」等集合信号，但未列成员 */
export function impliesLangSetWithoutMembers(text: string): boolean {
  const userText = userFacingTranscript(text);
  const t = userText.replace(/\s+/g, "");
  const setNearLang =
    /([一二三四五六七八九十两几多各\d]+种|几种|多种|各类).{0,16}(小语种|语种|语言|locale|contentLang)/.test(
      t,
    ) ||
    /(小语种|语种|语言|locale|contentLang).{0,16}([一二三四五六七八九十两几多各\d]+种|几种|多种|各类)/.test(
      t,
    );
  if (!setNearLang) return false;
  return extractLocalesFromText(userText).length === 0;
}

function isCompletionMetric(metricId: string | undefined, mergedNl: string): boolean {
  return (
    metricId === "avg_max_progress" ||
    (/完播|最大进度/.test(mergedNl) && !/人均/.test(mergedNl))
  );
}

function isNonPivotMetric(metricId: string | undefined, mergedNl: string): boolean {
  return (
    metricId === "avg_watch_second_per_user" ||
    metricId === "uniq_users" ||
    metricId === "sum_watch_second" ||
    (/人均/.test(mergedNl) && !/完播|最大进度/.test(mergedNl))
  );
}

/**
 * 确定性策略：禁止臆造 locale；反问优先级 time → contentLang → result_layout → metric；
 * clarifySlot 归一。在 parse / schema-agent 出口调用。
 */
export function enforceStructurePolicy(
  result: StructuredAskResult,
  transcript: string,
): StructuredAskResult {
  const userText = userFacingTranscript(transcript);
  const chatLocales = extractLocalesFromText(userText);
  const mergedNl =
    (result.status === "ok" ? result.mergedNl : result.mergedNl) || transcript;
  const needLangMembers =
    impliesLangSetWithoutMembers(transcript) ||
    (impliesLangSetWithoutMembers(mergedNl) && chatLocales.length === 0);

  const filters =
    result.status === "ok"
      ? { ...result.filters }
      : { ...(result.partialFilters || {}) };
  const langs = filters.contentLang || [];

  // 「N种小语种」未列码：一律先问 contentLang，丢掉模型臆造的 locale
  if (needLangMembers) {
    const partial = { ...filters };
    delete partial.contentLang;
    return {
      status: "clarify",
      clarify:
        "请确认要统计的具体内容语言列表（可多选）。请直接列出语言码（如 te-IN、ta-IN、ml-IN），不要猜测未说明的语种。",
      clarifySlot: "contentLang",
      mergedNl: mergedNl || undefined,
      time: result.time,
      partialFilters: partial,
    };
  }

  // 用户已写出部分 locale 时，过滤掉对话中未出现的码（半臆造）
  if (langs.length && chatLocales.length) {
    const allowed = new Set(chatLocales.map((x) => x.toLowerCase()));
    const kept = langs.filter((l) => allowed.has(l.toLowerCase()));
    if (kept.length !== langs.length) {
      if (!kept.length) {
        const partial = { ...filters };
        delete partial.contentLang;
        return {
          status: "clarify",
          clarify: "请确认要统计的具体内容语言列表（可多选）。",
          clarifySlot: "contentLang",
          mergedNl: mergedNl || undefined,
          time: result.time,
          partialFilters: partial,
        };
      }
      filters.contentLang = kept;
    }
  }

  if (result.status === "clarify") {
    const slot = normalizeClarifySlot(result.clarifySlot);
    return {
      ...result,
      clarifySlot: slot,
      partialFilters: Object.keys(filters).length ? filters : result.partialFilters,
    };
  }

  const time = result.time;
  const metricId = result.metricId;
  const outputDims = result.outputDims || [];
  let layout = result.layout;
  let pivotDim = result.pivotDim;

  if (!time?.start || !time?.end) {
    return {
      status: "clarify",
      clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。",
      clarifySlot: "time_range",
      mergedNl: mergedNl || undefined,
      partialFilters: filters,
    };
  }
  if (!metricId) {
    return {
      status: "clarify",
      clarify: "请确认指标口径（例如人均观看时长、观看人数、最大进度平均值）。",
      clarifySlot: "metric",
      mergedNl: mergedNl || undefined,
      time,
      partialFilters: filters,
    };
  }

  const finalLangs = filters.contentLang || [];
  if (
    isCompletionMetric(metricId, mergedNl) &&
    finalLangs.length > 1 &&
    !outputDims.includes("contentLang") &&
    outputDims.length > 0 &&
    !layout
  ) {
    if (/宽表|wide/i.test(userText)) layout = "wide";
    else if (/长表|(?:\blong\b)/i.test(userText)) layout = "long";
    else {
      return {
        status: "clarify",
        clarify:
          "多种语言作为筛选且不按语言分组时，请选择宽表（每种语言一列）或长表（语言作为行）。回复「宽表」或「长表」即可。",
        clarifySlot: "result_layout",
        mergedNl: mergedNl || undefined,
        time,
        partialFilters: filters,
      };
    }
  }

  if (!layout && /宽表|wide/i.test(userText)) layout = "wide";
  if (!layout && /长表|(?:\blong\b)/i.test(userText)) layout = "long";
  if (layout && finalLangs.length > 1 && !pivotDim) pivotDim = "contentLang";

  return {
    status: "ok",
    mergedNl: mergedNl || "（多轮合并问数）",
    time,
    filters,
    outputDims,
    layout,
    pivotDim,
    metricId,
    notes: [...(result.notes || [])],
  };
}

export function buildStructureSystemPrompt(pack: AnalyticsPack, clockIsoDate: string): string {
  return [
    "You are an analytics slot-filling engine. Read the FULL conversation and emit ONE JSON object.",
    "Do NOT write SQL. Merge all user turns + clarifications; assistant clarify messages are context only.",
    "Clarify priority (ask ONE slot at a time): time_range → contentLang → result_layout → metric.",
    "NEVER invent contentLang/movieType codes. If user says N种小语种/几种语言 without listing codes, status=clarify clarifySlot=contentLang (probe first). Do NOT guess te-IN/ta-IN/ml-IN.",
    "Only put a locale into filters.contentLang if it appears in a USER turn (or 澄清选择).",
    "When user lists locales like te-IN, put filters.contentLang.",
    "When user names a channel (IndiaA), put filters.channel.",
    "人均观看时长 → metricId avg_watch_second_per_user; 观看人数/UV → uniq_users; 时长合计 → sum_watch_second; 最大进度平均/完播(已点名最大进度) → avg_max_progress.",
    "IMPORTANT layout rule: only require layout wide|long when metricId is avg_max_progress. For avg_watch_second_per_user / uniq_users / sum_watch_second, multi contentLang = WHERE IN — do NOT clarify result_layout.",
    "If avg_max_progress and multiple grounded contentLang and outputDims are watch_date+channel (contentLang not in outputDims), clarify result_layout (clarifySlot MUST be result_layout, never layout).",
    `Today (business clock date): ${clockIsoDate}.`,
    "",
    "Catalog:",
    packCatalogHint(pack),
    "",
    "JSON schema:",
    "{",
    '  "status": "ok" | "clarify",',
    '  "mergedNl": string,',
    '  "clarify": string,',
    '  "clarifySlot": "time_range"|"contentLang"|"movieType"|"result_layout"|"metric",',
    '  "time": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },',
    '  "filters": { "channel"?: string[], "contentLang"?: string[], "movieType"?: string[] },',
    '  "outputDims": string[],',
    '  "layout": "wide"|"long",',
    '  "pivotDim": string,',
    '  "metricId": string,',
    '  "notes": string[]',
    "}",
    "Output JSON only.",
  ].join("\n");
}

export function parseStructureResponse(raw: string, transcript = ""): StructuredAskResult {
  const obj = extractJsonObject(raw) as Record<string, unknown>;
  const status = String(obj.status || "").toLowerCase();
  const mergedNl = String(obj.mergedNl || "").trim();
  const timeRaw = obj.time && typeof obj.time === "object" ? (obj.time as Record<string, unknown>) : null;
  const time =
    timeRaw && timeRaw.start && timeRaw.end
      ? { start: String(timeRaw.start).slice(0, 10), end: String(timeRaw.end).slice(0, 10) }
      : undefined;

  if (status === "clarify") {
    const metricIdEarly = obj.metricId ? String(obj.metricId) : undefined;
    const filtersEarly = normalizeFilters(obj.filters);
    const outputDimsEarly = asStringArray(obj.outputDims);
    const clarifySlot = normalizeClarifySlot(String(obj.clarifySlot || "unknown"));
    if (
      clarifySlot === "result_layout" &&
      isNonPivotMetric(metricIdEarly, mergedNl) &&
      time?.start &&
      time?.end &&
      metricIdEarly
    ) {
      return enforceStructurePolicy(
        {
          status: "ok",
          mergedNl: mergedNl || "（多轮合并问数）",
          time,
          filters: filtersEarly,
          outputDims: outputDimsEarly,
          metricId: metricIdEarly,
          notes: ["coerced_skip_result_layout_for_non_pivot_metric"],
        },
        transcript || mergedNl,
      );
    }
    return enforceStructurePolicy(
      {
        status: "clarify",
        clarify: String(obj.clarify || "请补充条件").trim(),
        clarifySlot,
        mergedNl: mergedNl || undefined,
        time,
        partialFilters: filtersEarly,
      },
      transcript || mergedNl,
    );
  }

  const filters = normalizeFilters(obj.filters);
  const outputDims = asStringArray(obj.outputDims);
  const layoutRaw = String(obj.layout || "").toLowerCase();
  const layout: ResultLayout | undefined =
    layoutRaw === "wide" || layoutRaw === "long" ? layoutRaw : undefined;
  const pivotDim = obj.pivotDim ? String(obj.pivotDim) : undefined;
  const metricId = obj.metricId ? String(obj.metricId) : undefined;

  return enforceStructurePolicy(
    {
      status: "ok",
      mergedNl: mergedNl || "（多轮合并问数）",
      time,
      filters,
      outputDims,
      layout,
      pivotDim,
      metricId,
      notes: asStringArray(obj.notes),
    },
    transcript || mergedNl,
  );
}

export function buildStructureUserPrompt(messages: ConversationTurn[]): string {
  return [
    "Full conversation transcript (must use ALL turns):",
    formatConversationTranscript(messages),
    "",
    "Emit the JSON now.",
  ].join("\n");
}
