/**
 * LLM 端到端评测：走 chatStream 全链路（模型 + 工具循环 + 反问/调用）
 * 需要 .env 中已配置 MODEL_* 且 agent-server 可访问模型 API。
 */
import "./../src/load-env.js";
import { chatStream } from "../src/chat.js";
import { createSession, deleteSession, clearSessionContext, setActiveProject } from "../src/session.js";
import { getCountry } from "../src/config.js";
import { mockLogin } from "../src/mock-upstream.js";

const CASES = [
  {
    name: "推荐片段管理-查列表",
    input: "推荐片段管理模块，列表查一下",
    forbid: [/重新描述你要操作的模块名/i, /禁止仅用文字/i],
    preferTools: ["grep_codebase", "search_api_module", "call_api"],
    requireTools: ["call_api"],
  },
  {
    name: "时间标签-id详情",
    input: "时间标签 id=4985535735769088，列给我所有详情",
    forbid: [/重新描述你要操作的模块名/i, /还需要确认【模块】.*重新描述/i],
    preferTools: ["call_api", "grep_codebase", "search_api_module"],
    requireTools: ["call_api"],
  },
  {
    name: "兑换码-列表查一下",
    input: "兑换码模块，列表查一下",
    forbid: [/没有匹配的模块/i, /重新描述你要操作的模块名/i],
    preferTools: ["call_api", "grep_codebase", "search_api_module"],
    requireTools: ["call_api"],
  },
  {
    name: "仅模块名-应可继续或反问操作",
    input: "兑换码",
    forbid: [/重新描述你要操作的模块名/i],
    allowClarify: true,
  },
];

const TIMEOUT_MS = 120_000;

async function runCase(session, c) {
  clearSessionContext(session.id);
  setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });

  const tools = [];
  let text = "";
  let error = "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    for await (const ev of chatStream(session, c.input, { model: process.env.E2E_MODEL || "hy3" }, ac.signal)) {
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
  const failedForbid = c.forbid?.filter((re) => re.test(full)) ?? [];
  const hitPrefer = c.preferTools?.some((t) => tools.includes(t)) ?? true;
  const required = Array.isArray(c.requireTools) ? c.requireTools : c.requireTools ? c.preferTools : null;
  const missingRequired = required?.filter((t) => !tools.includes(t)) ?? [];
  const ok = !error && failedForbid.length === 0 && hitPrefer && missingRequired.length === 0;

  console.log(`\n--- ${c.name} ---`);
  console.log(`输入: ${c.input}`);
  console.log(`工具: ${tools.join(" → ") || "(无)"}`);
  console.log(`输出: ${full.slice(0, 300)}${full.length > 300 ? "..." : ""}`);
  if (error) console.log(`错误: ${error}`);
  if (failedForbid.length) console.log(`违规文案: ${failedForbid.map(String).join(", ")}`);
  if (missingRequired.length) console.log(`违规: 缺少必需工具 ${missingRequired.join(", ")}`);
  console.log(ok ? "PASS" : "FAIL");

  return { name: c.name, ok, tools, text: full, error };
}

const country = getCountry("brazil") || getCountry("india");
if (!country) {
  console.error("未找到国家线配置，请检查 .env 中 COUNTRY_*");
  process.exit(1);
}

const auth = mockLogin("e2e-tester");
const session = createSession({
  token: auth.token,
  country,
  user: auth.user,
  menus: auth.menus,
});

console.log("LLM 端到端评测开始（chatStream）...");
console.log(`模型: ${process.env.E2E_MODEL || "hy3"}`);
console.log(`国家线: ${country.label}`);

const results = [];
for (const c of CASES) {
  results.push(await runCase(session, c));
}

deleteSession(session.id);

const pass = results.filter((r) => r.ok).length;
console.log(`\n========== LLM E2E ==========`);
console.log(`TOTAL: ${pass}/${results.length}`);

if (pass < results.length) process.exit(1);
