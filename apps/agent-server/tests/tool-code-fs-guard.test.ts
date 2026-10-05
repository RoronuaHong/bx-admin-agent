// run_tool_code 凭据文件守卫（src/tool-code-fs-guard.ts）：
// 模型写的代码 + read 级免确认 + 不受限出网 ⇒ 「读 .env 再外发」是最现实的凭据外带路径。
// 这里既测纯函数判定，也**真起一次子进程**验证：凭据文件读不到、工作区文件照常读、工具桥不受影响。
import { test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENY_MESSAGE,
  guardSourceLooksIntact,
  isDeniedToolCodePath,
  nodeFsGuardSource,
  parseFsAllow,
  pyFsGuardSource,
} from "../src/tool-code-fs-guard.js";
import { runToolCode } from "../src/tool-code.js";

test("纯函数：.env 与变体、私钥、云凭据目录一律拒", () => {
  expect(isDeniedToolCodePath(".env")).toBe(true);
  expect(isDeniedToolCodePath("D:/Code/app/.env")).toBe(true);
  expect(isDeniedToolCodePath("/etc/bx/.env.local")).toBe(true);
  expect(isDeniedToolCodePath("/etc/bx/.env.production")).toBe(true);
  // 私钥 / 密钥库后缀
  expect(isDeniedToolCodePath("/home/u/.ssh/id_rsa")).toBe(true);
  expect(isDeniedToolCodePath("C:/certs/server.pem")).toBe(true);
  expect(isDeniedToolCodePath("C:/certs/server.key")).toBe(true);
  expect(isDeniedToolCodePath("C:/certs/store.p12")).toBe(true);
  // 云凭据目录
  expect(isDeniedToolCodePath("C:/Users/u/.aws/credentials")).toBe(true);
  expect(isDeniedToolCodePath("C:/Users/u/.docker/config.json")).toBe(true);
  // 其他常见凭据文件
  expect(isDeniedToolCodePath("C:/Users/u/.npmrc")).toBe(true);
  expect(isDeniedToolCodePath("C:/Users/u/.git-credentials")).toBe(true);
  expect(isDeniedToolCodePath("C:/Users/u/.pgpass")).toBe(true);
  // Windows 反斜杠同样识别
  expect(isDeniedToolCodePath("D:\\Code\\app\\.env")).toBe(true);
});

test("纯函数：正当读取不受影响（守卫不能把工具用瘫）", () => {
  expect(isDeniedToolCodePath("data/users.csv")).toBe(false);
  expect(isDeniedToolCodePath("src/app/config.ts")).toBe(false);
  expect(isDeniedToolCodePath("D:/Code/bx-film-admin-in2/src/api/user.ts")).toBe(false);
  expect(isDeniedToolCodePath("report.md")).toBe(false);
  // 名字相近但不是凭据的不能误伤
  expect(isDeniedToolCodePath("src/env.ts")).toBe(false);
  expect(isDeniedToolCodePath("docs/environment.md")).toBe(false);
  expect(isDeniedToolCodePath("data/keys.md")).toBe(false);
  expect(isDeniedToolCodePath("")).toBe(false);
});

test("纯函数：TOOL_CODE_FS_ALLOW 提供精确逃逸口", () => {
  expect(parseFsAllow(" .env , id_rsa ")).toEqual([".env", "id_rsa"]);
  expect(parseFsAllow(undefined)).toEqual([]);
  // 放行优先于拒绝
  expect(isDeniedToolCodePath("/etc/.env", [".env"])).toBe(false);
  expect(isDeniedToolCodePath("/home/u/.ssh/id_rsa", ["id_rsa"])).toBe(false);
  // 未列入的仍然拒
  expect(isDeniedToolCodePath("/etc/.env", ["id_rsa"])).toBe(true);
  // 片段放行（如整个业务配置目录）
  expect(isDeniedToolCodePath("D:/Code/bx-film-admin-in2/.env", ["bx-film-admin-in2"])).toBe(false);
});

test("两侧守卫源码结构完整（防注入静默失效）", () => {
  const node = nodeFsGuardSource();
  const py = pyFsGuardSource();
  expect(guardSourceLooksIntact(node)).toBe(true);
  expect(guardSourceLooksIntact(py)).toBe(true);
  // 名单数据内联进源码，不依赖子进程能读到服务端模块
  expect(node).toContain(".pem");
  expect(py).toContain(".pem");
  // 不得残留模板占位
  expect(node).not.toContain("${JSON");
  expect(py).not.toContain("${JSON");
});

