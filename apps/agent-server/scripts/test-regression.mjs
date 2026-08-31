// bad case 回归集：把历史事故（模块/操作解析）固化为自动化断言，每次改动跑一遍防回归。
// 运行：npm run test:regression（或 node --import <tsx-loader> scripts/test-regression.mjs）
import "../src/load-env.js";
import { runAgentTool } from "../src/tools.ts";
import { inferCallOperation } from "../src/workflow-orchestrate.ts";

const CASES = [
  {
    name: "影片搜索统计列表+前50条（防被 film 截胡，issue: 影片搜索统计→film）",
    text: "看下影片搜索统计的列表，最新的前50条",
    module: "search",
    op: "search.getMovieSearchStatList",
    size: 50,
  },
  {
    name: "关键字搜索统计列表（防落 getList）",
    text: "看下关键字搜索统计的列表",
    module: "search",
    op: "search.getKeywordSearchStatList",
  },
  {
    name: "影片列表+前10条（回归：不应被 search 抢走）",
    text: "看下影片列表，最新的前10条",
    module: "film",
    op: "film.getList",
    size: 10,
  },
  {
    name: "用户列表（防 sys/user 无接口模块截胡 user）",
    text: "看下用户列表",
    module: "user",
    op: "user.getList",
  },
  {
    name: "删除用户（写意图必须识别为 write）",
    text: "删除用户 5850754967898112",
    module: "user",
    write: true,
  },
  {
    name: "影片详情+长ID（上下文继承应识别为详情读）",
    text: "看下影片 5850754967898112 的详情",
    module: "film",
    opType: "read",
  },
  // —— 影片管理菜单 10 模块（2026-08-22 补：影评/系列/采集源/高频未充值曾识别失败）——
  { name: "影片列表", text: "看下影片列表", module: "film", op: "film.getList" },
  { name: "影评列表", text: "看下影评列表", module: "comment", op: "comment.getList" },
  { name: "二级分类列表", text: "看下二级分类列表", module: "country", op: "country.getList" },
  { name: "三级分类列表", text: "看下三级分类列表", module: "tag", op: "tag.getList" },
  { name: "演员列表", text: "看下演员列表", module: "actor", op: "actor.getList" },
  { name: "系列列表", text: "看下系列列表", module: "movieseries", op: "movieseries.getList" },
  { name: "时间标签列表", text: "看下时间标签列表", module: "movietimetag", op: "movietimetag.getList" },
  { name: "推荐片段列表", text: "看下推荐片段列表", module: "movie-fragment", op: "movie-fragment.getList" },
  { name: "影片采集源列表", text: "看下影片采集源列表", module: "videosource", op: "videosource.getList" },
  {
    name: "高频未充值用户影片列表",
    text: "看下高频未充值用户影片列表",
    module: "userlayer/wool_user",
    op: "userlayer/wool_user.getWoolReport",
  },
];

let failed = 0;
for (const c of CASES) {
  try {
    const res = await runAgentTool(
      "parse_intent",
      { userInput: c.text, understoodFromLlm: false },
      { sessionId: "regression" },
    );
    let parsed = null;
    try {
      parsed = JSON.parse(String(res).replace(/^CLARIFICATION_REQUIRED\s*/, ""));
    } catch {
      parsed = null;
    }
    const module = String(parsed?.module || "");
    const opType = String(parsed?.operationType || "");
    const okModule = !c.module || module === c.module;
    let op = "";
    let size;
    if (okModule && (c.op || c.opType)) {
      const spec = inferCallOperation(
        module,
        c.text,
        "read",
        null,
        "",
        "",
        "regression",
      );
      op = String(spec?.operation || "");
      size = spec?.params?.size;
    }
    const okOp = !c.op || op === c.op;
    const okSize = c.size === undefined || size === c.size;
    const okType = !c.opType || opType === c.opType;
    const okWrite = c.write === true ? opType === "write" : true;
    const pass = okModule && okOp && okSize && okType && okWrite;
    if (!pass) failed++;
    console.log(
      `${pass ? "PASS" : "FAIL"} ${c.name}\n    module=${module}${c.op ? ` op=${op}` : ""}` +
        `${c.size !== undefined ? ` size=${size}` : ""}${c.write ? ` opType=${opType}` : ""}`,
    );
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}\n    异常: ${e && e.message ? e.message : String(e)}`);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
