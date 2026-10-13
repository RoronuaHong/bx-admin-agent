// 跨角色会话恢复：前端偏好契约回归（见 docs/cross-role-restore-scoping.md）。
// 锁两件极易被静默改坏的事：
// ① saveChatPreferences 必须把 agentId 透传进请求体——否则后端永远写 generic 槽，
//    非 generic 页（/support、/movie）的「按角色恢复」直接失效。
// ② fetchChatPreferences / toPreferences 必须解析 activeByAgent——否则非 generic 页
//    拿不到自己上次那条，只能回落到 generic 槽或 list[0]。
import { test, expect, vi, afterEach } from "vitest";
import { saveChatPreferences, fetchChatPreferences } from "../../web/src/api";

/** 造一个最小 fetch 桩：parseJson 只用到 .ok 与 .json()；withOwnerParam 在 Node 下走 try/catch 兜底。 */
function stubFetch(handler: (url: string, init?: { body?: unknown }) => unknown) {
  const fn = vi.fn(async (url: string, init?: { body?: unknown }) => {
    const body = handler(url, init);
    return { ok: true, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("[A] saveChatPreferences 带 agentId：请求体透传 agentId + activeConversationId，返回值解析 activeByAgent", async () => {
  let sent: Record<string, unknown> = {};
  stubFetch((_url, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    // 服务端回一份完整偏好（含 activeByAgent），验证返回值也经 toPreferences。
    return { activeConversationId: "g1", activeByAgent: { support: "c9" } };
  });
  const saved = await saveChatPreferences({ agentId: "support", activeConversationId: "c9" });
  expect(sent.agentId).toBe("support");
  expect(sent.activeConversationId).toBe("c9");
  expect(saved.activeByAgent).toEqual({ support: "c9" });
});

test("[B] saveChatPreferences 不带 agentId：请求体不含 agentId（后端按 generic 处理，保持旧行为）", async () => {
  let sent: Record<string, unknown> = {};
  stubFetch((_url, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return { activeConversationId: "g1" };
  });
  await saveChatPreferences({ activeConversationId: "g1" });
  expect(sent.activeConversationId).toBe("g1");
  expect("agentId" in sent).toBe(false);
});

test("[C] fetchChatPreferences 解析 activeByAgent；缺失 / 非对象时归一为 {}", async () => {
  stubFetch(() => ({ activeConversationId: "", activeByAgent: { movie: "m3", support: "c9" } }));
  expect((await fetchChatPreferences()).activeByAgent).toEqual({ movie: "m3", support: "c9" });

  stubFetch(() => ({ activeConversationId: "g1" })); // 服务端没回 activeByAgent
  expect((await fetchChatPreferences()).activeByAgent).toEqual({});

  stubFetch(() => ({ activeConversationId: "g1", activeByAgent: "oops" })); // 脏数据：非对象
  expect((await fetchChatPreferences()).activeByAgent).toEqual({});
});
