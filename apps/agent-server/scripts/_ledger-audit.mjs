// 解析 analytics 运行台账，统计 SQL 执行失败的类型与根因。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ledgerDir = fileURLToPath(new URL("../.data/analytics/ledger/", import.meta.url));
const file = ledgerDir + "ask-202609.jsonl";
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

const total = lines.length;
const byStatus = {};
const byFailure = {};
const byCode = {};
const fails = [];
let quotedLiteralIssue = 0;

for (const ln of lines) {
  let o;
  try { o = JSON.parse(ln); } catch { continue; }
  byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  if (o.failureClass) byFailure[o.failureClass] = (byFailure[o.failureClass] || 0) + 1;
  const err = o.error || "";
  const m = err.match(/Code:\s*(\d+)/);
  if (m) byCode[m[1]] = (byCode[m[1]] || 0) + 1;
  if (o.status === "error" || o.status === "refuse" && /Code:|DB::Exception|Syntax error/.test(err)) {
    // 检测未加单引号的字符串字面量问题
    const sqls = o.sqls || [];
    let unquoted = false;
    for (const s of sqls) {
      // 找 IN ( 后直接跟中文字符（无引号）
      if (/IN\s*\([\s\n]*[一-龥]/.test(s) || /=\s*[一-龥]/.test(s)) unquoted = true;
    }
    if (unquoted) quotedLiteralIssue++;
    fails.push({
      askId: o.askId,
      nl: o.nl,
      status: o.status,
      failureClass: o.failureClass,
      code: m ? m[1] : null,
      message: (o.message || "").slice(0, 160),
      error: err.slice(0, 220),
      unquoted,
    });
  }
}

const report = { file, total, byStatus, byFailure, byCode, unquotedLiteralIssues: quotedLiteralIssue, failCount: fails.length, fails };
writeFileSync(ledgerDir + "audit-report.json", JSON.stringify(report, null, 2));
console.log("TOTAL:", total);
console.log("STATUS:", JSON.stringify(byStatus));
console.log("FAILURE_CLASS:", JSON.stringify(byFailure));
console.log("ERROR_CODE:", JSON.stringify(byCode));
console.log("UNQUOTED_LITERAL_ISSUES:", quotedLiteralIssue, "of", fails.length, "fails");
console.log("\n--- SAMPLE FAILS (first 12) ---");
for (const f of fails.slice(0, 12)) {
  console.log(`\n[${f.status}/${f.failureClass}] code=${f.code} unquoted=${f.unquoted} nl=${JSON.stringify(f.nl)}`);
  console.log("  msg:", f.message);
}
