import { config } from "../config.js";
import type { DatasetResult } from "./types.js";

let cachedSession: { id: string; at: number } | null = null;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type MetabaseRunOpts = { signal?: AbortSignal; timeoutMs?: number };

function mergeTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal?: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const ms = timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
  if (!ms) return { signal, cleanup: () => {}, didTimeout: () => false };

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);

  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onParentAbort);
    },
    didTimeout: () => timedOut,
  };
}

/** Strip trailing slash so path join `${url}/api/...` is safe. */
export function normalizeMetabaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

/** Mask username/email for logs (never log full credentials). */
export function maskMetabaseUser(u: string): string {
  if (!u) return "(empty)";
  if (u.includes("@")) {
    const [a, b] = u.split("@");
    return `${a.slice(0, 2)}***@${b}`;
  }
  return `${u.slice(0, 2)}***`;
}

export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: string; message?: string; code?: number };
  if (err.name === "AbortError") return true;
  if (typeof err.message === "string" && /aborted|abort/i.test(err.message)) return true;
  // Node undici sometimes uses code 20 (ABORT_ERR)
  if (err.code === 20) return true;
  return false;
}

function rethrowIfAborted(e: unknown, signal?: AbortSignal): never | void {
  if (signal?.aborted || isAbortError(e)) {
    if (e instanceof Error) throw e;
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  }
}

async function login(force = false, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!force && cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return cachedSession.id;
  }
  const { url, username, password } = config.metabase;
  if (!username || !password) throw new Error("METABASE_USERNAME/PASSWORD missing");
  const resp = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal,
  });
  const data = (await resp.json()) as { id?: string };
  if (!resp.ok || !data?.id) throw new Error(`Metabase login ${resp.status}`);
  cachedSession = { id: data.id, at: Date.now() };
  return data.id;
}

