// 模型侧长期记忆工具回归（§11.2 F）：save_memory / recall_memory + owner 隔离 + 风险登记。
// 运行：node --import tsx scripts/_memory-tools-check.mjs
// 注意：会真实写入 .data/memory.json，脚本结束前按 id 清理自己写入的条目（不留脏数据）。
import assert from "node:assert/strict";

const builtins = await import("../src/builtins.js");
const memory = await import("../src/memory.js");
const risk = await import("../src/risk.js");

const OWNER = "memcheck:owner";
const OTHER = "memcheck:other";
const CONV = "memcheck";
const MARK = `【回归临时】${Date.now()}`;

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

const created = [];
async function save(text, owner = OWNER) {
  const out = await builtins.execBuiltin("save_memory", JSON.stringify({ text }), CONV, "generic", owner);
  const item = memory.listMemory(owner).find((m) => m.text === text);
  if (item) created.push({ id: item.id, owner });
  return out;
}
async function recall(owner = OWNER) {
  return builtins.execBuiltin("recall_memory", "{}", CONV, "generic", owner);
}

await check("save_memory 写入后 recall 可见", async () => {
  const out = await save(`${MARK} 用户偏好简表优先`);
  assert.equal(out.ok, true, out.text);
  const got = await recall();
  assert.equal(got.ok, true);
  assert.equal(got.text.includes(MARK), true);
});

await check("空 text 被拒", async () => {
  const out = await builtins.execBuiltin("save_memory", JSON.stringify({ text: "   " }), CONV, "generic", OWNER);
  assert.equal(out.ok, false);
});

await check("缺少用户标识时如实报错（不静默丢弃）", async () => {
  const out = await builtins.execBuiltin("save_memory", JSON.stringify({ text: `${MARK} 无主` }), CONV, "generic", undefined);
  assert.equal(out.ok, false);
  assert.equal(out.text.includes("缺少用户标识"), true);
});

await check("recall 只返回本 owner 的记忆（跨用户隔离）", async () => {
  await save(`${MARK} 他人内容`, OTHER);
  const mine = await recall(OWNER);
  assert.equal(mine.text.includes("他人内容"), false);
  const theirs = await recall(OTHER);
  assert.equal(theirs.text.includes("他人内容"), true);
});

await check("内容完全重复时不新增（幂等）", async () => {
  const text = `${MARK} 重复写入同一句`;
  await save(text);
  const before = memory.listMemory(OWNER).filter((m) => m.text === text).length;
  await save(text);
  const after = memory.listMemory(OWNER).filter((m) => m.text === text).length;
  assert.equal(before, 1);
  assert.equal(after, 1);
});

await check("无记忆时如实回「没有」，不编造", async () => {
  const out = await recall("memcheck:nobody");
  assert.equal(out.ok, true);
  assert.equal(out.text.includes("没有长期记忆"), true);
});

await check("风险登记：recall=read 免确认，save=write 但 scope=workspace（无外部副作用，不弹卡）", () => {
  const r = risk.resolveToolRisk("recall_memory");
  assert.equal(r.source, "builtin");
  assert.equal(r.level, "read");
  assert.equal(risk.verdictNeedsConfirm(r), false);
  const w = risk.resolveToolRisk("save_memory");
  assert.equal(w.source, "builtin");
  assert.equal(w.level, "write");
  assert.equal(w.external, false, "写记忆不应被当成外部副作用去弹确认卡");
  assert.equal(risk.verdictNeedsConfirm(w), false);
  builtins.assertBuiltinRiskCoverage();
});

// 清理：只删本次脚本自己写入的条目（按 id，避免误删用户真实记忆）。
for (const item of created) memory.removeMemory(item.id, item.owner);
const leftover = memory.listMemory(OWNER).filter((m) => m.text.includes(MARK));
assert.equal(leftover.length, 0, "测试残留未清理干净");
const leftoverOther = memory.listMemory(OTHER).filter((m) => m.text.includes(MARK));
assert.equal(leftoverOther.length, 0, "测试残留未清理干净（他人 owner）");

console.log(`=== memory-tools ${pass} PASS ===`);
