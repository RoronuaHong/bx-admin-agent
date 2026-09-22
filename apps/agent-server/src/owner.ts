// 轻量设备身份（owner 标注，归属隔离方案 A）：不做登录，只用一个长有效期 cookie 标识「这台设备」。
// 独立于会话 cookie（bx_agent_sid 有 TTL）：会话过期/清掉后，owner 不变，对话资产不孤儿化。
// 安全边界：这是**信任域内防串台**（多浏览器/多人共用一台服务器时互不可见），不是认证——
// cookie 可被复制，别把对外多租户寄托在它上面（那是要做方案 B 登录体系才解决的）。
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";

export const OWNER_COOKIE = "bx_agent_oid";
const OWNER_MAX_AGE = 60 * 60 * 24 * 365; // 1 年：设备标识要长于任何会话 TTL
/** 只接受自签发形态的 id（uuid 或同类），防伪造请求把 ownerKey 塞成奇怪的东西。 */
const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 取（必要时签发）设备 owner 标识；签发时回写 cookie。
 *  IM 通知里的「打开对话」链接带 `?owner=<ownerKey>`（钉钉/飞书 webview 不共享 cookie）。
 *  链接是**显式意图**，优先级高于设备上已有的 cookie：否则用户早先点过一次不带 owner 的旧链接、
 *  webview 里已经落了个随机 owner，之后所有带 owner 的链接都会被那个陈旧值压掉，点进来永远看不到目标对话。
 */
export function resolveOwner(c: Context): string {
  const existing = getCookie(c, OWNER_COOKIE);
  const fromQuery = String(c.req.query("owner") || "").trim();
  if (OWNER_RE.test(fromQuery)) {
    if (existing !== fromQuery) {
      setCookie(c, OWNER_COOKIE, fromQuery, {
        httpOnly: true,
        path: "/",
        sameSite: "Lax",
        maxAge: OWNER_MAX_AGE,
      });
    }
    return fromQuery;
  }
  if (existing && OWNER_RE.test(existing)) return existing;
  const owner = randomUUID();
  setCookie(c, OWNER_COOKIE, owner, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: OWNER_MAX_AGE,
  });
  return owner;
}
