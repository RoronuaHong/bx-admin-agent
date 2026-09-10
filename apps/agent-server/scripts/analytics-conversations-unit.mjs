import {
  createConversation,
  deleteConversation,
  listConversations,
  upsertMessages,
} from "../src/conversations.js";

const ownerKey = "india:test_analytics";
const id = `conv_unit_${Date.now()}`;
await createConversation({
  ownerKey,
  countryId: "india",
  loginName: "test_analytics",
  id,
  title: "t",
  store: "analytics",
});
await upsertMessages({
  ownerKey,
  countryId: "india",
  loginName: "test_analytics",
  id,
  messages: [
    { id: "1", role: "user", text: "hi" },
    { id: "2", role: "assistant", text: "yo", sqls: ["SELECT 1"] },
  ],
  title: "t",
  store: "analytics",
});
const list = await listConversations(ownerKey, "analytics");
const hit = list.find((c) => c.id === id);
const chatLeak = (await listConversations(ownerKey, "chat")).some((c) => c.id === id);
console.log(
  JSON.stringify({
    ok: Boolean(hit),
    n: hit?.messages?.length,
    sql: hit?.messages?.[1]?.sqls?.[0],
    chatLeak,
  }),
);
await deleteConversation(ownerKey, id, "analytics");
if (!hit || hit.messages?.length !== 2 || chatLeak) process.exitCode = 1;
