// 临时探针：直接拉起本地安装的 @zereight/mcp-gitlab（跳过 npx），握手 + 打印全部工具名。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const ENTRY = process.env.GITLAB_MCP_ENTRY || "node_modules/@zereight/mcp-gitlab/build/index.js";
const API_URL = process.env.GITLAB_API_URL || "https://git.work.xxbbc.com/api/v4";
const TOKEN = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("missing GITLAB_PERSONAL_ACCESS_TOKEN");
  process.exit(2);
}
if (!existsSync(ENTRY)) {
  console.error(`entry not found: ${ENTRY}`);
  process.exit(2);
}

const child = spawn(process.execPath, [ENTRY], {
  env: {
    ...process.env,
    GITLAB_API_URL: API_URL,
    GITLAB_PERSONAL_ACCESS_TOKEN: TOKEN,
    GITLAB_DISABLE_VERSION_CHECK: "true",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "1.0.0" },
  });
  console.log("serverInfo:", JSON.stringify(init.result?.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const list = await rpc("tools/list", {});
  const tools = list.result?.tools || [];
  console.log("count:", tools.length);
  console.log(tools.map((t) => t.name).join("\n"));
} catch (e) {
  console.error("probe failed:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
