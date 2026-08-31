// 补测剩余 3 个模型（hyvision / nvstepflash / nvnanoomni），追加写 verify-all-out.txt，5min 间隔。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:8787";
const PROMPT = "用户列表前2页";
const PER_MODEL_TIMEOUT_MS = 240000;
const GAP_MS = 300000;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../verify-all-out.txt");

const MODELS = ["hyvision", "nvstepflash", "nvnanoomni"];

const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}\n`;
  fs.appendFileSync(OUT, line);
  console.log(line.trim());
};

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: "india", username: "admin", password: "123456" }),
  });
  return res.headers.get("set-cookie") || null;
}

async function streamChat(cookie, model, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ text: prompt, model }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `http ${res.status}: ${await res.text()}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", text = "", errMsg = "";
    let tables = 0, calls = 0, submits = 0;
    const started = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (!p || p === "[DONE]") continue;
        let evt; try { evt = JSON.parse(p); } catch { continue; }
        if (evt.type === "text") text += evt.text || "";
        else if (evt.type === "toolCalls") for (const c of (evt.calls || [])) { if (c.name === "call_api") calls++; if (c.name === "submit") submits++; }
        else if (evt.type === "table" || evt.type === "UI_TABLE") tables++;
        else if (evt.type === "error") errMsg += evt.message || "";
      }
    }
    return { elapsed: ((Date.now() - started) / 1000).toFixed(1), text: text.slice(0, 160), tables, submits, calls, errMsg };
  } catch (e) {
    if (e.name === "AbortError") return { error: `timeout >${PER_MODEL_TIMEOUT_MS / 1000}s` };
    return { error: String(e).slice(0, 150) };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const cookie = await login();
  if (!cookie) { log("LOGIN FAILED"); return; }
  log(`RESUME remaining=${MODELS.length}`);
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const t0 = Date.now();
    let r;
    try { r = await streamChat(cookie, model, PROMPT); }
    catch (e) { r = { error: String(e).slice(0, 150) }; }
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.error) log(`#${MODELS.length + 10} ${model} ERROR(${dur}s): ${r.error}`);
    else log(`#${MODELS.length + 10} ${model} ok(${r.elapsed}s) tables=${r.tables} submit=${r.submits} call_api=${r.calls} err=${r.errMsg || "-"} | ${(r.text || "").replace(/\n/g, " ")}`);
    if (i < MODELS.length - 1) { log("  ..sleep 5min before next"); await new Promise((res) => setTimeout(res, GAP_MS)); }
  }
  log("DONE");
}
run();
