// 免打扰（DND）验证：字段持久化 / 列表可见 / 归属守卫 / 不刷新 updatedAt（整理类改动）。
// 运行：node --import tsx scripts/_mute-check.mjs
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 强制走内存降级，测试确定性
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const conversations = await import("../src/conversations.js");
const app = appMod.createApp();

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

const OWNER = "muteowner0001";
const cookie = { cookie: `bx_agent_oid=${OWNER}` };
const OTHER = { cookie: "bx_agent_oid=otherowner001" };

await conversations.createConversation({ id: "mute-1", title: "免打扰用例", ownerKey: OWNER });

await check("PATCH muted:true 持久化并回显", async () => {
  const res = await app.request("/chat/conversations/mute-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie },
    body: JSON.stringify({ muted: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.conversation.muted, true);
});

await check("列表接口返回 muted（前端据此渲染标识）", async () => {
  const res = await app.request("/chat/conversations", { headers: cookie });
  const list = (await res.json()).conversations || [];
  const conv = list.find((c) => c.id === "mute-1");
  assert.equal(conv?.muted, true);
});

await check("取消免打扰可回落 false", async () => {
  const res = await app.request("/chat/conversations/mute-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie },
    body: JSON.stringify({ muted: false }),
  });
  assert.equal((await res.json()).conversation.muted, false);
});

await check("免打扰是整理类改动：不刷新 updatedAt（不会把对话顶到列表最前）", async () => {
  const before = await conversations.getConversation("mute-1");
  await new Promise((r) => setTimeout(r, 10));
  await app.request("/chat/conversations/mute-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie },
    body: JSON.stringify({ muted: true }),
  });
  const after = await conversations.getConversation("mute-1");
  assert.equal(after.updatedAt, before.updatedAt, "updatedAt 不应变化");
});

await check("他人对话不可改免打扰（归属守卫 404）", async () => {
  const res = await app.request("/chat/conversations/mute-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...OTHER },
    body: JSON.stringify({ muted: false }),
  });
  assert.equal(res.status, 404);
  const conv = await conversations.getConversation("mute-1");
  assert.equal(conv.muted, true, "被拒后不应改变");
});

await check("未知对话 PATCH muted → 404", async () => {
  const res = await app.request("/chat/conversations/nope-conv", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie },
    body: JSON.stringify({ muted: true }),
  });
  assert.equal(res.status, 404);
});

await check("非法类型（字符串）被忽略，不写入脏值", async () => {
  await app.request("/chat/conversations/mute-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie },
    body: JSON.stringify({ muted: "yes" }),
  });
  const conv = await conversations.getConversation("mute-1");
  assert.equal(conv.muted, true, "应保持上一次的布尔值");
});

console.log(pass >= 7 ? `\n${pass} checks passed` : `\n${pass} checks passed (with failures above)`);
