// 主循环并发批（G1）纯函数回归：只测「哪些调用能凑成一个并发批」的决策，不跑真实模型。
// 运行：node --import tsx scripts/_concurrent-check.mjs
import assert from "node:assert/strict";

const chat = await import("../src/chat.js");

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, argsJson: JSON.stringify(args) });

/** 构造 opts：allow 里的工具名可并发（只读 / 免确认），其余不可。 */
function opts(calls, { allow, max = 4, executed = [], fused = [] } = {}) {
  const executedSet = new Set(executed);
  return {
    start: 0,
    max,
    signature: (name, argsJson) => `${name}|${argsJson}`,
    isExecuted: (sig) => executedSet.has(sig),
    isFused: (name) => fused.includes(name),
    canRun: (name) => allow.includes(name),
    _calls: calls,
  };
}

const plan = (calls, o) => chat.planConcurrentBatch(calls, o);

check("三个连续只读调用 → 全部进同一批", () => {
  const calls = [call("fs_read", { path: "a" }), call("fs_read", { path: "b" }), call("fs_glob", { pattern: "*.md" })];
  const out = plan(calls, opts(calls, { allow: ["fs_read", "fs_glob"] }));
  assert.equal(out.length, 3);
});

check("遇到写操作立即停止（写不进并发批，也不跳过它去凑批）", () => {
  const calls = [call("fs_read", { path: "a" }), call("fs_write", { path: "b" }), call("fs_read", { path: "c" })];
  const out = plan(calls, opts(calls, { allow: ["fs_read"] }));
  assert.equal(out.length, 1);
});

check("需要确认的交互式调用不进批", () => {
  const calls = [call("fs_read", { path: "a" }), call("request_clarification", { q: 1 }), call("fs_read", { path: "c" })];
  const out = plan(calls, opts(calls, { allow: ["fs_read"] }));
  assert.equal(out.length, 1);
});

check("task 委派与工具检索不进批（各自有独立语义）", () => {
  // 真实主循环里 concurrentOk 对这两个名字恒 false，这里用 allow 名单模拟同一效果。
  const a = plan([call("fs_read", { path: "a" }), call("task", { d: 1 })], opts([], { allow: ["fs_read"] }));
  assert.equal(a.length, 1);
  const b = plan([call("fs_read", { path: "a" }), call("search_tools", { q: 1 })], opts([], { allow: ["fs_read"] }));
  assert.equal(b.length, 1);
});

check("本轮已执行过的相同调用不进批（交串行路径回灌「已跳过」）", () => {
  const c1 = { id: "a", name: "fs_read", argsJson: JSON.stringify({ path: "x" }) };
  const c2 = { id: "b", name: "fs_read", argsJson: JSON.stringify({ path: "x" }) };
  const out = plan([c1, c2], opts([c1, c2], { allow: ["fs_read"], executed: [`fs_read|${c1.argsJson}`] }));
  assert.equal(out.length, 0);
});

check("批内重复（同轮两个相同参数）只收第一个", () => {
  const c1 = { id: "a", name: "fs_read", argsJson: JSON.stringify({ path: "x" }) };
  const c2 = { id: "b", name: "fs_read", argsJson: JSON.stringify({ path: "x" }) };
  const out = plan([c1, c2], opts([c1, c2], { allow: ["fs_read"] }));
  assert.equal(out.length, 1);
});

check("已熔断的工具不进批（交串行路径回灌「已熔断」）", () => {
  const calls = [call("fs_read"), call("mcp__bi__x")];
  const out = plan(calls, opts(calls, { allow: ["fs_read", "mcp__bi__x"], fused: ["mcp__bi__x"] }));
  assert.equal(out.length, 1);
});

check("max 限制生效（不无限凑批）", () => {
  const calls = [
    call("fs_read", { path: "a" }),
    call("fs_read", { path: "b" }),
    call("fs_read", { path: "c" }),
    call("fs_read", { path: "d" }),
  ];
  const out = plan(calls, opts(calls, { allow: ["fs_read"], max: 2 }));
  assert.equal(out.length, 2);
});

check("start 不是 0 时从指定位置开始收集", () => {
  const calls = [call("fs_write", { path: "z" }), call("fs_read", { path: "a" }), call("fs_read", { path: "b" })];
  const out = chat.planConcurrentBatch(calls, { ...opts(calls, { allow: ["fs_read"] }), start: 1 });
  assert.equal(out.length, 2);
});

check("空调用列表返回空批（不会越界）", () => {
  assert.equal(plan([], opts([], { allow: [] })).length, 0);
});

console.log(`=== concurrent ${pass} PASS ===`);
