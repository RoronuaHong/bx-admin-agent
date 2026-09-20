// 多 Agent（门户 + 观影助手）验证：角色注册 / 会话分槽 / 角色默认 MCP / 技能按角色过滤 / 系统提示按角色。
// 运行：node --import tsx scripts/_role-check.mjs
process.env.MONGO_URI = "mongodb://127.0.0.1:1"; // 内存降级，测试确定性
process.env.MONGO_DB_NAME = "bx_agent_check";

import assert from "node:assert/strict";

const appMod = await import("../src/app.js");
const conversations = await import("../src/conversations.js");
const skills = await import("../src/skills.js");
const systemPrompt = await import("../src/system-prompt.js");
const { getRole, hasRole, listRoles } = await import("../src/roles.js");

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

const OWNER = { cookie: "bx_agent_oid=roleowner0001" };
async function post(path, body, headers = OWNER) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path, headers = OWNER) {
  const res = await app.request(path, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- A. 角色注册表 ----
await check("角色表：generic 与 movie 已注册，未知角色回落 generic", () => {
  const ids = listRoles().map((r) => r.id);
  assert.ok(ids.includes("generic") && ids.includes("movie"));
  assert.equal(getRole("nope").id, "generic");
  assert.equal(hasRole("movie"), true);
  assert.equal(hasRole("nope"), false);
});

await check("系统提示按角色：movie 用观影人设 + 只见自己的技能", () => {
  const movie = systemPrompt.buildSystemPrompt({ role: "movie" });
  const generic = systemPrompt.buildSystemPrompt({ role: "generic" });
  assert.ok(movie.stable.includes("观影助手"), "movie 稳定前缀应为观影人设");
  assert.ok(generic.stable.includes("通用 AI 助手"), "generic 稳定前缀应为通用人设");
  // movie 技能只出现在 movie 前缀；generic 前缀不得出现（防止击穿通用 cache）。
  const movieIdx = skills.renderSkillIndex("movie");
  const genericIdx = skills.renderSkillIndex("generic");
  assert.ok(movieIdx.includes("movie"), "movie 索引应含 movie 技能");
  assert.ok(!genericIdx.split("\n").some((l) => l.startsWith("- movie")), "generic 索引不应含 movie 技能");
  // 「read_skill 全文」不受角色过滤（按需加载时模型可再取）。
  assert.ok(skills.readSkill("movie")?.includes("观影助手工作流"));
});

// ---- B. 会话分槽与角色默认 ----
await check("创建观影对话：agentId 落库 + 角色默认 MCP（movie）", async () => {
  const r = await post("/chat/conversations", { agentId: "movie" });
  assert.equal(r.status, 200);
  assert.equal(r.body.conversation.agentId, "movie");
  assert.ok((r.body.conversation.mcpServers || []).includes("movie"), "角色默认勾选 movie MCP");
  const r2 = await post("/chat/conversations", {});
  assert.ok(!(r2.body.conversation.agentId && r2.body.conversation.agentId !== "generic"), "未传角色 = generic");
});

await check("未知角色创建 → 400（服务端判定角色，前端不做角色逻辑）", async () => {
  const r = await post("/chat/conversations", { agentId: "nope" });
  assert.equal(r.status, 400);
});

await check("列表按 agentId 分槽：互不可见，generic 兜底旧数据", async () => {
  await conversations.createConversation({ id: "role-old", title: "旧数据", ownerKey: "roleowner0001" }); // 无 agentId
  await conversations.createConversation({ id: "role-mov", title: "观影", ownerKey: "roleowner0001", agentId: "movie" });
  const movie = (await get("/chat/conversations?agentId=movie")).body.conversations.map((c) => c.id);
  const generic = (await get("/chat/conversations?agentId=generic")).body.conversations.map((c) => c.id);
  const all = (await get("/chat/conversations")).body.conversations.map((c) => c.id);
  assert.ok(movie.includes("role-mov") && !movie.includes("role-old"), "movie 槽不含 generic/旧数据");
  assert.ok(generic.includes("role-old") && !generic.includes("role-mov"), "generic 槽含旧数据、不含 movie");
  assert.ok(all.includes("role-mov") && all.includes("role-old"), "不过滤时全部可见（旧调用方兼容）");
});

await check("技能面板按对话角色过滤", async () => {
  const convId = (await post("/chat/conversations", { agentId: "movie" })).body.conversation.id;
  const skillRes = await get(`/chat/skills?conversationId=${convId}`);
  const dirs = (skillRes.body.available || []).map((s) => s.dir);
  assert.ok(dirs.includes("movie"), "movie 对话应可见 movie 技能");
  assert.equal(hasRole("nope"), false);
});

// ---- C. 分角色活跃槽（无模型调用的纯会话逻辑）----
await check("resolveConversation 按 agentId 分槽且互相不顶掉", async () => {
  const session = { id: "s-role", createdAt: Date.now(), activeByAgent: {} };
  const a = await conversations.resolveConversation(session, undefined, "roleowner0001", "movie");
  const b = await conversations.resolveConversation(session, undefined, "roleowner0001", "movie");
  const g = await conversations.resolveConversation(session, undefined, "roleowner0001", "generic");
  assert.equal(a, b, "同一角色复用活跃槽");
  assert.notEqual(a, g, "不同角色不同槽");
  assert.equal(session.activeByAgent.movie, a);
  const doc = await conversations.getConversation(a);
  assert.equal(doc.agentId, "movie", "按角色新建的对话应带 agentId");
});

console.log(pass >= 7 ? `\n${pass} checks passed` : `\n${pass} checks passed (with failures above)`);
