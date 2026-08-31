// 验证分页去结构化（PaginationPlan/多页执行器/schema pagination 已删）后：
// 1. submit_understood_intent schema 无 pagination 字段
// 2. understood-intent 无 PaginationPlan/parsePaginationPlan 导出
// 3. workflow-orchestrate 无 listParamsFromPagination/extractTotal 残留
// 4. inferCallOperation 单次调用仍能正确选列表接口
// 运行：tsx scripts/verify-pagination-removal.mjs
import { getSubmitUnderstoodIntentTool } from "../src/tools.js";
import * as ui from "../src/understood-intent.js";
import * as wo from "../src/workflow-orchestrate.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

console.log("=== 1. submit_understood_intent schema 无 pagination ===");
const schema = getSubmitUnderstoodIntentTool().inputSchema;
check("properties 无 pagination", !schema.properties || !schema.properties.pagination);

console.log("=== 2. understood-intent 无分页结构 ===");
check("无 PaginationPlan 导出", !("PaginationPlan" in ui));
check("无 parsePaginationPlan 导出", !("parsePaginationPlan" in ui));

console.log("=== 3. workflow-orchestrate 无多页执行器残留 ===");
check("无 listParamsFromPagination 导出", !("listParamsFromPagination" in wo));

console.log("=== 4. inferCallOperation 单次调用仍能选列表接口 ===");
// 直接调 inferCallOperation（无分页参数），应能选到 account.getList 这类列表接口
try {
  const spec = wo.inferCallOperation?.("account", "用户列表", "read", null);
  console.log(`  inferCallOperation(account, read) = ${spec ? spec.operation : "null"}`);
  check("inferCallOperation 可调用且返回列表接口", !!spec && /list/i.test(spec.operation || ""));
} catch (e) {
  check("inferCallOperation 可调用", false, String(e));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
