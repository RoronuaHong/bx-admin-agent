import "dotenv/config";
import { ensureSession } from "../src/session.js";
import { connect } from "../src/mcp/hub.js";
import { chatStream } from "../src/chat.js";
import { answerConfirmation } from "../src/confirm.js";
import { patchConversation, resolveConversation } from "../src/conversations.js";

async function main() {
  const session = ensureSession();
  // MCP 启用集与上下文现在按「对话」持久化（不再挂在 session 上）。
  const conversationId = await resolveConversation(session);
  await patchConversation(conversationId, { mcpServers: ["bi"] });
  console.log("session:", session.id, "conversation:", conversationId);

  const conn = await connect("bi");
  console.log("connect bi ->", conn ? conn.error ?? `ok tools=${conn.tools.length}` : "no config");
  if (conn?.error) {
    console.error("BI 连接失败，终止。");
    return;
  }

  const question = "在 BI（Metabase）里帮我找日活（DAU）相关的表，列出可能的表名和关键字段。";
  console.log("\n=== USER ===\n" + question + "\n");

  for await (const ev of chatStream(conversationId, question)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = ev as any;
    switch (e.type) {
      case "model":
        console.log("[model]", e.label);
        break;
      case "tool_call":
        console.log("\n[tool_call]", e.name, "\n  args:", e.args);
        break;
      case "confirmation_required":
        console.log("[confirm_required]", e.name, e.args);
        answerConfirmation(e.id, true); // 测试时自动确认
        break;
      case "confirmation_response":
        console.log("[confirm_response] confirmed=", e.confirmed);
        break;
      case "tool_result":
        console.log("[tool_result]", e.name, "ok=", e.ok, "\n" + String(e.text || "").slice(0, 2000));
        break;
      case "text":
        console.log("\n[ANSWER]\n" + e.text);
        break;
      case "error":
        console.log("[error]", e.message);
        break;
      case "done":
        console.log("\n=== DONE ===");
        break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
