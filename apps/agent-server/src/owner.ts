// 轻量设备身份（owner 标注，归属隔离方案 A）：不做登录，只用一个长有效期 cookie 标识「这台设备」。
// 独立于会话 cookie（bx_agent_sid 有 TTL）：会话过期/清掉后，owner 不变，对话资产不孤儿化。
// 安全边界：这是**信任域内防串台**（多浏览器/多人共用一台服务器时互不可见），不是认证——
// cookie 可被复制，别把对外多租户寄托在它上面（那是要做方案 B 登录体系才解决的）。
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { listConversations } from "./conversations.js";
import { canonicalOwner, getDefaultCanonical, setDefaultCanonical, setOwnerAlias } from "./owner-alias.js";

export const OWNER_COOKIE = "bx_agent_oid";
const OWNER_MAX_AGE = 60 * 60 * 24 * 365; // 1 年：设备标识要长于任何会话 TTL
/** 只接受自签发形态的 id（uuid 或同类），防伪造请求把 ownerKey 塞成奇怪的东西。 */
const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 自动签发的设备标识形态（用于「自愈合并」时区分真实浏览器 UUID 与测试/命名 owner）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 取（必要时签发）设备 owner 标识；签发时回写 cookie。
 *  不接受 `?owner=` 覆盖：IM 链接只带 `?conv=`，任务对话对持链接的人只读开放，不转移设备身份。
 *
 *  cookie 是按 host 作用域的（没设 domain）：同一台设备换 host（localhost / 局域网 IP）会拿到新的
 *  owner，任务与对话就对不上号了。所以这里把 cookie 里的身份先过一遍**别名表**（owner-alias.ts）：
 *  已登记为同一台设备的别名 → 解析成规范 owner，存量资产不用迁移就能被看见。
 *
 *  单用户本地兜底（2026-11-05 事故修复）：别名表里存在「规范 owner」（= 数据实际归属的 key）时，
 *  - 无 cookie / 新设备：直接回落到规范 owner，避免换 host 或清 cookie 后列表全空；
 *  - 已有但非规范的 UUID 设备标识：一次性自愈合并到规范 owner（仅对自动签发的 UUID，不动命名/测试 owner）。
 */
export function resolveOwner(c: Context): string {
  const existing = getCookie(c, OWNER_COOKIE);
  const def = getDefaultCanonical();
  if (!existing || !OWNER_RE.test(existing)) {
    const owner = def ?? randomUUID();
    setCookie(c, OWNER_COOKIE, owner, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: OWNER_MAX_AGE,
    });
    return owner;
  }
  const can = canonicalOwner(existing);
  if (def && can !== def && UUID_RE.test(existing)) {
    setOwnerAlias(can, def);
    return def;
  }
  return can;
}

// ---- 单用户兜底的「种子」：规范 owner 从存量数据里认出来 ----

/**
 * 为什么需要：自愈合并（resolveOwner）要先知道规范 owner 才能写别名表，而别名表又只在
 * 自愈时被写入——没有种子时这是死循环：IM webview / 换设备永远拿到新随机身份，
 * 「打开对话」深链一律 404（该对话已不存在或无权访问），列表也全空。
 *
 * 做什么：既没有别名表、也没有显式默认 owner 时，从存量对话推一个——
 * 取**最近活跃**对话的 ownerKey（单用户本地部署：正在用系统的人就是数据的归属者）。
 * 不按对话数取：库里常有历史测试残留（vitest 等），按数量会被测试 owner 抢走规范位。
 * 落盘为规范 owner（owner-default.json）。推导只发生一次：落盘后 getDefaultCanonical
 * 命中文件缓存，不再查存储。
 *
 * 失败语义：推导失败（如存储层运行期不可用）不阻断请求，下次请求重试
 * （seeding 在 finally 里清空）；推不出（一条带 owner 的对话都没有）保持原随机签发行为。
 */
let seeding: Promise<void> | null = null;

export async function ensureDefaultOwnerSeeded(): Promise<void> {
  if (getDefaultCanonical()) return;
  if (!seeding) {
    seeding = (async () => {
      // 不按 owner 过滤（ownerKey 缺省 = 遗留数据，对所有人可见，也不参与推导）。
      const docs = await listConversations(undefined, true);
      let best: string | null = null;
      let bestLatest = 0;
      for (const doc of docs) {
        const o = doc.ownerKey;
        if (!o) continue;
        const latest = doc.updatedAt || 0;
        if (latest > bestLatest) {
          best = o;
          bestLatest = latest;
        }
      }
      if (best) {
        setDefaultCanonical(best);
        console.log(`[owner] 单用户兜底：规范 owner 取自最近活跃的存量对话，后续无 cookie / 新设备均回落到它`);
      }
    })()
      .catch((err) => {
        console.warn(`[owner] 规范 owner 种子推导失败（下次请求重试）：${String((err as Error)?.message || err)}`);
      })
      .finally(() => {
        seeding = null;
      });
  }
  await seeding;
}
