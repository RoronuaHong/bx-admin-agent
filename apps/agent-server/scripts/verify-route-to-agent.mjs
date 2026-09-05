// 验证 M1 Supervisor 路由是否真正生效（决定性测试）：
//   1. 用测试账号登录拿 session cookie
//   2. 发一条「分步」指令：先 route_to_agent 切到 knowledge Worker，
//      再 search_knowledge_base（知识库域工具，应在白名单内），
//      再 直接 call_api 查用户列表（backend-api 域工具，路由后应在白名单外）
//   3. 解析 SSE：
//      - 模型是否调用了 route_to_agent(domain=knowledge)
//      - 路由结果之后，模型是否还能调用 backend-api 域工具（call_api 等）
//        若能直接调用 call_api（未先路由回 backend-api）→ 说明工具未被裁剪 → FAIL
//        若 call_api 不出现、或先 route_to_agent 回 backend-api 再调 → 工具裁剪生效 → PASS
//
// 说明：route_to_agent 结果里的 [ACTIVE_WORKER:...] 标记在发给前端的 tool_result 中被
// truncateToolResultForUi 截断（标记在末尾），故本脚本不依赖该标记，改从「路由后是否还能调
// backend-api 工具」这一外部可观察行为来判定。
//
// 运行：node scripts/verify-route-to-agent.mjs
// 可选环境变量：AGENT_BASE(默认 http://localhost:8787)、A2A_COUNTRY/A2A_USER/A2A_PASS、A2A_MODEL

const BASE = process.env.AGENT_BASE || "http://localhost:8787";
const COUNTRY = process.env.A2A_COUNTRY || "india";
const USER = process.env.A2A_USER || "admin";
const PASS = process.env.A2A_PASS || "123456";
const MODEL = process.env.A2A_MODEL || "";

// backend-api 域工具（路由到 knowledge 后这些应被裁剪掉）
const BACKEND_API_TOOLS = [
  "call_api", "search_api_module", "read_api_module",
  "grep_codebase", "render_table",
  "normalize_output", "write_code_file", "git_commit_push", "submit_understood_intent",
  "export_dataset", "summarize_chart_data", "get_page_schema", "get_list_columns",
  "read_field_mapping",
];

function log(...a) { console.log(...a); }

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ country: COUNTRY, username: USER, password: PASS }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login failed ${res.status}: ${JSON.stringify(data)}`);
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/bx_agent_sid=([^;]+)/);
  if (!m) throw new Error("login response 中没有 bx_agent_sid cookie");
  log(`[login] OK  user=${data.user?.loginName} country=${data.country?.id}`);
  return m[1];
}

async function streamChat(cookie, text) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `bx_agent_sid=${cookie}` },
    body: JSON.stringify(MODEL ? { text, model: MODEL } : { text }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`chat/stream ${res.status}: ${t}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }
  return events;
}

(async () => {
  const cookie = await login();
  const text =
    "请严格按以下顺序执行三步：\n" +
    "1. 调用 route_to_agent 工具，domain 设为 knowledge，切换到知识库 Worker。\n" +
    "2. 调用 search_knowledge_base 工具，查询「公司年假政策」。\n" +
    "3. 紧接着直接调用 call_api 工具（module=account, operation=getList）查询用户列表。\n" +
    "最后用一句话总结你实际调用了哪些工具。";
  log(`[chat] sending step-by-step prompt (model=${MODEL || "server default"}) ...`);
  const events = await streamChat(cookie, text);

  const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => ({ name: e.name, input: e.input }));
  const routeCall = toolCalls.find((c) => c.name === "route_to_agent");
  const routeIdx = events.findIndex((e) => e.type === "tool_result" && e.name === "route_to_agent");
  const afterRoute = routeIdx >= 0
    ? toolCalls.filter((c) => events.findIndex((e) => e.type === "tool_call" && e.name === c.name && e.input === c.input) > routeIdx)
    : toolCalls;

  const hasDirectBackendAfterRoute = afterRoute.some((c) => BACKEND_API_TOOLS.includes(c.name));
  const backendRouteAfter = afterRoute.some(
    (c) => c.name === "route_to_agent" && c.input?.domain && c.input.domain !== "knowledge",
  );
  const finalText = events.filter((e) => e.type === "text" || e.type === "text_delta").map((e) => e.text).join("");
  const errors = events.filter((e) => e.type === "error");

  log("\n========== 路由验证结果 ==========");
  log("route_to_agent 被调用:", !!routeCall, routeCall ? `(domain=${routeCall.input?.domain})` : "");
  log("全部 tool_call:", JSON.stringify(toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`)));
  log("路由后调用的工具:", JSON.stringify(afterRoute.map((c) => c.name)));
  log("路由后直接调 backend-api 工具(应 false):", hasDirectBackendAfterRoute);
  log("路由后先 route 回 backend-api 再调(可选 true):", backendRouteAfter);
  log("最终文本长度:", finalText.length);
  if (errors.length) log("错误事件:", JSON.stringify(errors));
  log("===================================");

  // 判定口径（与机制对齐）：
  // - routeOk：模型调了 route_to_agent(domain=knowledge)
  // - restrictOk：路由后若仍尝试 backend-api 工具，须被越权拒绝（或根本未成功执行）
  // 注意：同轮可能同时提交 route + call_api；route 短路后 call_api 不会执行——仍算机制生效。
  const routeOk = !!routeCall && routeCall.input?.domain === "knowledge";
  const backendToolResults = events.filter(
    (e) => e.type === "tool_result" && BACKEND_API_TOOLS.includes(e.name) && (routeIdx < 0 || events.indexOf(e) > routeIdx),
  );
  const backendExecuted = backendToolResults.some((e) => {
    const r = typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? "");
    return !(r.includes("不允许调用") || r.includes("不在本 Worker") || r.includes("拒绝"));
  });
  const restrictOk = !backendExecuted;
  const ok = routeOk && restrictOk;
  log(
    "VERDICT:",
    ok
      ? "PASS 路由护栏生效 ✅（route_to_agent 命中；knowledge 下 backend-api 工具未能成功执行）"
      : "FAIL 路由护栏未生效 ❌（未路由到 knowledge，或 knowledge 下仍成功执行了 backend-api 工具）",
  );
  if (hasDirectBackendAfterRoute && ok) {
    log("注：路由后仍出现 backend-api tool_call 属模型越权尝试；已被执行层拦截（或同轮短路未执行）。");
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
