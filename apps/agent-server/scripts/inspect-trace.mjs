// 查询/可视化一次 Agent 请求的调用栈（traces）。
// 用法（需 tsx 解析 .ts 模块：npx tsx scripts/inspect-trace.mjs）：
//   npx tsx scripts/inspect-trace.mjs             列出最近 20 次 run（摘要）
//   npx tsx scripts/inspect-trace.mjs <runId>     打印某次 run 的完整 span 树（含耗时/token）
//   npx tsx scripts/inspect-trace.mjs --last      打印最近一次 run 的完整 span 树
import { listRuns, getRun } from "../src/trace.ts";

const arg = process.argv[2];
let runId = arg && !arg.startsWith("--") ? arg : null;
const last = arg === "--last";

if (last) {
  const runs = listRuns(1);
  runId = runs[0]?.runId ?? null;
}

if (!runId) {
  const runs = listRuns(20);
  if (!runs.length) {
    console.log("（暂无 trace 记录，先发一条消息给 agent 再试）");
    process.exit(0);
  }
  console.log(`最近 ${runs.length} 次 run：\n`);
  for (const r of runs) {
    const spans = getRun(r.runId);
    const runSpan = spans.find((s) => s.kind === "run");
    const llms = spans.filter((s) => s.kind === "llm");
    const tools = spans.filter((s) => s.kind === "tool");
    const routes = spans.filter((s) => s.kind === "route");
    const tok = llms.reduce(
      (a, s) => {
        a.prompt += s.usage?.promptTokens || 0;
        a.completion += s.usage?.completionTokens || 0;
        a.total += s.usage?.totalTokens || 0;
        return a;
      },
      { prompt: 0, completion: 0, total: 0 },
    );
    const start = new Date(r.startMs).toLocaleTimeString();
    console.log(
      `${r.runId}\n` +
        `  时间 ${start}  总耗时 ${runSpan ? runSpan.durationMs + "ms" : "?"}\n` +
        `  模型 ${runSpan?.model || "?"}  LLM×${llms.length}  工具×${tools.length}  路由×${routes.length}\n` +
        `  token: prompt=${tok.prompt} completion=${tok.completion} total=${tok.total}` +
        (runSpan?.meta?.userText ? `\n  输入: ${String(runSpan.meta.userText).slice(0, 60)}` : ""),
    );
  }
  console.log(`\n查看某次详情: node scripts/inspect-trace.mjs <runId>`);
  process.exit(0);
}

const spans = getRun(runId);
if (!spans.length) {
  console.log(`未找到 runId=${runId} 的 trace`);
  process.exit(1);
}
const runSpan = spans.find((s) => s.kind === "run");
console.log(`run ${runId}`);
if (runSpan) {
  console.log(`  输入: ${String(runSpan.meta?.userText ?? "").slice(0, 80)}`);
  console.log(`  模型: ${runSpan.model ?? "?"}  总耗时: ${runSpan.durationMs}ms\n`);
}
const tree = spans.filter((s) => s.kind !== "run").sort((a, b) => a.startMs - b.startMs);
for (const s of tree) {
  const indent = "  ";
  const tag = `[${s.kind}]`;
  const status = s.status !== "ok" ? ` ✗${s.status}` : "";
  const usage = s.usage?.totalTokens ? `  tok=${s.usage.totalTokens}(p${s.usage.promptTokens}/c${s.usage.completionTokens})` : "";
  const worker = s.worker ? ` @${s.worker}` : "";
  console.log(
    `${indent}${tag} ${s.name}${worker}  ${s.durationMs}ms${status}${usage}` +
      (s.note ? `  (${s.note})` : "") +
      (s.meta?.targetWorker ? `  →${s.meta.targetWorker}` : ""),
  );
}
// token 汇总
const llms = spans.filter((s) => s.kind === "llm");
const tok = llms.reduce((a, s) => { a.total += s.usage?.totalTokens || 0; a.prompt += s.usage?.promptTokens || 0; a.completion += s.usage?.completionTokens || 0; return a; }, { total: 0, prompt: 0, completion: 0 });
console.log(`\nLLM 调用 ${llms.length} 次  累计 token: prompt=${tok.prompt} completion=${tok.completion} total=${tok.total}`);
