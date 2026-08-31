/**
 * 真实 LLM 随机抽测（少量）：验证首工具是 submit_understood_intent
 */
import "./../src/load-env.ts";
import { chatStream } from "../src/chat.ts";
import { createSession, deleteSession, clearSessionContext, setActiveProject } from "../src/session.ts";
import { getCountry } from "../src/config.ts";
import { mockLogin } from "../src/mock-upstream.ts";

const MODULES = ["推荐片段管理", "时间标签", "影片", "兑换码", "二级分类", "会员订单"];
const OPS = ["列表查一下", "查列表", "列给我详情"];
const IDS = ["4985535735769088", "778899001122"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const cases = [
  { kind: "full", input: `${pick(MODULES)}模块，${pick(OPS)}` },
  { kind: "id", input: `${pick(MODULES)} id=${pick(IDS)}，列给我所有详情` },
  { kind: "incomplete", input: pick(["兑换码", "影片", "用户"]) },
  { kind: "chat", input: pick(["你好", "今天天气怎么样"]) },
];

const country = getCountry("brazil") || getCountry("india");
if (!country) {
  console.error("未找到国家线");
  process.exit(1);
}
const auth = mockLogin("rand-llm");
const session = createSession({
  token: auth.token,
  country,
  user: auth.user,
  menus: auth.menus,
});

console.log("========== 真实 LLM 随机抽测 ==========");
console.log(`model=${process.env.E2E_MODEL || "dsflash"}`);
console.log(cases.map((c, i) => `  ${i + 1}. [${c.kind}] ${c.input}`).join("\n"));

const rows = [];
const modelId = process.env.E2E_MODEL || "dsflash";
for (const c of cases) {
  clearSessionContext(session.id);
  setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });
  const tools = [];
  let text = "";
  let error = "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  try {
    for await (const ev of chatStream(session, c.input, { model: modelId }, ac.signal)) {
      if (ev.type === "tool_call") tools.push(ev.name);
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") error = ev.message;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const first = tools[0] || "-";
  const understandFirst = first === "submit_understood_intent";
  let verdict = "PASS";
  const notes = [];
  if (error) {
    verdict = "FAIL";
    notes.push(error.slice(0, 120));
  }
  if (c.kind !== "chat" && !understandFirst) {
    verdict = "FAIL";
    notes.push(`未先理解 first=${first}`);
  }
  if (c.kind === "chat" && tools.includes("call_api")) notes.push("WARN:闲聊调了call_api");

  console.log(`\n--- [${c.kind}] ${c.input}`);
  console.log(`  工具: ${tools.join("→") || "(无)"}`);
  console.log(`  输出: ${text.trim().slice(0, 200)}${text.length > 200 ? "..." : ""}`);
  console.log(`  ${verdict}${notes.length ? " | " + notes.join("; ") : ""}`);
  rows.push({ ...c, tools, verdict, notes });
}

deleteSession(session.id);
const fail = rows.filter((r) => r.verdict === "FAIL").length;
console.log(`\n========== 汇总 PASS ${rows.length - fail}/${rows.length} ==========`);
for (const r of rows) {
  console.log(`- ${r.verdict} [${r.kind}] ${r.tools.join(">") || "-"} :: ${r.input}`);
}
if (fail) process.exit(1);
