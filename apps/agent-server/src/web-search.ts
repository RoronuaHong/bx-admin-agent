/**
 * 联网检索（内置工具 `web_search` / `fetch_url` 的 provider 层）。
 *
 * 为什么是工具而不是「请求级联网开关」：Chat Completions 协议里没有 `web_search_preview`
 * （那是 Responses API 的内置工具），塞进 `tools` 只会被网关 400 拒掉。真正的联网能力必须是一个
 * 普通 function tool：模型经函数调用通道发起 → 服务端调搜索服务 → 结果按不可信内容定界回灌。
 *
 * 设计约束：
 * - provider 可配（env `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_API_KEY` / `WEB_SEARCH_BASE_URL`），
 *   未配置时按 `webSearchStatus()` 诚实上报「不可用」，绝不静默失败或让模型凭记忆作答；
 * - 不写死任何业务词：本模块只有协议字段名（title/url/snippet）与通用网络语义；
 * - `fetch_url` 只允许公网 http/https，阻断本机与私网地址（基础 SSRF 防护，与语言无关）。
 *   残余风险：解析校验与真正建连之间 DNS 可被换绑（rebinding），根治需在建连层固定已校验的 IP。
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** 一条检索结果（各 provider 归一化后的最小字段集）。 */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 命中该结果的搜索引擎/数据源（provider 提供时带上，便于模型判断来源）。 */
  source?: string;
  publishedAt?: string;
}

export type WebSearchOutcome = { ok: true; hits: WebSearchHit[]; provider: string } | { ok: false; error: string };

/** 网页抓取结果。 */
export type FetchOutcome =
  | { ok: true; title: string; text: string; url: string; bytes: number; truncated: boolean }
  | { ok: false; error: string };

interface ProviderSpec {
  /** 是否必须显式配置 baseUrl（自建实例没有公共默认地址）。 */
  requireBaseUrl?: boolean;
  defaultBaseUrl?: string;
  /** 是否必须配置 API key。 */
  requireKey?: boolean;
}

/** 支持的 provider：只声明协议差异，具体请求在下方各自的实现里。 */
const PROVIDERS: Record<string, ProviderSpec> = {
  // 自建元搜索（JSON API）：免密钥，需要自己的实例地址。
  searxng: { requireBaseUrl: true },
  tavily: { defaultBaseUrl: "https://api.tavily.com/search", requireKey: true },
  serper: { defaultBaseUrl: "https://google.serper.dev/search", requireKey: true },
  brave: { defaultBaseUrl: "https://api.search.brave.com/res/v1/web/search", requireKey: true },
};

export interface WebSearchConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResults: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS_CAP = 20;
/** 抓取正文的上限：超出即截断（工具结果会再经截断/卸载预算，这里先兜住单页体积）。 */
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_CHARS = 6000;

function env(name: string): string {
  return (process.env[name] || "").trim();
}

function positiveInt(raw: string, fallback: number, cap: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), cap);
}

/**
 * 读取联网检索配置；返回 null = 本次不可用（原因由 `webSearchStatus` 给出）。
 * 每次现读 env：改配置后重启即生效，无需额外状态。
 */
export function readWebSearchConfig(): WebSearchConfig | null {
  const provider = env("WEB_SEARCH_PROVIDER").toLowerCase();
  const spec = PROVIDERS[provider];
  if (!provider || !spec) return null;
  const baseUrl = (env("WEB_SEARCH_BASE_URL") || spec.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  const apiKey = env("WEB_SEARCH_API_KEY");
  if (spec.requireKey && !apiKey) return null;
  return {
    provider,
    baseUrl,
    apiKey,
    timeoutMs: positiveInt(env("WEB_SEARCH_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, 120000),
    maxResults: positiveInt(env("WEB_SEARCH_MAX_RESULTS"), DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP),
  };
}

/**
 * 能力可用性 + 不可用原因（进系统提示的「工具通道现状」，让模型如实说明而不是编造）。
 * 原因文案只描述配置缺口，不含任何业务语义。
 */
export function webSearchStatus(): { available: boolean; provider?: string; reason?: string } {
  const provider = env("WEB_SEARCH_PROVIDER").toLowerCase();
  if (!provider) return { available: false, reason: "未配置联网检索服务（WEB_SEARCH_PROVIDER）" };
  const spec = PROVIDERS[provider];
  if (!spec) {
    return {
      available: false,
      reason: `不支持的联网检索 provider：${provider}（可选 ${Object.keys(PROVIDERS).join(" / ")}）`,
    };
  }
  if (spec.requireBaseUrl && !env("WEB_SEARCH_BASE_URL")) {
    return { available: false, provider, reason: "缺少检索服务地址（WEB_SEARCH_BASE_URL）" };
  }
  if (spec.requireKey && !env("WEB_SEARCH_API_KEY")) {
    return { available: false, provider, reason: "缺少检索服务密钥（WEB_SEARCH_API_KEY）" };
  }
  return { available: true, provider };
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, error: `检索服务返回 ${response.status}：${body.slice(0, 200)}` };
    }
    try {
      return { ok: true, data: JSON.parse(body) };
    } catch {
      return { ok: false, error: `检索服务返回非 JSON 响应：${body.slice(0, 200)}` };
    }
  } catch (error) {
    return { ok: false, error: `检索请求失败：${(error as Error).message}` };
  }
}

