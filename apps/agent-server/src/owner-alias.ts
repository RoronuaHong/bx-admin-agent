// 设备身份合并（owner alias）。
//
// 为什么需要：`bx_agent_oid` 是**按 host 作用域**的 cookie（setCookie 没设 domain → 浏览器只把它
// 发给当初种下它的那个 host）。于是同一台设备用 localhost / 局域网 IP / 127.0.0.1 打开，
// 会拿到三个互不相同的 owner：各自是「一台设备」，任务与对话对不上号 →
// 列表为空、首屏开不出对话、任务结果看不见（owner.ts 里「owner 不变、对话资产不孤儿化」的意图被打破）。
//
// 做什么：登记「同一台设备的不同身份」→ 规范 owner（canonical）的别名。请求带别名 cookie 时，
// 统一解析成 canonical，**存量数据不用迁移**就能被看见（对话/任务仍挂在 canonical 名下）。
//
// 语义边界：owner 只是信任域内的防串台标签（见 owner.ts 的注释），不是认证。
// 所以把「确定是同一台设备」的两个身份合并是安全的；不做的是「把设备身份交给链接携带」（?owner= 仍被拒绝）。
//
// 持久化：与 session 存储同目录（.data/owner-aliases.json），文件 mtime 变更即自动重载，
// 改完不用重启进程。
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, atomicWriteJson } from "./store-util.js";

/** 别名表文件（别名 → 规范 owner）。 */
const ALIAS_FILE = resolve(DATA_DIR, "owner-aliases.json");

/** 缓存：mtime 未变就不重读（每请求都会调用，别每次都打盘）。 */
let cache: { mtimeMs: number; map: Map<string, string> } | null = null;

function loadMap(): Map<string, string> {
  try {
    const st = statSync(ALIAS_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.map;
    const parsed = JSON.parse(readFileSync(ALIAS_FILE, "utf-8")) as Record<string, unknown>;
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed || {})) {
      if (typeof k === "string" && typeof v === "string" && k && v) map.set(k, v);
    }
    cache = { mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    // 没有别名文件 = 正常情况（没发生过设备身份分裂）。
    return new Map();
  }
}

/**
 * 把别名 owner 解析成规范 owner：沿别名链往下走。
 * 成环时停在环上（不无限解析）；未登记的 id 原样返回。
 */
export function canonicalOwner(ownerId: string): string {
  if (!ownerId) return ownerId;
  const map = loadMap();
  if (!map.has(ownerId)) return ownerId;
  let cur = ownerId;
  const seen = new Set<string>([cur]);
  for (;;) {
    const next = map.get(cur);
    if (!next || seen.has(next)) break;
    seen.add(next);
    cur = next;
  }
  return cur;
}

/**
 * 登记一个别名（运维用：把同一台设备的另一个身份并到 canonical 上）。
 * 立刻生效（下一请求即按新映射解析），持久化到别名表文件。
 */
export function setOwnerAlias(alias: string, canonical: string): void {
  const map = loadMap();
  map.set(alias, canonical);
  atomicWriteJson(ALIAS_FILE, Object.fromEntries(map), { logLabel: "owner-aliases" });
  cache = null;
}

/** 当前别名表（只读快照，供排障/管理端查看）。 */
export function listOwnerAliases(): Record<string, string> {
  return Object.fromEntries(loadMap());
}

/**
 * 取「规范 owner」（数据实际归属的 key）：即别名表里被指向、且自身不是别名的那个目标。
 * 用作单用户本地兜底——无 cookie / 新设备一律回落到它，避免换 host 或清 cookie 后列表为空。
 * 别名表为空或无明确规范目标时返回 null（调用方回落到原始随机签发行为）。
 */
export function getDefaultCanonical(): string | null {
  const map = loadMap();
  if (map.size === 0) return null;
  const targets = new Set(map.values());
  for (const t of targets) if (!map.has(t)) return t;
  // 全部 target 自身也是 key（成环/链）：取被指向次数最多的目标作为规范。
  const counts = new Map<string, number>();
  for (const v of map.values()) counts.set(v, (counts.get(v) || 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
  return best;
}
