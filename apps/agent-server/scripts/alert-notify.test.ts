/**
 * alert-notify 单元闸门（零外部依赖，注入 mock sender）。
 * 运行：tsx scripts/alert-notify.test.ts
 */
import {
  notifyAlerts,
  resetAlertDedupState,
  alertNotifyEnabled,
  type AlertSender,
} from "../src/alert-notify.ts";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | [alert] ${name}${detail ? ` | ${detail}` : ""}`);
}

function mockSender(bag: Array<{ title: string; body: string }>): AlertSender {
  return async (_wh, title, body) => {
    bag.push({ title, body });
  };
}

// ---- 无消息 ----
{
  resetAlertDedupState();
  const bag: Array<{ title: string; body: string }> = [];
  const r = await notifyAlerts({
    kind: "budget",
    messages: [],
    webhook: "http://mock",
    sender: mockSender(bag),
  });
  assert("空消息不推", !r.attempted && r.sent === 0 && bag.length === 0);
}

// ---- 无 webhook ----
{
  resetAlertDedupState();
  const bag: Array<{ title: string; body: string }> = [];
  const prev = process.env.ALERT_DINGTALK_WEBHOOK;
  delete process.env.ALERT_DINGTALK_WEBHOOK;
  const r = await notifyAlerts({
    kind: "budget",
    messages: ["日预算超限：x"],
    sender: mockSender(bag),
  });
  assert("无 webhook → no-op", !r.attempted && r.sent === 0 && bag.length === 0);
  if (prev !== undefined) process.env.ALERT_DINGTALK_WEBHOOK = prev;
}

// ---- 正常推送 ----
{
  resetAlertDedupState();
  const bag: Array<{ title: string; body: string }> = [];
  const r = await notifyAlerts({
    kind: "budget",
    messages: ["日预算超限：a", "单次请求均值超限：b"],
    webhook: "http://mock",
    now: 1000,
    sender: mockSender(bag),
  });
  assert(
    "推送 2 条",
    r.attempted && r.sent === 2 && bag.length === 1,
    `attempted=${r.attempted} sent=${r.sent} bag=${bag.length} err=${r.error || ""}`,
  );
  assert(
    "正文含两条",
    Boolean(bag[0]?.body.includes("日预算超限：a") && bag[0]?.body.includes("单次请求均值超限：b")),
  );
}

// ---- 去重 ----
{
  resetAlertDedupState();
  const bag: Array<{ title: string; body: string }> = [];
  const sender = mockSender(bag);
  process.env.ALERT_DEDUP_MS = "60000";
  await notifyAlerts({
    kind: "degrade",
    messages: ["上游疑似劣化"],
    webhook: "http://mock",
    now: 10_000,
    sender,
  });
  const r2 = await notifyAlerts({
    kind: "degrade",
    messages: ["上游疑似劣化"],
    webhook: "http://mock",
    now: 20_000,
    sender,
  });
  assert("去重跳过", r2.attempted && r2.sent === 0 && r2.skippedDedup === 1 && bag.length === 1);
  const r3 = await notifyAlerts({
    kind: "degrade",
    messages: ["上游疑似劣化"],
    webhook: "http://mock",
    now: 10_000 + 60_001,
    sender,
  });
  assert("窗口后可再推", r3.sent === 1 && bag.length === 2);
  delete process.env.ALERT_DEDUP_MS;
}

// ---- 开关关闭 ----
{
  resetAlertDedupState();
  const bag: Array<{ title: string; body: string }> = [];
  process.env.ALERT_BUDGET_NOTIFY = "0";
  assert("budget 开关关", !alertNotifyEnabled("budget"));
  const r = await notifyAlerts({
    kind: "budget",
    messages: ["x"],
    webhook: "http://mock",
    sender: mockSender(bag),
  });
  assert("关闭后不推", r.skippedDisabled && r.sent === 0 && bag.length === 0);
  delete process.env.ALERT_BUDGET_NOTIFY;
}

// ---- 推送失败回滚 dedup ----
{
  resetAlertDedupState();
  const bag: Array<{ title: string; body: string }> = [];
  const r1 = await notifyAlerts({
    kind: "budget",
    messages: ["fail-me"],
    webhook: "http://mock",
    now: 1,
    sender: async () => {
      throw new Error("boom");
    },
  });
  assert("失败记 error", !!r1.error && r1.sent === 0);
  const r2 = await notifyAlerts({
    kind: "budget",
    messages: ["fail-me"],
    webhook: "http://mock",
    now: 2,
    sender: mockSender(bag),
  });
  assert("失败后可重试", r2.sent === 1 && bag.length === 1);
}

resetAlertDedupState();

const failed = results.filter((r) => !r.ok);
console.log(`\nalert-notify: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
