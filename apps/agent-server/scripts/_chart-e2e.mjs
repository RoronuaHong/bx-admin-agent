// 图表可视化（路线 1）端到端验证：BI 取数 → mcp__chart__generate_* 出图 → 图片 Markdown 上屏。
// 运行：node scripts/_chart-e2e.mjs（对 http://localhost:8787 的真实服务跑；自动批准确认卡=测试环境）。
const BASE = process.env.AGENT_BASE_URL || "http://localhost:8787";
const jar = new Map(); // cookie jar：会话 + owner cookie 全程复用

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function captureCookies(res) {
  const set = res.headers.getSetCookie?.() || [];
  for (const line of set) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: cookieHeader(), ...(init.headers || {}) },
  });
  captureCookies(res);
  return res;
}

async function confirmTickets(pending) {
  for (const p of pending) {
    const res = await api("/chat/confirm", {
      method: "POST",
      body: JSON.stringify({ ticket: p.ticket, confirmed: true }),
    });
    console.log(`[confirm] ${p.name} -> ${res.status}`);
  }
}

async function runTurn(conversationId, text) {
  const pending = [];
  const events = [];
  const res = await api("/chat/stream", {
    method: "POST",
    body: JSON.stringify({ text, conversationId }),
  });
  captureCookies(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      events.push(event);
      if (event.type === "confirmation_required") {
        pending.push(event);
      } else if (event.type === "tool_call") {
        console.log(`[tool_call] ${event.name}`);
      } else if (event.type === "tool_result") {
        const head = String(event.text || "").slice(0, 160).replace(/\n/g, " ");
        console.log(`[tool_result] ${event.name} ok=${event.ok} :: ${head}`);
      } else if (event.type === "error") {
        console.log(`[error] ${event.message || event.error?.defaultMessage}`);
      }
    }
    if (pending.length) {
      await confirmTickets(pending);
      pending.length = 0;
    }
  }
  return events;
}

const conversationId = process.argv[2] || `chart_e2e_${Date.now()}`;

// 1. 建对话
await api("/chat/conversations", { method: "POST", body: JSON.stringify({ id: conversationId, title: "chart e2e" }) });
// 2. 启用 bi + chart
await api("/chat/mcp/servers", { method: "PUT", body: JSON.stringify({ conversationId, enabled: ["bi", "chart"] }) });
await new Promise((r) => setTimeout(r, 2500)); // 等连接建立（面板同款 1.5s 轮询节奏）

const prompt =
  "先用 BI 工具查真实数据：用 list_databases 列出数据库，再用 get_database_schema 统计每个库下有多少张表，" +
  "然后用图表工具画一张柱状图展示「各数据库的表数量」，最后把图片用 Markdown 图片语法（![标题](链接)）贴进回复。";

console.log(`[e2e] conversation=${conversationId}`);
const events = await runTurn(conversationId, prompt);

const chartResults = events.filter((e) => e.type === "tool_result" && e.name?.startsWith("mcp__chart__"));
const finalText = events.filter((e) => e.type === "text").at(-1)?.text || "";
const hasImage = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/.test(finalText);
const imageUrl = finalText.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/)?.[1];

console.log("\n==== 结果 ====");
console.log(`图表工具调用：${events.filter((e) => e.type === "tool_call" && e.name?.startsWith("mcp__chart__")).length}`);
console.log(`图表工具成功：${chartResults.filter((e) => e.ok).length}`);
console.log(`回复含 Markdown 图片：${hasImage}`);
if (imageUrl) {
  console.log(`图片 URL：${imageUrl}`);
  const img = await fetch(imageUrl);
  console.log(`图片可达：${img.status} ${img.headers.get("content-type") || ""}`);
}
const pass = chartResults.some((e) => e.ok) && hasImage;
console.log(pass ? "\nE2E PASS" : "\nE2E FAIL");
process.exitCode = pass ? 0 : 1;
