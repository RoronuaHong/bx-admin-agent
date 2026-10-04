/**
 * 全局配置端点的准入（MCP 服务器管理 / 通知通道）。
 *
 * 为什么单独有这一层：会话中间件只挂在 `/chat/*`（身份 = 匿名 cookie 派生的设备 id），
 * 而这两组端点是**全局**注册表——其中 stdio 传输允许指定任意 command / args / env，
 * reload 即 spawn。把它们暴露给任何能连上端口的人，等同于开放远程代码执行。
 * 收窄监听地址（`HOST`）是外围防线，令牌是端点的防线：前者挡住局域网，后者挡住
 * 本机上其它进程与浏览器的跨站请求（CSRF：令牌走自定义头，跨站表单/脚本带不上）。
 */
import { timingSafeEqual } from "node:crypto";

export interface AdminCheckInput {
  /** 服务端配置的令牌（`AGENT_ADMIN_TOKEN`）。空 = 未启用，放行以保持单机原行为。 */
  token?: string | undefined;
  /** 请求携带的令牌（`x-admin-token` 头）。 */
  provided?: string | null | undefined;
}

export type AdminCheckResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" };

/** 定长比较：长度不同时也要走完比较路径，避免用响应时间逐字节试探令牌。 */
function secureEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function checkAdminToken(input: AdminCheckInput): AdminCheckResult {
  const expected = String(input.token || "").trim();
  // 未配置令牌 = 不启用这层防护（单机 + 只听本机的默认部署），行为与改动前一致。
  if (!expected) return { ok: true };
  const provided = String(input.provided || "").trim();
  if (!provided) return { ok: false, reason: "missing" };
  return secureEqual(provided, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}
