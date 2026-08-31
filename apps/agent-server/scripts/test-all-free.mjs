// 全部 zen 免费模型批量端到端测试（方案 A：数据回喂模型校验总结）
// 用法：node scripts/test-all-free.mjs [text]
import { writeFileSync } from "node:fs";
const BASE = "http://localhost:8787";
const text = process.argv[2] || "用户列表前3页的数据";
const MODELS = ["nemotronultra", "nemotronfree", "xpreviewfree", "lagunas", "zenhy3"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runModel(sid, model, idx) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 360000);
  const t0 = Date.now();
  try {
    const c = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `bx_agent_sid=${sid}` },
      body: JSON.stringify({ text, model }),
      signal: ac.signal,
    });
    const body = await c.text();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const evs = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
    const submitEvs = evs.filter((e) => e.includes("submit_understood_intent"));
    const callEvs = evs.filter((e) => e.includes('"call_api"'));
    const tables = evs.filter((e) => e.includes('"type":"table"')).length;
    const msgs = evs.filter((e) => e.includes('"type":"text"'));
    const err = evs.find((e) => e.includes('"type":"error"'));
    const done = evs.some((e) => e.includes('"type":"done"'));
    let submit = "";
    if (submitEvs.length) { try { const j = JSON.parse(submitEvs[0]); submit = (j.input?.summary || j.input?.operation || "").slice(0, 60); } catch { /* noop */ } }
    const calls = callEvs.map((e) => { try { const j = JSON.parse(e); const p = j.input?.params || {}; return `p${p.page}${p.pageSize ? "/s" + p.pageSize : ""}`; } catch { return "?"; } });
    const endText = msgs.length ? (JSON.parse(msgs[msgs.length - 1]).text || "").slice(0, 120).replace(/\n/g, " ") : "";
    console.log(`\n===== [${idx + 1}/5] ${model} =====`);
    console.log(`耗时=${dt}s | status=${c.status} | done=${done} | 表格=${tables} | submit=${submit}`);
    console.log(`call_api=${calls.length} 次 [${calls.join(", ")}] | err=${err ? JSON.stringify(err).slice(0, 100) : "无"}`);
    console.log(`最终文本: ${endText || "(空)"}`);
    writeFileSync(`tmp-e2e-${model}.txt`, body, "utf8");
  } catch (e) {
    console.log(`\n===== [${idx + 1}/5] ${model} =====`);
    console.log(`❌ 异常/超时: ${e.name || e.message}`);
  }
  clearTimeout(timer);
  await sleep(3000);
}

(async () => {
  const lg = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: "india", username: "admin", password: "123456" }),
    redirect: "manual",
  });
  const sid = (lg.headers.get("set-cookie") || "").split(";")[0].split("=")[1] || "";
  console.log("login", lg.status, "| text:", text);
  for (let i = 0; i < MODELS.length; i++) await runModel(sid, MODELS[i], i);
  console.log("\n===== 全部完成 =====");
})();
