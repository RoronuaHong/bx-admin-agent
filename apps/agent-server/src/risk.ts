// 工具风险分级（单一真相，写操作安全闸门 P0-1）。
// 原则：工具危不危险，由「工具自己的声明 + 服务端策略」决定；判定只在服务端做；
// 默认 fail-closed（未声明 / 查不到 = 未知 = 按最保守处理，绝不静默放行）。
// 判定与参数内容无关、与模型措辞无关。
import type { RiskLevel } from "@bx/shared";
import { BUILTIN_RISK } from "./builtins.js";
import { describeMcpTool, type McpToolFacts } from "./mcp/hub.js";
import { isReadOnlySql } from "./sql-readonly.js";

/** 判据来源，便于排障与审计。 */
export type RiskSource = "tool-config" | "builtin" | "server-config" | "annotation" | "default" | "grant" | "sql-readonly";

export interface RiskVerdict {
  /** 生效级别。 */
  level: RiskLevel;
  /** 是否来自「未知」兜底（决定能否被会话级只读授权覆盖）。 */
  unknown: boolean;
  /** 未声明工具按 MCP_UNKNOWN_TOOLS=deny 配置为直接拒绝（不进入确认流程）。 */
  deny: boolean;
  /** 人话原因，进确认卡与审计。 */
  reason: string;
  /** 判据来源。 */
  source: RiskSource;
  /** 是否有外部副作用（false = 仅本对话工作区）。 */
  external: boolean;
  /** 所属 MCP 服务器（内置工具为 undefined）。 */
  serverId?: string;
}

export type UnknownToolPolicy = "confirm" | "deny" | "allow";

/** 未声明 / 查不到的工具的处理口径：confirm（默认，弹确认卡）| deny（直接拒绝）| allow（按只读放行）。 */
export function unknownToolPolicy(): UnknownToolPolicy {
  const raw = (process.env.MCP_UNKNOWN_TOOLS || "confirm").trim().toLowerCase();
  return raw === "deny" || raw === "allow" ? (raw as UnknownToolPolicy) : "confirm";
}

const MCP_PREFIX = "mcp__";

function unknownVerdict(reason: string, serverId?: string): RiskVerdict {
  const policy = unknownToolPolicy();
  if (policy === "allow") {
    return {
      level: "read",
      unknown: true,
      deny: false,
      reason: `${reason}；未声明级别，按当前口径（allow）放行`,
      source: "default",
      external: true,
      ...(serverId ? { serverId } : {}),
    };
  }
  return {
    level: "destructive",
    unknown: true,
    deny: policy === "deny",
    reason: policy === "deny" ? `${reason}；未声明级别，按当前口径（deny）直接拒绝` : reason,
    source: "default",
    external: true,
    ...(serverId ? { serverId } : {}),
  };
}

/**
 * 判定优先级（从上到下，先命中先用）：
 * 1. 工具级显式覆盖（服务器配置的 toolRisks）
 * 2. 内置工具登记表（builtins.BUILTIN_RISK）
 * 3. 服务器级 requireConfirm: true → destructive
 * 4. 注解 readOnlyHint: true → read
 * 5. 注解 destructiveHint: true → destructive
 * 6. 注解 readOnlyHint/destructiveHint 均 false → write
 * 7. 未命中（含查不到）→ MCP_UNKNOWN_TOOLS 兜底（默认 confirm）
 * 8. unknown 且该服务器在会话级只读授权名单里 → 降为 read（仅对未声明工具生效）
 */