function text(value: unknown, cap = 600): string {
  const raw = typeof value === "string" ? value : "";
  // 摘要里的换行/连续空白统一压平，保证一条结果占固定行数、便于模型引用。
  return raw.replace(/\s+/g, " ").trim().slice(0, cap);
}

function pick(node: unknown, key: string): unknown {
  return node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
}

/**
 * 执行一次联网检索。provider 返回结构差异全部在这里归一化；
 * 任何失败都以 `{ ok: false, error }` 返回（工具层如实上报给模型，不抛异常打断对话）。
 */
export async function webSearch(query: string, count?: number): Promise<WebSearchOutcome> {
  const config = readWebSearchConfig();
  if (!config) return { ok: false, error: webSearchStatus().reason || "联网检索不可用" };
  const q = query.trim();
  if (!q) return { ok: false, error: "检索关键词为空" };
  const limit = Math.min(count && count > 0 ? Math.floor(count) : config.maxResults, MAX_RESULTS_CAP);

  try {
    if (config.provider === "searxng") {
      const url = new URL(`${config.baseUrl}/search`);
      url.searchParams.set("q", q);
      url.searchParams.set("format", "json");
      url.searchParams.set("safesearch", env("WEB_SEARCH_SAFE_SEARCH") || "0");
      const language = env("WEB_SEARCH_LANGUAGE");
      if (language) url.searchParams.set("language", language);
      const result = await requestJson(url.toString(), { headers: { Accept: "application/json" } }, config.timeoutMs);
      if (!result.ok) return result;
      const rows = Array.isArray(pick(result.data, "results")) ? (pick(result.data, "results") as unknown[]) : [];
      return {
        ok: true,
        provider: config.provider,
        hits: rows.slice(0, limit).map((row) => ({
          title: text(pick(row, "title"), 200),
          url: text(pick(row, "url"), 500),
          snippet: text(pick(row, "content")),
          ...(text(pick(row, "engine"), 40) ? { source: text(pick(row, "engine"), 40) } : {}),
          ...(text(pick(row, "publishedDate"), 40) ? { publishedAt: text(pick(row, "publishedDate"), 40) } : {}),
        })),
      };
    }

    if (config.provider === "tavily") {
      const result = await requestJson(
        config.baseUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            api_key: config.apiKey,
            query: q,
            max_results: limit,
            search_depth: env("WEB_SEARCH_DEPTH") || "basic",
            include_answer: false,
          }),
        },
        config.timeoutMs,
      );
      if (!result.ok) return result;
      const rows = Array.isArray(pick(result.data, "results")) ? (pick(result.data, "results") as unknown[]) : [];
      return {
        ok: true,
        provider: config.provider,
        hits: rows.slice(0, limit).map((row) => ({
          title: text(pick(row, "title"), 200),
          url: text(pick(row, "url"), 500),
          snippet: text(pick(row, "content")),
          ...(text(pick(row, "published_date"), 40) ? { publishedAt: text(pick(row, "published_date"), 40) } : {}),
        })),
      };
    }

    if (config.provider === "serper") {
      const result = await requestJson(
        config.baseUrl,
        {
          method: "POST",
          headers: { "X-API-KEY": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ q, num: limit }),
        },
        config.timeoutMs,
      );
      if (!result.ok) return result;
      const rows = Array.isArray(pick(result.data, "organic")) ? (pick(result.data, "organic") as unknown[]) : [];
      return {
        ok: true,
        provider: config.provider,
        hits: rows.slice(0, limit).map((row) => ({
          title: text(pick(row, "title"), 200),
          url: text(pick(row, "link"), 500),
          snippet: text(pick(row, "snippet")),
          ...(text(pick(row, "date"), 40) ? { publishedAt: text(pick(row, "date"), 40) } : {}),
        })),
      };
    }

    // brave
    const url = new URL(config.baseUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("count", String(limit));
    const result = await requestJson(
      url.toString(),
      { headers: { "X-Subscription-Token": config.apiKey, Accept: "application/json" } },
      config.timeoutMs,
    );
    if (!result.ok) return result;
    const web = pick(result.data, "web");
    const rows = Array.isArray(pick(web, "results")) ? (pick(web, "results") as unknown[]) : [];
    return {
      ok: true,
      provider: config.provider,
      hits: rows.slice(0, limit).map((row) => ({
        title: text(pick(row, "title"), 200),
        url: text(pick(row, "url"), 500),
        snippet: text(pick(row, "description")),
        ...(text(pick(row, "age"), 40) ? { publishedAt: text(pick(row, "age"), 40) } : {}),
      })),
    };
  } catch (error) {
    return { ok: false, error: `检索失败：${(error as Error).message}` };
  }
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据地址段）
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试保留段
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

