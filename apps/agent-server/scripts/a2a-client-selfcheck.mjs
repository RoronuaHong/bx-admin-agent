// A2A Client 自环测试：启动内置 A0 Server，用 a2a-client 走完整协议往返。
// 用法：node --import tsx scripts/a2a-client-selfcheck.mjs   （在 apps/agent-server 目录）
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { attachA2a, AGENT_CARD } from "../src/a2a.ts";
import {
  fetchAgentCard,
  sendA2AMessage,
  getA2ATask,
  cancelA2ATask,
  extractTaskText,
  a2aRunTask,
  A2AClientError,
} from "../src/a2a-client.ts";

process.env.A2A_TOKENS = JSON.stringify([
  { key: "client-test-key", label: "self-client", country: "in2", project: "bx-film-admin", environment: "test", readonly: true },
]);

const app = new Hono();
attachA2a(app);

const server = serve({ fetch: app.fetch, port: 0 }, async (info) => {
  const base = `http://127.0.0.1:${info.port}`;
  let pass = 0,
    fail = 0;
  const check = (name, ok, extra = "") => {
    console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " :: " + extra : ""}`);
    ok ? pass++ : fail++;
  };
  try {
    // 1. 发现：fetchAgentCard
    const card = await fetchAgentCard(base);
    check("fetchAgentCard 成功且 name 匹配", card.name === AGENT_CARD.name, card.name);

    // 2. 主交互：sendA2AMessage
    const task = await sendA2AMessage(base, "client-test-key", "你好", {});
    check("sendA2AMessage 返回 task.id", typeof task?.id === "string", `state=${task?.state}`);

    // 2b. 便捷封装：a2aRunTask 返回 {task, text}
    const run = await a2aRunTask(base, "client-test-key", "你好", {});
    check("a2aRunTask 返回 {task,text}", typeof run?.task?.id === "string" && typeof run?.text === "string", `text.len=${run?.text?.length}`);

    // 3. 轮询：getA2ATask
    const got = await getA2ATask(base, "client-test-key", task.id);
    check("getA2ATask 取回一致 task", got?.id === task.id, `state=${got?.state}`);

    // 4. 取消：cancelA2ATask
    const cancelled = await cancelA2ATask(base, "client-test-key", task.id);
    check("cancelA2ATask 返回 task", typeof cancelled?.id === "string", `state=${cancelled?.state}`);

    // 5. 文本聚合：extractTaskText 不抛错
    const txt = extractTaskText(task);
    check("extractTaskText 不抛错", typeof txt === "string", `len=${txt.length}`);

    // 6. 鉴权失败：错误 token 抛 A2AClientError（错误码 -32000）
    let threw = false,
      code = 0;
    try {
      await sendA2AMessage(base, "bad-key", "x", {});
    } catch (e) {
      threw = true;
      if (e instanceof A2AClientError) code = e.code;
    }
    check("错误 token 抛 A2AClientError", threw && code === -32000, `code=${code}`);
  } catch (e) {
    console.error("自测异常", e);
    fail++;
  } finally {
    console.log(`\nClient 自测：${pass} 通过 / ${fail} 失败`);
    server.close();
    process.exit(fail === 0 ? 0 : 1);
  }
});
