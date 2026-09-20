// 写操作安全闸门（P0）单元验证：风险分级 / 只读授权 / 确认票据会话绑定 / 参数脱敏 / 审计留痕。
// 运行：node --import tsx scripts/_risk-gate-check.mjs（纯函数 + 内存通道，不依赖真实 MCP / 模型）。
import assert from "node:assert/strict";

process.env.MCP_UNKNOWN_TOOLS = "confirm";

const risk = await import("../src/risk.js");
const confirm = await import("../src/confirm.js");
const audit = await import("../src/audit.js");
const chat = await import("../src/chat.js");
const sql = await import("../src/sql-readonly.js");

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- 1. 内置工具登记表 ----
check("builtin fs_read = read/workspace", () => {
  const v = risk.resolveToolRisk("fs_read");
  assert.equal(v.level, "read");
  assert.equal(v.external, false);
  assert.equal(v.source, "builtin");
  assert.equal(risk.verdictNeedsConfirm(v), false);
});
check("builtin fs_write = write，需用户确认（变更工作区文件）", () => {
  const v = risk.resolveToolRisk("fs_write");
  assert.equal(v.level, "write");
  assert.equal(v.external, true);
  assert.equal(risk.verdictNeedsConfirm(v), true);
});
check("builtin task = read/workspace", () => {
  const v = risk.resolveToolRisk("task");
  assert.equal(v.level, "read");
  assert.equal(v.external, false);
});

// ---- 2. 未注册 / 查不到的工具：fail-closed ----
check("未知裸名 = destructive/unknown/confirm 口径", () => {
  const v = risk.resolveToolRisk("no_such_tool");
  assert.equal(v.unknown, true);
  assert.equal(v.level, "destructive");
  assert.equal(v.deny, false);
  assert.equal(risk.verdictNeedsConfirm(v), true);
});
check("未知命名空间名 = destructive/unknown", () => {
  const v = risk.resolveToolRisk("mcp__nope__tool");
  assert.equal(v.unknown, true);
  assert.equal(v.level, "destructive");
  assert.equal(risk.verdictNeedsConfirm(v), true);
});
check("MCP_UNKNOWN_TOOLS=deny → 直接拒绝", () => {
  process.env.MCP_UNKNOWN_TOOLS = "deny";
  const v = risk.resolveToolRisk("mcp__nope__tool");
  assert.equal(v.deny, true);
  process.env.MCP_UNKNOWN_TOOLS = "confirm";
});
check("MCP_UNKNOWN_TOOLS=allow → 未知按只读放行", () => {
  process.env.MCP_UNKNOWN_TOOLS = "allow";
  const v = risk.resolveToolRisk("mcp__nope__tool");
  assert.equal(v.level, "read");
  assert.equal(v.unknown, true);
  assert.equal(risk.verdictNeedsConfirm(v), false);
  process.env.MCP_UNKNOWN_TOOLS = "confirm";
});
check("unknownToolPolicy 兜底非法值 = confirm", () => {
  process.env.MCP_UNKNOWN_TOOLS = "bogus";
  assert.equal(risk.unknownToolPolicy(), "confirm");
  process.env.MCP_UNKNOWN_TOOLS = "confirm";
});

// ---- 3. 会话级只读授权：仅对 unknown 且同 server 生效 ----
check("readGrants 把 unknown 降为 read（grant 来源）", () => {
  const v = risk.resolveToolRisk("mcp__yapi__tool", new Set(["yapi"]));
  assert.equal(v.level, "read");
  assert.equal(v.unknown, true);
  assert.equal(v.source, "grant");
  assert.equal(risk.verdictNeedsConfirm(v), false);
});
check("授权不影响显式 destructive（builtin 之外的未知 server 无配置时仍走 unknown）", () => {
  const v = risk.resolveToolRisk("mcp__bi__run_native_query", new Set(["bi"]));
  // bi 未连接（describeMcpTool = null）→ unknown；授权在 → read。这里验证授权只作用于 unknown。
  assert.equal(v.unknown, true);
});

