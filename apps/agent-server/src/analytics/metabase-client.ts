import { config } from "../config.js";
import type { DatasetResult } from "./types.js";

let cachedSession: { id: string; at: number } | null = null;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

async function login(): Promise<string> {
  if (cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) return cachedSession.id;
  const { url, username, password } = config.metabase;
  if (!username || !password) throw new Error("METABASE_USERNAME/PASSWORD missing");
  const resp = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await resp.json()) as { id?: string };
  if (!resp.ok || !data?.id) throw new Error(`Metabase login ${resp.status}`);
  cachedSession = { id: data.id, at: Date.now() };
  return data.id;
}

export async function runNativeDataset(
  sql: string,
  databaseId = config.metabase.databaseId,
): Promise<DatasetResult> {
  const t0 = Date.now();
  const session = await login();
  const resp = await fetch(`${config.metabase.url}/api/dataset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Metabase-Session": session,
    },
    body: JSON.stringify({ type: "native", database: databaseId, native: { query: sql } }),
  });
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
}

/** Clear cached session (tests / credential rotation). */
export function clearMetabaseSessionCache(): void {
  cachedSession = null;
}
