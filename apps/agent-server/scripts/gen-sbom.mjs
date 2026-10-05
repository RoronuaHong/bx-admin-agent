#!/usr/bin/env node
/**
 * 生成 CycloneDX 1.5 SBOM（P2 供应链，对齐 OWASP LLM05 / ASI06）。
 *
 * 为什么：供应链治理的第一步是「知道自己到底装了什么」。出事时能立刻回答
 * 「我们受不受影响」，而不是临时翻 node_modules。
 *
 * 做法（刻意零新依赖）：复用 `pnpm licenses list --prod --json` 的**已安装**清单——
 * 它给的是真实装上的版本与许可证，比读 package.json 的声明范围更接近事实。
 * 只做**生产依赖**（--prod），开发依赖不进交付物 SBOM。
 *
 * 用法：node scripts/gen-sbom.mjs [输出路径]（默认 .data/sbom.cdx.json）
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const OUT = process.argv[2] || resolve(REPO_ROOT, ".data", "sbom.cdx.json");

// Windows 上 pnpm 是 .cmd 垫片：`spawnSync("pnpm")` 会 ENOENT，必须显式带扩展名。
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function pnpm(args) {
  // Node 22 在 Windows 上 spawnSync .cmd 会 EINVAL（本机已踩过），统一走 `cmd /c`。
  const shell = process.env.ComSpec || "cmd.exe";
  return execFileSync(shell, ["/c", PNPM, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** pnpm 输出顶层是 { license: [pkg...] }，拍平成一个数组并按 name@version 去重。 */
function collect() {
  const raw = pnpm(["licenses", "list", "--prod", "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`pnpm licenses 输出不是合法 JSON：${String((err)?.message || err)}`);
  }
  const seen = new Map();
  for (const list of Object.values(parsed)) {
    if (!Array.isArray(list)) continue;
    for (const pkg of list) {
      if (!pkg?.name) continue;
      const version = Array.isArray(pkg.versions) ? pkg.versions[0] : undefined;
      if (!version) continue;
      const key = `${pkg.name}@${version}`;
      if (!seen.has(key)) {
        seen.set(key, {
          name: pkg.name,
          version,
          license: pkg.license || undefined,
          homepage: pkg.homepage || undefined,
          author: typeof pkg.author === "string" ? pkg.author : undefined,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** CycloneDX 许可证字段：有 SPDX 式标识就用 id，否则退回 name（不编造 id）。 */
function licenseOf(license) {
  if (!license) return [{ name: "UNKNOWN" }];
  const single = String(license).trim();
  // pnpm 偶尔给 "MIT OR Apache-2.0" 这类表达式——原样保留为 name，不做拆分（拆分要 SPDX 解析器）。
  if (/^[A-Za-z0-9.\-+]+$/.test(single)) return [{ id: single }];
  return [{ name: single }];
}

const components = collect().map((pkg) => ({
  type: "library",
  name: pkg.name,
  version: pkg.version,
  "bom-ref": `${pkg.name}@${pkg.version}`,
  ...(pkg.license ? { licenses: licenseOf(pkg.license) } : {}),
  ...(pkg.homepage ? { externalReferences: [{ type: "website", url: pkg.homepage }] } : {}),
}));

const release = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
})();

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: "bx-admin-agent",
      version: process.env.RELEASE || release,
      "bom-ref": "bx-admin-agent",
    },
    tools: [{ name: "scripts/gen-sbom.mjs", vendor: "bx-admin-agent" }],
  },
  components,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(bom, null, 2)}\n`, "utf-8");
console.log(`SBOM 已生成：${OUT}`);
console.log(`组件数（生产依赖）：${components.length}`);
const unknown = components.filter((c) => !c.licenses || c.licenses[0]?.name === "UNKNOWN").length;
console.log(`许可证未知：${unknown}${unknown ? "（建议人工核对，不自动猜）" : ""}`);