test("真实子进程（node）：工作区文件照常读，凭据文件被拒，工具桥仍可用", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-guard-cwd-"));
  const secretDir = mkdtempSync(join(tmpdir(), "bx-guard-secret-"));
  try {
    // 工作区内的正常文件（必须能读，否则守卫把工具用瘫了）
    writeFileSync(join(cwd, "data.txt"), "PUBLIC-OK-123", "utf8");
    // 工作区内的凭据文件（同样应被拒——守卫是全局的，不因在工作区内就放行）
    writeFileSync(join(cwd, ".env"), "MONGO_URI=mongodb://secret\nAPI_KEY=sk-should-not-leak\n", "utf8");
    // 工作区外的私钥
    writeFileSync(join(secretDir, "server.pem"), "-----BEGIN PRIVATE KEY-----\nleak\n", "utf8");

    const result = await runToolCode({
      language: "node",
      code: [
        // 用户代码被包在 async IIFE 里，静态 import 不可用（既有行为），故用动态 import。
        'const fs = (await import("node:fs")).default;',
        "const out = [];",
        'try { out.push("public=" + fs.readFileSync("data.txt", "utf8").trim()); } catch (e) { out.push("public=ERR:" + e.code); }',
        'try { const s = fs.readFileSync(".env", "utf8"); out.push("env=LEAKED:" + s.length); } catch (e) { out.push("env=blocked:" + (e.code || "err")); }',
        `try { const s = fs.readFileSync(${JSON.stringify(join(secretDir, "server.pem"))}, "utf8"); out.push("pem=LEAKED:" + s.length); } catch (e) { out.push("pem=blocked:" + (e.code || "err")); }`,
        'try { const r = await callTool("fs_read", { path: "data.txt" }); out.push("tool=" + (r || "").trim()); } catch (e) { out.push("tool=ERR:" + e.message); }',
        'console.log(out.join(" | "));',
      ].join("\n"),
      cwd,
      timeoutMs: 20_000,
      callTool: async (name, args) => {
        if (name === "fs_read") return { ok: true, text: `TOOL-OK:${String(args.path)}` };
        return { ok: false, text: `unexpected tool ${name}` };
      },
    });

    const text = result.text;
    expect(text).toContain("public=PUBLIC-OK-123");
    expect(text).toContain("env=blocked:BX_FS_GUARD_DENIED");
    expect(text).toContain("pem=blocked:BX_FS_GUARD_DENIED");
    // 内容一个字都不能漏
    expect(text).not.toContain("LEAKED");
    expect(text).not.toContain("sk-should-not-leak");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("MONGO_URI");
    // 工具桥完好
    expect(text).toContain("tool=TOOL-OK:data.txt");
    expect(result.ok).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
}, 40_000);

test("真实子进程（node）：promises.readFile / createReadStream / openSync 同样被拦", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-guard-p-"));
  try {
    writeFileSync(join(cwd, ".env"), "API_KEY=sk-leak\n", "utf8");
    const result = await runToolCode({
      language: "node",
      code: [
        'const fs = (await import("node:fs")).default;',
        "const out = [];",
        'try { await fs.promises.readFile(".env", "utf8"); out.push("promises=LEAKED"); } catch (e) { out.push("promises=blocked:" + (e.code || "err")); }',
        'try { fs.createReadStream(".env"); out.push("stream=LEAKED"); } catch (e) { out.push("stream=blocked:" + (e.code || "err")); }',
        'try { fs.openSync(".env", "r"); out.push("open=LEAKED"); } catch (e) { out.push("open=blocked:" + (e.code || "err")); }',
        'console.log(out.join(" | "));',
      ].join("\n"),
      cwd,
      timeoutMs: 20_000,
      callTool: async () => ({ ok: true, text: "x" }),
    });
    expect(result.text).toContain("promises=blocked:BX_FS_GUARD_DENIED");
    expect(result.text).toContain("open=blocked:BX_FS_GUARD_DENIED");
    expect(result.text).not.toContain("LEAKED");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("真实子进程（node）：TOOL_CODE_FS_ALLOW 可精确放行（误伤时的逃生口）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-guard-a-"));
  const prev = process.env.TOOL_CODE_FS_ALLOW;
  try {
    writeFileSync(join(cwd, ".env"), "ALLOWED-CONTENT\n", "utf8");
    process.env.TOOL_CODE_FS_ALLOW = ".env";
    const result = await runToolCode({
      language: "node",
      code: [
        'const fs = (await import("node:fs")).default;',
        'try { console.log("got=" + fs.readFileSync(".env", "utf8").trim()); } catch (e) { console.log("blocked:" + (e.code || "err")); }',
      ].join("\n"),
      cwd,
      timeoutMs: 20_000,
      callTool: async () => ({ ok: true, text: "x" }),
    });
    expect(result.text).toContain("got=ALLOWED-CONTENT");
  } finally {
    if (prev === undefined) delete process.env.TOOL_CODE_FS_ALLOW;
    else process.env.TOOL_CODE_FS_ALLOW = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("守卫提示文案两侧一致（排障时能对上）", () => {
  const head = DENY_MESSAGE.slice(0, 12);
  expect(nodeFsGuardSource()).toContain(head);
  expect(pyFsGuardSource()).toContain(head);
  // 两侧都必须给出可识别的错误标记
  expect(nodeFsGuardSource()).toContain("BX_FS_GUARD_DENIED");
  expect(pyFsGuardSource()).toContain("PermissionError");
});
