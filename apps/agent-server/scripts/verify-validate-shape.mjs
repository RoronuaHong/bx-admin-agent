// 验证：validateApiResultShape / extractListRowsFromContent 对真实 film.getList 返回的行为
// 运行：cd apps/agent-server && .\node_modules\.bin\tsx.cmd scripts/verify-validate-shape.mjs
import { extractListRowsFromContent } from "../src/report-pc-parity.js";

// 复刻 chat.ts validateApiResultShape 逻辑（避免依赖内部函数）
function validateApiResultShape(content) {
  const c = String(content || "").trim();
  if (!c) return "返回内容为空";
  try {
    const parsed = JSON.parse(c.replace(/^```json\s*|\s*```$/g, ""));
    if (parsed && typeof parsed === "object") return "";
  } catch {
    const m = c.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        if (parsed && typeof parsed === "object") return "";
      } catch {
        /* fallthrough */
      }
    }
  }
  return "返回内容不是 JSON 对象/数组";
}

// 真实返回形态（out-176 日志前缀 + mock 结构）：{page,pages,size,total,rows}
const realContent = JSON.stringify({
  page: 1,
  pages: 1074,
  size: 20,
  total: "21476",
  rows: [
    { id: "5590108001975296", title: "Tribhanga - Tedhi Medhi Crazy", score: 6.5, status: 1 },
    { id: "5590108001975297", title: "Your Name.", score: 9.1, status: 1 },
    { id: "5590108001975298", title: "Monarch: Legacy of Monsters", score: 8.8, status: 1 },
  ],
}, null, 2); // 带缩进，模拟 stringifyResult 格式

console.log("=== validateApiResultShape ===");
console.log("shapeIssue:", JSON.stringify(validateApiResultShape(realContent)));
console.log("（空串=通过，非空=被拦）");

console.log("\n=== extractListRowsFromContent ===");
const rows = extractListRowsFromContent(realContent);
console.log("rows:", rows ? `array/${rows.length}` : "null");
if (Array.isArray(rows)) console.log("首行:", JSON.stringify(rows[0]));

console.log("\n=== 带错误前缀的形态（应被 2017 if 拦下） ===");
const errContent = "错误：请求失败；socket hang up";
console.log("shapeIssue:", JSON.stringify(validateApiResultShape(errContent)));
console.log("rows:", extractListRowsFromContent(errContent));
