/**
 * 代码里调用只读工具（对齐 Deep Agents 解释器 + Anthropic programmatic tool calling）。
 *
 * 循环留在子进程里：每一页的明细只回到这段代码，模型只看到 stdout 里的聚合结果。
 * run_script 做不到这件事——它的进程里没有 MCP。子代理可以跑本工具，因为它登记为只读。
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function capOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…（已省略 ${text.length - maxChars} 字符）\n${text.slice(text.length - tail)}`;
}

export const TOOL_CODE_MAX_CALLS = 400;
const TOOL_CODE_TEXT_MAX = 1_500_000;
const OUTPUT_MAX = 12_000;
/** 单条流的捕获上限：print 一个死循环就能把进程内存吃光，收齐再截断是来不及的。 */
const STREAM_CAPTURE_MAX = 4 * 1024 * 1024;

/**
 * 子进程只拿「跑起来所必需」的环境变量，不继承服务端的全部环境。
 * 这段代码是模型写出来的（可被 prompt 注入操控），而 run_tool_code 登记为 read、免确认；
 * 继承全部环境等于把数据库 URI、各家的 API key 直接交给它，配上不受限的出网就是凭据外带。
 */
const ENV_ALLOW = new Set([
  "path",
  "pathext",
  "systemroot",
  "systemdrive",
  "comspec",
  "temp",
  "tmp",
  "tmpdir",
  "home",
  "userprofile",
  "homedrive",
  "homepath",
  "appdata",
  "localappdata",
  "programdata",
  "programfiles",
  "lang",
  "lc_all",
  "pythonioencoding",
  "pythonutf8",
  "pythonpath",
  "node_path",
]);

/** 服务端环境 → 子进程环境（只留白名单里的键，再补上桥接用的变量）。 */
export function toolCodeEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.has(key.toLowerCase())) out[key] = value;
  }
  return { ...out, ...extra };
}

const DENIED = new Set([
  "run_tool_code",
  "run_script",
  "run_command",
  "task",
  "manage_schedule",
  "request_clarification",
  "fs_delete",
  "image_gen",
]);

export function toolCodeDenied(name: string): string | null {
  if (DENIED.has(name)) return `不能从代码里调用 ${name}`;
  return null;
}

export interface ToolCodeResult {
  ok: boolean;
  text: string;
}

const NODE_CLIENT = `import net from "node:net";
export function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(process.env.BX_TOOL_PORT), "127.0.0.1", () => {
      sock.write(JSON.stringify({ token: process.env.BX_TOOL_TOKEN, name, arguments: args || {} }) + "\\n");
    });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      const cut = buf.indexOf("\\n");
      if (cut < 0) return;
      sock.end();
      let msg;
      try { msg = JSON.parse(buf.slice(0, cut)); } catch (err) { reject(err); return; }
      if (!msg.ok) reject(new Error(msg.error || msg.text || "工具调用失败"));
      else resolve(msg.text ?? "");
    });
    sock.on("error", reject);
  });
}
`;

const PY_CLIENT = `import json, os, socket
def call_tool(name, args=None):
    sock = socket.create_connection(("127.0.0.1", int(os.environ["BX_TOOL_PORT"])))
    try:
        payload = json.dumps({"token": os.environ["BX_TOOL_TOKEN"], "name": name, "arguments": args or {}}, ensure_ascii=False) + "\\n"
        sock.sendall(payload.encode("utf-8"))
        buf = b""
        while b"\\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
        msg = json.loads(buf.split(b"\\n", 1)[0].decode("utf-8"))
    finally:
        sock.close()
    if not msg.get("ok"):
        raise RuntimeError(msg.get("error") or msg.get("text") or "工具调用失败")
    return msg.get("text") or ""
`;

function readLine(sock: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const cut = buf.indexOf("\n");
      if (cut < 0) return;
      cleanup();
      resolve(buf.slice(0, cut));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      sock.off("data", onData);
      sock.off("error", onError);
    };
    sock.on("data", onData);
    sock.on("error", onError);
  });
}

