// End-to-end test of NVIDIA models via the agent-server /chat/stream endpoint.
// Login (India/admin/123456) -> capture Set-Cookie -> reuse for chat. Uses native fetch.
const BASE = "http://localhost:8787";
const MODELS = ["nvnemotronultra", "nvnemotronsuper", "nvnemotronlightning"];

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: "india", username: "admin", password: "123456" }),
  });
  const setCookie = res.headers.get("set-cookie");
  const json = await res.json().catch(() => ({}));
  console.log("login:", res.status, JSON.stringify(json), "cookie:", setCookie?.slice(0, 40));
  return setCookie || null;
}

async function streamChat(cookie, model, prompt) {
  const body = { text: prompt, model };
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `http ${res.status}: ${await res.text()}` };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let toolCalls = 0, tables = 0, confirmations = 0, submits = 0, calls = 0, failed = false;
  const started = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt; try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === "text") text += evt.text || "";
      else if (evt.type === "toolCalls") {
        toolCalls++;
        for (const c of (evt.calls || [])) { if (c.name === "call_api") calls++; if (c.name === "submit") submits++; }
      }
      else if (evt.type === "table" || evt.type === "UI_TABLE") tables++;
      else if (evt.type === "confirmation_required") confirmations++;
      else if (evt.type === "toolResult" && /失败|error|Error/.test(evt.content || "")) failed = true;
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  return { text: text.slice(0, 240), toolCalls, tables, confirmations, submits, calls, failed, elapsed };
}

async function run() {
  const cookie = await login();
  if (!cookie) { console.log("login failed, abort"); return; }
  const prompts = { hi: "你好，用三个词回答", biz: "用户列表前2页" };
  for (const model of MODELS) {
    for (const [key, prompt] of Object.entries(prompts)) {
      console.log(`\n=== ${model} / ${key} ===`);
      try {
        const r = await streamChat(cookie, model, prompt);
        if (r.error) console.log(`ERROR: ${r.error}`);
        else console.log(`elapsed=${r.elapsed}s tables=${r.tables} submit=${r.submits} call_api=${r.calls} confirm=${r.confirmations} failed=${r.failed}\nTEXT: ${r.text}`);
      } catch (e) { console.log(`THREW: ${String(e)}`); }
    }
  }
}
run();
