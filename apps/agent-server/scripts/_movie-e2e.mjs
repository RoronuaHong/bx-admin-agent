// 观影助手活路径 e2e（真实模型 + movie role）：验证角色分流（观影人设 + movie MCP 默认启用 + 观影 skill）。
// 运行：node --import tsx scripts/_movie-e2e.mjs（跑法见 scripts/run-movie-e2e.ps1）
// 可用 MOVIE_E2E_BASE 指向别的实例（便于在不打扰正在运行的 dev server 的情况下做验证）。
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
const cookie = "bx_agent_oid=moviee2e0001";
// 提问可覆盖（默认跑「推荐一部科幻片」）：MOVIE_E2E_PROMPT='…' 或第一个命令行参数。
// 换数据源/白名单后想验证别的场景（剧集分季、榜单排名等）时不必改脚本。
const PROMPT = process.env.MOVIE_E2E_PROMPT || process.argv[2] || "推荐一部科幻片";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const conv = await post("/chat/conversations", { agentId: "movie", title: "e2e-movie" });
const id = conv.body?.conversation?.id;
if (!id) throw new Error(`建对话失败：${JSON.stringify(conv).slice(0, 200)}`);
console.log(`[movie] 对话 ${id}，默认 MCP：${JSON.stringify(conv.body.conversation.mcpServers)}`);

console.log(`[movie] 提问：${PROMPT}`);
const res = await fetch(`${BASE}/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ conversationId: id, agentId: "movie", text: PROMPT }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const toolCalls = [];
let text = "";
let mcpInject = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n");
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.type === "tool_call") toolCalls.push(ev.name);
    if (ev.type === "text") text = ev.text;
    if (ev.type === "text_delta") text += ev.text;
  }
}
console.log(`工具调用：${toolCalls.join(", ") || "（无）"}`);
console.log(`最终回复：${text.slice(0, 400)}`);
// 事件里的工具名带命名空间（mcp__movie__movies_search），按后缀匹配。
// 数据源为 TMDb（公共托管 MCP）：工具集以 .env 的 movie 白名单为准（当前放行全部 21 个只读工具）。
const MOVIE_TOOLS = [
  "movies_search", "movies_details", "movies_discover", "movies_trending", "movies_similar", "movies_reviews",
  "movies_ratings", "movies_compare_lists", "movies_collection", "movies_person", "movies_keywords", "movies_companies",
  "tv_season", "tv_episode", "tv_episodes", "movies_videos", "movies_artwork", "movies_where_to_watch",
  "release_calendar", "find_by_external_id", "person_watch_path",
];
// 工作区 / 技能 / 计划类内置工具属于正常辅助动作（如 fs_ls 读观影偏好、read_skill 载入技能），不算越界。
const WORKSPACE_TOOLS = new Set(["read_skill", "write_todos", "task", "search_tools", "record_watched_movies"]);
const isMovieTool = (n) => MOVIE_TOOLS.some((t) => n.endsWith(t));
const isAuxTool = (n) => WORKSPACE_TOOLS.has(n) || n.startsWith("fs_") || n.startsWith("memory");
const ok = toolCalls.some(isMovieTool) && toolCalls.every((n) => isMovieTool(n) || isAuxTool(n));
console.log(`\n=== movie ${ok ? "PASS" : "FAIL"} ===`);
// 显式退出：MCP stdio 连接会让事件循环保持存活，不退出会留下挂住的进程与子进程。
process.exit(ok ? 0 : 1);
