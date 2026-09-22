// 探针：在真实服务上跑一次「无人值守定时任务」，验证
//   ① 轮次预算放宽后能否在出结论前不被截断（MCP_SCHEDULE_MAX_TOOL_ROUNDS）
//   ② 跑完没有任何结论文本时是否如实记 failed（不再推「成功 ·（本次未产出内容）」）
// 用独立 owner + 独立对话 + 不勾通知通道（不推钉钉），跑完自行清理。
import { writeFileSync } from "node:fs";

const BASE = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const OWNER = "probe_sched_owner_1";
const PROMPT =
  "INGoogle8,INGoogle10两个渠道、不同新增用户来源的新增用户数，监测每天这两个渠道的不同新增用户来源的结构变化与各来源的同比变化";
const OUT = "d:/Code/bx-admin-agent/apps/agent-server/_probe_result.txt";
const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

async function api(path, init) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}owner=${encodeURIComponent(OWNER)}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

// ---- 1) 建探针对话 ----
const created = await api("/chat/conversations", {
  method: "POST",
  body: JSON.stringify({ title: "探针-schedule-rounds" }),
});
const convId = created.data?.conversation?.id;
if (!convId) {
  log(`建对话失败: ${JSON.stringify(created)}`);
  writeFileSync(OUT, lines.join("\n"), "utf-8");
  process.exit(1);
}
log(`probe conversation = ${convId}`);

// ---- 2) 建一次性探针任务（一次到点即可，不勾通知通道 → 不推送）----
const at = Date.now() + 5000;
const sch = await api("/chat/schedules", {
  method: "POST",
  body: JSON.stringify({
    conversationId: convId,
    prompt: PROMPT,
    name: "probe-rounds",
    onceAt: at,
    mcpServers: ["bi"],
  }),
});
const schId = sch.data?.schedule?.id;
if (!schId) {
  log(`建任务失败: ${JSON.stringify(sch)}`);
  writeFileSync(OUT, lines.join("\n"), "utf-8");
  process.exit(1);
}
log(`probe schedule   = ${schId}  onceAt=${new Date(at).toISOString()}`);
log("等待调度触发并跑完（最长 12 分钟）…");

// ---- 3) 轮询等收束 ----
let final = null;
const deadline = Date.now() + 12 * 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const list = await api("/chat/schedules");
  const s = (list.data?.schedules || []).find((x) => x.id === schId);
  if (!s) break;
  if (s.lastStatus && s.lastRunAt) {
    final = s;
    break;
  }
  const st = await api(`/chat/task/status?conversationId=${encodeURIComponent(convId)}`);
  log(`  … running=${st.data?.running} at=${new Date().toISOString().slice(11, 19)}`);
}

log("");
log("===== 探针任务结果 =====");
if (!final) {
  log("未在窗口内收束（超时）");
} else {
  log(`lastStatus  = ${final.lastStatus}`);
  log(`lastNote    = ${final.lastNote ?? "(空)"}`);
  log(`lastRunAt   = ${new Date(final.lastRunAt).toISOString()}`);
  log(`lastDelivery= ${final.lastDelivery ? JSON.stringify(final.lastDelivery) : "(无 → 未推送，符合预期)"}`);
}

// ---- 4) 对话里这一轮的产出 ----
const conv = await api(`/chat/conversations`);
const c = (conv.data?.conversations || []).find((x) => x.id === convId);
if (c) {
  const lastAssistant = [...(c.messages || [])].reverse().find((m) => m.role === "assistant");
  const text = String(lastAssistant?.text || "");
  log("");
  log(`消息条数=${(c.messages || []).length}  末条 steps=${lastAssistant?.steps?.length || 0}`);
  log(`末条文本长度=${text.length}`);
  log(`末条文本开头: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
}

// ---- 5) 清理 ----
await api(`/chat/schedules/${encodeURIComponent(schId)}`, { method: "DELETE" });
await api(`/chat/conversations/${encodeURIComponent(convId)}`, { method: "DELETE" });
log("");
log("已清理探针任务与探针对话");

writeFileSync(OUT, lines.join("\n"), "utf-8");
console.log(`\n结果已写入 ${OUT}`);
