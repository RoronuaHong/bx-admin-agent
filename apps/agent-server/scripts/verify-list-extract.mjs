// 回归验证：call_api 返回文本 → 列表行提取
// 被测对象 = 真实实现 extractListRowsFromContent（report-pc-parity.ts，栈式配平+递归下钻）
// 对照 = 旧版脆弱解析（chat.ts 已删除的 search+slice+一层 key 检查）
// 运行：cd apps/agent-server && .\node_modules\.bin\tsx.cmd scripts/verify-list-extract.mjs
import { extractListRowsFromContent } from "../src/report-pc-parity.js";

// ---- 旧版逻辑（已从 chat.ts 删除，留作对照证明回归）----
function legacyExtract(content) {
  const c = String(content || "").trim();
  const start = c.search(/[[{]/);
  if (start === -1) return null;
  let payload;
  try {
    payload = JSON.parse(c.slice(start));
  } catch {
    return null;
  }
  if (Array.isArray(payload)) {
    return payload.length >= 2 ? payload : null;
  }
  if (payload && typeof payload === "object") {
    const o = payload;
    for (const key of ["rows", "list", "records", "items", "data"]) {
      if (Array.isArray(o[key]) && o[key].length >= 2) return o[key];
    }
  }
  return null;
}

const samples = [
  { name: "S1 裸数组", content: JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b" }]), expect: "array/2" },
  { name: "S2 两层封装 {code,data:{rows}}", content: JSON.stringify({ code: 0, msg: "success", data: { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }], total: 2, page: 1 } }), expect: "array/2" },
  { name: "S3 两层封装 {code,result:{list}}", content: JSON.stringify({ code: 200, message: "success", result: { list: [{ id: 1, name: "a" }, { id: 2, name: "b" }], total: 2 } }), expect: "array/2" },
  { name: "S4 前缀说明文本+data数组", content: `获取成功，共2条：${JSON.stringify({ code: 0, data: [{ id: 1, name: "a" }, { id: 2, name: "b" }] })}`, expect: "array/2" },
  { name: "S5 数组首位夹带字符串", content: JSON.stringify(["获取成功", { id: 1, name: "a" }, { id: 2, name: "b" }]), expect: "array/2" },
  { name: "S6 一层封装 {rows,total}", content: JSON.stringify({ rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }], total: 2 }), expect: "array/2" },
  { name: "S7 单条数组（1行也是列表）", content: JSON.stringify([{ id: 1, name: "a" }]), expect: "array/1" },
  { name: "S8 三层 {code,data:{list}}", content: JSON.stringify({ code: 0, data: { list: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3 } }), expect: "array/3" },
  { name: "S9 异常返回（无列表）", content: JSON.stringify({ code: 500, msg: "服务器错误" }), expect: "null" },
  { name: "S10 真实mock形态 {code,data:{list:1条},_mock}", content: JSON.stringify({ code: 0, data: { list: [{ id: "x1", name: "mock-item", status: 1, title: "演示记录" }], total: 1 }, _mock: true }), expect: "array/1" },
  { name: "S11 空列表 {code,data:{list:[],total:0}}", content: JSON.stringify({ code: 0, data: { list: [], total: 0 } }), expect: "null" },
];

function desc(r) {
  return r ? (Array.isArray(r) ? `array/${r.length}` : `obj/${Object.keys(r).length}`) : "null";
}

console.log("样本".padEnd(34), "期望".padEnd(10), "旧版".padEnd(10), "真实实现".padEnd(10), "结论");
let failLegacy = 0;
let failReal = 0;
for (const s of samples) {
  const legacy = desc(legacyExtract(s.content));
  const real = desc(extractListRowsFromContent(s.content));
  const legacyOk = legacy === s.expect;
  const realOk = real === s.expect;
  if (!legacyOk) failLegacy++;
  if (!realOk) failReal++;
  console.log(
    s.name.padEnd(34),
    s.expect.padEnd(10),
    legacy.padEnd(10),
    real.padEnd(10),
    `${legacyOk ? "✓" : "✗"}${realOk ? " ✓" : " ✗"}`,
  );
}
console.log("\n=== 汇总 ===");
console.log(`旧版失败 ${failLegacy}/${samples.length}（即「表格消失」的解析层面根因数）`);
console.log(`真实实现失败 ${failReal}/${samples.length}`);
console.log(failReal === 0 ? "→ extractListRowsFromContent 对全部真实形态样本解析正确，PASS" : "→ 仍有失败样本，需补充下钻路径");
process.exit(failReal === 0 ? 0 : 1);
