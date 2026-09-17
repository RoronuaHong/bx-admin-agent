// 冒烟：Deep Agents 能力层（D1 系统提示/skills · D2 文件系统/卸载 · D3 任务规划 · D4 子代理）。
// 跑法：node scripts/_deep-agents-check.mjs [base]
// 说明：走真实模型流（NDJSON），断言事件序列而非文本内容（模型输出不保证逐字一致）。
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

/** 发起一轮流式对话并收集非增量事件。 */
async function streamTurn(conversationId, message) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ conversationId, text: message }),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "text_delta") text += event.text;
        else events.push(event);
      } catch {
        /* 忽略不完整行 */
      }
    }
  }
  return { events, text };
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

// 建一个启用 BI 的对话（工具模式：内置工具随之注入）。
const id = `conv_deepagents_${Date.now()}`;
await call("/chat/conversations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id, title: "deep-agents 冒烟" }),
});
await call("/chat/mcp/servers", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ conversationId: id, enabled: ["bi"] }),
});

// ---- D2：fs_write → fs_read ----
console.log("D2 虚拟文件系统（fs_write → fs_read）");
const fsTurn = await streamTurn(
  id,
  "请先用 fs_write 工具把文本「DEEPAGENTS_SMOKE_v1」保存到 smoke.md，再用 fs_read 工具读回它，最后只回复文件里的那行文本。",
);
const fsCalls = fsTurn.events.filter((e) => e.type === "tool_call").map((e) => e.name);
check("出现 fs_write 调用", fsCalls.includes("fs_write"), JSON.stringify(fsCalls));
check("出现 fs_read 调用", fsCalls.includes("fs_read"), JSON.stringify(fsCalls));
check("fs_write 执行成功", fsTurn.events.some((e) => e.type === "tool_result" && e.name === "fs_write" && e.ok), JSON.stringify(fsTurn.events.filter((e) => e.name === "fs_write")).slice(0, 200));
check("回复含写入内容", fsTurn.text.includes("DEEPAGENTS_SMOKE_v1"), fsTurn.text.slice(0, 120));

// ---- D3：write_todos（计划持久化 + todos 事件）----
console.log("D3 任务规划（write_todos）");
const todoTurn = await streamTurn(
  id,
  "不要回答任何内容，也不要调用 BI 工具。你必须调用一次 write_todos 工具，todos 参数为：[{\"content\":\"查询日活\",\"status\":\"in_progress\"},{\"content\":\"计算环比\",\"status\":\"pending\"},{\"content\":\"输出结论\",\"status\":\"pending\"}]。调用完成后回复「计划已建立」。",
);
const todosEvent = todoTurn.events.find((e) => e.type === "todos");
check("产出 todos 事件", Boolean(todosEvent), JSON.stringify(todoTurn.events.map((e) => e.type)));
check("todos 有 3 条且第 1 条 in_progress", todosEvent?.todos?.length === 3 && todosEvent.todos[0]?.status === "in_progress", JSON.stringify(todosEvent));
const docAfterTodos = await call(`/chat/conversations/${id}`);
check("todos 已持久化", (docAfterTodos.data?.conversation?.todos || []).length === 3, JSON.stringify(docAfterTodos.data?.conversation?.todos));

// ---- D4：task 子代理（独立上下文 + 回传摘要）----
console.log("D4 子代理（task 委派）");
const taskTurn = await streamTurn(
  id,
  "不要自己调用 BI 工具。你必须调用一次 task 工具，description 参数为：「查询 BI 里有哪些数据库，只返回数据库名称列表」。等子代理返回后，把结果告诉我。",
);
const taskCall = taskTurn.events.find((e) => e.type === "tool_call" && e.name === "task");
check("出现 task 调用", Boolean(taskCall), JSON.stringify(taskTurn.events.map((e) => e.type + ":" + (e.name || ""))));
const taskResult = taskTurn.events.find((e) => e.type === "tool_result" && e.name === "task");
check("task 有结果且成功", Boolean(taskResult?.ok), JSON.stringify(taskResult)?.slice(0, 200));

// ---- 清理 ----
await call(`/chat/conversations/${id}`, { method: "DELETE" });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
