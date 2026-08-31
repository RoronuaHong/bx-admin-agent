/**
 * 验证「先理解再规则」：模拟 LLM submit_understood_intent → parse_intent → orchestrate
 * 随机抽样，不依赖真实大模型 API。
 *
 * 运行：pnpm --filter @bx/agent-server exec tsx scripts/eval-understand-then-rules.mjs
 */
import { runAgentTool } from "../src/tools.ts";
import { orchestrateBusinessQuery } from "../src/workflow-orchestrate.ts";
import { createSession, deleteSession, setActiveProject } from "../src/session.ts";
import { parseUnderstoodIntent } from "../src/understood-intent.ts";

const MODULES = [
  { say: "推荐片段管理", key: "movie-fragment" },
  { say: "时间标签", key: "movietimetag" },
  { say: "影片", key: "film" },
  { say: "兑换码", key: "vipExchangeCode" },
  { say: "二级分类", key: "country" },
  { say: "会员订单", key: "vipOrder" },
  { say: "用户", key: "user" },
];
const OPS_READ = ["列表查一下", "查列表", "列给我详情", "搜索一下"];
const IDS = ["4985535735769088", "10001", "778899001122"];
const CHAT = ["你好", "今天天气怎么样", "帮我写个正则", "什么是四元组"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 模拟大模型理解（故意不做规则映射，只抽自然语言槽位） */
function mockLlmUnderstand(userText) {
  const t = userText.trim();
  if (CHAT.some((c) => t === c) || /^(你好|谢谢|天气|正则)/.test(t)) {
    return parseUnderstoodIntent({
      isBusinessRequest: false,
      operationType: "unknown",
      summary: "闲聊",
    });
  }

  let module;
  for (const m of MODULES) {
    if (t.includes(m.say)) {
      module = m.say; // 故意交中文，规则层再映射
      break;
    }
  }
  const id = (t.match(/id\s*[:=]\s*(\d+)/i) || [])[1];
  const write = /(新增|修改|删除|上下线|关闭|开启)/.test(t);
  const read = /(查|列|详情|列表|搜索|获取)/.test(t);
  let operationType = "unknown";
  if (write) operationType = "write";
  else if (read) operationType = "read";

  // 故意留空：仅模块名、无操作词
  if (module && !write && !read && !id) {
    return parseUnderstoodIntent({
      isBusinessRequest: true,
      module,
      operationType: "unknown",
      summary: `提到了${module}但未说明操作`,
    });
  }

  return parseUnderstoodIntent({
    isBusinessRequest: true,
    project: "bx-film-admin",
    module,
    value: id,
    operationType,
    operationHint: /(详情|明细)/.test(t) ? "详情" : /(列表|列)/.test(t) ? "列表" : undefined,
    summary: t.slice(0, 40),
  });
}

function buildRandomCases(n = 12) {
  const cases = [];
  for (let i = 0; i < n; i++) {
    const kind = ["full", "id", "incomplete", "chat", "vague"][i % 5];
    if (kind === "full") {
      const m = pick(MODULES);
      cases.push({
        kind,
        input: `${m.say}模块，${pick(OPS_READ)}`,
        expect: { business: true, clarify: false, callApi: true },
      });
    } else if (kind === "id") {
      const m = pick(MODULES);
      cases.push({
        kind,
        input: `${m.say} id=${pick(IDS)}，列给我所有详情`,
        expect: { business: true, clarify: false, callApi: true },
      });
    } else if (kind === "incomplete") {
      cases.push({
        kind,
        input: pick(["兑换码", "用户", "影片"]),
        expect: { business: true, clarify: true, missing: "operation" },
      });
    } else if (kind === "chat") {
      cases.push({
        kind,
        input: pick(CHAT),
        expect: { business: false, skip: true },
      });
    } else {
      cases.push({
        kind,
        input: "帮我查一下那个模块",
        expect: { business: true, clarify: true, missing: "module" },
      });
    }
  }
  return cases;
}

const session = createSession({
  token: "eval-token",
  country: {
    id: "brazil",
    label: "Brazil",
    backendUrl: "http://localhost",
    userUrl: "http://localhost",
    filmUrl: "http://localhost",
  },
  user: { id: 1, loginName: "eval", name: "eval" },
  menus: [],
});
setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });

