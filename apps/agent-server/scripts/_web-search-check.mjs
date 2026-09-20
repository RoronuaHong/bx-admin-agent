// 联网检索验证（内置工具 web_search / fetch_url 的 provider 层与安全边界）。
// 运行：node --import tsx scripts/_web-search-check.mjs
// 依赖：配好 WEB_SEARCH_*（默认 searxng @ http://localhost:8888）；服务不可达时联网用例标记 SKIP 而非 FAIL。
import assert from "node:assert/strict";

await import("../src/load-env.js");
const web = await import("../src/web-search.js");
const { builtinToolSpecs, BUILTIN_RISK } = await import("../src/builtins.js");

let pass = 0;
let skip = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    if (err && err.skip) {
      skip += 1;
      console.log(`SKIP ${name}: ${err.message}`);
      return;
    }
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
const skipped = (message) => Object.assign(new Error(message), { skip: true });

/** 临时清空联网配置跑一段用例（验证「未配置时诚实降级」）；必须 await 完再恢复 env。 */
async function withoutConfig(fn) {
  const saved = {
    provider: process.env.WEB_SEARCH_PROVIDER,
    baseUrl: process.env.WEB_SEARCH_BASE_URL,
    key: process.env.WEB_SEARCH_API_KEY,
  };
  delete process.env.WEB_SEARCH_PROVIDER;
  delete process.env.WEB_SEARCH_BASE_URL;
  delete process.env.WEB_SEARCH_API_KEY;
  try {
    return await fn();
  } finally {
    for (const [name, value] of [
      ["WEB_SEARCH_PROVIDER", saved.provider],
      ["WEB_SEARCH_BASE_URL", saved.baseUrl],
      ["WEB_SEARCH_API_KEY", saved.key],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ---- A. 未配置时的诚实降级 ----
await check("未配置时：status 不可用且给出原因、检索返回错误不抛异常、工具不注册", async () => {
  await withoutConfig(async () => {
    const status = web.webSearchStatus();
    assert.equal(status.available, false);
    assert.ok(status.reason && status.reason.length > 0, "应给出不可用原因");
    const outcome = await web.webSearch("anything");
    assert.equal(outcome.ok, false);
    assert.ok(outcome.error.length > 0);
    const names = builtinToolSpecs().map((spec) => spec.name);
    assert.ok(!names.includes("web_search"), "未配置时不应注册 web_search");
    assert.ok(!names.includes("fetch_url"), "未配置时不应注册 fetch_url");
  });
  assert.ok(builtinToolSpecs().some((spec) => spec.name === "web_search"), "配置后应注册 web_search");
});

// ---- B. 未知 provider 不静默放过 ----
await check("未知 provider：status 不可用并列出可选值", () => {
  const saved = process.env.WEB_SEARCH_PROVIDER;
  process.env.WEB_SEARCH_PROVIDER = "not-a-provider";
  try {
    const status = web.webSearchStatus();
    assert.equal(status.available, false);
    assert.match(status.reason, /not-a-provider/);
  } finally {
    if (saved === undefined) delete process.env.WEB_SEARCH_PROVIDER;
    else process.env.WEB_SEARCH_PROVIDER = saved;
  }
});

// ---- C. 风险登记与内置工具规格 ----
await check("web_search / fetch_url 已登记为只读且不进确认流程", () => {
  for (const name of ["web_search", "fetch_url"]) {
    const risk = BUILTIN_RISK[name];
    assert.ok(risk, `${name} 缺少风险登记`);
    assert.equal(risk.level, "read");
    assert.equal(risk.scope, "workspace");
  }
  const search = builtinToolSpecs().find((spec) => spec.name === "web_search");
  assert.deepEqual(search.parameters.required, ["query"]);
});

// ---- D. fetch_url 安全边界（本机 / 私网 / 非 http）----
await check("fetch_url 阻断本机、私网与保留地址，且只允许 http(s)", async () => {
  const blocked = [
    "http://localhost:8888/",
    "http://127.0.0.1/admin",
    "http://10.1.2.3/",
    "http://192.168.1.10/",
    "http://172.16.5.4/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "file:///etc/passwd",
  ];
  for (const url of blocked) {
    const outcome = await web.fetchPage(url);
    assert.equal(outcome.ok, false, `${url} 应被拒绝`);
  }
  const bad = await web.fetchPage("not a url");
  assert.equal(bad.ok, false);
});

// ---- E. 真实联网（需要检索服务可用）----
await check("web_search 返回可引用的真实结果", async () => {
  const status = web.webSearchStatus();
  if (!status.available) throw skipped(status.reason || "未配置");
  const outcome = await web.webSearch("OpenAI");
  if (!outcome.ok) throw skipped(outcome.error);
  assert.ok(outcome.hits.length > 0, "应有命中结果");
  for (const hit of outcome.hits) {
    assert.ok(hit.url.startsWith("http"), `结果应带链接：${hit.url}`);
  }
  console.log(`  → ${outcome.provider} 命中 ${outcome.hits.length} 条，首条：${outcome.hits[0].title}`);
});

await check("fetch_url 抓取公网网页正文", async () => {
  const outcome = await web.fetchPage("https://example.com/");
  if (!outcome.ok) throw skipped(outcome.error);
  assert.ok(outcome.text.length > 20, "应提取出正文");
  console.log(`  → 抓取 ${outcome.bytes} 字节，正文 ${outcome.text.length} 字，标题：${outcome.title}`);
});

console.log(`\n结果：PASS ${pass} / SKIP ${skip}${process.exitCode ? " / FAIL" : ""}`);
