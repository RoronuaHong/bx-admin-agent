import type { BaseUrlKey, CountryConfig } from "@bx/shared";
import { createDecipheriv } from "node:crypto";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function unwrapUpstream(payload: unknown) {
  const data = asRecord(payload);
  if (data && typeof data.code === "number") {
    if (data.code !== 0 && data.code !== 200) {
      throw new Error(String(data.message || data.msg || `上游错误 ${data.code}`));
    }
    return data.result ?? data.data ?? payload;
  }
  return payload;
}

export function resolveBaseUrl(country: CountryConfig, key: BaseUrlKey) {
  if (key === "user") return country.userUrl.replace(/\/$/, "");
  if (key === "film") return country.filmUrl.replace(/\/$/, "");
  if (key === "gather") return (country.gatherUrl || "").replace(/\/$/, "");
  return country.backendUrl.replace(/\/$/, "");
}

function tryDecrypt(ciphertext: string, keyB64: string) {
  try {
    const rawKey = Buffer.from(keyB64, "base64");
    const key = rawKey.length >= 16 ? rawKey.subarray(0, 16) : Buffer.concat([rawKey, Buffer.alloc(16)]).subarray(0, 16);
    const buf = Buffer.from(ciphertext, "base64");
    const decipher = createDecipheriv("aes-128-cbc", key, key);
    const text = Buffer.concat([decipher.update(buf), decipher.final()]).toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const securityKeyCache = new Map<string, string>();

async function getSecurityKey(country: CountryConfig) {
  const cacheKey = country.userUrl;
  if (securityKeyCache.has(cacheKey)) return securityKeyCache.get(cacheKey) || "";
  const host = country.userUrl.replace(/\/$/, "");
  const url = `${host}/v0.1/system/getSecurityKey/5?clientType=5&lang=en-US`;
  const response = await fetch(url, { headers: { clientType: "5" } });
  const json = unwrapUpstream(await response.json());
  const key = typeof json === "string" ? json : "";
  if (key) securityKeyCache.set(cacheKey, key);
  return key;
}

export async function callUpstream(options: {
  country: CountryConfig;
  token: string;
  method: "GET" | "POST";
  path: string;
  baseUrlKey: BaseUrlKey;
  params: Record<string, unknown>;
}) {
  const base = resolveBaseUrl(options.country, options.baseUrlKey);
  if (!base) throw new Error("该环境未配置对应 API 地址");
  const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const url = new URL(`${base}${path}`);
  url.searchParams.set("clientType", "5");
  url.searchParams.set("lang", "en-US");
  const headers: Record<string, string> = { clientType: "5" };
  if (options.token) headers.Authorization = options.token;
  const reqParams = options.params || {}; // params 可选：避免 Object.entries(undefined) 崩溃

  let init: RequestInit = { method: options.method, headers };
  if (options.method === "GET") {
    url.searchParams.set("_t", String(Date.now()));
    for (const [key, value] of Object.entries(reqParams)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  } else {
    headers["Content-Type"] = "application/json";
    init = {
      ...init,
      headers,
      body: JSON.stringify({ lang: "en-US", clientType: 5, ...reqParams }),
    };
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    const key = await getSecurityKey(options.country);
    const decrypted = key ? tryDecrypt(text, key) : null;
    if (decrypted) json = decrypted;
    else if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
  }

  const obj = asRecord(json);
  if (obj && typeof obj.code !== "number" && typeof json === "string") {
    const key = await getSecurityKey(options.country);
    const decrypted = key ? tryDecrypt(json as string, key) : null;
    if (decrypted) json = decrypted;
  }

  if (!response.ok) {
    const err = asRecord(json);
    throw new Error(String(err?.message || err?.msg || `HTTP ${response.status}`));
  }
  return unwrapUpstream(json);
}