const cases = buildRandomCases(12);
console.log("========== 先理解再规则 · 随机抽测 ==========");
console.log(`样例:\n${cases.map((c, i) => `  ${i + 1}. [${c.kind}] ${c.input}`).join("\n")}\n`);

const rows = [];
for (const c of cases) {
  const llm = mockLlmUnderstand(c.input);
  const toolNames = [];

  // 1) 规则校验（带着模型理解）
  const parseOut = await runAgentTool(
    "parse_intent",
    {
      userInput: c.input,
      sessionProject: "bx-film-admin",
      understoodFromLlm: true,
      understoodProject: llm.project || "",
      understoodModule: llm.module || "",
      understoodValue: llm.value || "",
      understoodOperation: llm.operationType || "",
    },
    { sessionId: session.id },
  );
  const parseClarify = parseOut.startsWith("CLARIFICATION_REQUIRED");

  // 2) 编排
  const orch = await orchestrateBusinessQuery({
    userText: c.input,
    sessionId: session.id,
    token: session.token,
    country: session.country,
    menus: session.menus,
    llmIntent: llm,
    emitEvent: (ev) => {
      if (ev.type === "tool_call") toolNames.push(ev.name);
    },
  });

  let verdict = "PASS";
  const notes = [];

  if (c.expect.skip) {
    if (orch.kind !== "skip") {
      verdict = "FAIL";
      notes.push(`期望 skip，实际 ${orch.kind}`);
    }
    if (llm.isBusinessRequest) {
      verdict = "FAIL";
      notes.push("闲聊被标成业务");
    }
  } else if (c.expect.clarify) {
    const clarified = orch.kind === "clarification" || parseClarify;
    if (!clarified) {
      verdict = "FAIL";
      notes.push(`期望反问，实际 orch=${orch.kind}`);
    } else if (c.expect.missing) {
      const blob = orch.kind === "clarification" ? orch.clarificationText : parseOut;
      if (!blob.includes(`"${c.expect.missing}"`)) {
        verdict = "FAIL";
        notes.push(`反问槽位不含 ${c.expect.missing}`);
      }
    }
  } else if (c.expect.callApi) {
    if (!toolNames.includes("parse_intent")) notes.push("WARN: 无 parse_intent");
    if (toolNames[0] !== "parse_intent") {
      verdict = "FAIL";
      notes.push(`规则链首工具应为 parse_intent，实际 ${toolNames[0] || "-"}`);
    }
    if (toolNames.includes("call_api")) {
      // ok（上游可能连不上，kind 可能是 partial）
    } else if (orch.kind === "clarification") {
      verdict = "FAIL";
      notes.push("完整业务请求却反问了");
    } else {
      notes.push(`WARN: 未 call_api orch=${orch.kind}`);
    }
    // 关键：有 LLM 理解时不应再靠原文关键词猜（module 应来自 understood）
    if (!llm.module && orch.kind === "executed") {
      verdict = "FAIL";
      notes.push("模型未给 module 却执行成功（疑似回退关键词）");
    }
  }

  const line = {
    kind: c.kind,
    input: c.input,
    llm: {
      biz: llm.isBusinessRequest,
      module: llm.module || "-",
      op: llm.operationType,
      value: llm.value || "-",
    },
    orch: orch.kind,
    tools: toolNames.join("→") || "-",
    verdict,
    notes,
  };
  rows.push(line);

  console.log(`\n--- [${c.kind}] ${c.input}`);
  console.log(`  LLM理解: biz=${line.llm.biz} module=${line.llm.module} op=${line.llm.op} value=${line.llm.value}`);
  console.log(`  规则编排: ${line.orch} | ${line.tools}`);
  console.log(`  ${verdict}${notes.length ? " | " + notes.join("; ") : ""}`);
}

deleteSession(session.id);

const fail = rows.filter((r) => r.verdict === "FAIL");
const warn = rows.filter((r) => r.notes.some((n) => n.startsWith("WARN")));
console.log(`\n========== 汇总 ==========`);
console.log(`PASS ${rows.length - fail.length}/${rows.length}  FAIL ${fail.length}  WARN ${warn.length}`);
console.log("\n一览:");
for (const r of rows) {
  console.log(
    `- ${r.verdict} [${r.kind}] llm=${r.llm.module}/${r.llm.op} → ${r.orch} | ${r.tools} :: ${r.input}`,
  );
}
if (fail.length) process.exit(1);
