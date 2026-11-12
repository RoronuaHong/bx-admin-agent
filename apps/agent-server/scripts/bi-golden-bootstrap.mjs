// 黄金集落盘：把 metabase-mcp 的 get_golden_set 结果写到 tests/bi-golden-set.json。
// 用法：node scripts/bi-golden-bootstrap.mjs [database_id]   （默认所有库）
// 纯元数据、零 LLM；先起 metabase-mcp 作 stdio 子进程，再取数写盘。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  fs.writeFileSync(knownPath, JSON.stringify({ generatedAt: new Date().toISOString(), databaseIds: dbIds, total: tables.length, tables }, null, 2));
  console.log(`真实表名白名单已落盘: ${knownPath}（${tables.length} 张表，来自 ${dbIds.length} 个库）`);
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(0); }, 200);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
