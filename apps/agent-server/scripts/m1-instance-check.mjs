// M1 实例测试：验证 Supervisor 路由装配（route_to_agent → 工具裁剪 + preferredModel + 环境/prod）。
// 不依赖模型。用法：node --import tsx scripts/m1-instance-check.mjs  （在 apps/agent-server 目录）
import "../src/load-env.js";
import { listAgentTools } from "../src/tools.ts";
import { buildStaticGuide } from "../src/chat.ts";
import {
  resolveWorker,
  resolveWorkerById,
  workerToolNames,
  formatWorkerGuide,
  DEFAULT_WORKERS,
} from "../src/worker-registry.ts";
import { resolveBaseUrl, resolveCountryApiUrls } from "../src/upstream.ts";

let pass = 0,
  fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " :: " + extra : ""}`);
  ok ? pass++ : fail++;
};

// 1. route_to_agent 已注册进 listAgentTools
const names = listAgentTools().map((t) => t.name);
check("route_to_agent 在工具清单中", names.includes("route_to_agent"), `共 ${names.length} 个工具`);

// 2. resolveWorker 命中 backend-api（测试 / 生产）
const wTest = resolveWorker("backend-api", "bx-film-admin", "test");
check("resolveWorker(…,test) 命中", !!wTest, wTest ? `id=${wTest.id}` : "null");
const wProd = resolveWorker("backend-api", "bx-film-admin", "prod");
check("resolveWorker(…,prod) 命中", !!wProd, wProd ? `id=${wProd.id}` : "null");
check("prod Worker writeConfirmPolicy=always", wProd?.writeConfirmPolicy === "always");
check("test/prod 不是同一 Worker", wTest?.id !== wProd?.id);

// 3. 命中后工具被裁剪到白名单子集
const ns = workerToolNames(wTest);
const allTools = listAgentTools();
const filtered = allTools.filter((t) => ns.has(t.name));
check(
  "backend-api worker 工具裁剪=15",
  filtered.length === 15,
  `实际=${filtered.length}（含 call_api=${filtered.some((t) => t.name === "call_api")}）`,
);
check("裁剪后不含 knowledge 工具", !filtered.some((t) => t.name === "search_knowledge_base"));
check("裁剪后不含 common 工具", !filtered.some((t) => t.name === "request_clarification"));

// META 合并后应可见 route_to_agent（chat.ts 执行层策略的镜像）
const META = new Set([
  "submit_understood_intent",
  "parse_intent",
  "set_project",
  "request_clarification",
  "route_to_agent",
  "update_user_preference",
  "get_user_preferences",
  "get_current_time",
]);
const withMeta = allTools.filter((t) => ns.has(t.name) || META.has(t.name));
check("白名单∪META 含 route_to_agent", withMeta.some((t) => t.name === "route_to_agent"));

// 3b. 未路由时仅 META（完善：杜绝默认全量绕过路由）
const unrouted = allTools.filter((t) => META.has(t.name));
check("未路由仅 META，不含 call_api", !unrouted.some((t) => t.name === "call_api"));
check("未路由仅 META，不含 search_knowledge_base", !unrouted.some((t) => t.name === "search_knowledge_base"));
check("未路由含 route_to_agent", unrouted.some((t) => t.name === "route_to_agent"));
check(`未路由 META 数量=${META.size}`, unrouted.length === META.size, `实际=${unrouted.length}`);

// 4. 未命中回退全量
const none = resolveWorker("finance");
const nsNone = workerToolNames(none);
check("resolveWorker(finance) 未命中→白名单 null", nsNone === null);

// 5. preferredModel / systemPrompt
const byId = resolveWorkerById(wTest.id);
check("resolveWorkerById 一致", byId?.id === wTest.id);
check("Worker 无 preferredModel 时回退默认（字段缺省 undefined）", byId?.preferredModel === undefined);
check("test Worker 有 systemPrompt", Boolean(byId?.systemPrompt?.includes("测试")));
check("prod Worker 有 systemPrompt", Boolean(wProd?.systemPrompt?.includes("生产")));
const guide = formatWorkerGuide(wTest);
check("formatWorkerGuide 含 ACTIVE_WORKER_CTX", guide.includes(`[ACTIVE_WORKER_CTX:${wTest.id}]`));

// 6. 标记提取（route 结果 → activeWorkerId）
const sample =
  "已切换到 Worker「后台管理 API（测试）」（id=backend-api-bx-film-admin-test environment=test）。\n[ACTIVE_WORKER:backend-api-bx-film-admin-test]";
const m = /\[ACTIVE_WORKER:([^\]]+)\]/.exec(sample);
check("route 结果标记可提取 worker id", m?.[1] === "backend-api-bx-film-admin-test", `提取=${m?.[1]}`);

// 7. 环境双键：test 走 country；prod 未配 env 时为空
const fakeCountry = {
  id: "india",
  label: "India",
  backendUrl: "http://test-backend.example",
  userUrl: "http://test-user.example",
  filmUrl: "http://test-film.example",
};
check(
  "resolveBaseUrl(test)=country.backendUrl",
  resolveBaseUrl(fakeCountry, "backend", "test") === "http://test-backend.example",
);
const prevProd = process.env.COUNTRY_INDIA_PROD_BACKEND_URL;
delete process.env.COUNTRY_INDIA_PROD_BACKEND_URL;
check("resolveBaseUrl(prod) 未配置→空串", resolveBaseUrl(fakeCountry, "backend", "prod") === "");
process.env.COUNTRY_INDIA_PROD_BACKEND_URL = "https://prod-backend.example";
check(
  "resolveBaseUrl(prod) 读 COUNTRY_*_PROD_*",
  resolveBaseUrl(fakeCountry, "backend", "prod") === "https://prod-backend.example",
);
if (prevProd === undefined) delete process.env.COUNTRY_INDIA_PROD_BACKEND_URL;
else process.env.COUNTRY_INDIA_PROD_BACKEND_URL = prevProd;

const urls = resolveCountryApiUrls(fakeCountry, "test");
check("resolveCountryApiUrls(test).backendUrl", urls.backendUrl === fakeCountry.backendUrl);

// 8. buildStaticGuide 注入 worker 提示
const sessionStub = {
  id: "m1-check",
  token: "",
  country: fakeCountry,
  user: { loginName: "t", name: "t" },
  menus: [],
  createdAt: Date.now(),
  messages: [],
};
const staticWith = buildStaticGuide(sessionStub, undefined, wTest);
check("buildStaticGuide(worker) 含 worker-context", staticWith.includes("[workflow/worker-context]"));
check("buildStaticGuide(worker) 含 ACTIVE_WORKER_CTX", staticWith.includes(`[ACTIVE_WORKER_CTX:${wTest.id}]`));

check("注册表至少 4 个 Worker（含 prod）", DEFAULT_WORKERS.length >= 4, `n=${DEFAULT_WORKERS.length}`);

console.log(`\nM1 实例测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
