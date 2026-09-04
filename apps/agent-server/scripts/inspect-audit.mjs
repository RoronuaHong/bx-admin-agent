/**
 * 安全审计查看（P1）：读取 audit 落盘的越权拒绝 / 写确认事件。
 *
 * 用法（需 tsx 解析 .ts 模块：.\\node_modules\\.bin\\tsx.cmd）：
 *   tsx scripts/inspect-audit.mjs                       最近 200 条
 *   tsx scripts/inspect-audit.mjs --from 2026-09-01     按起始日过滤
 *   tsx scripts/inspect-audit.mjs --kind reject         只看越权拒绝
 *   tsx scripts/inspect-audit.mjs --kind confirm_result 只看写确认结论
 *   tsx scripts/inspect-audit.mjs --limit 50
 *
 * 红线：本脚本不含任何业务词；事件类型与过滤维度均为通用安全语义。
 */
import { listAuditEvents, getAuditDir } from "../src/audit.ts";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const events = listAuditEvents({
  fromDay: flag("from"),
  toDay: flag("to"),
  kind: flag("kind"),
  limit: Number(flag("limit")) || 200,
});

console.log(`\n===== 安全审计（${events.length} 条，目录 ${getAuditDir()}） =====`);
for (const e of events) {
  const who = e.ownerKey || "-";
  const what = [e.tool, e.worker, e.callId, e.result, e.method, e.detail]
    .filter(Boolean)
    .join(" | ");
  console.log(`  ${e.atIso}  [${e.kind}]  who=${who}  run=${(e.runId || "-").slice(0, 8)}  ${what}`);
}
if (!events.length) console.log("  （暂无审计事件）");
console.log("");
