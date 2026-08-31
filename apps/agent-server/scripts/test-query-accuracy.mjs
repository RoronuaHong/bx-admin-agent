// 临时：批量查询成功率/准确率端到端验证（走真实 agent-server HTTP）
// 场景覆盖：基础列表/多页分页/别名模块/i18n菜单/统计接口/命名错位/闲聊
// 判定：SUBMIT.module & CALL.operation 对照预期；done+表格/有效文本=成功；429/超时自动退避重试
const BASE = "http://localhost:8787";

const CASES = [
  { name: "用户列表", text: "看下用户列表", module: ["user", "account"], op: ["user.getList", "account.getList"] },
  { name: "用户列表前3页", text: "用户列表前3页的数据", module: ["user", "account"], op: ["user.getList", "account.getList"], pages: 3 },
  { name: "影片列表前2页", text: "影片列表管理，前2页", module: ["film"], op: ["film.getList"], pages: 2 },
  { name: "优惠活动配置列表", text: "查询优惠活动配置列表", module: ["user/special_offer"], op: ["user/special_offer.getList"] },
  { name: "二级分类列表", text: "看下二级分类列表", module: ["country"], op: ["country.getList"] },
  { name: "影片搜索统计", text: "看下影片搜索统计列表", module: ["search"], op: ["search.getMovieSearchStatList"] },
  { name: "用户分层前5页", text: "用户分层列表前5页的数据", module: ["user/account_layer"], op: ["user/account_layer.getStickiness"], pages: 5 },
  { name: "闲聊-你好", text: "你好", noBiz: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const lg = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: "india", username: "admin", password: "123456" }),
    redirect: "manual",
  });
  return (lg.headers.get("set-cookie") || "").split(";")[0].split("=")[1] || "";
}

async function runCase(c, attempt) {
  const sid = await login();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 240000);
  const t0 = Date.now();
  let body = "";
  let timedOut = false;
  try {
    const res = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `bx_agent_sid=${sid}` },
      body: JSON.stringify({ text: c.text }),
      signal: ac.signal,
    });
    body = await res.text();
  } catch (e) {
    timedOut = e?.name === "AbortError";
    body = "";
  }
  clearTimeout(timer);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // 429/上游 400/超时退避重试（zen 免费链间歇 400/限流）
  const isBad = /FreeUsageLimit|rate.?limit|429|503|http 400/i.test(body.slice(0, 500));
  if ((isBad || timedOut) && attempt < 2) {
    console.log(`  ⚠️ ${c.name} ${timedOut ? `超时(${dt}s)` : "上游异常"}，等待 ${isBad ? 90 : 60}s 重试`);
    await sleep(isBad ? 90000 : 60000);
    return runCase(c, attempt + 1);
  }

  const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
  const calls = [];
  let submit = null;
  let tables = 0;
  let texts = [];
  let error = "";
  let done = false;
  for (const e of evs) {
    try {
      const j = JSON.parse(e);
      if (j.type === "tool_call" && j.name === "submit_understood_intent") submit = j.input || {};
      if (j.type === "tool_call" && j.name === "call_api") calls.push(j.input || {});
      if (j.type === "table") tables += 1;
      if (j.type === "text") texts.push(String(j.text || ""));
      if (j.type === "error") error = String(j.message || "");
      if (j.type === "done") done = true;
    } catch { /* 忽略非 JSON 行 */ }
  }
  const lastText = (texts[texts.length - 1] || "").replace(/\s+/g, " ").slice(0, 120);

  const ops = calls.map((x) => x.operation || "");
  const modules = [submit?.module || "", ...ops.map((o) => (o || "").split(".")[0])].filter(Boolean);
  const modShort = (c.module || []).map((m) => m.split("/").slice(-1)[0]);

  const modOk = c.noBiz ? true : (c.module || []).some((m) => modules.includes(m) || modules.some((x) => x.endsWith(m.split("/").slice(-1)[0])));
  const opOk = c.op ? ops.some((o) => (c.op || []).includes(o)) : true;
  const pageOk = c.pages ? calls.length >= c.pages : true;
  const dataOk = c.noBiz ? true : tables > 0 || /共|条|记录|列表|数据/.test(lastText);
  const noBizOk = c.noBiz ? calls.length === 0 && tables === 0 : true;
  const success = done && !error && !timedOut && modOk && opOk && pageOk && dataOk && noBizOk;

  console.log(
    `\n[${c.name}] ${dt}s | ${success ? "✅成功" : "❌失败"} | done=${done} | 表格=${tables} | 调用=${calls.length}` +
      (c.pages ? `(需≥${c.pages})` : "") + ` | err=${error ? error.slice(0, 60) : timedOut ? "超时" : "无"}`,
  );
  if (submit) console.log(`  SUBMIT module=${JSON.stringify(submit.module)} opType=${submit.operationType} op=${submit.operation || ""}`);
  for (const x of calls) console.log(`  CALL ${x.operation || "(无operation)"} ${JSON.stringify(x.params || {})}`);
  if (lastText) console.log(`  输出: ${lastText}`);
  if (c.noBiz) {
    if (!noBizOk) console.log(`  ✗ 闲聊误调工具`);
  } else {
    if (!modOk) console.log(`  ✗ 模块不准: 期望 ${(c.module || []).join("/")}，实际 ${modules.join(",")}`);
    if (!opOk) console.log(`  ✗ 操作不准: 期望 ${(c.op || []).join("/")}，实际 ${ops.join(",")}`);
    if (c.pages && calls.length < c.pages) console.log(`  ✗ 分页不足: 期望≥${c.pages}次调用`);
    if (!dataOk) console.log(`  ✗ 未取到数据`);
  }
  if (error) console.log(`  ✗ 错误: ${error.slice(0, 120)}`);

  return { name: c.name, ok: success, dt: Number(dt), tables, calls: calls.length, timedOut };
}

const results = [];
for (let i = 0; i < CASES.length; i++) {
  console.log(`\n========== ${i + 1}/${CASES.length} ${CASES[i].name} ==========`);
  results.push(await runCase(CASES[i], 0));
  if (i < CASES.length - 1) await sleep(15000);
}

const pass = results.filter((r) => r.ok).length;
const biz = results.filter((r) => !r.name.includes("闲聊"));
const bizPass = biz.filter((r) => r.ok).length;
const avgDt = (results.reduce((s, r) => s + r.dt, 0) / results.length).toFixed(1);
console.log(`\n========== 汇总 ==========`);
console.log(`成功率: ${pass}/${results.length} (${((pass / results.length) * 100).toFixed(1)}%)`);
console.log(`业务场景: ${bizPass}/${biz.length} (${((bizPass / biz.length) * 100).toFixed(1)}%) | 平均耗时 ${avgDt}s`);
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.name} (${r.dt}s, 表格=${r.tables}, 调用=${r.calls})`);
