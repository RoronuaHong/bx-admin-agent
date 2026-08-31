// 验证 api-interface-routing 改造：
// 1) parseUnderstoodIntent 正确解析 operation（完整接口 id）
// 2) inferCallOperation 用模型 operation 直接返回，不走正则兜底
import "../src/load-env.js";
import { register } from "tsx/esm/api";
await register();

const { parseUnderstoodIntent } = await import("../src/understood-intent.ts");
const { inferCallOperation } = await import("../src/workflow-orchestrate.ts");

// 1. 模型提交完整 operation
const u = parseUnderstoodIntent({
  isBusinessRequest: true,
  module: "account",
  operation: "account.getList",
  operationType: "read",
  operationHint: "列表",
});
console.log("=== parseUnderstoodIntent(operation=account.getList) ===");
console.log("operation:", u.operation, "| operationType:", u.operationType);

// 2. 模型提交 operation 但误填 read（旧习惯）→ operation 应为 undefined（不误解析）
const u2 = parseUnderstoodIntent({
  isBusinessRequest: true,
  module: "account",
  operation: "read",
  operationType: "read",
});
console.log("\n=== parseUnderstoodIntent(operation=read 误填) ===");
console.log("operation:", u2.operation, "(应为 undefined)");

// 3. inferCallOperation 用 explicitOp=account.getList 直接命中
const spec = inferCallOperation("account", "用户列表", "read", "account.getList", "列表");
console.log("\n=== inferCallOperation(explicitOp=account.getList) ===");
console.log("operation:", spec?.operation, "| params:", JSON.stringify(spec?.params));

// 4. explicitOp 为空 → 走正则兜底（应选 getList）
const spec2 = inferCallOperation("account", "用户列表", "read", null, "列表");
console.log("\n=== inferCallOperation(无 explicitOp, 正则兜底) ===");
console.log("operation:", spec2?.operation);
