// 冒烟：对话级设置 / 上下文 / 设备偏好的新契约（第 1 步）。
// 跑法：node scripts/_thread-check.mjs [base]
const BASE = process.argv[2] || process.env.AGENT_BASE_URL || "http://localhost:8787";
let cookie = "";

async function call(path, opts = {}) {
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

console.log(`base=${BASE}`);

// 1) 设备级偏好
const prefs0 = await call("/chat/preferences");
check("GET /chat/preferences 200", prefs0.status === 200, JSON.stringify(prefs0.data));
const put = await call("/chat/preferences", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ theme: "dark", locale: "en" }),
});
check("PUT 偏好写入主题/语言", put.status === 200 && put.data.theme === "dark" && put.data.locale === "en", JSON.stringify(put.data));
const prefs1 = await call("/chat/preferences");
check("偏好可回读", prefs1.data.theme === "dark" && prefs1.data.locale === "en", JSON.stringify(prefs1.data));

// 2) 对话级设置
const id = `conv_step1_${Date.now()}`;
const created = await call("/chat/conversations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id, title: "step1" }),
});
check("创建对话", created.status === 200, JSON.stringify(created.data));

const patched = await call(`/chat/conversations/${id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "qwen35flash", mcpServers: ["bi"], locale: "en" }),
});
const doc = patched.data?.conversation;
check("PATCH 设置按对话写入", patched.status === 200 && doc?.model === "qwen35flash" && doc?.locale === "en" && doc?.mcpServers?.[0] === "bi", JSON.stringify(doc));

const got = await call(`/chat/conversations/${id}`);
check("GET :id 取回全量", got.status === 200 && got.data?.conversation?.model === "qwen35flash", JSON.stringify(got.data)?.slice(0, 200));

const listRes = await call("/chat/conversations");
const inList = (listRes.data?.conversations || []).find((x) => x.id === id);
check("列表包含该对话", Boolean(inList));
check("列表不含 context（体积控制）", inList !== undefined && inList.context === undefined, JSON.stringify(Object.keys(inList || {})));

const missing = await call("/chat/conversations/not-exist-xxx");
check("GET 不存在 → 404", missing.status === 404, String(missing.status));
const patchMissing = await call("/chat/conversations/not-exist-xxx", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ locale: "zh" }),
});
check("PATCH 不存在 → 404", patchMissing.status === 404, String(patchMissing.status));

// 3) 上下文清空
const clearCtx = await call(`/chat/conversations/${id}/context/clear`, { method: "POST" });
check("清空上下文 200", clearCtx.status === 200 && clearCtx.data?.ok === true, JSON.stringify(clearCtx.data));

// 清理：删掉测试对话
const del = await call(`/chat/conversations/${id}`, { method: "DELETE" });
check("删除测试对话", del.status === 200, String(del.status));

// 4) MCP 启用集按对话独立（不再挂在 cookie 会话上）
const ctype = { "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convA = `conv_mcp_a_${Date.now()}`;
const convB = `conv_mcp_b_${Date.now()}`;
await call("/chat/conversations", { method: "POST", headers: ctype, body: JSON.stringify({ id: convA, title: "A" }) });
await call("/chat/conversations", { method: "POST", headers: ctype, body: JSON.stringify({ id: convB, title: "B" }) });

const putA = await call("/chat/mcp/servers", {
  method: "PUT",
  headers: ctype,
  body: JSON.stringify({ conversationId: convA, enabled: ["bi"] }),
});
check("A 对话启用 bi", putA.data?.enabled?.includes("bi") === true, JSON.stringify(putA.data?.enabled));

const getA = await call(`/chat/mcp/servers?conversationId=${convA}`);
check("A 读回 enabled=[bi]", getA.data?.enabled?.includes("bi") === true, JSON.stringify(getA.data?.enabled));
const getB = await call(`/chat/mcp/servers?conversationId=${convB}`);
check("B 的启用集独立（空）", Array.isArray(getB.data?.enabled) && getB.data.enabled.length === 0, JSON.stringify(getB.data?.enabled));

const docA = await call(`/chat/conversations/${convA}`);
check("启用集已落对话文档", docA.data?.conversation?.mcpServers?.[0] === "bi", JSON.stringify(docA.data?.conversation?.mcpServers));

await sleep(2500);
const statusA = await call("/chat/mcp/servers");
check("有对话在用 → 连接保持", (statusA.data?.available || []).some((x) => x.id === "bi" && x.connected), JSON.stringify(statusA.data?.available));

// 清理测试对话（不改变其它对话的启用集）
await call(`/chat/conversations/${convA}`, { method: "DELETE" });
await call(`/chat/conversations/${convB}`, { method: "DELETE" });

// 5) 对话级并发保护：同对话 409（前端据此排队），跨对话真并行
const convP = `conv_par_p_${Date.now()}`;
const convQ = `conv_par_q_${Date.now()}`;
for (const cid of [convP, convQ]) {
  await call("/chat/conversations", { method: "POST", headers: ctype, body: JSON.stringify({ id: cid, title: cid }) });
}
const streamInit = (cid, text) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify({ conversationId: cid, text }),
});

const r1 = await fetch(`${BASE}/chat/stream`, streamInit(convP, "只回答一个字：甲"));
await sleep(700);
const r2 = await fetch(`${BASE}/chat/stream`, streamInit(convP, "只回答一个字：乙"));
check("同对话并发 → 409", r2.status === 409, String(r2.status));
const busyBody = await r2.json().catch(() => null);
check("409 带 CONVERSATION_BUSY", busyBody?.code === "CONVERSATION_BUSY", JSON.stringify(busyBody)?.slice(0, 120));
await r1.body?.cancel().catch(() => undefined);
await sleep(2000);

const p1 = await fetch(`${BASE}/chat/stream`, streamInit(convP, "只回答一个字：丙"));
const p2 = await fetch(`${BASE}/chat/stream`, streamInit(convQ, "只回答一个字：丁"));
check("跨对话并行：P 起流 200", p1.status === 200, String(p1.status));
check("跨对话并行：Q 起流 200", p2.status === 200, String(p2.status));
await p1.body?.cancel().catch(() => undefined);
await p2.body?.cancel().catch(() => undefined);
await sleep(1200);

const listAfter = await call("/chat/conversations");
const pDoc = (listAfter.data?.conversations || []).find((x) => x.id === convP);
check("对话列表带 running 字段", pDoc !== undefined && "running" in pDoc, JSON.stringify(Object.keys(pDoc || {})));

await call(`/chat/conversations/${convP}`, { method: "DELETE" });
await call(`/chat/conversations/${convQ}`, { method: "DELETE" });

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
if (fail) process.exit(1);
