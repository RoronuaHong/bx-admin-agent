// 对话 P2 留档项验证：归档 + 复制 + 导出 MD/JSON + owner 隔离。
process.env.MONGO_URI = "mongodb://127.0.0.1:1";
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const app = appMod.createApp();
const A = "owner-extras111";
const B = "owner-extras222";
const cookie = (o) => ({ "content-type": "application/json", cookie: `bx_agent_oid=${o}` });
const req = (path, init = {}, owner = A) =>
  app.request(path, { ...init, headers: { ...cookie(owner), ...(init.headers || {}) } });

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

await check("归档：PATCH archived → 默认列表隐藏、includeArchived 可见", async () => {
  await req("/chat/conversations", { method: "POST", body: JSON.stringify({ id: "ext-1", title: "待归档" }) });
  await req("/chat/conversations/ext-1", { method: "PATCH", body: JSON.stringify({ archived: true }) });
  const list = (await (await req("/chat/conversations")).json()).conversations;
  assert.ok(!list.some((c) => c.id === "ext-1"));
  const withArch = (await (await req("/chat/conversations?includeArchived=1")).json()).conversations;
  assert.ok(withArch.some((c) => c.id === "ext-1" && c.archived === true));
  await req("/chat/conversations/ext-1", { method: "PATCH", body: JSON.stringify({ archived: false }) });
});

await check("复制：Duplicate 生成带「 副本」的新对话并继承消息", async () => {
  await req("/chat/conversations", { method: "POST", body: JSON.stringify({ id: "ext-2", title: "原件" }) });
  await req("/chat/conversations/ext-2/messages", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", text: "你好" }, { role: "assistant", text: "您好" }] }),
  });
  const created = (await (await req("/chat/conversations/ext-2/duplicate", { method: "POST" })).json()).conversation;
  assert.notEqual(created.id, "ext-2");
  assert.equal(created.title, "原件 副本");
  assert.equal(created.archived, false);
  const full = await (await req(`/chat/conversations/${created.id}/export.json`)).json();
  assert.equal(full.messages.length, 2);
});

await check("导出 JSON / MD：内容正确且带下载头", async () => {
  const jsonRes = await app.request("/chat/conversations/ext-2/export.json", { headers: cookie(A) });
  assert.equal(jsonRes.status, 200);
  assert.equal(jsonRes.headers.get("content-type").includes("application/json"), true);
  assert.ok(jsonRes.headers.get("content-disposition").includes("attachment"));
  const json = await jsonRes.json();
  assert.equal(json.id, "ext-2");
  const mdRes = await app.request("/chat/conversations/ext-2/export.md", { headers: cookie(A) });
  const md = await mdRes.text();
  assert.ok(md.startsWith("# 原件"));
  assert.ok(md.includes("您好"));
});

await check("owner 隔离：B 看不到/无法复制/导出 A 的对话", async () => {
  const listB = (await (await req("/chat/conversations", {}, B)).json()).conversations;
  assert.ok(!listB.some((c) => c.id === "ext-2"));
  const dupB = await req("/chat/conversations/ext-2/duplicate", { method: "POST" }, B);
  assert.equal(dupB.status, 404);
  const expB = await app.request("/chat/conversations/ext-2/export.json", { headers: cookie(B) });
  assert.equal(expB.status, 404);
  const patchB = await req("/chat/conversations/ext-2", { method: "PATCH", body: JSON.stringify({ archived: true }) }, B);
  assert.equal(patchB.status, 404);
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);
