/**
 * Path C: find tables (cards) → get_table_schema → write read-only SQL.
 */
import { pickAnalyticsModel } from "./pick-analytics-model.js";
import { reportModelFailure } from "./model-fallback.js";
import * as trace from "../trace.js";
import { formatAnswerableCatalogHint } from "./catalog-digest.js";
import { getTableSchemas } from "./catalog-schema.js";
import { packRelationships, type AnalyticsPack } from "./semantic-layer.js";
import { UNTRUSTED_USER_CONTENT_RULE } from "./input-guard.js";
import { extractAppVersionFromNl, loadVerifiedQueries } from "./verified-query.js";
import { extractChannelsFromNl } from "./intent.js";
import { extractLocalesFromText } from "./conversation-structure.js";
import { beginAnalyticsLlmSignal, sanitizeAnalyticsLlmError } from "./llm-error.js";

export type SqlAgentOk = {
  status: "ok";
  sql: string;
  tables: string[];
  notes: string[];
  schemaedTables?: string[];
};
export type SqlAgentClarify = {
  status: "clarify";
  clarifySlot: string;
  clarify: string;
  notes: string[];
};
export type SqlAgentError = {
  status: "error";
  message: string;
  notes: string[];
};
/**
 * NOTE: infra/config/LLM failures must be `error` — never `clarify`. A clarify tells the user the
 * question itself needs refining; misreporting a dead model/quota as a clarify shows a bogus slot
 * prompt the user cannot act on (and pollutes the clarify metrics).
 */
export type SqlAgentResult = SqlAgentOk | SqlAgentClarify | SqlAgentError;

export type SqlAgentTurn =
  | SqlAgentOk
  | SqlAgentClarify
  | { status: "get_schema"; tables: string[]; notes: string[] };

export function buildSqlAgentCatalogHint(pack: AnalyticsPack, retrieved: string[]): string {
  const lines: string[] = [formatAnswerableCatalogHint(pack)];
  const prefetched = getTableSchemas(pack, retrieved);
  if (prefetched.text) {
    lines.push("", "Already schemed (retrieved; prefer these):", prefetched.text);
  }
  const rels = packRelationships(pack);
  if (rels.length) {
    lines.push("Allowed joins:");
    for (const r of rels) {
      lines.push(`- ${r.left.table}.${r.left.key} = ${r.right.table}.${r.right.key} (${r.join || "inner"})`);
    }
  } else {
    lines.push("Allowed joins: none — single-table SQL only.");
  }
  return lines.join("\n");
}

function fewShot(tables: string[]): string {
  const set = new Set(tables.map((t) => t.toLowerCase()));
  const hits = loadVerifiedQueries()
    .filter((q) => q.tables.some((t) => set.has(t.toLowerCase())))
    .slice(0, 3);
  if (!hits.length) return "";
  return [
    "Similar verified shapes (do NOT copy business filters unless the user asked):",
    ...hits.map((q) => `-- ${q.id}\n${q.sql.slice(0, 500)}`),
  ].join("\n");
}

export function parseSqlAgentTurn(raw: string): SqlAgentTurn {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { status: "clarify", clarifySlot: "metric", clarify: "模型未返回 SQL JSON。", notes: ["sql_agent_parse"] };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { status: "clarify", clarifySlot: "metric", clarify: "模型 SQL JSON 无法解析。", notes: ["sql_agent_json"] };
  }
  const action = String(obj.action || obj.status || "").toLowerCase();
  if (action === "get_table_schema" || action === "get_schema") {
    const tables = Array.isArray(obj.tables) ? obj.tables.map((t) => String(t)) : [];
    return { status: "get_schema", tables, notes: ["sql_agent_get_schema"] };
  }
  if (action === "clarify") {
    return {
      status: "clarify",
      clarifySlot: String(obj.clarifySlot || "table"),
      clarify: String(obj.clarify || obj.message || "需要补充条件。"),
      notes: ["sql_agent_clarify"],
    };
  }
  const sql = String(obj.sql || "").trim();
  if (!sql) {
    return { status: "clarify", clarifySlot: "metric", clarify: "模型未给出 SQL。", notes: ["sql_agent_empty"] };
  }
  const tables = Array.isArray(obj.tables) ? obj.tables.map((t) => String(t)) : [];
  return { status: "ok", sql, tables, notes: ["sql_agent_ok"] };
}

