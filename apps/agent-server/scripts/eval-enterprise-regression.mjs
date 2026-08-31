/**
 * 企业样本回归：覆盖“精确命中 + 触发反问”两类路径。
 */
import { resolveApiOperation } from "../src/api-operation-index.ts";
import { execCallApi } from "../src/tools.ts";

const routingCases = [
  ["二级分类，id=4933323088090112，我要详情", "country.getById"],
  ["secondary category id=4933323088090112 details", "country.getById"],
  ["把二级分类 4933323088090112 搜索栏关闭", "country.setVisible"],
  ["影片详情 id=5590108001975296", "film.getById"],
  ["show film detail movieId=5590108001975296", "film.getById"],
];

const clarificationCases = [
  { method: "GET", operation: "getById", expect: true, name: "non-unique short alias should clarify" },
  { method: "POST", expect: true, name: "missing path/url/operation should clarify" },
];

function route(input) {
  if (/二级分类|secondary category/i.test(input) && /详情|details?|查看|info/i.test(input)) {
    return resolveApiOperation("二级分类详情");
  }
  if (
    /二级分类|secondary category/i.test(input) &&
    (/关闭.*搜索|搜索.*关闭|search.*close|close.*search/i.test(input))
  ) {
    return resolveApiOperation("关闭搜索栏");
  }
  if (/影片|电影|film/i.test(input) && /详情|detail/i.test(input)) {
    return resolveApiOperation("影片详情");
  }
  return null;
}

let total = 0;
let pass = 0;

for (const [input, expected] of routingCases) {
  total += 1;
  const got = route(input)?.id || "MISS";
  const ok = got === expected;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | routing | expected=${expected} | got=${got} | input=${input}`);
}

for (const c of clarificationCases) {
  total += 1;
  const out = await execCallApi(c, {});
  const got = out.startsWith("CLARIFICATION_REQUIRED");
  const ok = got === c.expect;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | clarification | expected=${c.expect} | got=${got} | case=${c.name}`);
}

console.log(`\nTOTAL: ${pass}/${total} (${((pass / total) * 100).toFixed(1)}%)`);

