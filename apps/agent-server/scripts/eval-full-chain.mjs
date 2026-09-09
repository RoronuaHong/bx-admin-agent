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

// ---- 1. parse_intent（当前契约：校验模型理解，而不是从中文原句直接猜模块）----
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
    name: "推荐片段列表（模型已给模块）",
    input: "推荐片段管理模块，列表查一下",
    expectModule: "movie-fragment",
    expectOp: "read",
    understoodModule: "movie-fragment",
    understoodOperation: "read",
  },
  {
    name: "时间标签详情（模型已给模块和值）",
    input: "时间标签 id=4985535735769088，列给我所有详情",
    expectModule: "movietimetag",
    expectOp: "read",
    understoodModule: "movietimetag",
    understoodValue: "4985535735769088",
    understoodOperation: "read",
  },
  {
    name: "兑换码列表（模型已给模块）",
    input: "兑换码模块，列表查一下",
    expectModule: "vipExchangeCode",
    expectOp: "read",
    understoodModule: "vipExchangeCode",
    understoodOperation: "read",
  },
  {
    name: "仅给模块不给操作类型（应反问 operation）",
    input: "兑换码",
    expectClarify: true,
    understoodModule: "vipExchangeCode",
    missingSlot: "operation",
  },
];

for (const c of parseCases) {
  const out = await runAgentTool("parse_intent", {
    userInput: c.input,
    sessionProject: "bx-film-admin",
    understoodFromLlm: true,
    understoodModule: c.understoodModule || "",
    understoodValue: c.understoodValue || "",
    understoodOperation: c.understoodOperation || "",
  }, { sessionId: sid });
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
  "film 输出保持对齐包装且保留原始字段",
  normOut.includes("[已对齐 PC 端字段 - 模块: film]") && normOut.includes('"title": "测试片"'),
  normOut.slice(0, 100),
);

// ---- 6. 候选唯一自动命中 ----
const cands = findApiOperationCandidates("movieFragment.getList", 3);
record("candidates", "movieFragment.getList 唯一候选", cands.length === 1 && cands[0].id === "movie-fragment.getList", cands.map((c) => c.id).join(","));

// ---- 7. workflow 编排（无 LLM）----
const orchClarifyEvents = [];
const orchClarify = await orchestrateBusinessQuery({
  userText: "兑换码模块，列表查一下",
  sessionId: sid,
  token: session.token,
  country: session.country,
  menus: session.menus,
  emitEvent: (ev) => { if (ev.type === "tool_call") orchClarifyEvents.push(ev.name); },
});
record(
  "orchestrate",
  "兑换码模块列表查一下 会安全收束为澄清或继续调用",
  (
    (orchClarify.kind === "executed" || orchClarify.kind === "partial") &&
    orchClarifyEvents.includes("call_api")
  ) || (
    orchClarify.kind === "clarification" &&
    !orchClarifyEvents.includes("call_api")
  ),
  `${orchClarify.kind} ${orchClarifyEvents.join("→")}`,
);

async function assertOrchCallsApi(label, userText, llmIntent) {
  const names = [];
  const r = await orchestrateBusinessQuery({
    userText,
    sessionId: sid,
    token: session.token,
    country: session.country,
    menus: session.menus,
    llmIntent,
    emitEvent: (ev) => { if (ev.type === "tool_call") names.push(ev.name); },
  });
  const ok = names.includes("call_api");
  record("orchestrate", label, ok, `${r.kind} ${names.join("→")}`);
}

await assertOrchCallsApi(
  "模型已定模块后编排会进入 call_api",
  "查一下兑换码列表",
  { isBusinessRequest: true, project: "bx-film-admin", module: "vipExchangeCode", operationType: "read", responseMode: "execute" },
);
await assertOrchCallsApi(
  "模型已定模块和值后详情编排会进入 call_api",
  "查看时间标签 4985535735769088 详情",
  { isBusinessRequest: true, project: "bx-film-admin", module: "movietimetag", value: "4985535735769088", operationType: "read", responseMode: "execute" },
);

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
