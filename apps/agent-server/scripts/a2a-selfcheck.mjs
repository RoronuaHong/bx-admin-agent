// A2A Server 协议骨架自测（不触发模型调用）：验证 Agent Card / 鉴权 / 未配置响应。
// 用法：node --import tsx scripts/a2a-selfcheck.mjs   （在 apps/agent-server 目录）
import { attachA2a, AGENT_CARD } from "../src/a2a.ts";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();
attachA2a(app);

const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
  const base = `http://127.0.0.1:${info.port}`;
  (async () => {
    let pass = 0, fail = 0;
    const check = (name, ok, extra = "") => {
      console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " :: " + extra : ""}`);
      ok ? pass++ : fail++;
    };

    // 1. Agent Card
    const cardRes = await fetch(`${base}/.well-known/agent-card.json`);
    const card = await cardRes.json();
    check("AgentCard 可达且含 name", card.name === AGENT_CARD.name, card.name);

    // 2. 未配置 token → 503
    const noCfg = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ kind: "text", text: "hi" }] } } }),
    });
    check("未配置 A2A_TOKENS → 503", noCfg.status === 503, `status=${noCfg.status}`);

    // 3. 无 Authorization → 401
    process.env.A2A_TOKENS = JSON.stringify([{ key: "test-key", label: "self", country: "in2", project: "bx-film-admin", environment: "test", readonly: true }]);
    const noAuth = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "SendMessage", params: { message: { parts: [{ kind: "text", text: "hi" }] } } }),
    });
    check("无 Authorization → 401", noAuth.status === 401, `status=${noAuth.status}`);

    // 4. 错误 token → 403
    const badAuth = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "SendMessage", params: { message: { parts: [{ kind: "text", text: "hi" }] } } }),
    });
    check("错误 token → 403", badAuth.status === 403, `status=${badAuth.status}`);

    // 5. 未知方法 → -32601
    const unknown = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "Bogus", params: {} }),
    });
    const unknownBody = await unknown.json();
    check("未知方法 → -32601", unknownBody.error?.code === -32601, `code=${unknownBody.error?.code}`);

    // 6. 有效 token + SendMessage → 进入 chatStream（不 500；结果取决于模型是否配置）
    const send = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "SendMessage", params: { message: { contextId: "ctx-1", parts: [{ kind: "text", text: "你好" }] } } }),
    });
    const sendBody = await send.json();
    const state = sendBody?.result?.task?.state;
    check("SendMessage 走通 chatStream（不 500）", send.status === 200 && typeof state === "string", `state=${state}`);

    console.log(`\n自测结果：${pass} 通过 / ${fail} 失败`);
    server.close();
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => {
    console.error("自测异常", e);
    process.exit(2);
  });
});
