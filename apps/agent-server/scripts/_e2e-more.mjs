// 综合回归 e2e（movie 多轮 / 通用角色无回归 / movie 查不到不编造）。prompt 写死英文避免 PowerShell 中文乱码。
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";

async function newConv(agentId) {
  const res = await fetch(`${BASE}/chat/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(agentId ? { agentId, title: `e2e-${agentId}` } : { title: "e2e-generic" }),
  });
  const sc = res.headers.get("set-cookie") || "";
  const oid = sc.match(/bx_agent_oid=([^;]+)/)?.[1];
  const body = await res.json().catch(() => null);
  const id = body?.conversation?.id;
  return { id, cookie: `bx_agent_sid=${res.headers.get("set-cookie")?.match(/bx_agent_sid=([^;]+)/)?.[1]};${oid ? `bx_agent_oid=${oid}` : ""}` };
}

async function ask(id, agentId, text, cookie) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ conversationId: id, agentId, text }),
  });
  if (!res.ok) return { err: `HTTP ${res.status}`, calls: [], out: "" };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "", calls = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "tool_call" && ev.name?.includes("movie")) calls.push(ev.name);
      else if (ev.type === "text") out = ev.text;
      else if (ev.type === "text_delta") out += ev.text;
    }
  }
  return { err: null, calls, out };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { console.log(`  [${cond ? "PASS" : "FAIL"}] ${name} ${extra}`); cond ? pass++ : fail++; };

// A. movie 多轮：首轮查 Inception，第二轮追问年份（应回退 auto，不强制 required，正常作答）
console.log("=== A. movie 多轮 ===");
const mv = await newConv("movie");
if (!mv.id) { console.log("  建 movie 对话失败"); process.exit(2); }
const a1 = await ask(mv.id, "movie", "What is the movie Inception about?", mv.cookie);
check("首轮调用了电影工具", a1.calls.length > 0, `calls=${a1.calls.length}`);
check("首轮返回非空", a1.out.trim().length > 0, `len=${a1.out.trim().length}`);
const a2 = await ask(mv.id, "movie", "What year was it released?", mv.cookie);
check("第二轮（auto 回退）无报错且返回非空", !a2.err && a2.out.trim().length > 0, `err=${a2.err} len=${a2.out.trim().length}`);

// B. 通用角色无回归：不传 agentId，问通用知识，绝不应触发 movie 强制/工具
console.log("=== B. 通用角色无回归 ===");
const ge = await newConv(null);
if (!ge.id) { console.log("  建通用对话失败"); process.exit(2); }
const b1 = await ask(ge.id, undefined, "Explain REST API in one sentence.", ge.cookie);
check("通用对话无报错", !b1.err, `err=${b1.err}`);
check("通用对话返回非空文本", b1.out.trim().length > 0, `len=${b1.out.trim().length}`);
check("通用对话未误调 movie 工具", b1.calls.length === 0, `movieCalls=${b1.calls.length}`);

// C. movie 查不到：编造防护（搜索空结果后应诚实说没找到，而非编造剧情）
console.log("=== C. movie 查不到不编造 ===");
const mc = await newConv("movie");
const c1 = await ask(mc.id, "movie", "Tell me about the movie 'ZzxqwNotFoundMovie12345'.", mc.cookie);
check("查不到也走了工具（未凭记忆直答）", c1.calls.length > 0, `calls=${c1.calls.length}`);
const lowered = c1.out.toLowerCase();
const honest = /not found|cannot find|找不到|未找到|没有找到|no (such|matching|result)|don't have|do not have|无法找到|查不到/i.test(c1.out) || lowered.includes("zzxqwnotfoundmovie12345");
check("未编造（诚实回应或引用了查询词）", honest, `out=${c1.out.slice(0, 160).replace(/\n/g, " ")}`);

console.log(`\n=== 综合：${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
