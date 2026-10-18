// IM「打开对话」链接只带 ?conv=，发在群里谁点都能看：
// - ?owner= 不改写设备身份；
// - 定时任务的对话对持链接的人只读开放，不能改名、删除；
// - 主人的普通对话别人仍然读不到。
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { createConversation } from "../src/conversations.js";
import { buildScheduleDelivery } from "../src/notify/deliver.js";

const OWNER = "taskOwner00001";
const VIEWER = "groupMember001";

function ownerCookieOf(res: Response): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") || ""];
  return all.filter((line) => line.startsWith("bx_agent_oid=")).at(-1)?.split(";")[0]?.slice("bx_agent_oid=".length);
}

test("?owner= 不再改写设备身份", async () => {
  const app = createApp();
  const res = await app.request(`/chat/conversations?owner=${OWNER}`, { headers: { cookie: "bx_agent_oid=attacker0001" } });
  expect(ownerCookieOf(res)).toBeUndefined();
  const fresh = await app.request(`/chat/conversations?owner=${OWNER}`);
  expect(ownerCookieOf(fresh)).not.toBe(OWNER);
});

test("任务对话凭链接只读：能看不能改；主人的普通对话看不到", async () => {
  const app = createApp();
  const task = `conv_test_${Date.now()}_task`;
  const plain = `conv_test_${Date.now()}_plain`;
  await createConversation({ id: task, title: "预警任务", ownerKey: OWNER, scheduleId: "sched_test_1" });
  await createConversation({ id: plain, title: "主人的私人对话", ownerKey: OWNER });
  const cookie = `bx_agent_oid=${VIEWER}`;

  expect((await app.request(`/chat/conversations/${task}`, { headers: { cookie } })).status).toBe(200);
  expect((await app.request(`/chat/conversations/${task}/files`, { headers: { cookie } })).status).toBe(200);
  expect((await app.request(`/chat/conversations/${plain}`, { headers: { cookie } })).status).toBe(404);

  const list = (await (await app.request("/chat/conversations", { headers: { cookie } })).json()) as {
    conversations?: Array<{ id: string }>;
  };
  expect((list.conversations || []).some((c) => c.id === task || c.id === plain)).toBe(false);

  const rename = await app.request(`/chat/conversations/${task}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "被改写" }),
  });
  expect(rename.status).toBe(404);
  expect((await app.request(`/chat/conversations/${task}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);

  const ownerView = await app.request(`/chat/conversations/${task}`, { headers: { cookie: `bx_agent_oid=${OWNER}` } });
  expect(((await ownerView.json()) as { conversation: { title: string } }).conversation.title).toBe("预警任务");
});

test("通知链接只带对话 id，不带设备身份", () => {
  const msg = buildScheduleDelivery({
    prompt: "p",
    status: "success",
    text: "ok",
    conversationId: "c1",
    webOrigin: "https://agent.example.com",
  });
  expect(msg.links?.[0]?.url).toBe("https://agent.example.com/chat?conv=c1");
});
