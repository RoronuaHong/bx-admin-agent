// M0 实例测试：真实调用 chat.ts 的 buildStaticGuide，验证工具目录注入与领域分组正确（不依赖模型）。
// 用法：node --import tsx scripts/m0-instance-check.mjs  （在 apps/agent-server 目录）
import "../src/load-env.js";
import { buildStaticGuide } from "../src/chat.ts";
import { listAgentTools, toolCatalogByDomain } from "../src/tools.ts";

let pass = 0,
  fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " :: " + extra : ""}`);
  ok ? pass++ : fail++;
};

// 1. listAgentTools 每个工具都带 domain
const tools = listAgentTools();
const missing = tools.filter((t) => !t.domain);
check("listAgentTools 每个工具含 domain", missing.length === 0, `总数=${tools.length} 缺失=${missing.map((t) => t.name).join(",")}`);

// 2. 领域分布计数正确
const count = (d) => tools.filter((t) => t.domain === d).length;
check("backend-api = 15", count("backend-api") === 15, `实际=${count("backend-api")}`);
check("knowledge = 4 (chat 可见)", count("knowledge") === 4, `实际=${count("knowledge")}`);
check("common = 4", count("common") === 4, `实际=${count("common")}`);

// 3. 真实调用 buildStaticGuide（chat 主路径），注入工具目录
const guide = buildStaticGuide({ id: "m0-instance-test" });
check("buildStaticGuide 含 [workflow/tool-catalog]", guide.includes("[workflow/tool-catalog]"), `guide 长度=${guide.length}`);
check("tool-catalog 含 backend-api 分组", guide.includes("- backend-api："));
check("tool-catalog 含 knowledge 分组", guide.includes("- knowledge："));
check("tool-catalog 含 common 分组", guide.includes("- common："));
check("tool-catalog 列出 call_api", guide.includes("call_api"));
check("tool-catalog 列出 search_knowledge_base", guide.includes("search_knowledge_base"));

// 4. 缓存：两次调用返回同一引用
const a = toolCatalogByDomain();
const b = toolCatalogByDomain();
check("toolCatalogByDomain 缓存同一引用", a === b);

console.log(`\nM0 实例测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
