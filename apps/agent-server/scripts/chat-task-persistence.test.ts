import { buildStoredAssistantMessageFromEvents } from "../src/chat-task-persistence.ts";

const results: Array<{ name: string; ok: boolean }> = [];

function assert(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} | [task-persist] ${name}`);
}

const rich = buildStoredAssistantMessageFromEvents([
  { type: "reasoning", text: "step 1" },
  { type: "tool_result", name: "call_api", result: "{\"ok\":true}" },
  { type: "text", text: "final answer" },
  { type: "error", error: { code: "CHAT_TASK_FAILED" }, message: "task failed" },
]);

assert(
  "会从事件重建 reasoning/toolResults/errorToken",
  rich?.reasoning === "step 1\n" &&
    rich.toolResults?.[0]?.name === "call_api" &&
    rich.errorToken?.code === "CHAT_TASK_FAILED" &&
    rich.error === "task failed",
);

const toolOnly = buildStoredAssistantMessageFromEvents([
  { type: "tool_result", name: "search_knowledge_base", result: "{\"items\":[]}" },
]);
assert(
  "没有最终文本时仍会保留结构化工具结果",
  toolOnly?.role === "assistant" &&
    toolOnly.text === "" &&
    toolOnly.toolResults?.length === 1,
);

const empty = buildStoredAssistantMessageFromEvents([{ type: "done" }]);
assert("空事件不会产生空助手消息", empty === null);

const failed = results.filter((item) => !item.ok);
console.log(`\nchat-task-persistence: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
