// 离线归一化 tests/bi-golden-set.json（不连 BI）：应用自然语言改写稿、裸表名补 schema、剔除 CTE 名、标出白名单外的表。
// bi-golden-bootstrap.mjs 重新落盘时会自动做同样的事；这里用于不重拉卡片、只按现有白名单与改写稿修正。
// 用法：node scripts/bi-golden-normalize.mjs [--check]   （--check 只报告差异、不写盘）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeGoldenCase, applyGoldenQuestions } from "./metabase-card-graph.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = path.join(root, "tests", "bi-golden-set.json");
const knownPath = path.join(root, "tests", "bi-known-tables.json");
const questionsPath = path.join(root, "tests", "bi-golden-questions.json");
const check = process.argv.includes("--check");

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const known = JSON.parse(fs.readFileSync(knownPath, "utf8"));
const qMap = fs.existsSync(questionsPath) ? JSON.parse(fs.readFileSync(questionsPath, "utf8")).questions || {} : {};
const source = applyGoldenQuestions(golden.cases, qMap);
let changed = 0;
let questionChanged = 0;
const cases = source.map((c, i) => {
  const n = normalizeGoldenCase(c, known);
  if (JSON.stringify(n.tables) !== JSON.stringify(c.tables) || JSON.stringify(n.unverifiedTables) !== JSON.stringify(c.unverifiedTables)) changed++;
  if (c.question !== golden.cases[i].question || c.cardTitle !== golden.cases[i].cardTitle) questionChanged++;
  return n;
});
const unverified = cases.filter((c) => c.unverifiedTables?.length);
console.log(`期望表有变化 ${changed}/${cases.length} 例；问题改写有变化 ${questionChanged} 例；含白名单外表 ${unverified.length} 例：`);
for (const c of unverified) console.log(`  #${c.id} ${c.question} → ${c.unverifiedTables.join(", ")}`);
if (!check) {
  fs.writeFileSync(goldenPath, JSON.stringify({ ...golden, cases, normalizedAt: new Date().toISOString() }, null, 2));
  console.log("已写回:", goldenPath);
}
