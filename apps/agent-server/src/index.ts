import "./load-env.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertBuiltinRiskCoverage } from "./builtins.js";
import { config, defaultModel, listModels } from "./config.js";
import { listEnabledMcpServers, pruneUnknownMcpServers } from "./conversations.js";
import { loadServers } from "./mcp/config.js";
import { connect, disconnectAll, startIdleSweeper } from "./mcp/hub.js";
import {
  interruptOwnRunningTasks,
  recoverStaleTasks,
  startTaskRetentionSweeper,
  startTaskWatchdog,
} from "./chat-tasks.js";
import { initTaskStore } from "./task-store.js";

// 启动断言：内置工具漏登记风险级别直接拒绝启动（否则会在运行时静默按「未知」兜底）。
assertBuiltinRiskCoverage();
if ((process.env.SUBAGENT_ALLOW_WRITE || "off").toLowerCase() === "on") {
  console.warn(
    "[安全] SUBAGENT_ALLOW_WRITE=on 已被忽略：子代理确认事件转发尚未实现，放开会让「需要用户确认」的操作静默挂起到超时。" +
      "子代理的可执行范围由作用域决定（工作区内的写可执行；外部写/破坏性操作在闸门处直接拒绝）。",
  );
}

const app = createApp();

// 进程退出前：先把自己还在跑的任务标成 interrupted（状态写实，晚到的重连据此如实收口），
// 再断开全部 MCP 连接（stdio 子进程随之回收）。pm2 的 kill_timeout 很短，故两件事都只做最少的必要动作。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void interruptOwnRunningTasks(signal)
      .catch(() => 0)
      .then(() => disconnectAll())
      .finally(() => process.exit(0));
  });
}
serve({ fetch: app.fetch, port: config.port }, () => {
  const models = listModels();
  const summary = models.length ? models.map((m) => `${m.id}:${m.provider}/${m.name}`).join(", ") : "(none)";
  console.log(`agent-server http://localhost:${config.port} models=[${summary}]`);
  if (!defaultModel()) {
    console.warn("[警告] 未配置任何模型（MODEL_PROVIDERS），聊天将提示未配置。");
  }
  // 周期回收空闲 MCP 连接（stdio 子进程不常驻），下次用到时自动重连。
  startIdleSweeper();
  // 周期回收「已收束任务的事件留档」（断线续传的取数窗口，过期即释放内存）。
  startTaskRetentionSweeper();
  // 无进展看门狗：服务端判定「这一轮还活着吗」——长时间没有任何实质事件就主动收口，
  // 免得极端情况下（某处 await 永不返回且不理会 abort）前端气泡永远停在「执行中」。
  startTaskWatchdog();
  // 任务留档（跨进程续传的读侧）：连得上 Mongo 才做启动恢复——把上一次进程留下的
  // running 僵尸任务标成 interrupted，晚到的重连据此如实收口（不重放、不重试）。
  void initTaskStore().then(async (ok) => {
    if (ok) await recoverStaleTasks();
  });
  // 启动维护：把「配置里已不存在」的 MCP id 从各对话启用集里摘掉。
  // 服务器的增减多来自 .env（只在启动时读），除了 DELETE 端点没有别的清理点；
  // 放在这里而不是 GET 里，见 conversations.ts 的 pruneUnknownMcpServers 注释（安全方法语义）。
  void pruneUnknownMcpServers(loadServers().map((s) => s.id)).then((n) => {
    if (n) console.log(`[mcp] 启动维护：${n} 个对话的启用集里含已移除的服务器，已摘除`);
  });
  // 任意对话启用了的 MCP 服务器：启动后自动重连，否则面板会一直显示"未连接"，与勾选状态矛盾。
  void listEnabledMcpServers().then((ids) => {
    for (const id of ids) void connect(id);
  });
});
