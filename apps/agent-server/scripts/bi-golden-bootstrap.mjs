// 黄金集落盘：把 metabase-mcp 的 get_golden_set 结果写到 tests/bi-golden-set.json。
// 用法：node scripts/bi-golden-bootstrap.mjs [database_id]   （默认所有库）
// 纯元数据、零 LLM；先起 metabase-mcp 作 stdio 子进程，再取数写盘。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeGoldenCase, applyGoldenQuestions } from "./metabase-card-graph.mjs";

const repo = path.dirname(fileURLToPath(import.meta.url)); // apps/agent-server/scripts
const root = path.join(repo, ".."); // apps/agent-server
const outPath = path.join(root, "tests", "bi-golden-set.json");
const databaseId = process.argv[2] ? Number(process.argv[2]) : null;

const child = spawn("node", ["scripts/metabase-mcp.mjs"], {
  cwd: root,
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});
let buf = "";
const pending = new Map();
let id = 0;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { const fn = pending.get(msg.id); pending.delete(msg.id); fn(msg); }
  }
});
const rpc = (method, params) =>
  new Promise((res) => { const myId = ++id; pending.set(myId, res); send({ jsonrpc: "2.0", id: myId, method, params }); });

(async () => {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bootstrap", version: "1" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const r = await rpc("tools/call", { name: "get_golden_set", arguments: databaseId != null ? { database_id: databaseId } : {} });
  const content = r?.result?.content || [];
  const text = content.map((x) => x.text || "").join("\n");
  let parsed;
  try { parsed = JSON.parse(text); } catch { console.error("解析失败：", text.slice(0, 300)); process.exit(1); }
  const payload = { generatedAt: new Date().toISOString(), databaseId, total: parsed.total, withSql: parsed.withSql, cases: parsed.cases };
  // 卡片标题只是标题，用作模型提示太弱且容易被按标题搜回原卡片。应用自然语言改写稿，
  // 原卡片名留作 cardTitle 供留一法识别孪生卡片；映射不存在时保持原样。
  const qPath = path.join(root, "tests", "bi-golden-questions.json");
  const qMap = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, "utf8")).questions || {} : {};
  payload.cases = applyGoldenQuestions(payload.cases, qMap);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`黄金集已落盘: ${outPath}`);
  console.log(`总卡片 ${parsed.total} / 带 SQL ${parsed.withSql} / 样例:`, parsed.cases?.slice(0, 3).map((c) => `#${c.id} ${c.question}`).join(" | "));

  // 附带导出真实 schema 表名白名单：跑分器用它把抽表结果里的 CTE 名 / 别名噪声滤掉（§11.7 限制 3）。
  const textOf = (m) => (m?.result?.content || []).map((x) => x.text || "").join("\n");
  const ld = await rpc("tools/call", { name: "list_databases", arguments: { detail: "detailed" } });
  let dbIds = [];
  try { dbIds = (JSON.parse(textOf(ld)).databases || []).map((d) => d.id).filter((x) => x != null); }
  catch { console.warn("[warn] list_databases 解析失败，白名单将为空"); }
  const known = new Set();
  for (const dbId of dbIds) {
    const s = await rpc("tools/call", { name: "get_database_schema", arguments: { database_id: dbId, detail: "detailed" } });
    try {
      const obj = JSON.parse(textOf(s));
      for (const t of obj.tables || []) {
        const name = typeof t === "string" ? t : t?.table || t?.name;
        if (name) known.add(String(name).replace(/[`"]/g, "").trim().toLowerCase());
      }
    } catch { console.warn(`[warn] db=${dbId} 表清单解析失败，跳过`); }
  }
  const knownPath = path.join(root, "tests", "bi-known-tables.json");
  const tables = [...known].sort();
  // tableAudit 是人工/只读 SQL 查证的结论，tableTexts 由 bi-metadata-gaps.mjs 导出，重新导出表清单时都不能冲掉。
  const prev = fs.existsSync(knownPath) ? JSON.parse(fs.readFileSync(knownPath, "utf8")) : {};
  const knownDoc = {
    generatedAt: new Date().toISOString(),
    databaseIds: dbIds,
    total: tables.length,
    tables,
    ...(prev.tableAudit ? { tableAudit: prev.tableAudit } : {}),
    ...(prev.tableTexts ? { tableTexts: prev.tableTexts } : {}),
  };
  fs.writeFileSync(knownPath, JSON.stringify(knownDoc, null, 2));
  console.log(`真实表名白名单已落盘: ${knownPath}（${tables.length} 张表，来自 ${dbIds.length} 个库）`);

  // 期望表归一化（裸名补 schema、剔 CTE、标白名单外表），与 bi-golden-normalize.mjs 同一逻辑。
  if (tables.length) {
    let cases = payload.cases.map((c) => normalizeGoldenCase(c, knownDoc));
    // 1.3 准入检查：引用库里已不存在的表（unverifiedTableStatus 含 "missing"，见 bi-known-tables.json 的 tableAudit.missing）
    // 的样例无法执行，退出黄金集，避免污染评测基线。
    const missingCases = cases.filter((c) => Object.values(c.unverifiedTableStatus || {}).includes("missing"));
    if (missingCases.length) {
      cases = cases.filter((c) => !Object.values(c.unverifiedTableStatus || {}).includes("missing"));
      console.log(`准入检查：退出引用失效表的 ${missingCases.length} 例（${missingCases.map((c) => "#" + c.id).join(", ")}），基线从 ${payload.cases.length} 例降为 ${cases.length} 例`);
    }
    fs.writeFileSync(outPath, JSON.stringify({ ...payload, cases, normalizedAt: new Date().toISOString() }, null, 2));
    const unverified = cases.filter((c) => c.unverifiedTables?.length).length;
    console.log(`期望表已归一化；含白名单外表 ${unverified} 例（见各例 unverifiedTables）`);
  }
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(0); }, 200);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
