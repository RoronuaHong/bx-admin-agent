import { enforceRoleIdentity } from "../src/role-guard.js";

// 长回答样本：必须真的超过 role-guard 的字数上限（400），否则覆盖不到「超长不改写」这条分支。
// 拼接而非手写超长字面量，避免改阈值时样本与阈值脱节。
const LONG_SELF_ID =
  "我是 Kimi。" +
  "下面为你推荐几部科幻片：星际穿越、盗梦空间、银翼杀手，它们都探讨了时间与记忆的主题，评分均在 8.5 以上。".repeat(9);
if (LONG_SELF_ID.length <= 400) throw new Error(`长回答样本只有 ${LONG_SELF_ID.length} 字，覆盖不到超长分支`);

const cases: Array<[string, string, string]> = [
  // [input, roleLabel, expected]
  ["我是 Kimi，由 Moonshot AI（月之暗面）开发的 AI 助手。", "观影助手", "我是观影助手。"],
  ["你好，我是 Kimi", "观影助手", "我是观影助手。"],
  ["我是观影助手，有什么可以帮你？", "观影助手", "我是观影助手，有什么可以帮你？"],
  ["我是通用助手", "通用助手", "我是通用助手"],
  ["I'm Kimi, developed by Moonshot.", "观影助手", "我是观影助手。"],
  // 长回答（>400 字）：即便开头自报也不改写，交 prompt 层处理，避免误伤正文
  [LONG_SELF_ID, "观影助手", LONG_SELF_ID],
  ["你好！我来帮你找电影。", "观影助手", "你好！我来帮你找电影。"],
];

let ok = true;
for (const [input, label, expected] of cases) {
  const got = enforceRoleIdentity(input, label);
  const pass = got === expected;
  ok = ok && pass;
  console.log(`${pass ? "PASS" : "FAIL"} | in="${input}"\n     out="${got}"${pass ? "" : `\n  expected="${expected}"`}`);
}
console.log("\n==>", ok ? "ALL PASS" : "SOME FAIL");
process.exit(ok ? 0 : 1);