// ---- 4. 确认票据：会话绑定 + 一次性 ----
check("票据归属校验：错误会话被拒且票据作废", async () => {
  const { ticket } = confirm.requestConfirmation({
    sessionId: "s1",
    conversationId: "c1",
    callId: "call_1",
    tool: "mcp__bi__run_native_query",
    serverId: "bi",
  });
  const bad = confirm.answerConfirmation(ticket, "s2", true);
  assert.equal(bad.ok, false);
  // 票据一次性：错误应答后也已删除（原等待方按超时拒绝），再次应答失败。
  const again = confirm.answerConfirmation(ticket, "s1", true);
  assert.equal(again.ok, false);
});
check("票据正确会话应答 → 解挂并返回会话/服务器", async () => {
  const { ticket, wait } = confirm.requestConfirmation({
    sessionId: "s1",
    conversationId: "c1",
    callId: "call_2",
    tool: "t",
    serverId: "bi",
  });
  const res = confirm.answerConfirmation(ticket, "s1", true);
  assert.equal(res.ok, true);
  assert.equal(res.conversationId, "c1");
  assert.equal(res.serverId, "bi");
  const outcome = await wait;
  assert.deepEqual(outcome, { confirmed: true, timedOut: false });
});
check("票据重复使用失败", () => {
  const { ticket } = confirm.requestConfirmation({ sessionId: "s", conversationId: "c", callId: "x", tool: "t" });
  confirm.answerConfirmation(ticket, "s", false);
  assert.equal(confirm.answerConfirmation(ticket, "s", true).ok, false);
});
check("票据签发同时回传有效期（前端据此提示时限）", () => {
  const { timeoutMs } = confirm.requestConfirmation({ sessionId: "s", conversationId: "c", callId: "y", tool: "t" });
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
});

// ---- 5. 参数摘要脱敏 ----
check("argSummary：敏感键脱敏 + 截断 + 上限 8 项", () => {
  const summary = chat.summarizeArgsForConfirm(
    JSON.stringify({
      query: "SELECT 1",
      api_key: "super-secret",
      Authorization: "Bearer xyz",
      password: "hunter2",
      big: "x".repeat(500),
      a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9,
    }),
  );
  assert.ok(summary.length <= 8);
  const byKey = new Map(summary.map((row) => [row.key, row.value]));
  assert.equal(byKey.get("api_key"), "•••");
  assert.equal(byKey.get("Authorization"), "•••");
  assert.equal(byKey.get("password"), "•••");
  assert.ok(byKey.get("big").endsWith("…") && byKey.get("big").length <= 201);
  assert.ok(!summary.some((row) => row.key === "i"));
});

// ---- 6. 审计：append + list 回读 ----
check("审计事件落盘并可回读", () => {
  audit.appendAudit({
    kind: "gate",
    decision: "confirmed",
    tool: "mcp__x__y",
    server: "x",
    level: "destructive",
    unknown: false,
    reason: "test",
    argsDigest: audit.argsDigestOf('{"a":1}'),
  });
  const events = audit.listAuditEvents({ decision: "confirmed", limit: 5 });
  assert.ok(events.length >= 1);
  const found = events.find((e) => e.tool === "mcp__x__y");
  assert.ok(found);
  assert.equal(found.kind, "gate");
  assert.ok(found.argsDigest);
});

// ---- 7. 原生 SQL 只读判定 ----
check("只读 SELECT 放行", () => {
  assert.equal(sql.isReadOnlySql("SELECT a FROM t"), true);
});

// ---- 8. 原生 SQL 工具：非只读查询被服务端硬拒（双重保险，P1-1）----
check("run_native_query 只读 SELECT → 不拒（降级免确认）", () => {
  assert.equal(risk.isNativeSqlRejected(["run_native_query"], "run_native_query", { query: "SELECT 1" }), false);
});
check("run_native_query 写操作 DELETE → 硬拒", () => {
  assert.equal(risk.isNativeSqlRejected(["run_native_query"], "run_native_query", { query: "DELETE FROM t" }), true);
});
check("run_native_query 多语句 INSERT…SELECT → 硬拒", () => {
  assert.equal(risk.isNativeSqlRejected(["run_native_query"], "run_native_query", { query: "INSERT INTO t SELECT 1" }), true);
});
check("非 SQL 工具不受 SQL 判据影响", () => {
  assert.equal(risk.isNativeSqlRejected(["run_native_query"], "get_card", { query: "DELETE FROM t" }), false);
});
check("SQL 字面量里的关键字不误判（SELECT 'drop table'）→ 不拒", () => {
  assert.equal(risk.isNativeSqlRejected(["run_native_query"], "run_native_query", { query: "SELECT 'drop table' FROM t" }), false);
});

console.log(`\n${pass} checks passed${process.exitCode ? "（存在失败）" : ""}`);