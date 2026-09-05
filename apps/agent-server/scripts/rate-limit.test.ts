/**
 * rate-limit 单元闸门（零外部依赖）。
 * 运行：tsx scripts/rate-limit.test.ts
 */
import {
  checkRateLimit,
  clientIpFromHeaders,
  resetRateLimitState,
} from "../src/rate-limit.ts";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | [rate-limit] ${name}${detail ? ` | ${detail}` : ""}`);
}

resetRateLimitState();

// ---- 关闭（limit≤0）恒放行 ----
{
  const r = checkRateLimit({ bucket: "chat", key: "off", limit: 0, windowMs: 60_000, now: 1000 });
  assert("limit=0 → allowed", r.allowed && r.limit === 0);
}

// ---- 窗口内超限 ----
{
  resetRateLimitState();
  const key = "user:a";
  const windowMs = 60_000;
  const limit = 3;
  const t0 = 1_000_000;
  const a = checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 });
  const b = checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 + 1 });
  const c = checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 + 2 });
  const d = checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 + 3 });
  assert("前 3 次放行", a.allowed && b.allowed && c.allowed && c.remaining === 0);
  assert("第 4 次拒绝", !d.allowed && d.remaining === 0 && d.retryAfterSec >= 1);
}

// ---- 窗口滑出后恢复 ----
{
  resetRateLimitState();
  const key = "user:b";
  const windowMs = 10_000;
  const limit = 2;
  const t0 = 2_000_000;
  checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 });
  checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 + 1 });
  const blocked = checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 + 2 });
  const after = checkRateLimit({ bucket: "chat", key, limit, windowMs, now: t0 + windowMs + 1 });
  assert("窗口内仍拒", !blocked.allowed);
  assert("滑出后放行", after.allowed && after.remaining === 1);
}

// ---- 桶/键隔离 ----
{
  resetRateLimitState();
  const limit = 1;
  const windowMs = 60_000;
  const now = 3_000_000;
  const chatA = checkRateLimit({ bucket: "chat", key: "k1", limit, windowMs, now });
  const chatB = checkRateLimit({ bucket: "chat", key: "k2", limit, windowMs, now });
  const loginA = checkRateLimit({ bucket: "login", key: "k1", limit, windowMs, now });
  const chatA2 = checkRateLimit({ bucket: "chat", key: "k1", limit, windowMs, now: now + 1 });
  assert("不同 key 互不影响", chatA.allowed && chatB.allowed);
  assert("不同 bucket 互不影响", loginA.allowed);
  assert("同 key 同 bucket 受限", !chatA2.allowed);
}

// ---- IP 解析 ----
{
  const h = (m: Record<string, string>) => ({
    get: (n: string) => m[n.toLowerCase()] ?? m[n],
  });
  assert(
    "x-forwarded-for 取第一段",
    clientIpFromHeaders(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })) === "1.2.3.4",
  );
  assert(
    "x-real-ip 回退",
    clientIpFromHeaders(h({ "x-real-ip": "9.9.9.9" })) === "9.9.9.9",
  );
  assert("无头 → unknown", clientIpFromHeaders(h({})) === "unknown");
}

const failed = results.filter((r) => !r.ok);
console.log(`\nrate-limit: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