/** 把 IPv6 展开成 8 组 16 位整数；非法返回 null。 */
function expandV6(ip: string): number[] | null {
  let text = ip;
  const tailV4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tailV4) {
    const [p, q, r, s] = tailV4[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tailV4[1]!.length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** 本机 / 私网 / 保留地址判定（IP 字面量）。v4 映射、NAT64 内嵌的 v4 按内嵌地址再判一次。 */
export function isBlockedIp(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const embedded = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedV4(embedded); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return isBlockedV4(embedded); // ::a.b.c.d（已废弃的兼容写法）
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedV4(embedded); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g[0]! & 0xff00) === 0xff00) return true; // 组播
  return false;
}

/** 主机名层面的拦截（不做解析）：localhost 族与私网 IP 字面量。 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host)) return isBlockedIp(host);
  return false;
}

type HostLookup = (hostname: string) => Promise<string[]>;

const systemLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * 校验一跳抓取目标：协议、主机名、以及 DNS 解析出的**每一个**地址。
 * 只看主机名拦不住 `127.0.0.1.nip.io` 这类解析到内网的公网域名。
 */
export const FETCH_DNS_FAILED = "抓取失败：域名解析失败";

export async function checkFetchTarget(target: URL, lookup: HostLookup = systemLookup): Promise<string | null> {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return `只支持 http/https 链接（当前：${target.protocol}）`;
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHost(host)) return "出于安全考虑，不抓取本机、私网或保留地址";
  if (isIP(host)) return null;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return FETCH_DNS_FAILED;
  }
  if (!addresses.length || addresses.some((addr) => isBlockedIp(addr))) {
    return "出于安全考虑，不抓取本机、私网或保留地址";
  }
  return null;
}

const MAX_REDIRECTS = 5;

/** HTML → 纯文本：去掉不可见结构与标签，压缩空白（够用即可，不做完整 DOM 解析）。 */
function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = body
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x?([0-9a-f]+);/gi, (_, code: string) => {
      const point = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(point) && point > 31 && point < 0x10ffff ? String.fromCodePoint(point) : " ";
    });
  return {
    title,
    text: decoded
      .split("\n")
      .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n"),
  };
}

/**
 * 抓取网页正文（只读、公网 http/https）。
 * 限制：单页 512KB / 正文 6000 字，超出截断并如实标注，避免把上下文一次性吃满。
 */
export async function fetchPage(
  rawUrl: string,
  opts: { signal?: AbortSignal; lookup?: HostLookup } = {},
): Promise<FetchOutcome> {
  let target: URL;
  try {
    target = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "链接格式不正确" };
  }
  const config = readWebSearchConfig();
  const timeoutMs = config?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    // 重定向手动跟随：fetch 自动跟随时跳到内网地址不会再经过校验。
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const blocked = await checkFetchTarget(target, opts.lookup);
      if (blocked) return { ok: false, error: blocked };
      response = await fetch(target.toString(), {
        redirect: "manual",
        signal,
        headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) break;
      await response.body?.cancel().catch(() => undefined);
      if (hop === MAX_REDIRECTS) return { ok: false, error: `抓取失败：重定向超过 ${MAX_REDIRECTS} 次` };
      try {
        target = new URL(location, target);
      } catch {
        return { ok: false, error: "抓取失败：重定向地址格式不正确" };
      }
    }
    if (!response) return { ok: false, error: "抓取失败：没有响应" };
    if (!response.ok) return { ok: false, error: `抓取失败：HTTP ${response.status}` };
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type && !/text\/html|application\/xhtml|text\/plain|application\/json/.test(type)) {
      return { ok: false, error: `不支持的内容类型：${type.split(";")[0]}` };
    }
    // 边读边计数：超上限即停止读取，避免大文件把内存与上下文撑满。
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, error: "抓取失败：响应缺少正文" };
    const decoder = new TextDecoder();
    let raw = "";
    let bytes = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value?.byteLength || 0;
      raw += decoder.decode(value, { stream: true });
      if (bytes >= MAX_PAGE_BYTES) {
        truncated = true;
        await reader.cancel().catch((err) => {
          console.debug(`[web-search] reader 取消收尾异常：${String((err as Error)?.message || err)}`);
        });
        break;
      }
    }
    const plain = /application\/json/.test(type) ? { title: "", text: raw.trim() } : htmlToText(raw);
    if (!plain.text) return { ok: false, error: "网页没有可提取的文本内容" };
    const clipped = plain.text.length > MAX_PAGE_CHARS;
    return {
      ok: true,
      url: target.toString(),
      title: plain.title,
      text: plain.text.slice(0, MAX_PAGE_CHARS),
      bytes,
      truncated: truncated || clipped,
    };
  } catch (error) {
    return { ok: false, error: `抓取失败：${(error as Error).message}` };
  }
}
