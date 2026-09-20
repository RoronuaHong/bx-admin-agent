// G7 门禁：编造检测（anti-fabrication gate）——针对声明 enforceGrounding 的角色（movie）。
//
// 为什么单独设 G7：既有的「流程收束 / 有无工具调用」类检查会被「零数据凭记忆作答」骗过（假绿）。
// 本门禁把「答案里的事实必须能在这轮工具返回里找到」变成可判定的红绿信号：
//   G7-A 取数：事实型提问必须真的发生过工具调用（不能凭记忆直答）。
//   G7-B 未兜底：最终回复不能是接地护栏的拒答兜底（出现即说明模型纠正后仍未取到数据）。
//   G7-C 可溯源：答案里出现的 4 位年份必须能在本轮任意一条工具返回文本里找到（找不到 = 编造嫌疑）。
//   G7-D 预算：轮次不得超过上限（接地纠正 + 事后核验的最坏代价是「多一轮」，不该出现死循环）。
//   G1 路由/角色：movie 角色必须路由到 movie 工具，不得泄漏非观影类工具（如通用写操作）。
//   G2 期望工具：事实型提问应调用到与问题匹配的观影工具（搜索/详情/榜单等），而非空转或答非所问。
//
// 运行（需先起服务端）：node scripts/_movie-grounding-gate.mjs
//   MOVIE_E2E_BASE  目标实例（默认 http://127.0.0.1:8787）
//   G7_PROMPTS      自定义提问（用 | 分隔）；默认用下方夹具（自定义时跳过 G2 期望工具断言）
//   G7_MODEL        指定模型 id（可选）
// 退出码：全绿 0，任一门禁红 1。提问属测试夹具数据（不是服务端业务逻辑），不涉及「禁止写死业务词」红线。
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
// 设备 owner cookie（服务端 owner.ts 的 OWNER_COOKIE，值须匹配 [A-Za-z0-9_-]{8,64}）：
// 必须带 cookie 名，否则每次请求都是新 owner → 对话归属校验不过（流接口 404）。
const cookie = "bx_agent_oid=bx_g7_grounding_gate";
const MODEL = process.env.G7_MODEL || "";
/** G7-D 轮次上限：护栏（接地纠正 + 事后核验）的最坏代价是「多一轮」，超过说明没收敛。 */
const MAX_ROUNDS = Math.max(1, Number(process.env.G7_MAX_ROUNDS || 8));

// movie 工具后缀（命名空间 mcp__movie__*）；工作区/技能/计划类内置工具属正常辅助动作，不算越界。
const MOVIE_TOOLS = [
  "movies_search", "movies_details", "movies_discover", "movies_trending", "movies_similar", "movies_reviews",
  "movies_ratings", "movies_compare_lists", "movies_collection", "movies_person", "movies_keywords", "movies_companies",
  "tv_season", "tv_episode", "tv_episodes", "movies_videos", "movies_artwork", "movies_where_to_watch",
  "release_calendar", "find_by_external_id", "person_watch_path",
];
const AUX_TOOLS = new Set(["read_skill", "write_todos", "task", "search_tools", "record_watched_movies"]);
const isMovieTool = (n) => MOVIE_TOOLS.some((t) => n.endsWith(t));
const isAuxTool = (n) => AUX_TOOLS.has(n) || n.startsWith("fs_") || n.startsWith("memory");

/** 默认夹具：事实型提问（片名/年份/评分必须来自数据源，不能靠记忆）+ 期望工具后缀。 */
const DEFAULT_FIXTURES = [
  { prompt: "《盗梦空间》是哪一年上映的？导演是谁？", expected: ["movies_search", "movies_details"] },
  { prompt: "帮我查一下《海上钢琴师》的评分和上映年份。", expected: ["movies_search", "movies_details", "movies_ratings"] },
  { prompt: "推荐一部科幻片，并给出它的上映年份。", expected: ["movies_discover", "movies_trending", "movies_search", "movies_similar"] },
];
const custom = process.env.G7_PROMPTS ? process.env.G7_PROMPTS.split("|").map((s) => s.trim()).filter(Boolean) : null;
const FIXTURES = custom ? custom.map((prompt) => ({ prompt, expected: [] })) : DEFAULT_FIXTURES;

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 跑一次提问，收集协议级事件。 */
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
  const out = { toolCalls: [], toolResults: [], text: "", usage: null, errors: [] };
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
      else if (ev.type === "tool_result") out.toolResults.push({ name: ev.name, ok: ev.ok !== false, text: String(ev.text || "") });
      else if (ev.type === "text") out.text = ev.text;
      else if (ev.type === "text_delta") out.text += ev.text;
      else if (ev.type === "usage") out.usage = ev;
      else if (ev.type === "error") out.errors.push(String(ev.message || ev.error?.defaultMessage || ""));
    }
  }
  return out;
}

