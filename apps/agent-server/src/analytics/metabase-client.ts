import { config } from "../config.js";
import type { DatasetResult } from "./types.js";

let cachedSession: { id: string; at: number } | null = null;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type MetabaseRunOpts = { signal?: AbortSignal };

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
  const signal = opts?.signal;
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

/** Clear cached session (tests / credential rotation). */
export function clearMetabaseSessionCache(): void {
  cachedSession = null;
}
