// 轻量体检：按 MODEL_PROVIDERS 逐个发一条最小请求，报告 HTTP 状态与错误摘要。
// 目的：模型链里混进「额度已耗尽(402/401008)」的模型时，一次任务会连续白等多次回退。
import { config as loadEnv } from "dotenv";

loadEnv({ path: new URL("../.env", import.meta.url).pathname.replace(/^\//, "") });

const ids = (process.env.MODEL_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean);
const only = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
const targets = only.length ? only : ids;

console.log(`模型链: ${ids.join(" → ")}`);
console.log(`探测: ${targets.join(", ")}`);
console.log("");

for (const id of targets) {
  const prefix = `MODEL_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
  const name = process.env[`${prefix}NAME`] || "";
  const baseUrl = (process.env[`${prefix}BASE_URL`] || "").replace(/\/+$/, "");
  const key = process.env[`${prefix}API_KEY`] || "";
  if (!baseUrl || !key || !name) {
    console.log(`${id.padEnd(10)} ⚠ 配置不完整（name/baseUrl/key 缺一）`);
    continue;
  }
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: name, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(25000),
    });
    const raw = await res.text();
    let brief = raw.replace(/\s+/g, " ").slice(0, 180);
    try {
      const j = JSON.parse(raw);
      const code = j?.error?.code || j?.code;
      const msg = j?.error?.message_zh || j?.error?.message || j?.message || "";
      if (code) brief = `code=${code} ${msg}`.slice(0, 180);
      else if (j?.choices) brief = "OK";
    } catch {
      /* 非 JSON 原样截断 */
    }
    const ok = res.ok && !/^code=/.test(brief);
    console.log(`${id.padEnd(10)} ${ok ? "✅" : "❌"} http=${res.status} ${Date.now() - started}ms  ${brief}`);
  } catch (err) {
    console.log(`${id.padEnd(10)} ❌ ${String(err?.message || err).slice(0, 160)}`);
  }
}
