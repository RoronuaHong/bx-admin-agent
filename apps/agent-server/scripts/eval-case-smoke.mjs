/**
 * 冒烟：LLM-first + 规则门 + 白名单等关键路径
 */
import "./../src/load-env.ts";
import { chatStream } from "../src/chat.ts";
import { createSession, deleteSession, clearSessionContext, setActiveProject } from "../src/session.ts";
import { getCountry } from "../src/config.ts";
import { mockLogin } from "../src/mock-upstream.ts";

const cases = [
  {
    name: "白名单管理-列表",
    input: "需要看白名单管理的列表",
    expect: {
      understandFirst: true,
      forbidModuleClarify: true,
      expectMockData: true,
      expectCallApi: true,
    },
  },
  {
    name: "用户详情-带id",
    input: "用户列表，10038557464768004，看详情",
    expect: {
      understandFirst: true,
      expectMockData: true,
      expectCallApi: true,
    },
  },
  {
    name: "仅模块名-应反问或继续",
    input: "兑换码",
    expect: {
      understandFirst: true,
      allowClarify: true,
    },
  },
  {
    name: "闲聊",
    input: "你好",
    expect: {
      noCallApi: true,
    },
  },
];

const country = getCountry("brazil") || getCountry("india");
if (!country) {
  console.error("未找到国家线");
  process.exit(1);
}
const auth = mockLogin("case-smoke");
const session = createSession({
  token: auth.token,
  country,
  user: auth.user,
  menus: auth.menus,
});

const modelId = process.env.E2E_MODEL || "dsflash";
console.log("========== 用例冒烟 ==========");
console.log(`model=${modelId}`);

const rows = [];
for (const c of cases) {
  clearSessionContext(session.id);
  setActiveProject(session.id, {
    key: "bx-film-admin",
    label: "影视后台管理系统",
    setAt: Date.now(),
  });

  const tools = [];
  let text = "";
  let error = "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);

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

  const full = text.trim();
  const first = tools[0] || "-";
  const notes = [];
  let verdict = "PASS";

  if (error) {
    if (/recursion limit/i.test(error) || error.includes("工具调用过多")) {
      verdict = "FAIL";
      notes.push(`recursion=${error.slice(0, 80)}`);
    } else if (/取消|abort/i.test(error)) {
      verdict = "FAIL";
      notes.push(`timeout/abort=${error.slice(0, 80)}`);
    } else {
      notes.push(`error=${error.slice(0, 100)}`);
      // 上游登录失败等允许，只要流程走到了
    }
  }

  if (c.expect.understandFirst && first !== "submit_understood_intent" && first !== "-") {
    // 允许闲聊不调工具；业务应优先理解。若直接 grep 也算可接受但记 WARN
    if (c.name !== "闲聊") {
      if (!tools.includes("submit_understood_intent")) {
        verdict = "FAIL";
        notes.push("未调用 submit_understood_intent");
      } else if (first !== "submit_understood_intent") {
        notes.push(`WARN: 首工具不是理解 first=${first}`);
      }
    }
  }

  if (c.expect.forbidModuleClarify) {
    if (/你要操作哪个模块？[\s\S]*影片（film）/.test(full)) {
      verdict = "FAIL";
      notes.push("又出现误导性模块反问（影片/片段）");
    }
  }

  if (c.expect.noCallApi && tools.includes("call_api")) {
    notes.push("WARN: 闲聊调了 call_api");
  }

  if (c.expect.expectCallApi && !tools.includes("call_api")) {
    verdict = "FAIL";
    notes.push("未调用 call_api");
  }

  // mock-token 下应拿到业务数据，不应再出现「登录过期」
  if (c.expect.expectMockData) {
    if (/登录过期|login expired|未登录/i.test(full)) {
      verdict = "FAIL";
      notes.push("仍出现登录过期（mock 未生效）");
    }
    if (tools.includes("call_api") && !/白名单|用户|列表|详情|deviceId|loginName|演示|评测|共\s*\d|条/i.test(full)) {
      notes.push("WARN: call_api 后答复不像业务数据");
    }
  }

  if (!error && /未能生成最终说明/.test(full)) {
    verdict = "FAIL";
    notes.push("空转收束无有效答复");
  }

  if (!error && !full && tools.length === 0) {
    verdict = "FAIL";
    notes.push("无输出无工具");
  }

  console.log(`\n--- ${c.name} ---`);
  console.log(`输入: ${c.input}`);
  console.log(`工具: ${tools.join(" → ") || "(无)"}`);
  console.log(`输出: ${full.slice(0, 220)}${full.length > 220 ? "..." : ""}`);
  if (error) console.log(`错误: ${error.slice(0, 200)}`);
  console.log(`${verdict}${notes.length ? " | " + notes.join("; ") : ""}`);

  rows.push({ name: c.name, verdict, tools, notes, error, text: full });
}

deleteSession(session.id);
const fail = rows.filter((r) => r.verdict === "FAIL");
console.log(`\n========== 汇总 PASS ${rows.length - fail.length}/${rows.length} ==========`);
for (const r of rows) {
  console.log(`- ${r.verdict} ${r.name} | ${r.tools.join(">") || "-"}`);
}
if (fail.length) process.exit(1);
