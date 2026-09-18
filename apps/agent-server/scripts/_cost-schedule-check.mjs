// 成本计量（§12）+ 定时任务（§8）验证。
// 运行：node --import tsx scripts/_cost-schedule-check.mjs（强制 Mongo 降级内存，确定性）
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MONGO_DB_NAME = "bx_agent_check";
process.env.COST_RATE_TESTM_PER_1K = "0.002"; // 1k token = 0.002

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const trace = await import("../src/trace.js");
const schedules = await import("../src/schedules.js");
const tasksMod = await import("../src/chat-tasks.js");

const app = appMod.createApp();
const OWNER = "owner-costsched";
const cookie = `bx_agent_oid=${OWNER}`;

let pass = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
const req = (path, init = {}) => app.request(path, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers || {}) } });

// ---- A. 成本计量 ----
await check("按单价模型计费 + 未定价模型如实计入 unpricedTokens", async () => {
  await trace.appendRunTrace({
    runId: trace.newRunId(), at: Date.now(), conversationId: "cost-a", ownerKey: OWNER,
    model: "TESTM", status: "success", durationMs: 100, tokens: 5000, release: "test",
  });
  await trace.appendRunTrace({
    runId: trace.newRunId(), at: Date.now(), conversationId: "cost-a", ownerKey: OWNER,
    model: "NOPRICE", status: "success", durationMs: 100, tokens: 777, release: "test",
  });
  const res = await req("/chat/cost/summary?days=1");
  const body = await res.json();
  assert.equal(body.totals.runs >= 2, true);
  const testm = body.byModel.find((m) => m.model === "TESTM");
  assert.ok(testm.tokens >= 5000);
  // 计费公式一致性：cost = tokens/1000 × 单价（JSONL 累积多次运行，用相对断言）
  assert.ok(Math.abs(testm.cost - (testm.tokens / 1000) * 0.002) < 1e-9);
  const noprice = body.byModel.find((m) => m.model === "NOPRICE");
  assert.equal(noprice.cost, 0);
  assert.ok(noprice.unpricedTokens >= 777);
  assert.ok(body.byDay.length >= 1);
  assert.ok(body.slowest.length >= 1);
});

await check("cost owner 过滤：别人的 run 不计入", async () => {
  await trace.appendRunTrace({
    runId: trace.newRunId(), at: Date.now(), conversationId: "cost-b", ownerKey: "owner-someoneelse",
    model: "TESTM", status: "success", durationMs: 100, tokens: 999999, release: "test",
  });
  const body = await (await req("/chat/cost/summary?days=1")).json();
  const testm = body.byModel.find((m) => m.model === "TESTM");
  assert.ok(testm.tokens < 999999);
});

await check("日 token 预算告警", async () => {
  process.env.DAILY_TOKEN_BUDGET = "10";
  const body = await (await req("/chat/cost/summary?days=1")).json();
  delete process.env.DAILY_TOKEN_BUDGET;
  assert.ok((body.budgetAlerts || []).length >= 1);
});

// ---- B. 定时任务 ----
await check("cron 校验：5 段合法 / 6 段与乱串拒绝", async () => {
  assert.equal(schedules.validateCron("*/5 * * * *"), null);
  assert.ok(schedules.validateCron("0 * * * * *")); // 6 段
  assert.ok(schedules.validateCron("not a cron"));
});

await check("创建（含 nextRunAt 计算）+ owner 过滤列表", async () => {
  // 先用 A 的身份建对话（走 HTTP 拿到归属守卫路径）
  await req("/chat/conversations", { method: "POST", body: JSON.stringify({ id: "sched-a", title: "定时" }) });
  const res = await req("/chat/schedules", {
    method: "POST",
    body: JSON.stringify({ conversationId: "sched-a", prompt: "每小时汇报一次", cron: "0 * * * *" }),
  });
  const { schedule } = await res.json();
  assert.ok(schedule.id.startsWith("sched_"));
  assert.ok(schedule.nextRunAt > Date.now());
  const listB = (await (await app.request("/chat/schedules", { headers: { cookie: "bx_agent_oid=owner-bbb22222" } })).json()).schedules;
  assert.ok(!listB.some((s) => s.id === schedule.id));
});

await check("非法 cron → 400", async () => {
  const res = await req("/chat/schedules", {
    method: "POST",
    body: JSON.stringify({ conversationId: "sched-a", prompt: "x", cron: "bad" }),
  });
  assert.equal(res.status, 400);
});

await check("schedulerTick：到点触发 runner + 推进 nextRunAt + 留痕", async () => {
  const list = await schedules.listSchedules(OWNER);
  const sched = list[0];
  // 人为把 nextRunAt 拨到过去 → 本 tick 必触发
  await schedules.patchSchedule(sched.id, OWNER, { enabled: true, nextRunAt: Date.now() - 1000 });
  const runs = [];
  const fired = await schedules.schedulerTick(async (s) => {
    runs.push(s.id);
    return "success";
  }, Date.now());
  assert.equal(fired, 1);
  assert.deepEqual(runs, [sched.id]);
  const after = await schedules.getSchedule(sched.id);
  assert.equal(after.lastStatus, "success");
  assert.ok(after.nextRunAt > Date.now());
});

await check("对话忙时触发 → skipped（不排队不重复跑）", async () => {
  const ghost = tasksMod.startTask({ conversationId: "sched-a", userText: "running" });
  const list = await schedules.listSchedules(OWNER);
  const s = list[0];
  await schedules.patchSchedule(s.id, OWNER, { nextRunAt: Date.now() - 1000 });
  // 模拟 app.ts 真实 runner 的「忙时跳过」语义
  const fired = await schedules.schedulerTick(async (sched) => {
    if (tasksMod.isTaskRunning(sched.conversationId)) return "skipped";
    return "success";
  }, Date.now());
  assert.equal(fired, 1);
  const after = await schedules.getSchedule(s.id);
  assert.equal(after.lastStatus, "skipped");
  assert.ok(after.lastNote);
  tasksMod.finishTask(ghost, "cancelled", false);
});

await check("PATCH / DELETE 的归属守卫（别人的日程 404）", async () => {
  const list = await schedules.listSchedules(OWNER);
  const id = list[0].id;
  const patchB = await app.request(`/chat/schedules/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie: "bx_agent_oid=owner-bbb22222" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patchB.status, 404);
  const delB = await app.request(`/chat/schedules/${id}`, {
    method: "DELETE", headers: { cookie: "bx_agent_oid=owner-bbb22222" },
  });
  assert.equal(delB.status, 404);
  const delA = await req(`/chat/schedules/${id}`, { method: "DELETE" });
  assert.equal((await delA.json()).ok, true);
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);
