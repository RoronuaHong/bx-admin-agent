/**
 * 多语言实例冒烟：登录后串行打 /chat/stream，验证任意语种闲聊可走通
 *（入口清洗不毁文 + SSE 收束）。运行：tsx scripts/prompt-guard-i18n-smoke.mjs
 */
const BASE = process.env.AGENT_BASE_URL || "http://localhost:8787";
const country = process.env.EVAL_COUNTRY;
const username = process.env.EVAL_USER;
const password = process.env.EVAL_PASS;
const model = process.env.EVAL_MODEL || undefined;

if (!country || !username || !password) {
  console.error("需要 EVAL_COUNTRY / EVAL_USER / EVAL_PASS");
  process.exit(2);
}

async function login() {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ country, username, password }),
  });
  if (!resp.ok) throw new Error(`login ${resp.status} ${await resp.text()}`);
  const setCookie = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  let cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    const raw = resp.headers.get("set-cookie") || "";
    cookie = raw.split(",")[0].split(";")[0];
  }
  if (!cookie) throw new Error("no cookie");
  return cookie;
}

async function chat(cookie, text) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text, model }),
  });
  if (resp.status === 429) {
    return {
      ok: false,
      status: 429,
      ms: Date.now() - t0,
      events: 0,
      error: "RATE_LIMITED",
      reply: "",
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      ms: Date.now() - t0,
      events: 0,
      error: await resp.text(),
      reply: "",
    };
  }
  const raw = await resp.text();
  const texts = [];
  let done = false;
  let err = "";
  let events = 0;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    events += 1;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "text" && ev.text) texts.push(ev.text);
      if (ev.type === "done") done = true;
      if (ev.type === "error") err = ev.message || JSON.stringify(ev);
    } catch {
      /* ignore */
    }
  }
  return {
    ok: done && !err,
    status: resp.status,
    ms: Date.now() - t0,
    events,
    error: err,
    reply: texts.join("").slice(0, 200),
  };
}

const cases = [
  { id: "zh", text: "你好" },
  { id: "en", text: "Hello" },
  { id: "es", text: "Hola, como estas?" },
  { id: "ar", text: "مرحبا" },
  { id: "hi", text: "नमस्ते" },
  { id: "ja", text: "こんにちは" },
  // 夹杂 NUL / 零宽 / 双向覆盖：应被入口剥离后仍能闲聊走通
  { id: "ctrl+en", text: "Hi\u0000\u200B\u202E there" },
];

const cookie = await login();
console.log("LOGIN ok");

let pass = 0;
for (const c of cases) {
  const r = await chat(cookie, c.text);
  if (r.ok) pass += 1;
  const safeIn = c.text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u202a-\u202e\u2060\ufeff]/g, "·");
  console.log(
    [
      r.ok ? "PASS" : "FAIL",
      c.id,
      `in=${JSON.stringify(safeIn)}`,
      `status=${r.status}`,
      `ms=${r.ms}`,
      `events=${r.events}`,
      r.error ? `err=${r.error}` : "",
      `reply=${JSON.stringify(r.reply)}`,
    ]
      .filter(Boolean)
      .join(" | "),
  );
}

console.log(`TOTAL ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
