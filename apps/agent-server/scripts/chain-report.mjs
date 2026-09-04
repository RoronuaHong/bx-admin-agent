// 聚合分析：读取 _mr-results.jsonl，按 suite 输出通过率/性能统计
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const file = process.argv[2] || join(process.cwd(), ".data", "multirun", `results-${new Date().toISOString().slice(0, 10)}.jsonl`);
if (!existsSync(file)) { console.log("no results file"); process.exit(1); }
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const bySuite = new Map();
for (const r of rows) {
  if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
  bySuite.get(r.suite).push(r);
}

console.log("==== MULTIRUN REPORT ====");
for (const [suite, list] of bySuite) {
  const pass = list.filter((r) => r.ok).length;
  const durs = list.map((r) => r.durRun || 0).filter(Boolean);
  const toks = list.map((r) => r.tokens || 0).filter((t) => t > 0);
  const rounds = list.map((r) => r.rounds).filter(Boolean);
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  console.log(`\n[${suite}]  ${pass}/${list.length} pass (${list.length ? ((pass / list.length) * 100).toFixed(0) : 0}%)`);
  if (rounds.length) console.log(`  rounds: median=${med(rounds)} all=${JSON.stringify(rounds)}`);
  if (toks.length) console.log(`  tokens: median=${med(toks)} all=${JSON.stringify(toks)}`);
  if (durs.length) console.log(`  runDur(ms): median=${med(durs)} all=${JSON.stringify(durs)}`);
  for (const r of list.filter((r) => !r.ok)) console.log(`  FAIL #${r.run}: ${r.detail}`);
}
const total = rows.length;
const totalPass = rows.filter((r) => r.ok).length;
console.log(`\nTOTAL: ${totalPass}/${total} (${((totalPass / total) * 100).toFixed(1)}%)`);
