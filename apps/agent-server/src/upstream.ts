import type { BaseUrlKey, CountryConfig } from "@bx/shared";
import { createDecipheriv } from "node:crypto";
import type { ApiEnvironment } from "./worker-registry.js";

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

/** 按国家线 × 环境解析 API 基址（M1：test=COUNTRY_*_URL；prod=COUNTRY_*_PROD_*_URL） */
export function resolveCountryApiUrls(
  country: CountryConfig,
  environment: ApiEnvironment = "test",
): { backendUrl: string; userUrl: string; filmUrl: string; gatherUrl: string } {
  if (environment === "test") {
    return {
      backendUrl: country.backendUrl || "",
      userUrl: country.userUrl || "",
      filmUrl: country.filmUrl || "",
      gatherUrl: country.gatherUrl || "",
    };
  }
  const envKey = country.id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    backendUrl: (process.env[`COUNTRY_${envKey}_PROD_BACKEND_URL`] || "").trim(),
    userUrl: (process.env[`COUNTRY_${envKey}_PROD_USER_URL`] || "").trim(),
    filmUrl: (process.env[`COUNTRY_${envKey}_PROD_FILM_URL`] || "").trim(),
    gatherUrl: (process.env[`COUNTRY_${envKey}_PROD_GATHER_URL`] || "").trim(),
  };
}

export function resolveBaseUrl(
  country: CountryConfig,
  key: BaseUrlKey,
  environment: ApiEnvironment = "test",
) {
  const urls = resolveCountryApiUrls(country, environment);
  if (key === "user") return urls.userUrl.replace(/\/$/, "");
  if (key === "film") return urls.filmUrl.replace(/\/$/, "");
  if (key === "gather") return (urls.gatherUrl || "").replace(/\/$/, "");
  return urls.backendUrl.replace(/\/$/, "");
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
  /** M1：API 环境；缺省 test */
  environment?: ApiEnvironment;
}) {
  const environment = options.environment ?? "test";
  const base = resolveBaseUrl(options.country, options.baseUrlKey, environment);
  if (!base) {
    throw new Error(
      environment === "prod"
        ? "生产环境未配置对应 API 地址；请在服务端设置 COUNTRY_<ID>_PROD_*_URL"
        : "该环境未配置对应 API 地址",
    );
  }
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
