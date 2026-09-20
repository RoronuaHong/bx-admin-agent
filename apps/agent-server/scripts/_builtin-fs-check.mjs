// 内置文件系统工具回归（§11.2 A）：fs_read 分页 / fs_glob / fs_grep + 越界拒绝 + 风险登记。
// 运行：node --import tsx scripts/_builtin-fs-check.mjs（纯本地磁盘，不依赖真实 MCP / 模型）。
import assert from "node:assert/strict";

const fsStore = await import("../src/fs-store.js");
const builtins = await import("../src/builtins.js");
const risk = await import("../src/risk.js");

const CONV = `fscheck_${Date.now()}`;

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

// ---- 0. 准备工作区 ----
fsStore.fsWrite(CONV, "notes/a.md", "# 标题\n第二行 alpha\n第三行");
fsStore.fsWrite(CONV, "notes/b.md", "beta 一行");
fsStore.fsWrite(CONV, "results/r.txt", "alpha 结果\n收尾");
fsStore.fsWrite(CONV, "config.json", '{"k":1}');

// ---- 1. fs_read 分页（行级）----
await check("fs_read 整读（不带分页）与现状一致", () => {
  const r = fsStore.fsRead(CONV, "notes/a.md");
  assert.equal(r.content.includes("第二行 alpha"), true);
  assert.equal(r.totalLines, undefined);
});
await check("fs_read offset+limit 按行切分并回报总行数", () => {
  const r = fsStore.fsRead(CONV, "notes/a.md", { offset: 1, limit: 1 });
  assert.equal(r.content.startsWith("第二行 alpha"), true);
  assert.equal(r.totalLines, 3);
  assert.equal(r.content.includes("共 3 行"), true);
  assert.equal(r.content.includes("第 2–2 行"), true);
});
await check("fs_read offset 越界时如实说明而不是返回空", () => {
  const r = fsStore.fsRead(CONV, "notes/a.md", { offset: 99, limit: 5 });
  assert.equal(r.totalLines, 3);
  assert.equal(r.content.includes("已超出范围"), true);
});
await check("fs_read 分页与整读内容可拼接还原（不丢行）", () => {
  const total = fsStore.fsRead(CONV, "notes/a.md").content.split("\n");
  const p1 = fsStore.fsRead(CONV, "notes/a.md", { offset: 0, limit: 1 }).content.split("\n")[0];
  const p2 = fsStore.fsRead(CONV, "notes/a.md", { offset: 1, limit: 1 }).content.split("\n")[0];
  assert.equal(p1, total[0]);
  assert.equal(p2, total[1]);
});

// ---- 2. fs_glob ----
await check("fs_glob **/*.md 跨目录命中两个 md", () => {
  const r = fsStore.fsGlob(CONV, "**/*.md");
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.files.map((f) => f.path).sort(),
    ["notes/a.md", "notes/b.md"],
  );
});
await check("fs_glob 单层 *.md 不跨目录（notes 下无 md）", () => {
  const r = fsStore.fsGlob(CONV, "*.md");
  assert.equal(r.total, 0);
});
await check("fs_glob 目录前缀 results/* 命中", () => {
  const r = fsStore.fsGlob(CONV, "results/*");
  assert.equal(r.total, 1);
  assert.equal(r.files[0].path, "results/r.txt");
});
await check("fs_glob 拒绝 .. 与绝对路径", () => {
  const a = fsStore.fsGlob(CONV, "../**/*");
  const b = fsStore.fsGlob(CONV, "/etc/passwd");
  assert.equal("error" in a, true, `../**/* -> ${JSON.stringify(a)}`);
  assert.equal("error" in b, true, `/etc/passwd -> ${JSON.stringify(b)}`);
});

// ---- 3. fs_grep ----
await check("fs_grep content 模式回 路径:行号:命中行", () => {
  const r = fsStore.fsGrep(CONV, "alpha");
  assert.equal(r.files.length, 2);
  const hit = r.hits.find((h) => h.path === "notes/a.md");
  assert.equal(hit.line, 2);
  assert.equal(hit.text, "第二行 alpha");
});
await check("fs_grep files 模式只回文件名", () => {
  const r = fsStore.fsGrep(CONV, "alpha", { mode: "files" });
  assert.equal(r.hits.length, 0);
  assert.equal(r.files.length, 2);
});
await check("fs_grep count 模式回每文件命中数", () => {
  const r = fsStore.fsGrep(CONV, "alpha", { mode: "count" });
  assert.equal(r.counts.length, 2);
  assert.equal(r.counts.reduce((n, c) => n + c.count, 0), 2);
});
await check("fs_grep glob 过滤生效（只在 md 里找）", () => {
  const r = fsStore.fsGrep(CONV, "alpha", { glob: "**/*.md" });
  assert.deepEqual(r.files, ["notes/a.md"]);
});
await check("fs_grep 非法正则被拒（不抛异常）", () => {
  assert.equal("error" in fsStore.fsGrep(CONV, "([unclosed"), true);
});
await check("fs_grep 空模式被拒", () => {
  assert.equal("error" in fsStore.fsGrep(CONV, "   "), true);
});
await check("fs_grep 无命中如实返回空而不是报错", () => {
  const r = fsStore.fsGrep(CONV, "zzz-not-exist");
  assert.equal(r.files.length, 0);
  assert.equal(r.hits.length, 0);
});
await check("fs_grep 二进制文件跳过（含 \\0 不参与检索也不报错）", () => {
  fsStore.fsWrite(CONV, "bin.dat", "alpha\u0000beta");
  const r = fsStore.fsGrep(CONV, "alpha");
  const before = r.files.length;
  assert.equal(r.files.includes("bin.dat"), false);
  assert.ok(before >= 2);
  fsStore.fsWrite(CONV, "bin.dat", "x"); // 复原（避免影响后续 glob 计数）
});

// ---- 4. 风险登记（漏登启动即抛错，这里直接断言不抛）----
await check("新工具已登记风险级别且免确认（只读 / 工作区）", () => {
  for (const name of ["fs_glob", "fs_grep"]) {
    const v = risk.resolveToolRisk(name);
    assert.equal(v.source, "builtin");
    assert.equal(v.level, "read");
    assert.equal(risk.verdictNeedsConfirm(v), false);
  }
  builtins.assertBuiltinRiskCoverage();
});

// ---- 5. 走 execBuiltin 验证工具真的被接线 ----
const cases = [
  ["fs_glob", { pattern: "**/*.md" }],
  ["fs_grep", { pattern: "alpha", mode: "content" }],
  ["fs_read", { path: "notes/a.md", offset: 1, limit: 1 }],
];
for (const [name, args] of cases) {
  const out = await builtins.execBuiltin(name, JSON.stringify(args), CONV);
  check(`execBuiltin ${name} 可用且返回文本`, () => {
    assert.ok(out, `${name} 未返回（未接线？）`);
    assert.equal(out.ok, true, out?.text);
    assert.ok(out.text.length > 0);
  });
}
await check("execBuiltin fs_read 分页结果带总行数提示", async () => {
  const out = await builtins.execBuiltin("fs_read", JSON.stringify({ path: "notes/a.md", offset: 0, limit: 1 }), CONV);
  assert.equal(out.text.includes("共 3 行"), true);
});
await check("execBuiltin fs_glob 非法模式回错误而非抛错", async () => {
  const out = await builtins.execBuiltin("fs_glob", JSON.stringify({ pattern: "../**" }), CONV);
  assert.equal(out.ok, false);
});

fsStore.fsRemoveConversation(CONV);
console.log(`=== builtin-fs ${pass} PASS ===`);
