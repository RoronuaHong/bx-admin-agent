/**
 * MCP 服务器来源校验（OWASP ASI06 供应链）。
 *
 * 两层：
 * 1. 命令形态（command / args / cwd）以及 HTTP 的 url、请求头哈希。
 *    挡住「把 node 换成别的程序」和「把远程端点或鉴权头换掉」。请求头只进哈希，不落原文。
 * 2. 参数里指向的本仓库脚本内容（.js / .mjs / .cjs / .ts，单文件最多读 1MB）。
 *    挡住「命令仍是 node scripts/metabase-mcp.mjs，文件内容被换掉」。
 *    不哈希 node / npx 自身：运行时升级会误报，那一层靠命令白名单。
 *
 * 旧基线只有形态指纹时，形态没变就补记脚本哈希，不算漂移。
 * 严格模式（`MCP_REQUIRE_PROVENANCE=on`）下，形态或脚本内容变了都拒绝连接。
 * 非严格模式：形态变化保留旧基线并持续告警；仅脚本变化告警一次后接受新内容，避免改脚本时每次启动都报。
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadServers, type McpServerConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(__dirname, "..", "..", ".data", "mcp-provenance.json");

const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs", ".ts"]);
const MAX_SCRIPT_BYTES = 1_048_576;

export interface ProvenanceRecord {
  id: string;
  /** 形态 + 脚本内容的指纹。旧记录可能只有形态指纹。 */
  digest: string;
  /** 仅 command / args / cwd。缺省时用 digest（旧记录）。 */
  shape?: string;
  /** 参数中本地脚本的 sha256。缺省表示尚未做内容基线。 */
  scripts?: Record<string, string>;
  command: string;
  args: string[];
  cwd?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type ProvenanceStatus = "unchanged" | "changed" | "new";

export interface ProvenanceCheck {
  id: string;
  status: ProvenanceStatus;
  digest: string;
  previousDigest?: string;
  /** 命令形态没变，只是脚本内容变了。 */
  scriptDrift?: boolean;
}

type DigestCfg = Pick<McpServerConfig, "command" | "args" | "cwd" | "url" | "headers">;

