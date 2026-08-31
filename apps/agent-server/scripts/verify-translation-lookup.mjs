/**
 * 验证翻译表反查（A+ 方案）：断言 5 例模块定位。
 * 运行：cd apps/agent-server && .\node_modules\.bin\tsx.cmd scripts/verify-translation-lookup.mjs
 * - 账号合并（C2 纯 i18n，核心回归）必须命中 user/account_merge
 * - 账号合并558523069977（extractGrepPattern 粘连数字形态）同样必须命中
 * - 优惠活动配置 / 用户列表 / 影片搜索统计（C1 硬编码中文，对照）不误报、不产生错误候选
 */
import { lookupTermModules, formatTranslationHits } from "../src/translation-lookup.ts";

const root = "D:\\Code\\bx-film-admin-in2";

const cases = [
  { term: "账号合并", expect: "user/account_merge" },
  { term: "账号合并558523069977", expect: "user/account_merge" }, // extractGrepPattern 粘连数字的真实形态
  { term: "影片上传自动化", expect: "movie/autoUpload" }, // 2026-08-24「查询影片上传自动化列表」慢排查新增回归
  { term: "优惠活动配置", expect: "user/special_offer" },
  { term: "用户列表", expect: "account" },
  { term: "影片搜索统计", expect: "search" },
  { term: "错误日志", expect: null }, // routes/ 子目录系统页（sys/error-log 无 api import），诚实回退不误调
];

let pass = 0;
let fail = 0;
const t0 = Date.now();
for (const c of cases) {
  const hits = lookupTermModules(c.term, root);
  const ids = hits.map((h) => h.moduleId);
  const ok = c.expect === null ? ids.length === 0 : ids.includes(c.expect);
  console.log(`${ok ? "PASS" : "FAIL"} 「${c.term}」期望 ${c.expect ?? "(无命中)"} | 实际 ${ids.join(", ") || "(无命中)"}`);
  if (hits.length) {
    console.log("  " + formatTranslationHits(c.term, hits).replace(/\n/g, "\n  "));
  }
  ok ? pass++ : fail++;
}
const coldMs = Date.now() - t0;

// 热缓存耗时对比（验证 walkFiles 目录列表缓存生效：文件内容 cachedRead + 目录列表 dirListCache）
const t1 = Date.now();
for (const c of cases) {
  lookupTermModules(c.term, root);
}
const hotMs = Date.now() - t1;

console.log(`\n结果：${pass}/${pass + fail} 通过`);
console.log(`反查耗时：冷缓存 ${coldMs}ms | 热缓存 ${hotMs}ms（热缓存明显更快 = 目录列表缓存生效）`);
process.exit(fail ? 1 : 0);
