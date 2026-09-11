/**
 * Channel grounding hard gate — membership against ClickHouse/Metabase domain.
 */

import { isAbortError, runNativeDataset, type MetabaseRunOpts } from "./metabase-client.js";
import type { AnalyticsPack } from "./semantic-layer.js";

export type GroundingOk = {
  status: "ok";
  filters: Record<string, string[]>;
  notes: string[];
};

export type GroundingClarify = {
  status: "clarify";
  clarifySlot: string;
  message: string;
  filters: Record<string, string[]>;
  options: Array<{ id: string; label: string }>;
  notes: string[];
};

export type GroundingResult = GroundingOk | GroundingClarify;

function canonMap(values: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of values) {
    if (!v) continue;
    m.set(v.toLowerCase(), v);
  }
  return m;
}

async function existingChannelMembers(input: {
  pack: AnalyticsPack;
  channels: string[];
  opts?: MetabaseRunOpts;
}): Promise<{ ok: true; foundCanon: Map<string, string>; sample: string[] } | { ok: false; error: string }> {
  const table = input.pack.tables[0]?.name;
  if (!table) return { ok: false, error: "no_table" };
  const channels = [...new Set(input.channels.map(String).filter((c) => c !== "(empty)" && c !== ""))];
  if (!channels.length) return { ok: true, foundCanon: new Map(), sample: [] };

  // Case-insensitive match; return DB-canonical spelling
  const sql = [
    `SELECT channel, count() AS c`,
    `FROM ${table}`,
    `WHERE lower(channel) IN (${channels.map((c) => `'${c.replace(/'/g, "''").toLowerCase()}'`).join(", ")})`,
    `GROUP BY channel`,
    `ORDER BY c DESC`,
    `LIMIT 50`,
  ].join(" ");

  try {
    const res = await runNativeDataset(sql, input.pack.datasource.metabaseDatabaseId, input.opts);
    if (!res.ok) return { ok: false, error: res.error || "probe_failed" };
    const found: string[] = [];
    for (const row of res.rows) {
      if (row[0] != null && String(row[0]).length) found.push(String(row[0]));
    }
    const sampleSql = [
      `SELECT channel, count() AS c`,
      `FROM ${table}`,
      `GROUP BY channel`,
      `ORDER BY c DESC`,
      `LIMIT 15`,
    ].join(" ");
    const sampleRes = await runNativeDataset(
      sampleSql,
      input.pack.datasource.metabaseDatabaseId,
      input.opts,
    );
    const sample: string[] = [];
    if (sampleRes.ok) {
      for (const row of sampleRes.rows) {
        const v = row[0] == null ? "" : String(row[0]);
        if (v) sample.push(v);
      }
    }
    return { ok: true, foundCanon: canonMap(found), sample };
  } catch (e) {
    if (input.opts?.signal?.aborted || isAbortError(e)) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function groundChannelFilters(input: {
  pack: AnalyticsPack;
  filters: Record<string, string[]>;
  opts?: MetabaseRunOpts;
}): Promise<GroundingResult> {
  const filters = { ...input.filters };
  const channels = [...(filters.channel || [])];
  if (!channels.length) return { status: "ok", filters, notes: [] };

  const checked = await existingChannelMembers({
    pack: input.pack,
    channels,
    opts: input.opts,
  });
  if (!checked.ok) {
    return {
      status: "clarify",
      clarifySlot: "channel",
      message: `无法校验渠道是否存在（${checked.error}）。请从候选中选择渠道。`,
      filters,
      options: [],
      notes: [`channel_grounding_probe_failed:${checked.error}`],
    };
  }

  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const c of channels) {
    if (c === "(empty)" || c === "") {
      resolved.push(c);
      continue;
    }
    const hit = checked.foundCanon.get(c.toLowerCase());
    if (hit) resolved.push(hit);
    else unresolved.push(c);
  }

  if (!unresolved.length) {
    filters.channel = [...new Set(resolved)];
    return {
      status: "ok",
      filters,
      notes: [`channel_grounded:${filters.channel.join(",")}`],
    };
  }

  const options = [
    ...checked.sample.map((id) => ({ id, label: id })),
    ...[...checked.foundCanon.values()]
      .filter((id) => !checked.sample.includes(id))
      .map((id) => ({ id, label: id })),
  ];
  const seen = new Set<string>();
  const uniqOpts = options.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  return {
    status: "clarify",
    clarifySlot: "channel",
    message: `无法识别渠道「${unresolved.join("、")}」，请从候选中选择（不会使用未校验的渠道码查数）。`,
    filters: {
      ...filters,
      ...(resolved.length ? { channel: [...new Set(resolved)] } : (() => {
        const next = { ...filters };
        delete next.channel;
        return next;
      })()),
    },
    options: uniqOpts.slice(0, 20),
    notes: [`channel_ungrounded:${unresolved.join(",")}`],
  };
}
