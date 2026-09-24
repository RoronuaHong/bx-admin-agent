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

/**
 * 每次改写把 mtime 推后一个**严格递增**的量。
 *
 * 不能只写 `Date.now() + 1000`：本文件用例各只跑 1ms 左右，相邻两个用例极可能落在**同一毫秒**，
 * 平移后 mtime 依旧相同 → 缓存命中旧值 → 用例假红（曾连续两次在全量跑里随机失败）。
 * 递增偏移量保证后一次一定大于前一次，与机器快慢无关。
 */
let clockTick = 0;
function touch(): void {
  clockTick += 1;
  const t = new Date(Date.now() + 1000 * clockTick);
  utimesSync(CFG, t, t);
}

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
  touch();
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe("new");
});

test("[C] 内容未变时不重复解析（缓存仍生效，不是每次都读盘）", () => {
  const before = loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN;
  writeFileSync(CFG, readFileSync(CFG, "utf-8"), "utf-8"); // 重写但内容一致
  touch(); // mtime 变了 → 会重读，但值应完全一致
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe(before);
});

test("[D] 列表清空 → 不再返回已移除的服务器（不留在旧列表里）", () => {
  writeFileSync(CFG, "[]", "utf-8");
  touch();
  expect(loadServers().find((s) => s.id === "gitlab")).toBeUndefined();
});

// 钉住「失效键含 size」：mtime 完全没变、只有长度变化时也必须重载——
// 只按 mtime 失效的话，同毫秒内的改写会被缓存吞掉（改了却用旧值）。
test("[E] mtime 相同但长度变化 → 仍然重载（size 参与失效）", () => {
  writeFileSync(
    CFG,
    JSON.stringify([{ id: "gitlab", label: "GitLab", transport: "stdio", enabled: true, env: { TOKEN: "same-ms" } }]),
    "utf-8",
  );
  const t = new Date(Date.now() + 1000 * 100); // 固定到一个更远的未来时间
  utimesSync(CFG, t, t);
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe("same-ms");
  // 关键：mtime 保持不动，只改内容（长度不同）
  writeFileSync(CFG, JSON.stringify([{ id: "gitlab", label: "GitLab", transport: "stdio", enabled: true, env: { TOKEN: "x" } }]), "utf-8");
  utimesSync(CFG, t, t);
  expect(loadServers().find((s) => s.id === "gitlab")?.env?.TOKEN).toBe("x");
});
