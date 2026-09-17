// 模拟前端客户端：打真实 HTTP 接口（与 web 前端同一套协议），验证 BI MCP 选项端到端可用。
// 流程：GET /chat/mcp/servers（拿 cookie + 看 available）→ PUT 启用 bi → POST /chat/stream(NDJSON 分块)，
// 收到 confirmation_required 时 POST /chat/confirm 应答，最后收 text/done。
import { appendFileSync } from "node:fs";

const BASE = process.argv[2] || process.env.BASE || "http://localhost:8787";
const LOG = new URL("../scripts/_sim-client.log", import.meta.url);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a: unknown[]) {
  const line = `${stamp()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  appendFileSync(LOG, line + "\n");
  console.log(line);
}

let cookie = "";
async function call(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers as Record<string, string>) };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0]; // 仅取 name=value
  return res;
}

async function waitHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return log("[health] server up");
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server 未在超时内就绪");
}

async function readStream(res: Response, onEvent: (e: any) => void) {
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`chat/stream 失败 ${res.status} ${txt}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  }
}

async function main() {
  await waitHealth();

  log("[1] GET /chat/mcp/servers");
  const s1 = await call("/chat/mcp/servers").then((r) => r.json());
  const avail = (s1.available || []) as any[];
  log("    available =", avail.map((x) => `${x.id}(connected=${x.connected},tools=${x.tools})`).join(", "));
  const bi = avail.find((x) => x.id === "bi");
  if (!bi) throw new Error("BI 选项未出现在 available 中（检查 mcp-servers.json）");

  log("[2] PUT /chat/mcp/servers 启用 bi");
  const s2 = await call("/chat/mcp/servers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: ["bi"] }),
  }).then((r) => r.json());
  log("    enabled =", s2.enabled, " bi.connected =", (s2.available || []).find((x: any) => x.id === "bi")?.connected);

  const question = "请使用已连接的 BI（Metabase）MCP 工具来回答：1) 先调用 list_databases 看有哪些数据库；2) 查看主库表结构，或用 run_native_query 查系统表 system.tables，找出日活（DAU）相关的表；3) 列出表名与关键字段。";
  log("[3] POST /chat/stream 提问：", question);

  let finalText = "";
  let confirmCount = 0;
  let toolRound = 0;
  let answer = "";

  const res = await call("/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: question }),
  });

  await readStream(res, async (e: any) => {
    switch (e.type) {
      case "model":
        log("[model]", e.label);
        break;
      case "tool_call":
        toolRound++;
        log(`[tool_call#${toolRound}]`, e.name, e.args || "");
        break;
      case "confirmation_required":
        confirmCount++;
        log(`[confirm#${confirmCount}]`, e.name, e.args || "");
        // 模拟前端弹窗后自动同意
        await call("/chat/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId: e.id, confirmed: true }),
        });
        log(`[confirm#${confirmCount}] -> answered true`);
        break;
      case "tool_result":
        log(`[tool_result]`, e.name, "ok=", e.ok, (e.text || "").slice(0, 60).replace(/\n/g, " "));
        break;
      case "text_delta":
        finalText += e.text;
        break;
      case "text":
        answer = e.text;
        break;
      case "done":
        log("[done]");
        break;
      case "error":
        log("[error]", e.message);
        break;
      default:
        break;
    }
  });

  const out = answer || finalText;
  log("[4] 完成。共工具轮次 =", toolRound, " 确认次数 =", confirmCount, " 回答长度 =", out.length);
  log("[answer] " + out.slice(0, 1200));
  if (!out.trim()) throw new Error("未收到任何回答");
  log("[OK] BI MCP 选项通过真实 HTTP 接口验证通过 ✅");
}

main().catch((e) => {
  log("[exception]", String(e?.stack || e));
  process.exit(1);
});
