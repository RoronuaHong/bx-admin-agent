// 临时探针：验证内置工具注入清单与 write_todos 执行链路（跑完即删）。
import { builtinToolSpecs, execBuiltin } from "../src/builtins.js";

console.log("specs:", builtinToolSpecs({}).map((s) => s.name).join(","));
const r = await execBuiltin(
  "write_todos",
  JSON.stringify({ todos: [{ content: "probe", status: "in_progress" }] }),
  `probe-${Date.now()}`,
);
console.log("write_todos:", JSON.stringify(r));
