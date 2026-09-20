// 观影角色「非数据轮次话术」门禁（补 G7 管不到的那半边）。
//
// 为什么单独一条门禁：`_movie-grounding-gate.mjs`（G7）只覆盖**事实型**夹具（必须取数、不得走兜底），
// 而「问候 / 明显超范围提问」这类**不需要数据**的轮次恰恰是接地护栏最容易误伤的路径——历史上它们被回成
// 「抱歉，本次没有取得任何数据源返回的数据…请在对话设置里确认数据源已连接」，既与事实不符也泄漏内部机制。
// 本门禁因此断言：这类轮次不许出现观影工具调用，且正文不许出现「数据源 / 已连接 / 无法访问数据」话术；
// 同时回归事实型提问仍必须真取数（防「为了避免兜底而干脆不调工具」的矫枉过正）。
//
// 中文提问写在文件里（PowerShell 直接传中文参数会乱码）。
// 运行（需先起服务端）：node scripts/_movie-e2e-cases.mjs
//   MOVIE_E2E_BASE  目标实例（默认 http://127.0.0.1:8787）；MOVIE_E2E_MODEL 指定模型 id（可选）
// 退出码：全绿 0，任一红 1。提问属测试夹具数据（不是服务端业务逻辑），不涉及「禁止写死业务词」红线。
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
const cookie = "bx_agent_oid=bx_movie_cases";
const MODEL = process.env.MOVIE_E2E_MODEL || "";

// 夹具：①修复点（闲聊 / 超范围，都不该调工具、更不该被回成「数据源未连接」）②回归（事实型必须取数）。
const CASES = [
  { prompt: "你好，今天珠海天气如何？", expect: "no-tool" },
  { prompt: "你好，你是谁？", expect: "no-tool" },
  { prompt: "《盗梦空间》是哪一年上映的？导演是谁？", expect: "movie-tool" },
  { prompt: "帮我推荐一部高分科幻片，并说明推荐理由。", expect: "movie-tool" },
];

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function runPrompt(conversationId, text) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ conversationId, agentId: "movie", text, ...(MODEL ? { model: MODEL } : {}) }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out = { toolCalls: [], text: "", usage: null, started: Date.now() };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "tool_call") out.toolCalls.push(ev.name);
      else if (ev.type === "text") out.text = ev.text;
      else if (ev.type === "text_delta") out.text += ev.text;
      else if (ev.type === "usage") out.usage = ev;
    }
  }
  out.ms = Date.now() - out.started;
  return out;
}

let failed = 0;
for (const [i, item] of CASES.entries()) {
  const conv = await post("/chat/conversations", { agentId: "movie", title: `cases-${i + 1}` });
  const id = conv.body?.conversation?.id;
  if (!id) {
    console.error(`建对话失败：HTTP ${conv.status}`);
    process.exit(2);
  }
  const run = await runPrompt(id, item.prompt);
  const usage = run.usage || {};
  const movieCalls = run.toolCalls.filter((n) => n.includes("movie"));
  const answer = run.text.trim();
  // 判定：
  //  - 期望「不调工具」的轮次：不许出现观影工具调用；回复里不许出现「数据源」类内部机制话术（本次修复的回归点）。
  //    这类轮次走接地兜底（ungrounded=true）是预期行为：该端点模型不会为零数据轮次调工具。
  //  - 期望「调工具」的轮次：必须真的取到数，且未走兜底。
  const noMechanismLeak = !/数据源|已连接|无法访问数据/.test(answer);
  const ok =
    item.expect === "no-tool"
      ? movieCalls.length === 0 && noMechanismLeak
      : movieCalls.length > 0 && usage.ungrounded !== true;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  [${i + 1}/${CASES.length}] ${item.prompt}  （期望：${item.expect}）`);
  console.log(
    `      工具调用 ${run.toolCalls.length} 次${movieCalls.length ? `（观影 ${movieCalls.length}）` : ""}｜` +
      `rounds=${usage.rounds ?? "-"}｜groundingRetries=${usage.groundingRetries ?? 0}｜` +
      `ungrounded=${usage.ungrounded === true}｜${(run.ms / 1000).toFixed(1)}s`,
  );
  console.log(`      回复：${answer.replace(/\n+/g, " ").slice(0, 300) || "（空）"}\n`);
}

console.log(`=== movie cases ${failed === 0 ? "ALL PASS" : `FAIL ${failed}/${CASES.length}`} ===`);
process.exit(failed === 0 ? 0 : 1);
