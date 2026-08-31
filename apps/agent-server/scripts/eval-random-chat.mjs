/**
 * 随机输入端到端抽测（不固化用例，每次从池子抽样）
 */
import "./../src/load-env.js";
import { chatStream } from "../src/chat.js";
import { createSession, deleteSession, clearSessionContext, setActiveProject } from "../src/session.js";
import { getCountry } from "../src/config.js";
import { mockLogin } from "../src/mock-upstream.js";
import { isActionableBusinessQuery } from "../src/tool-gate.js";

const MODULES = [
  "推荐片段管理",
  "时间标签",
  "影片管理",
  "兑换码",
  "用户管理",
  "二级分类",
  "一级分类",
  "会员订单",
];
const OPS = ["列表查一下", "查列表", "列给我详情", "搜索一下"];
const IDS = ["4985535735769088", "10001", "778899001122"];
const EXPLICIT = [
  "推荐片段管理模块，列表查一下",
  "影片管理模块，列表查一下",
  "兑换码模块，列表查一下",
  "时间标签 id=4985535735769088，列给我所有详情",
];
const INCOMPLETE = ["兑换码", "用户", "分类", "那个模块", "帮我查一下"];
const CHAT = ["你好", "今天天气怎么样", "帮我写个正则"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildCases(n = 10) {
  const cases = [];
  for (let i = 0; i < n; i++) {
    const kind = ["full", "id", "explicit", "incomplete", "chat"][i % 5];
    if (kind === "full") {
      const input = `${pick(MODULES)}模块，${pick(OPS)}`;
      cases.push({ kind, input, expectTools: true, expectClarifyOk: true });
    } else if (kind === "id") {
      const input = `${pick(MODULES)} id=${pick(IDS)}，列给我所有详情`;
      cases.push({ kind, input, expectTools: true, expectClarifyOk: true });
    } else if (kind === "explicit") {
      cases.push({ kind, input: pick(EXPLICIT), expectTools: true, expectClarifyOk: true });
    } else if (kind === "incomplete") {
      cases.push({ kind, input: pick(INCOMPLETE), expectTools: false, expectClarifyOk: true });
    } else {
      cases.push({ kind, input: pick(CHAT), expectTools: false, expectClarifyOk: true });
    }
  }
  return cases;
}

const TIMEOUT_MS = 90_000;
const country = getCountry("brazil") || getCountry("india");
if (!country) {
  console.error("未找到国家线配置");
  process.exit(1);
}
const auth = mockLogin("random-tester");
const session = createSession({
  token: auth.token,
  country,
  user: auth.user,
  menus: auth.menus,
});

const cases = buildCases(10);
console.log("随机抽测开始");
console.log(`模型: ${process.env.E2E_MODEL || "hyvision"}`);
console.log(`种子用例:\n${cases.map((c, i) => `  ${i + 1}. [${c.kind}] ${c.input}`).join("\n")}`);

const results = [];
for (const c of cases) {
  clearSessionContext(session.id);
  setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });
  const tools = [];
  let text = "";
  let error = "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    for await (const ev of chatStream(session, c.input, { model: process.env.E2E_MODEL || "hyvision" }, ac.signal)) {
      if (ev.type === "tool_call") tools.push(ev.name);
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") error = ev.message;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const full = text.trim();
  const actionable = isActionableBusinessQuery(c.input);
  const hasCallApi = tools.includes("call_api");
  const hasGrep = tools.includes("grep_codebase");
  const hasParse = tools.includes("parse_intent");
  const hasUnderstand = tools.includes("submit_understood_intent");
  const understandFirst = tools[0] === "submit_understood_intent";
  const badAskModule = /重新描述你要操作的模块名|没有匹配的模块/.test(full);
  const hallucinateJson = /"name"\s*:\s*"周末特惠"/.test(full);
  let verdict = "OK";
  const notes = [];
  if (error) {
    verdict = "FAIL";
    notes.push(`error=${error.slice(0, 120)}`);
  }
  if (hasUnderstand && !understandFirst) {
    verdict = "FAIL";
    notes.push(`理解未优先: first=${tools[0] || "-"}`);
  }
  if (actionable && c.expectTools && !hasUnderstand) {
    verdict = "FAIL";
    notes.push("业务请求未先 submit_understood_intent");
  }
  if (actionable && c.expectTools && !hasGrep && !hasCallApi && !hasParse) {
    verdict = "FAIL";
    notes.push("业务请求未走编排工具");
  }
  if (actionable && c.kind !== "incomplete" && !hasCallApi && tools.length) {
    notes.push("WARN: 有工具但未 call_api");
  }
  if (c.kind === "chat" && tools.length) notes.push("WARN: 闲聊也调了工具");
  if (badAskModule) {
    verdict = "FAIL";
    notes.push("错误反问模块");
  }
  if (hallucinateJson) notes.push("WARN: 疑似编造数据");

  console.log(`\n--- [${c.kind}] ${c.input} ---`);
  console.log(`actionable=${actionable} 工具: ${tools.join(" → ") || "(无)"}`);
  console.log(`输出: ${full.slice(0, 220)}${full.length > 220 ? "..." : ""}`);
  console.log(`${verdict}${notes.length ? " | " + notes.join("; ") : ""}`);
  results.push({ ...c, tools, text: full, error, verdict, notes, actionable });
}

deleteSession(session.id);
const fail = results.filter((r) => r.verdict === "FAIL");
const warn = results.filter((r) => r.notes.some((n) => n.startsWith("WARN")));
console.log(`\n========== 随机抽测 ==========`);
console.log(`FAIL ${fail.length}/${results.length}  WARN ${warn.length}/${results.length}`);
for (const r of results) {
  console.log(`- [${r.kind}] ${r.verdict} tools=${r.tools.join(">") || "-"} :: ${r.input}`);
}
if (fail.length) process.exit(1);
