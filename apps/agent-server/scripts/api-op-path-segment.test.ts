/**
 * api-operation 结构回落闸门（零业务词：只认标识符形态）。
 * 运行：tsx scripts/api-op-path-segment.test.ts
 */
import { resolveApiOperation, findApiOperationCandidates } from "../src/api-operation-index.ts";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | [api-op] ${name}${detail ? ` | ${detail}` : ""}`);
}

{
  const hit = resolveApiOperation("user.getList");
  assert("精确 id 仍命中", hit?.id === "user.getList", `id=${hit?.id}`);
}

{
  const hit = resolveApiOperation("userAccount.getList");
  assert("模块 token：path 段 camel", hit?.id === "user.getList", `id=${hit?.id}`);
}

{
  const hit = resolveApiOperation("user-account.getList");
  assert("模块 token：kebab", hit?.id === "user.getList", `id=${hit?.id}`);
}

{
  const hit = resolveApiOperation("userAccount.get");
  assert("func 宽松 get↔getList", hit?.id === "user.getList", `id=${hit?.id}`);
}

{
  assert("大小写变体", resolveApiOperation("User.getList")?.id === "user.getList");
}

{
  const cands = findApiOperationCandidates("userAccount.getList", 3);
  assert("candidates 含结构回落", cands.some((c) => c.id === "user.getList"));
}

{
  assert(
    "嵌名词 getUserList→user.getList",
    resolveApiOperation("demo.getUserList")?.id === "user.getList",
  );
  assert(
    "嵌名词 getBannerList→banner.getList",
    resolveApiOperation("foo.getBannerList")?.id === "banner.getList",
  );
  assert(
    "嵌名词 getActorList→actor.getList",
    resolveApiOperation("x.getActorList")?.id === "actor.getList",
  );
}

{
  assert(
    "模块 id/文件名 token：advertisingBudget",
    resolveApiOperation("advertisingBudget.getList")?.id === "advertisingbudget.getList",
  );
}

{
  assert(
    "复合前缀 sysUser.getList→user.getList",
    resolveApiOperation("sysUser.getList")?.id === "user.getList",
  );
  assert(
    "复合前缀 systemUser.getList→user.getList",
    resolveApiOperation("systemUser.getList")?.id === "user.getList",
  );
}

{
  assert("臆造仍 null", resolveApiOperation("totallyFakeModule.noSuchFunc") == null);
  assert(
    "无线索不硬猜",
    resolveApiOperation("unknownMod.getList") == null ||
      resolveApiOperation("unknownMod.getList")?.id === "unknownMod.getList",
  );
}

{
  // 模糊分并列不得乱取第一
  const hit = resolveApiOperation("get");
  assert("裸短串不因 scored 误命中", hit == null, `id=${hit?.id}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[api-op] ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) process.exit(1);
