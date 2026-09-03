// M1 实例测试：验证 Supervisor 路由装配（route_to_agent → 工具裁剪 + preferredModel）。不依赖模型。
// 用法：node --import tsx scripts/m1-instance-check.mjs  （在 apps/agent-server 目录）
import "../src/load-env.js";
import { listAgentTools } from "../src/tools.ts";
import { resolveWorker, resolveWorkerById, workerToolNames, DEFAULT_WORKERS } from "../src/worker-registry.ts";

let pass = 0,
  fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " :: " + extra : ""}`);
  ok ? pass++ : fail++;
};

// 1. route_to_agent 已注册进 listAgentTools
const names = listAgentTools().map((t) => t.name);
check("route_to_agent 在工具清单中", names.includes("route_to_agent"), `共 ${names.length} 个工具`);

// 2. resolveWorker 命中 backend-api（测试环境）
const w = resolveWorker("backend-api", "bx-film-admin", "test");
check("resolveWorker(backend-api,bx-film-admin,test) 命中", !!w, w ? `id=${w.id}` : "null");

// 3. 命中后工具被裁剪到白名单子集
const ns = workerToolNames(w);
const allTools = listAgentTools();
const filtered = allTools.filter((t) => ns.has(t.name));
check(
  "backend-api worker 工具裁剪=15",
  filtered.length === 15,
  `实际=${filtered.length}（含 call_api=${filtered.some((t) => t.name === "call_api")}）`,
);
check("裁剪后不含 knowledge 工具", !filtered.some((t) => t.name === "search_knowledge_base"));
check("裁剪后不含 common 工具", !filtered.some((t) => t.name === "request_clarification"));

// 4. 未命中回退全量
const none = resolveWorker("finance");
const nsNone = workerToolNames(none);
check("resolveWorker(finance) 未命中→白名单 null", nsNone === null);

// 5. preferredModel 配置存在性（默认注册表暂未配，验证字段可被读取）
const byId = resolveWorkerById(w.id);
check("resolveWorkerById 一致", byId?.id === w.id);
check("Worker 无 preferredModel 时回退默认模型（字段缺省 undefined）", byId?.preferredModel === undefined);

// 6. 标记提取（route 结果 → activeWorkerId）
const sample = "已切换到 Worker「后台管理 API（测试）」（id=backend-api-bx-film-admin-test）。\n[ACTIVE_WORKER:backend-api-bx-film-admin-test]";
const m = /\[ACTIVE_WORKER:([^\]]+)\]/.exec(sample);
check("route 结果标记可提取 worker id", m?.[1] === "backend-api-bx-film-admin-test", `提取=${m?.[1]}`);

console.log(`\nM1 实例测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
