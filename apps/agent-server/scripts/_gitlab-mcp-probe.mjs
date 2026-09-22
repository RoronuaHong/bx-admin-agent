// 临时探针：以 stdio 方式拉起 @zereight/mcp-gitlab，握手 + 列工具 + 试调只读工具。
// token 从环境变量读，脚本内不落密钥。
import { spawn } from "node:child_process";

const PKG = process.env.GITLAB_MCP_PKG || "@zereight/mcp-gitlab@2.1.63";
const API_URL = process.env.GITLAB_API_URL || "https://git.work.xxbbc.com/api/v4";
const TOKEN = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
const PROJECT = process.env.PROBE_PROJECT || "web/bx-film-admin-in2";

if (!TOKEN) {
  console.error("missing GITLAB_PERSONAL_ACCESS_TOKEN");
  process.exit(2);
}

const child = spawn("npx", ["-y", PKG, "--permission-mode=readonly"], {
  shell: true,
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
child.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.error("[server]", s.slice(0, 400));
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
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const short = (o) => JSON.stringify(o).slice(0, 300);

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "1.0.0" },
  });
  console.log("initialize:", init.result?.serverInfo ? short(init.result.serverInfo) : short(init));
  notify("notifications/initialized", {});

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools || [];
  console.log("tools count:", tools.length);
  const names = tools.map((t) => t.name);
  console.log("sample:", names.slice(0, 25).join(", "));

  const pick = (re) => names.filter((n) => re.test(n));
  console.log("project-ish:", pick(/project/i).slice(0, 12).join(", "));
  console.log("repo-file-ish:", pick(/file|blob|tree|branch|commit/i).slice(0, 12).join(", "));

  const candidates = [
    ["project detail", names.find((n) => /^get_project$/.test(n)), { project_id: PROJECT }],
    ["branches", names.find((n) => /^list_branches$/.test(n)), { project_id: PROJECT }],
    ["repo tree", names.find((n) => /^get_repository_tree$/.test(n)), { project_id: PROJECT }],
    ["file content", names.find((n) => /^get_file_contents$/.test(n)), { project_id: PROJECT, file_path: "package.json", ref: "dev" }],
  ];
  for (const [label, name, args] of candidates) {
    if (!name) {
      console.log(`-- ${label}: (no matching tool)`);
      continue;
    }
    const schema = tools.find((t) => t.name === name)?.inputSchema;
    console.log(`== ${label} [${name}] required=${JSON.stringify(schema?.required || [])}`);
    try {
      const res = await rpc("tools/call", { name, arguments: args }, 90000);
      console.log(`   raw=${JSON.stringify(res.result ?? res).slice(0, 700)}`);
    } catch (e) {
      console.log(`   ERROR ${e.message}`);
    }
  }
} catch (e) {
  console.error("probe failed:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
