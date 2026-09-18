// RAG 验证（agent-infrastructure §7）：解析 → 切片 → 混合检索 → 降级 → 增量 → 工具接线。
// 用临时目录隔离，不污染真实索引（.data/rag）。
// 运行：node --import tsx scripts/_rag-check.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ragcheck-"));
process.env.KB_EMBEDDING = process.env.KB_EMBEDDING || "off";

const store = await import("../src/rag/store.js");
const parsers = await import("../src/rag/parsers.js");
const { execBuiltin, builtinToolSpecs, BUILTIN_RISK } = await import("../src/builtins.js");

store.setRagDirForTest(tmp);
store.resetCache();

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

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// ---- A. 解析层 ----
await check("扩展名分发：md/html 支持、图片不支持", () => {
  assert.equal(parsers.isSupportedExt(".md"), true);
  assert.equal(parsers.isSupportedExt(".html"), true);
  assert.equal(parsers.isSupportedExt(".png"), false);
});

await check("stripHtml 去标签/脚本，保留正文", () => {
  const out = parsers.stripHtml("<html><script>x</script><style>a{}</style><h1>标题</h1><p>正文</p></html>");
  assert.ok(out.includes("标题") && out.includes("正文"));
  assert.ok(!out.includes("script") && !out.includes("<p>"));
});

await check("looksBinary 识别二进制、放行文本", () => {
  assert.equal(parsers.looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  assert.equal(parsers.looksBinary(Buffer.from("hello 中文正文")), false);
});

await check("titleOf 取首个标题，回退文件名", () => {
  assert.equal(parsers.titleOf("# 考勤制度\n正文", "fallback"), "考勤制度");
  assert.equal(parsers.titleOf("没有标题的一段正文内容", "fallback.md"), "没有标题的一段正文内容");
});

await check("可选依赖未安装时解析 pdf 如实报错（不静默跳过）", async () => {
  const p = path.join(tmp, "x.pdf");
  fs.writeFileSync(p, "%PDF-1.4 fake");
  const res = await parsers.parseFile(p);
  assert.ok("error" in res, `应返回错误，实际：${JSON.stringify(res).slice(0, 120)}`);
});

await check("二进制文件（伪装成 .txt）被拒绝直读", async () => {
  const p = path.join(tmp, "fake.txt");
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
  const res = await parsers.parseFile(p);
  assert.ok("error" in res && res.error.includes("二进制"));
});

// ---- B. 切片与入库 ----
await check("chunkText 短文本不切、长文本多片且内容不丢", () => {
  assert.equal(store.chunkText("短文本").length, 1);
  // 每段约 60 字 × 40 段 ≈ 2400 字，远超 900 的默认切片阈值。
  const long = Array.from(
    { length: 40 },
    (_, i) => `第${i}段落：这是一段用于验证切片行为的较长正文内容，包含足够的字符数以触发切分逻辑。`,
  ).join("\n");
  const chunks = store.chunkText(long);
  assert.ok(chunks.length > 1, `应切多片，实际 ${chunks.length}`);
  assert.ok(chunks.every((c) => c.length <= 1200), "单片不应异常膨胀");
  assert.ok(chunks.some((c) => c.includes("第0段落")), "首段内容不丢");
  assert.ok(chunks.some((c) => c.includes("第39段落")), "尾段内容不丢");
});

const docs = [
  { id: "a.md", title: "考勤制度", source: "a.md", text: "上班迟到 30 分钟以内扣半天工资，超过 30 分钟按旷工处理。请假需提前在系统提交。", hash: md5("1") },
  { id: "b.md", title: "报销流程", source: "b.md", text: "差旅报销需在返回后 7 个工作日内提交发票与行程单，审批通过后次月发放。", hash: md5("2") },
  { id: "c.md", title: "部署规范", source: "c.md", text: "生产环境发布必须走灰度：先 10% 流量观察 30 分钟，无异常再全量。回滚窗口保留 24 小时。", hash: md5("3") },
];

await check("ingest 入库并可统计", async () => {
  const n = await store.ingest(docs);
  assert.equal(n, docs.length);
  const s = store.stats();
  assert.equal(s.docs, 3);
  assert.equal(s.sources, 3);
});

await check("检索命中正确文档（纯词法，embedding 关闭）", async () => {
  const hits = await store.search("上班迟到了会扣钱吗", 3);
  assert.ok(hits.length, "应有命中");
  assert.equal(hits[0].title, "考勤制度");
  assert.ok(hits[0].source === "a.md");
  assert.ok(hits[0].score > 0);
});

await check("检索带来源与分数（答案可溯源）", async () => {
  const hits = await store.search("灰度发布", 3);
  assert.equal(hits[0].title, "部署规范");
  assert.ok(hits[0].source && typeof hits[0].score === "number");
});

await check("空查询/无命中返回空数组，不报错", async () => {
  assert.deepEqual(await store.search("", 3), []);
  assert.deepEqual(await store.search("量子计算与区块链的结合", 3), []);
});

// ---- C. 降级：embedding 开了但端点不可用，必须仍能用词法 ----
await check("embedding 端点不可用 → 自动降级纯词法（不报错）", async () => {
  process.env.KB_EMBEDDING = "on";
  process.env.KB_EMBEDDING_BASE_URL = "http://127.0.0.1:1/v1"; // 必然连不上
  process.env.KB_EMBEDDING_TIMEOUT_MS = "1000";
  const hits = await store.search("报销需要发票吗", 3);
  assert.ok(hits.length, "降级后仍应有词法命中");
  assert.equal(hits[0].title, "报销流程");
  process.env.KB_EMBEDDING = "off";
  delete process.env.KB_EMBEDDING_BASE_URL;
});

// ---- D. 增量：指纹未变跳过、变更重建、删除清理 ----
await check("sourceHashes 提供指纹，未变更可跳过", async () => {
  const hashes = store.sourceHashes();
  assert.equal(hashes.get("a.md"), md5("1"));
  assert.equal(hashes.get("b.md"), md5("2"));
});

await check("变更内容后重新入库，切片随之更新", async () => {
  const changed = [{ ...docs[0], text: "考勤制度已修订：迟到一律按旷工半天计算，并记入季度考核。", hash: md5("1-new") }];
  store.removeSource("a.md");
  await store.ingest(changed);
  assert.equal(store.sourceHashes().get("a.md"), md5("1-new"));
  const hits = await store.search("迟到", 3);
  assert.ok(hits.some((h) => h.text.includes("季度考核")), "应命中修订后的内容");
});

await check("removeSource 精确删除该来源全部切片", async () => {
  const before = store.stats().docs;
  const removed = store.removeSource("c.md");
  assert.ok(removed >= 1);
  assert.equal(store.stats().docs, before - removed);
  assert.equal(store.listSources().some((s) => s.source === "c.md"), false);
});

// ---- E. 工具接线 ----
await check("search_knowledge / knowledge_sources 已注册且有风险登记", () => {
  const names = builtinToolSpecs().map((s) => s.name);
  assert.ok(names.includes("search_knowledge"));
  assert.ok(names.includes("knowledge_sources"));
  assert.equal(BUILTIN_RISK.search_knowledge.level, "read");
  assert.equal(BUILTIN_RISK.knowledge_sources.level, "read");
});

await check("execBuiltin search_knowledge 返回带来源的片段", async () => {
  const out = await execBuiltin("search_knowledge", JSON.stringify({ query: "报销" }), "conv-test");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("来源：b.md"), `应带来源，实际：${out.text.slice(0, 120)}`);
});

