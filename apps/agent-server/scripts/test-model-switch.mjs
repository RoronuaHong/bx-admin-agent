// 临时：指定模型端到端测试（登录 + 聊天，打印 submit/call_api/error 摘要）
// 用法：node scripts/test-model-switch.mjs [modelId] [text]
import { writeFileSync } from "node:fs";
const BASE = "http://localhost:8787";
const model = process.argv[2] === "default" || process.argv[2] === "-" ? "" : (process.argv[2] || "");
const text = process.argv[3] || "用户列表前3页的数据";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const lg = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: "india", username: "admin", password: "123456" }),
    redirect: "manual",
  });
  const sid = (lg.headers.get("set-cookie") || "").split(";")[0].split("=")[1] || "";
  console.log("login", lg.status, "sid?", !!sid);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300000);
  const t0 = Date.now();
  const c = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `bx_agent_sid=${sid}` },
    body: JSON.stringify({ text, model: model || undefined }),
    signal: ac.signal,
  });
  clearTimeout(timer);
  const body = await c.text();
  writeFileSync("tmp-e2e.txt", body, "utf8");
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
  const submitEvs = evs.filter((e) => e.includes("submit_understood_intent"));
  const callEvs = evs.filter((e) => e.includes('"call_api"') || e.includes("call_api"));
  const tables = evs.filter((e) => e.includes('"type":"table"')).length;
  const msgs = evs.filter((e) => e.includes('"type":"message"') || e.includes('"type":"answer"'));
  const err = evs.find((e) => e.includes('"type":"error"'));
  const done = evs.some((e) => e.includes('"type":"done"'));
  const endText = msgs.length ? (JSON.parse(msgs[msgs.length - 1]).text || "").slice(0, 150).replace(/\n/g, " ") : "";
  console.log(`[${text}] model=${model || "(default)"} ${dt}s | status=${c.status} | done=${done} | 表格=${tables} | err=${err ? JSON.stringify(err).slice(0, 160) : "无"}`);
  for (const e of submitEvs) {
    try { const j = JSON.parse(e); const inp = j.input || j.parameters || j.arguments; console.log("SUBMIT:", JSON.stringify(inp).slice(0, 320)); } catch { /* noop */ }
  }
  for (const e of callEvs) {
    try { const j = JSON.parse(e); const inp = j.input || j.parameters || j.arguments; console.log("CALL:", JSON.stringify(inp).slice(0, 220)); } catch { /* noop */ }
  }
  if (endText) console.log("OUTPUT:", endText);
  await sleep(1000);
})();