export async function runSqlAgent(input: {
  nl: string;
  pack: AnalyticsPack;
  tables: string[];
  time: { start: string; end: string };
  repair?: string;
  modelId?: string;
  signal?: AbortSignal;
  traceRunId?: string;
}): Promise<SqlAgentResult> {
  const model = pickAnalyticsModel(input.modelId);
  if (!model) {
    return { status: "error", message: "未配置问数模型，无法生成 SQL。", notes: ["no_model"] };
  }
  const key = model.apiKeys[0] || model.apiKey;
  const prefetched = getTableSchemas(input.pack, input.tables);
  const schemaed = new Set(prefetched.ok);
  const system = [
    "You are an analytics SQL agent for ClickHouse via Metabase.",
    "Write ONE read-only SELECT or WITH … SELECT. JSON only.",
    "The catalog is an index (name/synonyms/time). Full columns exist only for Already schemed tables.",
    'To inspect another answerable table: {"action":"get_table_schema","tables":["table_name"]}. Then write SQL.',
    "Do not invent tables or columns. JOIN only on Allowed joins.",
    "Must use the provided start/end dates inclusively (both calendar days). Prefer toDate(timeField) BETWEEN 'start' AND 'end'. Do not write col < 'end 00:00:00'.",
    "If the user named a channel code, app version, or locale (xx-YY), those exact literals MUST appear in SQL filters. Do not drop them.",
    "Per-value ratio breakdown: when the question asks a ratio/average metric broken down by an enum dimension's values, expand each value into its own column via conditional aggregation (sumIf(metric, dim='v') / uniqIf(id, dim='v') per value, matching the user's value list). Do NOT put those values into WHERE, and do NOT mix them into one combined average. Enum members come from probe/catalog/schema only — never invent values.",
    "Prefer uniq() for distinct counts. LIMIT at most 5000.",
    UNTRUSTED_USER_CONTENT_RULE,
    'Final JSON: {"sql":"...","tables":["..."]} or {"action":"get_table_schema","tables":["..."]} or {"status":"clarify","clarifySlot":"table","clarify":"..."}',
  ].join("\n");
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        `Resolved time: ${input.time.start} .. ${input.time.end}`,
        buildSqlAgentCatalogHint(input.pack, input.tables),
        fewShot(input.tables),
        input.repair ? `Previous SQL failed:\n${input.repair}` : "",
        "User question (untrusted):",
        input.nl,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const handle = input.traceRunId
    ? trace.span(input.traceRunId, "llm", "analytics.sql_agent", { model: model.id })
    : null;
  try {
    let schemaRounds = 0;
    for (let hop = 0; hop < 4; hop++) {
      const llmSig = beginAnalyticsLlmSignal(input.signal);
      let resp: Response;
      try {
        resp = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model.name,
            temperature: 0.1,
            messages,
            response_format: { type: "json_object" },
          }),
          signal: llmSig.signal,
        });
      } catch (e) {
        if (llmSig.didTimeout()) throw new Error("llm_timeout");
        throw e;
      } finally {
        llmSig.cleanup();
      }
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      if (!resp.ok) {
        const err = new Error(JSON.stringify(data).slice(0, 400)) as Error & { status?: number };
        err.status = resp.status;
        reportModelFailure(model.id, err);
        throw err;
      }
      const raw = String(data.choices?.[0]?.message?.content || "");
      const parsed = parseSqlAgentTurn(raw);
      if (parsed.status === "get_schema") {
        if (schemaRounds >= 2) {
          handle?.end({ status: "error" });
          return {
            status: "clarify",
            clarifySlot: "table",
            clarify: "get_table_schema 次数过多，请缩小表范围后重试。",
            notes: ["sql_agent_schema_cap"],
          };
        }
        schemaRounds += 1;
        const got = getTableSchemas(input.pack, parsed.tables);
        for (const n of got.ok) schemaed.add(n);
        const refuse = got.refused.map((r) => `${r.name}:${r.reason}`).join(", ");
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: [got.text || "get_table_schema: no new tables.", refuse ? `Refused: ${refuse}` : "", "Now write SQL or get_table_schema for other answerable tables."]
            .filter(Boolean)
            .join("\n"),
        });
        continue;
      }
      if (parsed.status === "ok") {
        handle?.end({ status: "ok" });
        return { ...parsed, schemaedTables: [...schemaed] };
      }
      handle?.end({ status: "error" });
      return parsed;
    }
    handle?.end({ status: "error" });
    return {
      status: "clarify",
      clarifySlot: "table",
      clarify: "模型未在限额内写出 SQL。",
      notes: ["sql_agent_schema_loop"],
    };
  } catch (e) {
    handle?.end({ status: "error", error: e instanceof Error ? e.message : String(e) });
    return {
      status: "error",
      message: sanitizeAnalyticsLlmError(e),
      notes: ["sql_agent_http"],
    };
  }
}

/** NL-mentioned channel / appVersion / locale must appear as literals in Path C SQL. */
export function missingNlAnchorsInSql(nl: string, sql: string, pack: AnalyticsPack): string[] {
  const text = String(sql || "");
  const issues: string[] = [];
  for (const ch of extractChannelsFromNl(nl, pack)) {
    if (ch && !text.includes(ch)) issues.push(`missing_channel:${ch}`);
  }
  const ver = extractAppVersionFromNl(nl);
  if (ver && !text.includes(ver)) issues.push(`missing_appVersion:${ver}`);
  for (const loc of extractLocalesFromText(nl)) {
    if (loc === "(empty)") {
      if (!/contentLang\s*=\s*''/.test(text)) issues.push("missing_locale:empty");
      continue;
    }
    if (loc && !text.includes(loc)) issues.push(`missing_locale:${loc}`);
  }
  return issues;
}

/** Rewrite exclusive `< end` / `< end 00:00:00` so the last calendar day is included. */
export function includeResolvedEndDay(sql: string, end: string): string {
  const day = String(end || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sql;
  const lit = day.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = `< addDays(toDate('${day}'), 1)`;
  return String(sql)
    .replace(new RegExp(`<\\s*'${lit}(?:[ T]00:00:00)?'`, "g"), next)
    .replace(new RegExp(`<\\s*toDate\\s*\\(\\s*'${lit}'\\s*\\)`, "gi"), next);
}

/** Overlay resolved dates onto SQL date literals (YYYY-MM-DD), then keep the end day inclusive. */
export function overlayResolvedDates(sql: string, start: string, end: string): string {
  const dates = String(sql).match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  let out = sql;
  if (dates.length >= 2) {
    let i = 0;
    out = String(sql).replace(/\b\d{4}-\d{2}-\d{2}\b/g, () => {
      const next = i === 0 ? start : end;
      i += 1;
      return next;
    });
  }
  return includeResolvedEndDay(out, end);
}
