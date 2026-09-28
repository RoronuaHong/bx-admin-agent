// 会话创建 / 读取的契约回归测试：锁住两个极易被改坏的语义。
// ① 新建会话必须落一个空消息数组：此前 upsert 未把 messages 写进 $setOnInsert，
//    落库后根本没有该字段，违反 ConversationDoc 契约，全靠前端 `|| []` 兜着。
// ② 幂等 create（同一 id 再建，如定时任务建专属对话 / ensureConversation 复用）
//    必须保留既有历史——这是刻意保留的语义，不能"顺手改成重开"。
import { test, expect } from "vitest";
import { createConversation, getConversation, upsertMessages, deleteConversation } from "../src/conversations.js";

/** 唯一 id：Mongo 在线时文档会真实落库，避免与其它用例 / 真实对话互相干扰。 */
const uniq = (tag: string) => `conv_test_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

test("①新建会话：messages 必须是空数组，不能是 undefined", async () => {
  const id = uniq("fresh");
  await createConversation({ id, title: "新对话" });
  const doc = await getConversation(id);
  expect(doc).toBeTruthy();
  expect(Array.isArray(doc!.messages)).toBe(true);
  expect(doc!.messages).toEqual([]);
  await deleteConversation(id);
});

test("②幂等 create：同 id 重建保留既有消息，且不重置历史", async () => {
  const id = uniq("idempotent");
  await createConversation({ id, title: "新对话" });
  await upsertMessages({ id, messages: [{ role: "user", text: "hi" }] });
  expect((await getConversation(id))!.messages).toHaveLength(1);

  // 复用同一 id 再建（定时任务 / ensure 场景）：标题更新，但历史不能丢
  await createConversation({ id, title: "复用后的标题" });
  const after = await getConversation(id);
  expect(after!.messages).toHaveLength(1);
  expect(after!.messages[0]).toMatchObject({ role: "user", text: "hi" });
  expect(after!.title).toBe("复用后的标题");
  await deleteConversation(id);
});

test("③getConversation：不存在的 id 返回 null（不抛错、不返回空壳）", async () => {
  expect(await getConversation(uniq("missing"))).toBeNull();
});
