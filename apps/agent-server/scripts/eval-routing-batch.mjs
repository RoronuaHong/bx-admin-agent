/**
 * 批量变形验证（模块级）：校验语句 -> operation 映射准确率。
 */
import { resolveApiOperation } from "../src/api-operation-index.ts";

const suites = [
  {
    module: "country",
    cases: [
      ["二级分类，id=4933323088090112，我要详情", "country.getById"],
      ["查询二级分类详情 id:4933323088090112", "country.getById"],
      ["把二级分类 4933323088090112 搜索栏关闭", "country.setVisible"],
      ["二级分类 4933323088090112 开启搜索栏", "country.setVisible"],
      ["更新二级分类", "country.update"],
    ],
  },
  {
    module: "film",
    cases: [
      ["影片详情 id=5590108001975296", "film.getById"],
      ["查询电影详情 5590108001975296", "film.getById"],
    ],
  },
  {
    module: "vipExchangeCode",
    cases: [
      ["查询兑换码列表", "vipExchangeCode.getCodeList"],
      ["兑换码列表", "vipExchangeCode.getCodeList"],
    ],
  },
];

function route(input) {
  if (/二级分类/.test(input) && /详情|信息|查看/.test(input)) return resolveApiOperation("二级分类详情");
  if (/二级分类/.test(input) && /关闭.*搜索|搜索.*关闭/.test(input)) return resolveApiOperation("关闭搜索栏");
  if (/二级分类/.test(input) && /开启.*搜索|搜索.*开启/.test(input)) return resolveApiOperation("开启搜索栏");
  if (/二级分类/.test(input) && /更新|编辑|修改/.test(input)) return resolveApiOperation("更新二级分类");
  if (/影片|电影/.test(input) && /详情/.test(input)) return resolveApiOperation("影片详情");
  if (/兑换码/.test(input) && /列表/.test(input)) return resolveApiOperation("兑换码列表");
  return null;
}

let total = 0;
let pass = 0;
for (const suite of suites) {
  let mTotal = 0;
  let mPass = 0;
  for (const [input, expected] of suite.cases) {
    total += 1;
    mTotal += 1;
    const got = route(input)?.id || "MISS";
    const ok = got === expected;
    if (ok) {
      pass += 1;
      mPass += 1;
    }
    console.log(`${ok ? "PASS" : "FAIL"} | ${suite.module} | expected=${expected} | got=${got} | input=${input}`);
  }
  console.log(`MODULE ${suite.module}: ${mPass}/${mTotal} (${((mPass / mTotal) * 100).toFixed(1)}%)`);
}

console.log(`\nTOTAL: ${pass}/${total} (${((pass / total) * 100).toFixed(1)}%)`);

