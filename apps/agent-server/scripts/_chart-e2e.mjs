// 图表可视化（路线 3 · 本地渲染）端到端验证：BI 取数 → render_chart → chart 事件下发。
// 运行：node scripts/_chart-e2e.mjs（对 http://localhost:8787 的真实服务跑；自动批准确认卡=测试环境）。
//
// 历史：早期版本验证的是路线 1（mcp__chart__generate_* 调 AntV 官方服务出图 + 回复贴 Markdown 图片）。
// 该路线已下线（chart 服务器从 .env 移除，且 PUT /chat/mcp/servers 会过滤掉不存在的 id），
// 本脚本随之改为断言路线 3 的产物：内置工具 render_chart + `chart` 事件。
// 注意：内置工具（含 render_chart）只在会话勾选了至少一个 MCP 时才注入，故这里先建对话并勾选 bi。
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
      } else if (event.type === "chart") {
        const rows = Array.isArray(event.data) ? `${event.data.length} 行` : "(图形结构)";
        console.log(`[chart] 事件下发：type=${event.chartType} title=${event.title || "(无)"} data=${rows}`);
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
// 2. 启用 bi（取数来源）。内置工具随「勾选了至少一个 MCP」注入。
const put = await api("/chat/mcp/servers", {
  method: "PUT",
  body: JSON.stringify({ conversationId, enabled: ["bi"] }),
});
console.log(`[启用] ${JSON.stringify((await put.json()).enabled)}`);
await new Promise((r) => setTimeout(r, 2500)); // 等连接建立（面板同款 1.5s 轮询节奏）

const prompt =
  "先用 BI 工具查真实数据：用 mcp__bi__list_databases 列出数据库，再用 mcp__bi__get_database_schema 统计每个库下有多少张表，" +
  "然后调用 render_chart 画一张柱状图展示「各数据库的表数量」：" +
  "chartType=column，data=[{name, tables}]，encode={x:'name', y:'tables'}。不要输出图片链接。";

console.log(`[e2e] conversation=${conversationId}`);
const events = await runTurn(conversationId, prompt);

const chartCalls = events.filter((e) => e.type === "tool_call" && e.name === "render_chart");
const chartResults = events.filter((e) => e.type === "tool_result" && e.name === "render_chart");
const biCalls = events.filter((e) => e.type === "tool_call" && String(e.name).startsWith("mcp__bi__"));
const charts = events.filter((e) => e.type === "chart");
const shaped = charts.filter(
  (c) =>
    typeof c.chartType === "string" &&
    c.chartType.length > 0 &&
    (Array.isArray(c.data) ? c.data.length > 0 : Boolean(c.data && c.data.nodes && c.data.edges)),
);

console.log("\n==== 结果 ====");
console.log(`BI 取数调用：${biCalls.length} 次${biCalls.length ? `（${biCalls.map((c) => c.name).join(", ")}）` : ""}`);
console.log(`render_chart 调用：${chartCalls.length} 次；成功：${chartResults.filter((r) => r.ok).length}`);
console.log(`chart 事件：${charts.length} 个；结构合法：${shaped.length} 个`);
for (const c of charts) {
  const rows = Array.isArray(c.data) ? `${c.data.length} 行` : "图形结构";
  console.log(`  → ${c.chartType} | ${c.title || "(无标题)"} | ${rows} | encode=${JSON.stringify(c.encode || {})}`);
}

// 断言：取数（真实数据）→ render_chart 成功 → 下发结构合法的 chart 事件。三者缺一不算通过。
const pass = biCalls.length > 0 && chartResults.some((r) => r.ok) && shaped.length > 0;
console.log(pass ? "\nE2E PASS" : "\nE2E FAIL");
process.exitCode = pass ? 0 : 1;
