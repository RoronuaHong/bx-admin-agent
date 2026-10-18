import { expect, test } from "vitest";
import { createApp } from "../src/app.js";

const OWNER_A = "ownerAAAA1111";
const OWNER_B = "ownerBBBB2222";

function post(app: ReturnType<typeof createApp>, owner: string, body: unknown) {
  return app.request("/chat/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `bx_agent_oid=${owner}` },
    body: JSON.stringify(body),
  });
}

test("带他人对话 id 新建 → 404，对方标题与内容不被改写也不被回传", async () => {
  const app = createApp();
  const id = `conv_test_${Date.now()}_own`;

  const created = await post(app, OWNER_A, { id, title: "A 的对话" });
  expect(created.status).toBe(200);

  const hijack = await post(app, OWNER_B, { id, title: "被改写" });
  expect(hijack.status).toBe(404);
  const hijackBody = (await hijack.json()) as { conversation?: unknown };
  expect(hijackBody.conversation).toBeUndefined();

  const read = await app.request(`/chat/conversations/${id}`, { headers: { cookie: `bx_agent_oid=${OWNER_A}` } });
  expect(read.status).toBe(200);
  const doc = (await read.json()) as { conversation: { title: string } };
  expect(doc.conversation.title).toBe("A 的对话");
});

test("同一 owner 重复带 id 新建仍幂等", async () => {
  const app = createApp();
  const id = `conv_test_${Date.now()}_idem`;
  expect((await post(app, OWNER_A, { id, title: "x" })).status).toBe(200);
  expect((await post(app, OWNER_A, { id, title: "x" })).status).toBe(200);
});
