// 口径审计（离线、零 LLM、不访问 BI）：用口径词典里可机检的规则扫黄金集卡片 SQL，
// 列出每条口径「一致 / 冲突」的卡片，供业务方拍板词典时对照。
// 用法：node scripts/bi-caliber-audit.mjs [--out .data/bi-caliber-audit.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCaliber, loadGlossary } from "./bi-semantic.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function auditCards(cases, glossary) {
  const byRule = new Map();
  for (const e of glossary?.entries || []) if (e.check) byRule.set(e.id, { id: e.id, name: e.name, status: e.status, agree: [], conflict: [] });
  for (const c of cases) {
    if (!c.expected_sql) continue;
    const r = checkCaliber(c.expected_sql, glossary);
    for (const id of r.passed) byRule.get(id)?.agree.push(c.id);
    for (const v of r.violations) byRule.get(v.id)?.conflict.push({ id: c.id, title: c.cardTitle || c.question, detail: v.detail });
  }
  return [...byRule.values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = path.resolve(root, outIdx >= 0 ? args[outIdx + 1] : ".data/bi-caliber-audit.json");
  const golden = JSON.parse(fs.readFileSync(path.join(root, "tests", "bi-golden-set.json"), "utf8"));
  const glossary = loadGlossary();
  if (!glossary) {
    console.error("口径词典缺失或无法解析：bi-semantic/caliber-glossary.json");
    process.exit(1);
  }
  const rules = auditCards(golden.cases, glossary);
  for (const r of rules) {
    console.log(`\n[${r.status}] ${r.name}（${r.id}）：一致 ${r.agree.length} 张，冲突 ${r.conflict.length} 张`);
    for (const c of r.conflict) console.log(`  #${c.id} ${c.title} —— ${c.detail}`);
  }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), glossaryVersion: glossary.version, rules }, null, 2));
  console.log(`\n报告已写: ${out}`);
}
