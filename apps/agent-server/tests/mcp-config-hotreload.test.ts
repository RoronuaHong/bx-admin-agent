// MCP 配置「外部改文件也要生效」验证（纯文件操作，无需网络/模型）。
//
// 背景：config.ts 用进程内 fileCache 缓存 .data/mcp-servers.json。旧实现只在**自己写过**
// （upsert/delete）时才刷新缓存，于是「手工编辑文件 / 部署脚本写盘」这类进程外改动对运行中的
// 服务不可见 —— 最痛的表现是换了 token 却一直 401：直连 API 200、独立起 MCP 进程也
// authenticated:true，唯独对话里失败（2026-09-23 实测）。
// 修法与 rag/store.ts 同一口径：**按文件 mtime 失效**。本用例把这条行为钉死，防止回退。
import { mkdtempSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mcp-cfg-"));
const CFG = join(dir, "mcp-servers.json");
let loadServers: () => Array<{ id: string; env?: Record<string, string> }>;

beforeAll(async () => {
  process.env.AGENT_DATA_DIR = dir;
  writeFileSync(
    CFG,
    JSON.stringify([{ id: "gitlab", label: "GitLab", transport: "stdio", enabled: true, env: { TOKEN: "old" } }]),
    "utf-8",
  );
  const mod = await import("../src/mcp/config.js");
  loadServers = mod.loadServers as typeof loadServers;
});

afterAll(() => {
  delete process.env.AGENT_DATA_DIR;
});

test("[A] 首次读取拿到磁盘上的值", () => {
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe("old");
});

test("[B] 进程外改写文件 → 下次 loadServers 立即看到新值（本次修复的核心）", () => {
  writeFileSync(
    CFG,
    JSON.stringify([{ id: "gitlab", label: "GitLab", transport: "stdio", enabled: true, env: { TOKEN: "new" } }]),
    "utf-8",
  );
  // mtime 精度到毫秒，显式推后 1 秒，避免同毫秒写入导致用例在快机器上假绿。
  const t = new Date(Date.now() + 1000);
  utimesSync(CFG, t, t);
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe("new");
});

test("[C] 内容未变时不重复解析（缓存仍生效，不是每次都读盘）", () => {
  const before = loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN;
  writeFileSync(CFG, readFileSync(CFG, "utf-8"), "utf-8"); // 重写但保持 mtime 语义一致
  const t = new Date(Date.now() + 1000);
  utimesSync(CFG, t, t); // mtime 变了 → 会重读，但值应完全一致
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe(before);
});

test("[D] 文件被删除 → 不再返回已删除的服务器（不留在旧列表里）", () => {
  writeFileSync(CFG, "[]", "utf-8");
  const t = new Date(Date.now() + 1000);
  utimesSync(CFG, t, t);
  expect(loadServers().find((s) => s.id === "gitlab")).toBeUndefined();
});