export async function runToolCode(opts: {
  language: string;
  code: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCodeResult>;
}): Promise<ToolCodeResult> {
  const language = opts.language.trim().toLowerCase();
  const python = language === "python" || language === "py";
  const node = language === "node" || language === "js" || language === "javascript" || language === "";
  if (!python && !node) {
    return { ok: false, text: `run_tool_code 不支持的语言：${language || "(空)"}（支持 node/js/javascript、python/py）` };
  }
  if (!opts.code.trim()) return { ok: false, text: "run_tool_code 需要 code" };
  mkdirSync(opts.cwd, { recursive: true });
  const token = randomBytes(16).toString("hex");
  let calls = 0;
  let okCalls = 0;
  const sockets = new Set<Socket>();

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {
      /* 子进程先断开时会 ECONNRESET，不能冒泡成未捕获异常 */
    });
    void (async () => {
      try {
        const line = await readLine(sock);
        const req = JSON.parse(line) as { token?: string; name?: string; arguments?: unknown };
        if (req.token !== token) {
          sock.write(`${JSON.stringify({ ok: false, error: "token 不匹配" })}\n`);
          return;
        }
        const name = String(req.name || "").trim();
        const denied = toolCodeDenied(name);
        if (denied) {
          sock.write(`${JSON.stringify({ ok: false, error: denied })}\n`);
          return;
        }
        calls += 1;
        if (calls > TOOL_CODE_MAX_CALLS) {
          sock.write(`${JSON.stringify({ ok: false, error: `已达代码内工具调用上限 ${TOOL_CODE_MAX_CALLS}` })}\n`);
          return;
        }
        const args =
          req.arguments && typeof req.arguments === "object" && !Array.isArray(req.arguments)
            ? (req.arguments as Record<string, unknown>)
            : {};
        const result = await opts.callTool(name, args);
        if (result.ok) okCalls += 1;
        const text = result.text.length > TOOL_CODE_TEXT_MAX ? result.text.slice(0, TOOL_CODE_TEXT_MAX) : result.text;
        sock.write(`${JSON.stringify({ ok: result.ok, text, ...(result.ok ? {} : { error: text }) })}\n`);
      } catch (err) {
        try {
          sock.write(`${JSON.stringify({ ok: false, error: String((err as Error)?.message || err) })}\n`);
        } catch {
          /* 连接已断 */
        }
      } finally {
        sock.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  if (!port) {
    await closeToolServer(server, sockets);
    return { ok: false, text: "run_tool_code 未能打开本机回环端口" };
  }

  // 辅助模块放临时目录，不写进对话工作区（并行调用不会互相覆盖，fs_ls 也看不到桥接脚本）。
  const scratch = mkdtempSync(join(tmpdir(), "bx-tool-code-"));
  const clientName = python ? "_bx_tool.py" : "_bx_tool.mjs";
  const scriptName = python ? "tool_code.py" : "tool_code.mjs";
  const clientPath = join(scratch, clientName);
  writeFileSync(clientPath, python ? PY_CLIENT : NODE_CLIENT, "utf8");
  const body = python
    ? `import sys\nsys.path.insert(0, ${JSON.stringify(scratch)})\nfrom _bx_tool import call_tool\n${opts.code}`
    : `import { callTool } from ${JSON.stringify(pathToFileURL(clientPath).href)};\nglobalThis.callTool = callTool;\nawait (async () => {\n${opts.code}\n})();\n`;
  const scriptPath = join(scratch, scriptName);
  writeFileSync(scriptPath, body, "utf8");

  const command = python ? "python" : "node";
  const child = spawn(command, [scriptPath], {
    cwd: opts.cwd,
    windowsHide: true,
    env: toolCodeEnv({
      BX_TOOL_PORT: String(port),
      BX_TOOL_TOKEN: token,
      NO_COLOR: "1",
      TERM: "dumb",
      BX_AGENT: "1",
    }),
  });

  let stdout = "";
  let stderr = "";
  let streamTruncated = false;
  let spawnError: Error | null = null;
  // 边收边掐：超过上限就停止累加并记一笔，避免「疯狂 print」在收齐前先把内存打爆。
  const push = (cur: string, chunk: string): string => {
    if (cur.length >= STREAM_CAPTURE_MAX) {
      streamTruncated = true;
      return cur;
    }
    return cur + chunk.slice(0, Math.max(0, STREAM_CAPTURE_MAX - cur.length));
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = push(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = push(stderr, chunk);
  });
  child.once("error", (err) => {
    spawnError = err;
  });

  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill(), opts.timeoutMs);
  const onAbort = () => child.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    hangTimer = setTimeout(() => {
      // 兜底：SIGTERM 之后进程仍未退出（忽略了软终止）——升级成强杀，不留孤儿进程继续跑。
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGTERM" });
    }, opts.timeoutMs + 1_500);
  });
  let status: { code: number | null; signal: NodeJS.Signals | null };
  try {
    status = await Promise.race([finished, hang]);
  } finally {
    clearTimeout(timer);
    clearTimeout(hangTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    await closeToolServer(server, sockets);
    rmSync(scratch, { recursive: true, force: true });
  }

  const captured = [stdout.trim(), stderr.trim() ? `--- stderr ---\n${stderr.trim()}` : ""].filter(Boolean).join("\n");
  const output = capOutput(
    streamTruncated ? `（输出已超 ${STREAM_CAPTURE_MAX} 字符被截断）\n${captured}` : captured,
    OUTPUT_MAX,
  );
  if (opts.signal?.aborted) return { ok: false, text: "已取消" };
  if (status.signal) return { ok: false, text: `代码超时或被中断（${opts.timeoutMs}ms）\n${output}` };
  if (spawnError || status.code === null) {
    return { ok: false, text: `找不到解释器 ${command}。Node 用 node，Python 用 python。\n${output}` };
  }
  if (status.code !== 0) return { ok: false, text: `代码退出码 ${status.code}\n${output}` };
  if (okCalls === 0) {
    return { ok: false, text: `代码没有成功调用只读工具，输出不能当作事实。\n${output}` };
  }
  return { ok: true, text: output || "（代码没有输出。请用 print / console.log 打出聚合结果）" };
}

function closeToolServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const sock of sockets) sock.destroy();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
