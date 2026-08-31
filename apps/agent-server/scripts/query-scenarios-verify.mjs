// 全场景查询用例批量验证（2026-08-25，只读模式验证）
// 用法：node scripts/query-scenarios-verify.mjs   （每用例间隔 5 分钟防 429，输出追加 tmp-query-report.txt）
import { writeFileSync, appendFileSync } from "node:fs";

const BASE = "http://localhost:8787";
const LOG = "tmp-query-report.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s) => {
  appendFileSync(LOG, s + "\n", "utf8");
  console.log(s);
};

// 覆盖常见后台查询场景（参考通用后台管理系统常见查询：列表/分页/口语/配置/多页/详情/搜索/知识库/闲聊）
const CASES = [
  { name: "闲聊问候", text: "你好", expect: "非业务直接回复" },
  { name: "列表分页", text: "影片列表管理，前2页", expect: "2次call_api+表格" },
  { name: "口语化列表", text: "帮我查下用户列表", expect: "call_api+表格" },
  { name: "配置类列表", text: "查询优惠活动配置列表", expect: "call_api+表格" },
  { name: "多页聚合", text: "用户分层列表前5页的数据", expect: "多次call_api聚合1表" },
  { name: "详情查询", text: "查看影片ID为5590108001975296的详情", expect: "详情渲染" },
  { name: "关键词搜索", text: "搜索影片名称包含Your的影片", expect: "call_api+表格" },
  { name: "知识库问答", text: "上班迟到了会扣钱吗", expect: "KB语义检索" },
];

async function runCase(idx, c) {
  const t0 = Date.now();
  let sid = "";
  try {
    const lg = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: "india", username: "admin", password: "123456" }),
      redirect: "manual",
    });
    sid = (lg.headers.get("set-cookie") || "").split(";")[0].split("=")[1] || "";
    if (!sid) return `[${c.name}] 登录失败 status=${lg.status}`;
  } catch (e) {
    return `[${c.name}] 登录异常 ${e.message}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300000);
  let status = 0, body = "";
  try {
    const c2 = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `bx_agent_sid=${sid}` },
      body: JSON.stringify({ text: c.text, model: undefined }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    status = c2.status;
    body = await c2.text();
  } catch (e) {
    clearTimeout(timer);
    return `[${c.name}] 请求异常 ${e.message}`;
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
  const submits = evs.filter((e) => e.includes("submit_understood_intent"));
  const calls = evs.filter((e) => e.includes('"call_api"') || e.includes("call_api"));
  const tables = evs.filter((e) => e.includes('"type":"table"')).length;
  const err = evs.find((e) => e.includes('"type":"error"'));
  const done = evs.some((e) => e.includes('"type":"done"'));
  const msgs = evs.filter((e) => e.includes('"type":"message"') || e.includes('"type":"answer"'));
  const endText = msgs.length ? (JSON.parse(msgs[msgs.length - 1]).text || "").slice(0, 120).replace(/\n/g, " ") : "";

  const callBrief = calls.slice(0, 8).map((e) => {
    try { const j = JSON.parse(e); const inp = j.input || j.parameters || j.arguments; return `${inp.method || "?"} ${inp.operation || inp.path || inp.url || "?"}`; }
    catch { return "?"; }
  }).join(" | ");
  const submitBrief = submits[0] ? (() => { try { const j = JSON.parse(submits[0]); const inp = j.input || j.parameters || j.arguments; return `module=${inp.module || "?"} op=${inp.operationType || "?"}`; } catch { return "?"; } })() : "无";

  return `[${c.name}] ${dt}s status=${status} done=${done} 表格=${tables}\n    submit: ${submitBrief}\n    calls: ${callBrief || "无"}\n    output: ${endText || "无"}${err ? `\n    err: ${JSON.stringify(err).slice(0, 150)}` : ""}`;
}

(async () => {
  line(`==== 全场景查询验证开始 ${new Date().toISOString()} ====`);
  line(`模型: default(auto) | 每用例间隔 5 分钟防 429`);
  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const r = await runCase(i, CASES[i]);
    results.push(r);
    line(`\n--- ${i + 1}/${CASES.length} ---\n${r}`);
    if (i < CASES.length - 1) {
      line(`[等待 5 分钟防 429... ${new Date().toISOString()}]`);
      await sleep(300000);
    }
  }
  line(`\n==== 全部完成 ${new Date().toISOString()} ====`);
  line(`\n==== 汇总 ====`);
  results.forEach((r) => line(r.split("\n")[0]));
})();
