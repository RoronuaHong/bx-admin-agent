/**
 * 变形语句路由评估（只做解析评估，不发起写请求）。
 * 目标：验证“用户输入 -> operation + params”是否稳定命中。
 *
 * 运行：
 *   node scripts/eval-intent-routing.mjs
 */
import { resolveApiOperation } from "../src/api-operation-index.ts";

function parseIntent(input) {
  const id =
    (input.match(/id\s*[:=]\s*(\d{8,})/i) || input.match(/(\d{8,})/))?.[1] ||
    "";

  let operationQuery = "";
  if (/二级分类/.test(input) && /详情|信息|查看/.test(input)) {
    operationQuery = "二级分类详情";
  } else if (/二级分类/.test(input) && /关闭.*搜索|搜索.*关闭/.test(input)) {
    operationQuery = "关闭搜索栏";
  } else if (/二级分类/.test(input) && /开启.*搜索|搜索.*开启/.test(input)) {
    operationQuery = "开启搜索栏";
  }

  const op = operationQuery ? resolveApiOperation(operationQuery) : null;

  let params = {};
  if (op?.id === "country.getById") {
    params = { id };
  } else if (op?.id === "country.setVisible") {
    params = { field: 1, id, visible: /开启/.test(input) };
  }

  return {
    input,
    operationQuery,
    operation: op?.id || null,
    params,
  };
}

const cases = [
  ["二级分类，id=4933323088090112，我要详情", "country.getById"],
  ["我要看二级分类详情 4933323088090112", "country.getById"],
  ["查询二级分类信息 id:4933323088090112", "country.getById"],
  ["二级分类，id=4933323088090112，关闭搜索栏", "country.setVisible"],
  ["把二级分类 4933323088090112 搜索栏关闭", "country.setVisible"],
  ["二级分类 4933323088090112 开启搜索栏", "country.setVisible"],
];

let pass = 0;
const rows = [];
for (const [text, expected] of cases) {
  const result = parseIntent(text);
  const ok = result.operation === expected && Boolean(result.params.id);
  if (ok) pass += 1;
  rows.push({
    ok,
    expected,
    actual: result.operation,
    input: text,
    params: result.params,
  });
}

for (const row of rows) {
  console.log(
    `${row.ok ? "PASS" : "FAIL"} | expected=${row.expected} | actual=${row.actual} | input=${row.input} | params=${JSON.stringify(row.params)}`,
  );
}
console.log(`\nAccuracy: ${pass}/${cases.length} (${((pass / cases.length) * 100).toFixed(1)}%)`);
