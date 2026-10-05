/**
 * MCP 服务器来源校验（P2，OWASP ASI06 供应链）。
 *
 * 缺口：stdio 传输会 `spawn` 任意命令，命令白名单（ASI06 第一层）能挡「不在名单里的命令」，
 * 但挡不住「名单里的命令本身被换掉了」——比如 `npx` 还在，但它指向的可执行文件已被替换。
 * 这里补的是**来源漂移检测**：记住每个服务器首次登记时的命令形态（command / args / cwd），
 * 之后一旦变了就告警并留审计——不管它是被谁、以什么方式改的。
 *
 * 刻意不做：不做可执行文件的内容哈希（体积大、跨平台差异大、更新依赖就会误报）；
 * 只做**声明形态**的指纹，成本低且能抓到绝大多数「被换掉」的情形。
 * 严格模式（`MCP_REQUIRE_PROVENANCE=on`）下检测到漂移会拒绝连接（fail-closed）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadServers, type McpServerConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(__dirname, "..", "..", ".data", "mcp-provenance.json");

export interface ProvenanceRecord {
  id: string;
  /** 声明形态的指纹（command + args + cwd）。 */
  digest: string;
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
}

/** 纯函数：声明形态指纹。 */
export function provenanceDigest(cfg: Pick<McpServerConfig, "command" | "args" | "cwd">): string {
  const canonical = {
    command: String(cfg.command || "").trim(),
    args: (cfg.args || []).map((a) => String(a)),
    cwd: String(cfg.cwd || "").trim(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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
 * 首次出现记为 `new`（不算漂移——没有基线），形态变了才是 `changed`。
 */
export function checkProvenanceRecords(
  servers: McpServerConfig[],
  store: Record<string, ProvenanceRecord>,
): ProvenanceCheck[] {
  return servers.map((cfg) => {
    const digest = provenanceDigest(cfg);
    const prev = store[cfg.id];
    if (!prev) return { id: cfg.id, status: "new" as ProvenanceStatus, digest };
    if (prev.digest !== digest) {
      return { id: cfg.id, status: "changed" as ProvenanceStatus, digest, previousDigest: prev.digest };
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
  const checks = checkProvenanceRecords(servers, store);
  const now = Date.now();
  for (const cfg of servers) {
    const check = checks.find((c) => c.id === cfg.id);
    if (!check || check.status === "changed") continue; // 漂移的不覆盖，保留旧指纹供比对
    const prev = store[cfg.id];
    store[cfg.id] = {
      id: cfg.id,
      digest: check.digest,
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
    if (check.status === "changed") {
      console.warn(
        `[mcp:provenance] 服务器 ${check.id} 的命令形态与首次登记不一致（疑似被替换）${strict ? "；严格模式已拒绝连接" : ""}`,
      );
    }
  }
  return { checks, blocked, strict };
}

/** 严格模式下被调用方询问：这个服务器是否因来源漂移被禁。 */
export function provenanceBlocked(id: string): boolean {
  if (process.env.MCP_REQUIRE_PROVENANCE !== "on") return false;
  const report = verifyProvenance();
  return report.blocked.includes(id);
}