await check("execBuiltin search_knowledge 无命中时如实说明（不编造）", async () => {
  const out = await execBuiltin("search_knowledge", JSON.stringify({ query: "区块链" }), "conv-test");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("没有匹配"));
});

await check("execBuiltin knowledge_sources 列出来源", async () => {
  const out = await execBuiltin("knowledge_sources", "{}", "conv-test");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("a.md") && out.text.includes("b.md"));
});

// 注意：该用例会整体覆盖临时索引，必须放在依赖临时索引的用例（A–E）之后。
await check("索引被外部进程改动后自动重载（无需重启服务）", async () => {
  await new Promise((r) => setTimeout(r, 20)); // 确保 mtime 与上一次写入不同
  fs.writeFileSync(
    path.join(tmp, "index.json"),
    JSON.stringify({
      updatedAt: Date.now(),
      docs: [
        { id: "ext.md#0", title: "外部写入", source: "ext.md", text: "外部进程写入的独有能力验证内容。", updatedAt: Date.now() },
      ],
    }),
  );
  const hits = await store.search("外部进程写入", 3);
  assert.equal(hits[0]?.title, "外部写入", "应读到外部进程写入的索引（按 mtime 失效重载）");
});

// ---- F. 真实语料（docs/knowledge 已入库才跑）----
store.setRagDirForTest(""); // 回到真实索引目录
store.resetCache();
if (store.stats().docs > 0) {
  // 断言只用「文档里确实有答案」的问题：知识库答不上来的问题本就该无命中（不允许编造）。
  await check("真实语料：口语化提问命中正确文档（补卡）", async () => {
    const hits = await store.search("忘记打卡了怎么办", 3);
    assert.ok(hits.length, "应有命中");
    assert.ok(hits[0].source.includes("考勤"), `top1 实际：${hits[0].source}`);
  });
  await check("真实语料：场景提问不串台（进程托管方式）", async () => {
    const hits = await store.search("前端项目用什么进程管理工具托管", 3);
    assert.ok(hits.length, "应有命中");
    assert.ok(hits[0].source.includes("部署"), `top1 实际：${hits[0].source}`);
  });
  await check("真实语料：工具输出带来源（答案可溯源）", async () => {
    const out = await execBuiltin("search_knowledge", JSON.stringify({ query: "忘记打卡怎么办" }), "conv-test");
    assert.equal(out.ok, true);
    assert.ok(out.text.includes("来源："), `应带来源，实际：${out.text.slice(0, 120)}`);
    assert.ok(out.text.includes("考勤"), `top1 应为考勤制度，实际：${out.text.slice(0, 120)}`);
  });
} else {
  console.log("SKIP 真实语料未入库（先跑 scripts/build-rag-index.mjs）");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(pass >= 15 ? `\n${pass} checks passed` : `\n${pass} checks passed (with failures above)`);