export function resolveToolRisk(
  namespacedName: string,
  grantServers?: ReadonlySet<string>,
  args?: Record<string, unknown>,
): RiskVerdict {
  if (!namespacedName.startsWith(MCP_PREFIX)) {
    const builtin = BUILTIN_RISK[namespacedName];
    if (builtin) {
      return {
        level: builtin.level,
        unknown: false,
        deny: false,
        reason: builtin.reason,
        source: "builtin",
        external: builtin.scope === "external",
      };
    }
    // 既不是内置工具也带不上 MCP 命名空间：执行层本来就会失败，但闸门仍按未知保守处理。
    return unknownVerdict("工具不在已登记清单中（未声明级别）");
  }

  const described = describeMcpTool(namespacedName);
  if (!described) {
    // 查不到（未连接 / 已被裁剪 / 名字不存在）：fail-closed，绝不静默放行。
    // 仍从命名空间解析所属服务器：会话级只读授权按服务器生效，不受连接状态影响。
    const serverId = namespacedName.slice(MCP_PREFIX.length).split("__")[0] || undefined;
    const verdict = unknownVerdict("工具未连接或不在当前注册表中（未声明级别）", serverId);
    return applyGrant(verdict, grantServers);
  }

  const bare = namespacedName.slice(MCP_PREFIX.length).split("__").pop() || namespacedName;
  // 通配 "*"：本服务器全部未单独声明的工具按同一级别处理（如纯生成类服务器整体定 read）。
  const toolOverride =
    described.toolRisks?.[bare] ?? described.toolRisks?.[namespacedName] ?? described.toolRisks?.["*"];
  const base = { ...(described.serverId ? { serverId: described.serverId } : {}), external: true };
  const downgraded = readOnlySqlOk(described, bare, args) && toolOverride === "destructive";
  // 原生 SQL 工具（readOnlySqlTools 声明的，如 bi 的 run_native_query）：本次若是非只读查询，
  // 服务端闸门直接硬拒——双重保险：即便 MCP 适配器层被绕过/改坏，这里仍拦一道。
  // 与服务端 src/sql-readonly.ts 口径一致（首词白名单 + 全文黑名单 + 危险构造）。
  const sqlRejected = isNativeSqlRejected(described.readOnlySqlTools, bare, args);

  let verdict: RiskVerdict;
  if (toolOverride === "read" || toolOverride === "write" || toolOverride === "destructive") {
    if (sqlRejected) {
      verdict = {
        ...base,
        level: "destructive",
        unknown: false,
        deny: true,
        reason: `该工具（${bare}）为原生 SQL 工具，服务端判定本次为非只读查询，按只读策略拒绝执行`,
        source: "sql-readonly",
      };
    } else {
      verdict = {
        ...base,
        level: downgraded ? "read" : toolOverride,
        unknown: false,
        deny: false,
        reason: downgraded
          ? "该工具为原生 SQL 工具，服务端判定本次为只读查询"
          : `工具级配置将该操作定为 ${toolOverride}`,
        source: downgraded ? "sql-readonly" : "tool-config",
      };
    }
  } else if (described.requireConfirm) {
    verdict = {
      ...base,
      level: "destructive",
      unknown: false,
      deny: false,
      reason: `服务器「${described.serverId}」配置为默认需确认`,
      source: "server-config",
    };
  } else {
    const hints = described.annotations || {};
    if (hints.readOnlyHint === true) {
      verdict = { ...base, level: "read", unknown: false, deny: false, reason: "该工具声明为只读（readOnlyHint）", source: "annotation" };
    } else if (hints.destructiveHint === true) {
      verdict = {
        ...base,
        level: "destructive",
        unknown: false,
        deny: false,
        reason: "该工具声明为破坏性操作（destructiveHint）",
        source: "annotation",
      };
    } else if (hints.readOnlyHint === false && hints.destructiveHint === false) {
      verdict = { ...base, level: "write", unknown: false, deny: false, reason: "该工具声明为写操作（非只读非破坏性）", source: "annotation" };
    } else {
      verdict = unknownVerdict("该工具未声明操作级别", described.serverId);
    }
  }

  // 会话级只读授权：仅对「未声明级别」且同服务器的工具生效（第 8 条）。
  return applyGrant(verdict, grantServers);
}

function readOnlySqlOk(d: McpToolFacts, bare: string, args?: Record<string, unknown>): boolean {
  if (!d.readOnlySqlTools?.includes(bare)) return false;
  return isReadOnlySql(args?.query) || isReadOnlySql(args?.sql);
}

/** 原生 SQL 工具的非只读查询判定（服务端硬拒判据）。仅对 `readOnlySqlTools` 声明的工具生效；可单测。 */
export function isNativeSqlRejected(
  readOnlySqlTools: string[] | undefined,
  bare: string,
  args?: Record<string, unknown>,
): boolean {
  if (!readOnlySqlTools?.includes(bare)) return false;
  return !(isReadOnlySql(args?.query) || isReadOnlySql(args?.sql));
}

/** 第 8 条：unknown 且服务器在授权名单里 → 降为 read。 */
function applyGrant(verdict: RiskVerdict, grantServers?: ReadonlySet<string>): RiskVerdict {
  if (verdict.unknown && !verdict.deny && verdict.serverId && grantServers?.has(verdict.serverId)) {
    return { ...verdict, level: "read", reason: `${verdict.reason}；本对话已授权该服务器按只读处理`, source: "grant" };
  }
  return verdict;
}

/**
 * 该次调用是否需要用户确认（deny 由调用方先行拒绝，不走本判定）：
 * 只有**外部副作用**且级别非 read 才确认；内置工作区写（fs_write 等，无外部副作用）免确认。
 */
export function verdictNeedsConfirm(v: RiskVerdict): boolean {
  if (!v.external) return false;
  return v.level !== "read";
}
