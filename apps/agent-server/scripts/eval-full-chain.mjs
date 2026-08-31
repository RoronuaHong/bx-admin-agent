/**
 * 全链路评测：parse_intent → 模块检索 → operation 解析 → call_api 兜底 → normalize_output
 * 不依赖 LLM，直接测 tools 层确定性行为。
 */
import { resolveApiOperation, findApiOperationCandidates } from "../src/api-operation-index.ts";
import { runAgentTool } from "../src/tools.ts";
import { orchestrateBusinessQuery } from "../src/workflow-orchestrate.ts";
import { createSession, deleteSession, setActiveProject } from "../src/session.ts";

const results = [];
function record(stage, name, ok, detail = "") {
  results.push({ stage, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | [${stage}] ${name}${detail ? ` | ${detail}` : ""}`);
}

// ---- 1. parse_intent ----
const session = createSession({
  token: "eval-token",
  country: { id: "brazil", label: "Brazil", backendUrl: "http://localhost", userUrl: "http://localhost", filmUrl: "http://localhost" },
  user: { id: 1, loginName: "eval", name: "eval" },
  menus: [],
});
setActiveProject(session.id, { key: "bx-film-admin", label: "影视后台管理系统", setAt: Date.now() });
const sid = session.id;

const parseCases = [
  {
    name: "推荐片段管理模块（中文模块名）",
    input: "推荐片段管理模块，列表查一下",
    expectModule: "movie-fragment",
    expectOp: "read",
    expectClarify: false,
  },
  {
    name: "时间标签 + id + 详情",
    input: "时间标签 id=4985535735769088，列给我所有详情",
    expectModule: "movietimetag",
    expectOp: "read",
    expectClarify: false,
  },
  {
    name: "兑换码模块列表查一下",
    input: "兑换码模块，列表查一下",
    expectModule: "vipExchangeCode",
    expectOp: "read",
    expectClarify: false,
  },
  {
    name: "二级分类 + id + 详情",
    input: "二级分类 id=778899001122 详情",
    expectModule: "country",
    expectOp: "read",
    expectClarify: false,
  },
  {
    name: "会员订单 + id + 详情",
    input: "会员订单 id=778899001122 详情",
    expectModule: "vipOrder",
    expectOp: "read",
    expectClarify: false,
  },
  {
    name: "仅模块名无操作（应反问 operation）",
    input: "兑换码",
    expectClarify: true,
    missingSlot: "operation",
  },
];

for (const c of parseCases) {
  const out = await runAgentTool("parse_intent", { userInput: c.input, sessionProject: "bx-film-admin" }, { sessionId: sid });
  const isClarify = out.startsWith("CLARIFICATION_REQUIRED");
  if (c.expectClarify) {
    const ok = isClarify && (!c.missingSlot || out.includes(`"${c.missingSlot}"`));
    record("parse_intent", c.name, ok, isClarify ? "clarify" : "no-clarify");
  } else {
    try {
      const parsed = JSON.parse(out);
      const ok = parsed.module === c.expectModule && parsed.operationType === c.expectOp;
      record("parse_intent", c.name, ok, `module=${parsed.module} op=${parsed.operationType}`);
    } catch {
      record("parse_intent", c.name, false, "invalid JSON");
    }
  }
}

// ---- 2. operation 归一化（camelCase → kebab-case）----
const opCases = [
  ["movieFragment.getList", "movie-fragment.getList"],
  ["movieFragment.getById", "movie-fragment.getById"],
  ["film.getById", "film.getById"],
  ["vipExchangeCode.getList", "vipExchangeCode.getList"],
];

for (const [input, expected] of opCases) {
  const got = resolveApiOperation(input)?.id || "MISS";
  record("operation_resolve", input, got === expected, `got=${got}`);
}

// ---- 3. 模块检索 ----
const searchOut = await runAgentTool("search_api_module", { query: "推荐片段" }, {});
record("search_api_module", "推荐片段", /movie-fragment|代码库检索回退/i.test(searchOut), searchOut.slice(0, 80));

const grepOut = await runAgentTool("grep_codebase", { pattern: "推荐片段管理", maxResults: 5 }, {});
record("grep_codebase", "推荐片段管理", /film\.ts|推荐片段管理/.test(grepOut), grepOut.split("\n")[2]?.slice(0, 80) || "");

// ---- 4. call_api 路径（不连真实上游，验证不走错误反问）----
const callCases = [
  {
    name: "movieFragment.getList 不应反问模块",
    input: { method: "GET", operation: "movieFragment.getList" },
    forbidClarifyModule: true,
  },
  {
    name: "film.getById 有 operation 不应反问",
    input: { method: "GET", operation: "film.getById", params: { movieId: "4985535735769088" } },
    forbidClarify: true,
  },
  {
    name: "裸 getById 应触发澄清",
    input: { method: "GET", operation: "getById" },
    expectClarify: true,
  },
  {
    name: "缺 operation/path 应触发澄清",
    input: { method: "GET" },
    expectClarify: true,
  },
];

for (const c of callCases) {
  const out = await runAgentTool("call_api", c.input, { sessionId: sid });
  const isClarify = out.startsWith("CLARIFICATION_REQUIRED");
  if (c.expectClarify) {
    record("call_api", c.name, isClarify, "clarify");
  } else if (c.forbidClarifyModule) {
    const badModuleClarify = isClarify && out.includes('"missingSlots": ["module"]');
    record("call_api", c.name, !badModuleClarify, isClarify ? "unexpected module clarify" : "proceed");
  } else {
    record("call_api", c.name, !isClarify, isClarify ? "unexpected clarify" : out.slice(0, 60));
  }
}

// ---- 5. normalize_output 字段对齐 ----
const sampleFilm = { id: "1", title: "测试片", status: 1, movieType: 1 };
const normOut = await runAgentTool("normalize_output", { module: "film", data: sampleFilm }, {});
record(
  "normalize_output",
  "film 字段中文化",
  normOut.includes("影片名称") && normOut.includes("上线"),
  normOut.slice(0, 100),
);

// ---- 6. 候选唯一自动命中 ----
const cands = findApiOperationCandidates("movieFragment.getList", 3);
record("candidates", "movieFragment.getList 唯一候选", cands.length === 1 && cands[0].id === "movie-fragment.getList", cands.map((c) => c.id).join(","));

// ---- 7. workflow 编排（无 LLM）----
const orchEvents = [];
const orch = await orchestrateBusinessQuery({
  userText: "兑换码模块，列表查一下",
  sessionId: sid,
  token: session.token,
  country: session.country,
  menus: session.menus,
  emitEvent: (ev) => { if (ev.type === "tool_call") orchEvents.push(ev.name); },
});
const orchTools = orchEvents.join("→");
const orchOk = (orch.kind === "executed" || orch.kind === "partial") &&
  orchEvents.includes("grep_codebase") &&
  orchEvents.includes("search_api_module") &&
  orchEvents.includes("call_api");
record("orchestrate", "兑换码模块列表查一下 链式编排", orchOk, `${orch.kind} ${orchTools}`);

async function assertOrchCallsApi(label, userText) {
  const names = [];
  const r = await orchestrateBusinessQuery({
    userText,
    sessionId: sid,
    token: session.token,
    country: session.country,
    menus: session.menus,
    emitEvent: (ev) => { if (ev.type === "tool_call") names.push(ev.name); },
  });
  const ok = names.includes("call_api");
  record("orchestrate", label, ok, `${r.kind} ${names.join("→")}`);
}

await assertOrchCallsApi("二级分类 id 详情应 call_api", "二级分类 id=778899001122 详情");
await assertOrchCallsApi("会员订单 id 详情应 call_api", "会员订单 id=778899001122 详情");

// cleanup
deleteSession(session.id);

const pass = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n========== 全链路评测 ==========`);
console.log(`TOTAL: ${pass}/${total} (${((pass / total) * 100).toFixed(1)}%)`);
if (pass < total) {
  console.log("\n失败项:");
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  - [${r.stage}] ${r.name}: ${r.detail}`);
  }
  process.exit(1);
}