/** 请求头参与指纹，但调用方只保存哈希，不把鉴权原文写进基线文件。 */
export function headerFingerprint(headers?: Record<string, string>): string {
  const entries = Object.entries(headers || {})
    .map(([key, value]) => [key, String(value)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * 纯函数：来源指纹。
 * 传入 files 时把脚本内容哈希算进去。
 * `endpoint: false` 时不含 url / 请求头，用来认出升级前的旧基线。
 */
export function provenanceDigest(
  cfg: DigestCfg,
  files?: Record<string, string>,
  endpoint = true,
): string {
  const canonical: Record<string, unknown> = {
    command: String(cfg.command || "").trim(),
    args: (cfg.args || []).map((a) => String(a)),
    cwd: String(cfg.cwd || "").trim(),
  };
  if (endpoint) {
    const url = String(cfg.url || "").trim();
    if (url) canonical.url = url;
    if (cfg.headers && Object.keys(cfg.headers).length) canonical.hdr = headerFingerprint(cfg.headers);
  }
  if (files) canonical.files = files;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sameScripts(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && a[key] === b[key]);
}

/**
 * 参数里能对上的本地脚本，返回「参数原文 → sha256」。
 * read 缺省时读磁盘；单测可注入。读不到或不是脚本扩展名则跳过。
 */
export function scriptFileDigests(
  cfg: Pick<McpServerConfig, "args" | "cwd">,
  read: (abs: string) => Buffer | null = readScriptPrefix,
  baseDir = process.cwd(),
): Record<string, string> {
  const base = String(cfg.cwd || "").trim() || baseDir;
  const out: Record<string, string> = {};
  for (const raw of cfg.args || []) {
    const arg = String(raw);
    if (!arg || arg.startsWith("-")) continue;
    if (!SCRIPT_EXT.has(extname(arg).toLowerCase())) continue;
    const buf = read(resolve(base, arg));
    if (!buf) continue;
    out[arg] = createHash("sha256").update(buf).digest("hex");
  }
  return out;
}

function readScriptPrefix(abs: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, MAX_SCRIPT_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return Buffer.concat([Buffer.from(String(size)), buf]);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function load(): Record<string, ProvenanceRecord> {
  try {
    if (!existsSync(STORE_PATH)) return {};
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ProvenanceRecord>) : {};
  } catch {
    return {};
  }
}

function save(store: Record<string, ProvenanceRecord>): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  } catch (err) {
    console.warn(`[mcp:provenance] 写入失败：${String((err as Error)?.message || err)}`);
  }
}

/**
 * 纯函数：拿当前服务器配置与已登记记录比对。
 * 首次出现记为 `new`（不算漂移）。命令、url、请求头或脚本内容变了才是 `changed`。
 * 旧基线还没有 url / 请求头时，这两项第一次补记不算漂移。
 */
export function checkProvenanceRecords(
  servers: McpServerConfig[],
  store: Record<string, ProvenanceRecord>,
  scriptsById: Record<string, Record<string, string>> = {},
): ProvenanceCheck[] {
  return servers.map((cfg) => {
    const scripts = scriptsById[cfg.id] ?? {};
    const legacyShape = provenanceDigest(cfg, undefined, false);
    const shape = provenanceDigest(cfg);
    const digest = provenanceDigest(cfg, scripts);
    const prev = store[cfg.id];
    if (!prev) return { id: cfg.id, status: "new" as ProvenanceStatus, digest };
    const prevShape = prev.shape || prev.digest;
    const adoptingEndpoint = prevShape === legacyShape && shape !== legacyShape;
    const filesSame = sameScripts(prev.scripts ?? {}, scripts);
    if ((prev.scripts === undefined && prev.digest === legacyShape) || (adoptingEndpoint && filesSame)) {
      return { id: cfg.id, status: "unchanged" as ProvenanceStatus, digest };
    }
    if (prevShape !== shape) {
      return { id: cfg.id, status: "changed" as ProvenanceStatus, digest, previousDigest: prev.digest };
    }
    if (prev.digest !== digest) {
      return {
        id: cfg.id,
        status: "changed" as ProvenanceStatus,
        digest,
        previousDigest: prev.digest,
        scriptDrift: true,
      };
    }
    return { id: cfg.id, status: "unchanged" as ProvenanceStatus, digest };
  });
}

export interface ProvenanceReport {
  checks: ProvenanceCheck[];
  /** 严格模式下这些服务器应被拒绝连接。 */
  blocked: string[];
  strict: boolean;
}

/** 读取全部服务器并比对，同时把「首次出现 / 形态一致」的记回存储。 */
export function verifyProvenance(): ProvenanceReport {
  const strict = process.env.MCP_REQUIRE_PROVENANCE === "on";
  let servers: McpServerConfig[] = [];
  try {
    servers = loadServers();
  } catch (err) {
    console.warn(`[mcp:provenance] 读取服务器配置失败：${String((err as Error)?.message || err)}`);
    return { checks: [], blocked: [], strict };
  }
  const store = load();
  const scriptsById: Record<string, Record<string, string>> = {};
  for (const cfg of servers) {
    if (cfg.transport !== "stdio") continue;
    scriptsById[cfg.id] = scriptFileDigests(cfg);
  }
  const checks = checkProvenanceRecords(servers, store, scriptsById);
  const now = Date.now();
  for (const cfg of servers) {
    const check = checks.find((c) => c.id === cfg.id);
    if (!check) continue;
    const scriptOnly = check.status === "changed" && check.scriptDrift && !strict;
    if (check.status === "changed" && !scriptOnly) continue;
    const prev = store[cfg.id];
    store[cfg.id] = {
      id: cfg.id,
      digest: check.digest,
      shape: provenanceDigest(cfg),
      scripts: scriptsById[cfg.id] ?? {},
      command: String(cfg.command || ""),
      args: (cfg.args || []).map((a) => String(a)),
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
    };
  }
  save(store);
  const blocked = strict ? checks.filter((c) => c.status === "changed").map((c) => c.id) : [];
  for (const check of checks) {
    if (check.status !== "changed") continue;
    const what = check.scriptDrift ? "脚本内容" : "命令形态";
    console.warn(
      `[mcp:provenance] 服务器 ${check.id} 的${what}与已登记基线不一致${strict ? "；严格模式下拒绝新连接" : ""}`,
    );
  }
  return { checks, blocked, strict };
}

/** 严格模式下被调用方询问：这个服务器是否因来源漂移被禁。 */
export function provenanceBlocked(id: string): boolean {
  if (process.env.MCP_REQUIRE_PROVENANCE !== "on") return false;
  const report = verifyProvenance();
  return report.blocked.includes(id);
}