async function postDataset(sql: string, databaseId: number, session: string, signal?: AbortSignal) {
  return fetch(`${config.metabase.url}/api/dataset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Metabase-Session": session,
    },
    body: JSON.stringify({ type: "native", database: databaseId, native: { query: sql } }),
    signal,
  });
}

export async function runNativeDataset(
  sql: string,
  databaseId = config.metabase.databaseId,
  opts?: MetabaseRunOpts,
): Promise<DatasetResult> {
  const timeoutMs =
    opts?.timeoutMs ??
    Number(process.env.ANALYTICS_QUERY_TIMEOUT_MS || process.env.METABASE_TIMEOUT_MS || 120000);
  const { signal, cleanup, didTimeout } = mergeTimeoutSignal(opts?.signal, timeoutMs);
  const t0 = Date.now();
  try {
    signal?.throwIfAborted();
    let session = await login(false, signal);
    let resp = await postDataset(sql, databaseId, session, signal);
    if (resp.status === 401) {
      clearMetabaseSessionCache();
      session = await login(true, signal);
      resp = await postDataset(sql, databaseId, session, signal);
    }
    const data = (await resp.json()) as {
      status?: string;
      error?: string;
      data?: { rows?: unknown[][]; cols?: Array<{ name?: string; display_name?: string }> };
    };
    const ms = Date.now() - t0;
    if (!resp.ok || data?.status === "failed") {
      return { ok: false, cols: [], rows: [], error: String(data?.error || resp.status), ms };
    }
    const cols = (data?.data?.cols ?? []).map((c) => c.name || c.display_name || "");
    return { ok: true, cols, rows: data?.data?.rows ?? [], ms };
  } catch (e) {
    if (opts?.signal?.aborted) rethrowIfAborted(e, opts.signal);
    if (isAbortError(e) && didTimeout()) {
      return {
        ok: false,
        cols: [],
        rows: [],
        error: `query_timeout:${timeoutMs}ms`,
        ms: Date.now() - t0,
      };
    }
    if (isAbortError(e)) rethrowIfAborted(e, signal);
    return {
      ok: false,
      cols: [],
      rows: [],
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    };
  } finally {
    cleanup();
  }
}

function toTemplateTags(
  parameters?: Record<string, string>,
): Array<{ type: string; target: [string, [string, string]]; value: string }> | undefined {
  if (!parameters || !Object.keys(parameters).length) return undefined;
  return Object.entries(parameters).map(([name, value]) => ({
    type: "category",
    target: ["variable", ["template-tag", name]],
    value,
  }));
}

async function postCardQuery(
  questionId: number,
  session: string,
  parameters?: Record<string, string>,
  signal?: AbortSignal,
) {
  const body: Record<string, unknown> = {
    ignore_cache: false,
    collection_preview: false,
  };
  const params = toTemplateTags(parameters);
  if (params?.length) body.parameters = params;
  return fetch(`${config.metabase.url}/api/card/${questionId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Metabase-Session": session,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Run a saved Metabase question/card (`POST /api/card/:id/query`).
 * Optional template-tag parameters (e.g. start/end date).
 */
export async function runMetabaseQuestion(
  questionId: number,
  parameters?: Record<string, string>,
  opts?: MetabaseRunOpts,
): Promise<DatasetResult> {
  const signal = opts?.signal;
  const t0 = Date.now();
  if (!Number.isFinite(questionId) || questionId <= 0) {
    return { ok: false, cols: [], rows: [], error: "invalid questionId", ms: 0 };
  }
  try {
    signal?.throwIfAborted();
    let session = await login(false, signal);
    let resp = await postCardQuery(questionId, session, parameters, signal);
    if (resp.status === 401) {
      clearMetabaseSessionCache();
      session = await login(true, signal);
      resp = await postCardQuery(questionId, session, parameters, signal);
    }
    const data = (await resp.json()) as {
      status?: string;
      error?: string;
      data?: { rows?: unknown[][]; cols?: Array<{ name?: string; display_name?: string }> };
    };
    const ms = Date.now() - t0;
    if (!resp.ok || data?.status === "failed") {
      return { ok: false, cols: [], rows: [], error: String(data?.error || resp.status), ms };
    }
    const cols = (data?.data?.cols ?? []).map((c) => c.name || c.display_name || "");
    return { ok: true, cols, rows: data?.data?.rows ?? [], ms };
  } catch (e) {
    rethrowIfAborted(e, signal);
    return {
      ok: false,
      cols: [],
      rows: [],
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    };
  }
}

async function metabaseGetJson<T>(
  path: string,
  opts?: MetabaseRunOpts,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const signal = opts?.signal;
  try {
    signal?.throwIfAborted();
    let session = await login(false, signal);
    let resp = await fetch(`${config.metabase.url}${path}`, {
      headers: { "X-Metabase-Session": session },
      signal,
    });
    if (resp.status === 401) {
      clearMetabaseSessionCache();
      session = await login(true, signal);
      resp = await fetch(`${config.metabase.url}${path}`, {
        headers: { "X-Metabase-Session": session },
        signal,
      });
    }
    const data = (await resp.json()) as T;
    if (!resp.ok) {
      return { ok: false, error: `metabase_get ${path} → ${resp.status}` };
    }
    return { ok: true, data };
  } catch (e) {
    rethrowIfAborted(e, signal);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type MetabaseFieldMeta = {
  id: number;
  name: string;
  display_name?: string;
  description?: string | null;
  table_id?: number;
  has_field_values?: string;
};

type DbMetadata = {
  tables?: Array<{
    id?: number;
    name?: string;
    schema?: string;
    fields?: Array<{
      id?: number;
      name?: string;
      display_name?: string;
      description?: string | null;
      has_field_values?: string;
    }>;
  }>;
};

const fieldMetaCache = new Map<string, { at: number; field: MetabaseFieldMeta }>();
const FIELD_META_TTL_MS = 30 * 60 * 1000;

/** Locate a table.field in Metabase DB metadata (cached). */
export async function findMetabaseField(
  databaseId: number,
  tableName: string,
  fieldName: string,
  opts?: MetabaseRunOpts,
): Promise<{ ok: true; field: MetabaseFieldMeta } | { ok: false; error: string }> {
  const cacheKey = `${databaseId}:${tableName}.${fieldName}`;
  const hit = fieldMetaCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FIELD_META_TTL_MS) {
    return { ok: true, field: hit.field };
  }
  const meta = await metabaseGetJson<DbMetadata>(
    `/api/database/${databaseId}/metadata?include_hidden=true`,
    opts,
  );
  if (!meta.ok) return meta;
  const table = (meta.data.tables || []).find((t) => t.name === tableName);
  if (!table) return { ok: false, error: `table_not_found:${tableName}` };
  const f = (table.fields || []).find((x) => x.name === fieldName);
  if (!f?.id) return { ok: false, error: `field_not_found:${tableName}.${fieldName}` };
  const field: MetabaseFieldMeta = {
    id: f.id,
    name: f.name || fieldName,
    display_name: f.display_name,
    description: f.description,
    table_id: table.id,
    has_field_values: f.has_field_values,
  };
  fieldMetaCache.set(cacheKey, { at: Date.now(), field });
  return { ok: true, field };
}

export type MetabaseFieldValuesPayload = {
  values?: unknown[];
  field_id?: number;
  has_more_values?: boolean;
};

/** Field values (often [[code, label], …] when remapped in Metabase Admin). */
export async function fetchMetabaseFieldValues(
  fieldId: number,
  opts?: MetabaseRunOpts,
): Promise<{ ok: true; values: unknown[] } | { ok: false; error: string }> {
  const res = await metabaseGetJson<MetabaseFieldValuesPayload>(`/api/field/${fieldId}/values`, opts);
  if (!res.ok) return res;
  return { ok: true, values: Array.isArray(res.data.values) ? res.data.values : [] };
}

/** Clear cached session (tests / credential rotation). */
export function clearMetabaseSessionCache(): void {
  cachedSession = null;
  fieldMetaCache.clear();
}