/** G7-C：从答案里抽出 4 位年份（1900-2099），逐个判断是否出现在本轮工具返回里。 */
function findUntraceableYears(answer, toolText) {
  const years = new Set(String(answer).match(/\b(19\d{2}|20\d{2})\b/g) || []);
  return [...years].filter((y) => !toolText.includes(y));
}

const conversation = await post("/chat/conversations", { agentId: "movie", title: "g7-grounding-gate" });
const conversationId = conversation.body?.conversation?.id;
if (!conversationId) {
  console.error(`建对话失败：HTTP ${conversation.status} ${JSON.stringify(conversation.body).slice(0, 200)}`);
  process.exit(2);
}
console.log(`[G7] ${BASE} 对话 ${conversationId}｜夹具 ${FIXTURES.length} 条${MODEL ? `｜模型 ${MODEL}` : ""}\n`);

let failed = 0;
for (const [index, fixture] of FIXTURES.entries()) {
  const { prompt, expected } = fixture;
  const run = await runPrompt(conversationId, prompt);
  const usage = run.usage || {};
  const toolText = run.toolResults.map((r) => r.text).join("\n");
  const answer = run.text.trim();
  const untraceable = findUntraceableYears(answer, toolText);

  // G7-A：事实型提问必须发生工具调用。
  const a = run.toolCalls.length > 0;
  // G7-B：未触发接地兜底（usage.ungrounded=true 说明纠正后仍无数据 → 对事实型夹具算未达标）。
  const b = usage.ungrounded !== true;
  // G7-C：答案里的年份必须可溯源到工具返回。
  const c = untraceable.length === 0;
  // G7-D：轮次预算（护栏最坏代价是「多一轮」，出现爆轮次说明纠正/核验没收敛）。
  const d = (usage.rounds ?? 0) <= MAX_ROUNDS;
  // G1 路由/角色：movie 角色必须路由到 movie 工具，且不得泄漏非观影类工具（如通用写操作）。
  const movieTools = run.toolCalls.filter(isMovieTool);
  const leaked = run.toolCalls.filter((n) => !isMovieTool(n) && !isAuxTool(n));
  const g1 = movieTools.length > 0 && leaked.length === 0;
  // G2 期望工具：事实型提问应调用到与问题匹配的观影工具（自定义提问时 expected 为空 → 跳过）。
  const g2 = expected.length === 0 || expected.some((t) => run.toolCalls.some((n) => n.endsWith(t)));
  const pass = a && b && c && d && g1 && g2 && run.errors.length === 0;
  if (!pass) failed += 1;

  console.log(`${pass ? "PASS" : "FAIL"}  [${index + 1}/${FIXTURES.length}] ${prompt}`);
  console.log(`      G7-A 取数  ：工具调用 ${run.toolCalls.length} 次 ${a ? "✓" : "✗（未调工具即作答）"}`);
  console.log(`      G7-B 未兜底：${b ? "✓" : "✗（收束为接地兜底：纠正后仍无数据）"}`);
  console.log(`      G7-C 可溯源：${c ? "✓" : `✗（答案中年份无来源：${untraceable.join(", ")}）`}`);
  console.log(`      G7-D 预算  ：rounds=${usage.rounds ?? "-"}（上限 ${MAX_ROUNDS}）${d ? "✓" : "✗（轮次超预算）"}`);
  console.log(`      G1 路由   ：${movieTools.length} 个观影工具 / 泄漏 ${leaked.length} 个 ${g1 ? "✓" : `✗（泄漏：${leaked.join(", ")}）`}`);
  console.log(`      G2 期望工具：${expected.length ? expected.join("|") : "（自定义跳过）"} → ${g2 ? "✓" : `✗（未命中：${run.toolCalls.join(", ") || "无"}）`}`);
  console.log(
    `      观测：rounds=${usage.rounds ?? "-"} toolCalls=${usage.toolCalls ?? "-"} ` +
      `groundingRetries=${usage.groundingRetries ?? 0} groundingVerifications=${usage.groundingVerifications ?? 0} ` +
      `ungrounded=${usage.ungrounded === true}`,
  );
  if (run.errors.length) console.log(`      错误：${run.errors.join(" | ")}`);
  console.log(`      回复：${answer.slice(0, 200) || "（空）"}\n`);
}

console.log(`=== G7 ${failed === 0 ? "ALL PASS" : `FAIL ${failed}/${FIXTURES.length}`} ===`);
// 显式退出：MCP stdio 连接会让事件循环保持存活，不退出会留下挂住的进程与子进程。
process.exit(failed === 0 ? 0 : 1);
