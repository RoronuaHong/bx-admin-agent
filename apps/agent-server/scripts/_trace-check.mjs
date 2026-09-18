// 运行追踪（§10 最小版）验证：run 级 JSONL 落盘 + /chat/trace/runs owner 过滤 + release 标记。
// 运行：node --import tsx scripts/_trace-check.mjs（强制 Mongo 降级内存，确定性）
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const trace = await import("../src/trace.js");

const app = appMod.createApp();
const OWNER = "owner-trace111";
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

async function readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) if (line.trim()) lines.push(JSON.parse(line));
  }
  return lines;
}

await check("health 带 release 标记", async () => {
  const res = await app.request("/health");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.release && body.release.length >= 7);
});

await check("任务收束后落 run 级 trace（模型/轮次/token/错误/release）", async () => {
  const res = await app.request("/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "trace me", conversationId: "trace-a" }),
  });
  await readNdjson(res); // 消费完整流（error+done：无模型环境）
  const runs = trace.listRunTraces({ ownerKey: OWNER, conversationId: "trace-a" });
  assert.ok(runs.length >= 1);
  const run = runs[0];
  assert.equal(run.status, "failed"); // 无模型 → 诚实 failed
  assert.ok(run.runId.startsWith("run_"));
  assert.ok(run.durationMs >= 0);
  assert.equal(run.model, undefined); // 无模型 → 无 model 事件
  assert.ok(run.error);
  assert.ok(run.release);
  assert.equal(run.ownerKey, OWNER);
});

await check("/chat/trace/runs：owner 过滤（别人的 run 不可见）", async () => {
  const res = await app.request("/chat/trace/runs?limit=20", { headers: { cookie } });
  const body = await res.json();
  assert.equal(body.release, trace.getRelease());
  for (const run of body.runs) assert.equal(run.ownerKey, OWNER);
  const other = await (
    await app.request("/chat/trace/runs?limit=20", { headers: { cookie: "bx_agent_oid=owner-other222" } })
  ).json();
  assert.ok(!other.runs.some((r) => r.conversationId === "trace-a"));
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);
