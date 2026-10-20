// 精确复刻 src/numeric-verify.ts 的 TOTAL_RE，验证 L1 跨源总数校验是否真能匹配。
const UNIT_ALT = "条记录|条数据|条|个|项|元|次|人|笔|名|张|页|份";
const UNIT_RE = new RegExp(`(${UNIT_ALT})`);
const TOTAL_RE = new RegExp(
  `(?:共|合计|总计|总|累计|总和)\\s*[:：]?\\s*(\\d[\\d,]*\\s*)${UNIT_RE.source}`,
  "g",
);
const cases = [
  "工具返回共 20 条数据",
  "共 20 条",
  "共20条",
  "返回总计 1,234 元",
  "合计：30 个",
];
for (const c of cases) {
  const m = [...c.matchAll(TOTAL_RE)].map((x) => x[0]);
  console.log(JSON.stringify(c), "=>", JSON.stringify(m));
}
console.log("UNIT_RE.source =", UNIT_RE.source);
