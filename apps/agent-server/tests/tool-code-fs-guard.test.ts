// run_tool_code 凭据文件守卫（src/tool-code-fs-guard.ts）：
// 模型写的代码 + read 级免确认 + 不受限出网 ⇒ 「读 .env 再外发」是最现实的凭据外带路径。
// 这里既测纯函数判定，也**真起一次子进程**验证：凭据文件读不到、工作区文件照常读、工具桥不受影响。
import { test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENY_CHILDPROC_CODE,
  DENY_CHILDPROC_MESSAGE,
  DENY_CODE,
  DENY_MESSAGE,
  guardSourceLooksIntact,
  isDeniedToolCodePath,
  nodeFsGuardPreloadSource,
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
  // 路径片段放行必须**含 /** —— 否则 `TOOL_CODE_FS_ALLOW=.` 会让任何路径都命中而全局关停守卫。
  expect(isDeniedToolCodePath("D:/Code/bx-film-admin-in2/.env", ["d:/code/bx-film-admin-in2/"])).toBe(false);
  expect(isDeniedToolCodePath("D:/Code/bx-film-admin-in2/.env", ["bx-film-admin-in2"])).toBe(true);
});

test("两侧守卫源码结构完整（防注入静默失效）", () => {
  const node = nodeFsGuardPreloadSource();
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

// ---- 三份实现一致性 ----
// 判定逻辑在三个地方各写了一份：TS 谓词（isDeniedToolCodePath）、注入的 JS 副本、注入的 Python 副本。
// TS 那份在 src 里没有调用点，若只测它就等于测了不生效的实现。这里把**注入源码真正跑起来**，
// 用同一张用例表逐条比对，任何一份漂移都会红。
const TABLE = [
  ".env",
  "/etc/app/.env.local",
  "D:\\Code\\app\\.env",
  "C:/certs/server.pem",
  "C:/certs/server.key",
  "C:/certs/store.p12",
  // 裸后缀：basename **等于**后缀本身。曾暴露 node 侧用 `>` 比较长度导致的漂移——
  // 该形态下 TS/Python 的 endswith 命中、node 侧的 `b.length > suf.length` 落空，放行。
  // 保留此样本，任何一份再退化为严格大于就会红。
  "/etc/certs/.pem",
  // 反面对照：形似但不构成后缀命中，必须放行（防止把守卫修成过度拦截）。
  "/etc/certs/.pema",
  "/home/u/.ssh/id_rsa",
  "C:/Users/u/.aws/credentials",
  "C:/Users/u/.docker/config.json",
  "C:/Users/u/.npmrc",
  "src/env.ts",
  "docs/environment.md",
  "data/users.csv",
] as const;

test("三份实现一致（node 侧注入源码真跑一遍，与 TS 谓词逐条比对）", async () => {
  const src = nodeFsGuardPreloadSource();
  const pre = mkdtempSync(join(tmpdir(), "bx-consist-"));
  const prePath = join(pre, "_bx_guard.cjs");
  const probePath = join(pre, "probe.mjs");
  writeFileSync(prePath, src, "utf8");
  // 直接复用注入源码里挂到 globalThis 的判定函数（它就是子进程里真正生效的那份）。
  writeFileSync(
    probePath,
    `const out = ${JSON.stringify(TABLE)}.map((p) => (globalThis.__bx_denied(p) ? 1 : 0));\nconsole.log(JSON.stringify(out));\n`,
    "utf8",
  );
  try {
    const raw = execFileSync(process.execPath, ["--require", prePath, probePath], { encoding: "utf-8" });
    const got = JSON.parse(raw.trim().split("\n").filter(Boolean).pop() || "[]") as number[];
    const want = TABLE.map((p) => (isDeniedToolCodePath(p) ? 1 : 0));
    expect(got.length).toBe(want.length);
    expect(got).toEqual(want);
    // 表里必须同时含「应拒」与「应放行」，否则这条用例本身没有区分力。
    expect(want.some((v) => v === 1)).toBe(true);
    expect(want.some((v) => v === 0)).toBe(true);
  } finally {
    rmSync(pre, { recursive: true, force: true });
  }
}, 30_000);

// ---- Python 侧副本一致性（与 node 侧对称的钉）----
// 判定逻辑在 TS / JS 注入副本 / Python 注入副本三处各写一份。node 侧已由上方用例钉住，
// 这里补 Python 副本：直接复用注入源码里定义的 `__bx_denied`（即子进程真正生效的那份），
// 对整张用例表逐条判定，与 TS 谓词比对。任何一份漂移都会红。
test("三份实现一致（python 侧注入源码真跑一遍，与 TS 谓词逐条比对）", () => {
  const src = pyFsGuardSource();
  const py = mkdtempSync(join(tmpdir(), "bx-consist-py-"));
  try {
    const srcPath = join(py, "_bx_guard.py");
    const tablePath = join(py, "table.json");
    const probePath = join(py, "probe.py");
    writeFileSync(srcPath, src, "utf8");
    writeFileSync(tablePath, JSON.stringify(TABLE), "utf8");
    writeFileSync(
      probePath,
      `${src}\nimport json\nwith open(${JSON.stringify(tablePath)}) as f:\n    tbl = json.load(f)\nprint(json.dumps([1 if __bx_denied(p) else 0 for p in tbl]))\n`,
      "utf8",
    );
    let raw: string;
    try {
      raw = execFileSync("python", [probePath], { encoding: "utf-8" });
    } catch {
      // Python 未安装：跳过（与下方真实子进程用例一致，不因环境缺失判红）。
      return;
    }
    const got = JSON.parse(raw.trim().split("\n").filter(Boolean).pop() || "[]") as number[];
    const want = TABLE.map((p) => (isDeniedToolCodePath(p) ? 1 : 0));
    expect(got.length).toBe(want.length);
    expect(got).toEqual(want);
    expect(want.some((v) => v === 1)).toBe(true);
    expect(want.some((v) => v === 0)).toBe(true);
  } finally {
    rmSync(py, { recursive: true, force: true });
  }
}, 30_000);

// ---- 绕道回归（这些是审计实测可达的通道，必须钉住）----
test("绕道：node:fs 命名导出解构（ESM 快照）也被拦", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-bypass-ns-"));
  try {
    writeFileSync(join(cwd, ".env"), "API_KEY=sk-leak\n", "utf8");
    const r = await runToolCode({
      language: "node",
      code: [
        // B1 绕过点：过去这样拿到的是未包装的原函数
        'const { readFileSync } = await import("node:fs");',
        'try { readFileSync(".env", "utf8"); console.log("ns=LEAKED"); } catch (e) { console.log("ns=" + (e.code || "err")); }',
        'const ns = await import("node:fs");',
        'try { ns.readFileSync(".env", "utf8"); console.log("nsdot=LEAKED"); } catch (e) { console.log("nsdot=" + (e.code || "err")); }',
      ].join("\n"),
      cwd,
      timeoutMs: 20_000,
      callTool: async () => ({ ok: true, text: "x" }),
    });
    expect(r.text).toContain(`ns=${DENY_CODE}`);
    expect(r.text).toContain(`nsdot=${DENY_CODE}`);
    expect(r.text).not.toContain("LEAKED");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("绕道：回调式 fs.readFile / copyFileSync / openAsBlob 也被拦", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-bypass-cb-"));
  try {
    writeFileSync(join(cwd, ".env"), "API_KEY=sk-leak\n", "utf8");
    const r = await runToolCode({
      language: "node",
      code: [
        'const fs = (await import("node:fs")).default;',
        'const out = [];',
        'try { fs.readFile(".env", "utf8", () => {}); out.push("cb=LEAKED"); } catch (e) { out.push("cb=" + (e.code || "err")); }',
        'try { fs.copyFileSync(".env", "copy.txt"); out.push("copy=LEAKED"); } catch (e) { out.push("copy=" + (e.code || "err")); }',
        'if (typeof fs.openAsBlob === "function") { try { fs.openAsBlob(".env"); out.push("blob=LEAKED"); } catch (e) { out.push("blob=" + (e.code || "err")); } }',
        'console.log(out.join(" | "));',
      ].join("\n"),
      cwd,
      timeoutMs: 20_000,
      callTool: async () => ({ ok: true, text: "x" }),
    });
    expect(r.text).toContain(`cb=${DENY_CODE}`);
    expect(r.text).toContain(`copy=${DENY_CODE}`);
    expect(r.text).not.toContain("LEAKED");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("绕道：TOOL_CODE_FS_ALLOW=. 不得把守卫全局关停（放行粒度修复）", () => {
  // 子串包含会让几乎任何路径都命中 "."；修复后裸 basename 只做相等匹配。
  expect(isDeniedToolCodePath("D:/app/.env", ["."])).toBe(true);
  expect(isDeniedToolCodePath("D:/app/.env", ["env"])).toBe(true);
  // basename 相等才放行
  expect(isDeniedToolCodePath("D:/app/.env", [".env"])).toBe(false);
  // 含 / 的片段才走路径包含
  expect(isDeniedToolCodePath("D:/proj/.env", ["d:/proj/"])).toBe(false);
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
  expect(nodeFsGuardPreloadSource()).toContain(head);
  expect(pyFsGuardSource()).toContain(head);
  // 两侧都必须给出可识别的错误标记
  expect(nodeFsGuardPreloadSource()).toContain(DENY_CODE);
  expect(pyFsGuardSource()).toContain("PermissionError");
});

// ---- 命令执行守卫（审计第 2 项：Node ESM 命名导入绕过 permission model）----
// run_tool_code 子进程里的代码若 `import { execSync } from "node:child_process"` 就能执行任意命令，
// 绕过工具桥接层的 resolveToolRisk 只读/免确认判定。修复在 --require 预加载里把 child_process 的
// exec/spawn 家族在模块层打补丁抛错——无论 ESM 命名导入 / 动态 import() / createRequire 都拿不到可用函数。
test("真实子进程（node）：child_process 各导入形态均被封死，工具桥不受影响", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-cp-"));
  try {
    const result = await runToolCode({
      language: "node",
      code: [
        "const out = [];",
        // ESM 命名导入（审计点名的具体绕过形态）
        'try { const { execSync } = await import("node:child_process"); execSync("echo hi"); out.push("named=LEAKED"); } catch (e) { out.push("named=" + (e.code || "err")); }',
        // 动态 import()
        'try { const cp2 = await import("node:child_process"); cp2.spawnSync("echo", ["hi"]); out.push("dyn=LEAKED"); } catch (e) { out.push("dyn=" + (e.code || "err")); }',
        // createRequire 再 require（ESM 里 require 不可用，这是真实的等价通道）
        'try { const { createRequire } = await import("node:module"); const cp3 = createRequire(import.meta.url)("node:child_process"); cp3.exec("echo hi"); out.push("creq=LEAKED"); } catch (e) { out.push("creq=" + (e.code || "err")); }',
        // 工具桥接完好（证明封的是命令执行，不是把工具用瘫）
        'try { await callTool("fs_read", { path: "x" }); out.push("tool=OK"); } catch (e) { out.push("tool=ERR:" + e.message); }',
        'console.log(out.join(" | "));',
      ].join("\n"),
      cwd,
      timeoutMs: 20_000,
      callTool: async () => ({ ok: true, text: "TOOL-OK" }),
    });
    const text = result.text;
    expect(text).toContain(`named=${DENY_CHILDPROC_CODE}`);
    expect(text).toContain(`dyn=${DENY_CHILDPROC_CODE}`);
    expect(text).toContain(`creq=${DENY_CHILDPROC_CODE}`);
    expect(text).not.toContain("LEAKED");
    expect(text).toContain("tool=OK");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("真实子进程（python）：subprocess / os.system / os.popen 被封死", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-py-cp-"));
  try {
    const r = await runToolCode({
      language: "python",
      code: [
        "out = []",
        'try:\n    import subprocess\n    subprocess.run(["echo", "hi"])\n    out.append("run=LEAKED")\nexcept Exception as e:\n    out.append("run=blocked")',
        'try:\n    import os\n    os.system("echo hi")\n    out.append("system=LEAKED")\nexcept Exception as e:\n    out.append("system=blocked")',
        'try:\n    import os\n    os.popen("echo hi").read()\n    out.append("popen=LEAKED")\nexcept Exception as e:\n    out.append("popen=blocked")',
        'print(" | ".join(out))',
      ].join("\n"),
      cwd,
      timeoutMs: 25_000,
      callTool: async () => ({ ok: true, text: "x" }),
    });
    // Python 未安装时跳过（不因环境缺失把用例判红）。
    if (r.text.includes("找不到解释器")) {
      expect(true).toBe(true);
      return;
    }
    expect(r.text).toContain("run=blocked");
    expect(r.text).toContain("system=blocked");
    expect(r.text).toContain("popen=blocked");
    expect(r.text).not.toContain("LEAKED");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 45_000);

test("两侧源码均含 child_process 守卫（结构自检互补，防该块静默失效）", () => {
  // Node 侧：拒绝码与提示文案都注入，且被 guardSourceLooksIntact 覆盖
  expect(nodeFsGuardPreloadSource()).toContain(DENY_CHILDPROC_CODE);
  expect(nodeFsGuardPreloadSource()).toContain(DENY_CHILDPROC_MESSAGE.slice(0, 12));
  expect(guardSourceLooksIntact(nodeFsGuardPreloadSource())).toBe(true);
  // Python 侧：命令执行守卫走 __BX_CP_MSG（提示文案），结构自检经 __bx_guard_cmd 覆盖
  expect(pyFsGuardSource()).toContain(DENY_CHILDPROC_MESSAGE.slice(0, 12));
  expect(guardSourceLooksIntact(pyFsGuardSource())).toBe(true);
});

// Python 侧此前**零**真实子进程覆盖（只有字符串断言），而它恰恰是最容易被一行绕过的那一侧：
// 只包 builtins.open 时 io.open 不受约束，而 pathlib.Path.read_text() 内部正是走 io.open。
test("python 侧真实子进程：builtins.open / io.open / pathlib / os.open 均被拦", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bx-py-"));
  try {
    writeFileSync(join(cwd, ".env"), "API_KEY=sk-leak\n", "utf8");
    const envPath = join(cwd, ".env");
    const r = await runToolCode({
      language: "python",
      code: [
        "import io, os",
        "from pathlib import Path",
        "out = []",
        `try:\n    open(${JSON.stringify(envPath)}).read()\n    out.append("builtins=LEAKED")\nexcept Exception as e:\n    out.append("builtins=blocked")`,
        `try:\n    io.open(${JSON.stringify(envPath)}).read()\n    out.append("io=LEAKED")\nexcept Exception as e:\n    out.append("io=blocked")`,
        `try:\n    Path(${JSON.stringify(envPath)}).read_text()\n    out.append("pathlib=LEAKED")\nexcept Exception as e:\n    out.append("pathlib=blocked")`,
        `try:\n    os.open(${JSON.stringify(envPath)}, os.O_RDONLY)\n    out.append("osopen=LEAKED")\nexcept Exception as e:\n    out.append("osopen=blocked")`,
        'print(" | ".join(out))',
      ].join("\n"),
      cwd,
      timeoutMs: 25_000,
      callTool: async () => ({ ok: true, text: "x" }),
    });
    // Python 未安装时跳过（不因环境缺失把用例判红）。
    if (r.text.includes("找不到解释器")) {
      expect(true).toBe(true);
      return;
    }
    expect(r.text).toContain("builtins=blocked");
    expect(r.text).toContain("io=blocked");
    expect(r.text).toContain("pathlib=blocked");
    expect(r.text).toContain("osopen=blocked");
    expect(r.text).not.toContain("LEAKED");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 45_000);
