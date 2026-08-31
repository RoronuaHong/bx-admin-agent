// 临时验证：module=user + read 意图 → inferCallOperation 结果；以及 parsePaginationPlan({}) 行为
import "../src/load-env.js";
import { register } from "tsx/esm/api";
await register();

const { inferCallOperation } = await import("../src/workflow-orchestrate.ts");
const { parsePaginationPlan } = await import("../src/understood-intent.ts");

console.log("=== parsePaginationPlan({}) ===");
console.log("结果:", parsePaginationPlan({}));

console.log("\n=== inferCallOperation('user', read) ===");
const spec = inferCallOperation("user", "用户列表前3页的数据", "read", "用户列表", parsePaginationPlan({}));
console.log("callSpec:", JSON.stringify(spec));

console.log("\n=== inferCallOperation('account', read) ===");
const spec2 = inferCallOperation("account", "用户列表前3页的数据", "read", "用户列表", parsePaginationPlan({}));
console.log("callSpec:", JSON.stringify(spec2));
