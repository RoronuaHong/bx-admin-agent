// 定时任务结果投递端到端验证（真跑：建通道 → 测试发送 → 一次性任务到点执行 → 结果推送到本地假机器人）。
//
// 前置：服务端进程需带 NOTIFY_ALLOWED_HOSTS=127.0.0.1（出站白名单默认只放行钉钉/飞书域名，
// 本地假机器人必须显式加白），且已配置可用模型（任务会真的跑一轮对话）。
// 运行：node scripts/_notify-schedule-e2e.mjs
const BASE = process.env.AGENT_BASE_URL || "http://localhost:8787";
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT || 8899);
const jar = new Map();
/** 假机器人收到的原始载荷。 */
const received = [];

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function captureCookies(res) {
  for (const line of res.headers.getSetCookie?.() || []) {
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
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** 本地假机器人：按钉钉/飞书的成功响应形状回包。 */
async function startHook() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        received.push({ url: req.url, payload: JSON.parse(body || "{}") });
      } catch {
        received.push({ url: req.url, payload: { raw: body } });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    });
  });
  await new Promise((resolve) => server.listen(HOOK_PORT, "127.0.0.1", resolve));
  return server;
}

const hook = await startHook();
const createdChannelIds = [];
const createdScheduleIds = [];
let conversationId = "";
try {
  // 1) 建一个对话（任务必须绑定对话：结果回投到这里）
  const conv = await api("/chat/conversations", { method: "POST", body: JSON.stringify({ title: "notify-e2e" }) });
  conversationId = conv.data?.conversation?.id || "";
  check("建对话", Boolean(conversationId), conversationId);

  // 2) 建通道（被白名单拦下是预期失败：这一步同时验证 SSRF 闸门）
  const blocked = await api("/notify/channels", {
    method: "POST",
    body: JSON.stringify({ kind: "dingtalk", label: "blocked", webhook: "https://example.com/hook" }),
  });
  check("非白名单域名被拒", blocked.status === 400, `status=${blocked.status}`);

  const created = await api("/notify/channels", {
    method: "POST",
    body: JSON.stringify({ kind: "dingtalk", label: "e2e-dingtalk", webhook: `http://127.0.0.1:${HOOK_PORT}/hook`, keyword: "bx-agent" }),
  });
  const channelId = created.data?.channel?.id || "";
  if (channelId) createdChannelIds.push(channelId);
  check("建通道（本地假机器人）", created.status === 200 && Boolean(channelId), JSON.stringify(created.data).slice(0, 160));

  // 3) 凭据不外泄：GET 只回域名与 hasSecret
  const list = await api("/notify/channels");
  const publicChannel = (list.data?.channels || []).find((c) => c.id === channelId);
  check(
    "凭据不外泄（只回域名）",
    Boolean(publicChannel) && publicChannel.host === "127.0.0.1" && publicChannel.webhook === undefined,
    JSON.stringify(publicChannel),
  );

  // 4) 测试发送
  const tested = await api(`/notify/channels/${channelId}/test`, { method: "POST" });
  check("测试发送成功", tested.status === 200 && tested.data?.ok === true, JSON.stringify(tested.data).slice(0, 160));
  const testPayload = received.at(-1)?.payload;
  check("假机器人收到测试消息（markdown + 关键词）", testPayload?.msgtype === "markdown" && String(testPayload?.markdown?.text || "").includes("bx-agent"));

  // 5) 一次性任务：3 秒后到点，结果推送到该通道
  const created2 = await api("/chat/schedules", {
    method: "POST",
    body: JSON.stringify({
      conversationId,
      name: "notify-e2e-task",
      prompt: "只回复两个字：收到",
      onceAt: Date.now() + 3000,
      notifyChannelIds: [channelId],
      notifyOn: ["success", "failed"],
      locale: "zh",
    }),
  });
  const scheduleId = created2.data?.schedule?.id || "";
  if (scheduleId) createdScheduleIds.push(scheduleId);
  check("建一次性任务", created2.status === 200 && Boolean(scheduleId), JSON.stringify(created2.data).slice(0, 200));
  check("一次性任务已排期（onceAt + enabled）", created2.data?.schedule?.onceAt > 0 && created2.data?.schedule?.enabled === true);

  // 6) 等调度器 tick（30s 周期）+ 一轮对话跑完
  const before = received.length;
  const deadline = Date.now() + 150_000;
  let schedule = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const got = await api("/chat/schedules");
    schedule = (got.data?.schedules || []).find((s) => s.id === scheduleId) || null;
    if (schedule?.lastStatus) break;
  }
  check("任务已执行（lastStatus 落库）", Boolean(schedule?.lastStatus), `lastStatus=${schedule?.lastStatus} lastNote=${schedule?.lastNote || ""}`);
  check("一次性任务跑完自动停用", schedule?.enabled === false);

  // 投递是 fire-and-forget：再等一小会儿让请求落地
  const deliverDeadline = Date.now() + 20_000;
  while (received.length === before && Date.now() < deliverDeadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  const delivered = received.at(-1)?.payload;
  check("假机器人收到任务结果", received.length > before, `payloads=${received.length - before}`);
  // 带「打开对话」按钮时走 actionCard（正文在 actionCard.text），无按钮才走 markdown。
  const deliveredText = String(delivered?.markdown?.text || delivered?.actionCard?.text || "");
  check(
    "结果消息含任务名与状态",
    deliveredText.includes("notify-e2e-task") && /状态：(成功|失败)/.test(deliveredText),
    `${delivered?.msgtype}: ${deliveredText.slice(0, 140).replace(/\n/g, " ")}`,
  );
  check(
    "结果消息带「打开对话」按钮（?conv=<对话 id>）",
    delivered?.msgtype === "actionCard" &&
      String(delivered?.actionCard?.btns?.[0]?.actionURL || "").includes(`conv=${conversationId}`),
    JSON.stringify(delivered?.actionCard?.btns || []).slice(0, 160),
  );

  const after = await api("/chat/schedules");
  const finalSchedule = (after.data?.schedules || []).find((s) => s.id === scheduleId);
  check("投递结果已回写 lastDelivery", Boolean(finalSchedule?.lastDelivery), JSON.stringify(finalSchedule?.lastDelivery));
} catch (err) {
  check("脚本执行", false, String(err?.stack || err).slice(0, 400));
} finally {
  for (const id of createdScheduleIds) await api(`/chat/schedules/${id}`, { method: "DELETE" }).catch(() => undefined);
  for (const id of createdChannelIds) await api(`/notify/channels/${id}`, { method: "DELETE" }).catch(() => undefined);
  if (conversationId) await api(`/chat/conversations/${conversationId}`, { method: "DELETE" }).catch(() => undefined);
  hook.close();
}

console.log(failures ? `\n=== 结果投递 e2e FAIL（${failures} 项）===` : "\n=== 结果投递 e2e 全部 PASS ===");
process.exit(failures ? 1 : 0);
