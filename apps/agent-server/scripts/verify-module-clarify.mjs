// 临时验证脚本：验证 ① 用户列表翻译表反查多候选(account+user) ② account 模块列表+多页解析
import "../src/load-env.js";
import { register } from "tsx/esm/api";
await register();

const { inferCallOperation } = await import("../src/workflow-orchestrate.ts");
const { lookupTermModules } = await import("../src/translation-lookup.ts");
const { resolveCodebaseRoot } = await import("../src/project-context.ts");

console.log("=== ① 用户列表 翻译表反查多候选 ===");
const hits = lookupTermModules("用户列表", resolveCodebaseRoot());
console.log("命中候选数:", hits.length);
console.log("候选模块:", hits.map((h) => h.moduleId).join(", "));
console.log("含 account 且含 user:", hits.some((h) => h.moduleId === "account") && hits.some((h) => h.moduleId === "user"));
console.log("任一候选带菜单标题:", hits.some((h) => h.menuTitle));

console.log("\n=== ② account + 用户列表前2页 ===");
const spec = inferCallOperation("account", "用户列表前2页", "read", "用户列表", { mode: "pages", from: 1, to: 2 });
console.log("callSpec.operation:", spec?.operation);
console.log("是否正确 account.getList:", spec?.operation === "account.getList");

console.log("\n=== ③ 通用列表匹配（无写死候选名）：换一个非常规列表接口名模块 ===");
// 用 api-operation-index 里真实存在的某模块验证 inferCallOperation 不依赖 getList 字面
const spec2 = inferCallOperation("vipExchangeCode", "查看兑换码批次", "read", "兑换码批次", undefined);
console.log("vipExchangeCode 读操作:", spec2?.operation);
