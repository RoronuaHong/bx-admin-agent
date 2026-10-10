// 会话创建 / 读取的契约回归测试：锁住两个极易被改坏的语义。
// ① 新建会话必须落一个空消息数组：此前 upsert 未把 messages 写进 $setOnInsert，
//    落库后根本没有该字段，违反 ConversationDoc 契约，全靠前端 `|| []` 兜着。
// ② 幂等 create（同一 id 再建，如定时任务建专属对话 / ensureConversation 复用）
//    必须保留既有历史——这是刻意保留的语义，不能"顺手改成重开"。
import { test, expect } from "vitest";
import {
  createConversation,
  getConversation,
  appendUserTurnIfMissing,
  upsertMessages,
  deleteConversation,
  compactSnapshot,
  listSnapshot,
  SNAPSHOT_DETAIL_TAIL,
} from "../src/conversations.js";
import { getRole } from "../src/roles.js";

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

// 增量落库（2026-10-09 修复）：对话变长后 persist 不再全量回写整段历史，
// 只回写「自 base 起的新增 / 最后一条变更」，避免大请求体触发代理重置与体积守卫。
test("④增量 append：base===当前长度时把 tail 追加到末尾", async () => {
  const id = uniq("delta-append");
  await createConversation({ id, title: "d" });
  await upsertMessages({ id, messages: [{ role: "user", text: "u1" }, { role: "assistant", text: "a1" }] });
  // 客户端已落库 2 条，新增第 3 条：只回写 tail
  await upsertMessages({ id, messages: [{ role: "user", text: "u2" }], base: 2 });
  const msgs = (await getConversation(id))!.messages;
  expect(msgs).toHaveLength(3);
  expect(msgs[2]).toMatchObject({ role: "user", text: "u2" });
  await deleteConversation(id);
});

test("⑤增量 replace-last：base===当前长度-1 且只带 1 条时原地替换最后一条（流式更新不重复堆积）", async () => {
  const id = uniq("delta-replace");
  await createConversation({ id, title: "d" });
  await upsertMessages({ id, messages: [{ role: "user", text: "u1" }, { role: "assistant", text: "a1" }] });
  // 最后一条流式更新：客户端仍记 base=2，但只回写变更后的最后一条
  await upsertMessages({ id, messages: [{ role: "assistant", text: "a1-updated" }], base: 1 });
  const msgs = (await getConversation(id))!.messages;
  expect(msgs).toHaveLength(2);
  expect(msgs[1]).toMatchObject({ role: "assistant", text: "a1-updated" });
  await deleteConversation(id);
});

test("⑥同一轮里相同的助手结论不重复追加", async () => {
  const id = uniq("delta-dupe");
  await createConversation({ id, title: "d" });
  const now = Date.now();
  await upsertMessages({ id, messages: [{ role: "assistant", text: "same", at: now }] });
  await upsertMessages({ id, messages: [{ role: "assistant", text: "same", at: now }], base: 1 });
  expect((await getConversation(id))!.messages).toHaveLength(1);
  await deleteConversation(id);
});

test("⑦上一期的相同结论仍要追加", async () => {
  const id = uniq("delta-old");
  await createConversation({ id, title: "d" });
  await upsertMessages({ id, messages: [{ role: "assistant", text: "same", at: Date.now() - 180_000 }] });
  await upsertMessages({ id, messages: [{ role: "assistant", text: "same", at: Date.now() }], base: 1 });
  expect((await getConversation(id))!.messages).toHaveLength(2);
  await deleteConversation(id);
});

test("⑧开跑时先记下提问，客户端按旧基线回写整轮时不重复这条提问", async () => {
  const id = uniq("user-first");
  await createConversation({ id, title: "d" });
  await appendUserTurnIfMissing(id, "前3个月净利润多少？", 1000);
  await appendUserTurnIfMissing(id, "前3个月净利润多少？", 1000);
  expect((await getConversation(id))!.messages).toEqual([{ role: "user", text: "前3个月净利润多少？", at: 1000 }]);
  // 客户端还停在「库里是 0 条」，把提问和回复一起交上来。
  await upsertMessages({
    id,
    messages: [
      { role: "user", text: "前3个月净利润多少？", at: 1000 },
      { role: "assistant", text: "这个数我给不出来。", at: 2000 },
    ],
    base: 0,
  });
  const msgs = (await getConversation(id))!.messages;
  expect(msgs).toHaveLength(2);
  expect(msgs[0]).toMatchObject({ role: "user", text: "前3个月净利润多少？" });
  expect(msgs[1]).toMatchObject({ role: "assistant", text: "这个数我给不出来。" });
  await deleteConversation(id);
});

test("⑨快照只给最近一段留思考过程，列表则一律不带", () => {
  const older = { role: "assistant" as const, text: "结论", thinking: "很长的思考", steps: [{ name: "count", status: "ok", result: "complete: true" }] };
  const recent = { role: "assistant" as const, text: "新结论", thinking: "x".repeat(20), steps: [{ name: "count", status: "ok", result: "ok" }] };
  const messages = [...Array.from({ length: SNAPSHOT_DETAIL_TAIL }, () => ({ ...older, steps: older.steps.map((s) => ({ ...s })) })), recent];
  const compacted = compactSnapshot(messages);
  expect(compacted[0]?.thinking).toBeUndefined();
  expect(compacted[0]?.steps?.[0]).toEqual({ name: "count", status: "ok" });
  expect(compacted[compacted.length - 1]?.thinking).toBe(recent.thinking);
  expect(listSnapshot([recent])[0]?.thinking).toBeUndefined();
  expect((listSnapshot([recent])[0]?.steps?.[0] as { result?: string }).result).toBeUndefined();
  const huge = compactSnapshot([{ role: "assistant", text: "a", thinking: "y".repeat(20_000) }]);
  expect(huge[0]?.thinking?.startsWith("…\n")).toBe(true);
  expect((huge[0]?.thinking?.length ?? 0) < 20_000).toBe(true);
});

test("⑨全量替换向后兼容：不带 base（或 full）仍整段覆盖", async () => {
  const id = uniq("full-replace");
  await createConversation({ id, title: "d" });
  await upsertMessages({ id, messages: [{ role: "user", text: "u1" }, { role: "assistant", text: "a1" }] });
  // 老客户端 / 清空场景：不带 base，整段替换
  await upsertMessages({ id, messages: [{ role: "user", text: "only" }] });
  const msgs = (await getConversation(id))!.messages;
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ role: "user", text: "only" });
  await deleteConversation(id);
});

test("⑩通用助手新建对话不预勾连接器，显式空数组也不勾", async () => {
  expect(getRole("generic").defaultMcpServers).toBeUndefined();
  const id = uniq("generic-bi");
  await createConversation({ id, title: "n" });
  expect((await getConversation(id))!.mcpServers || []).toEqual([]);
  const emptyId = uniq("explicit-empty");
  await createConversation({ id: emptyId, title: "e", mcpServers: [] });
  expect((await getConversation(emptyId))!.mcpServers).toEqual([]);
  await deleteConversation(id);
  await deleteConversation(emptyId);
});
