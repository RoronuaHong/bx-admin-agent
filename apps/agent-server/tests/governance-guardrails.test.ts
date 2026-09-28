// 交付物生成硬卡点（CI 级）：源码级钉死 §11 / DELIVERABLE_GUARDRAILS.md 的五条原则，
// 防"确定性编造 / 外链回归"被重新引入。行为级回归由 export-formats / html-self-contained 锁死。
//
// 设计取舍：只扫"交付物生成"相关源码（report.ts 是 HTML 生成器、builtins.ts 是工具分发），
// 不扫 web-search / dingtalk-doc 等合法外部 API 调用，避免误报。注释先剥离，避免历史说明触发误报。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(root, "src", rel), "utf-8");

// 去掉 /* */ 块注释与 // 行注释（保留字符串字面量里的 URL）。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("[G1] 导出物零外链（源码级）", () => {
  it("report.ts 不出现 http(s):// 字面量（除 SVG 命名空间这一处）", () => {
    const code = stripComments(readSrc("report.ts"));
    const hits = [...code.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    const forbidden = hits.filter((u) => u !== "http://www.w3.org/2000/svg");
    expect(forbidden, `发现外部链接字面量: ${forbidden.join(", ")}`).toEqual([]);
  });
});

describe("[G2] 禁止工具侧确定性编造（源码级）", () => {
  it("report.ts / builtins.ts 无默认标题兜底 `|| \"数据分析报告\"` / `|| \"导出数据\"`", () => {
    const code = stripComments(readSrc("report.ts") + "\n" + readSrc("builtins.ts"));
    const bad = ["数据分析报告", "导出数据"].filter((s) =>
      new RegExp(`(?:\\|\\||\\?\\?)\\s*["']${s}["']`).test(code),
    );
    expect(bad, `发现默认标题兜底: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("[G3] 零外链软护栏存在且覆盖手写 HTML", () => {
  it("builtins.ts 含 externalRefHint 与 .html 下载卡片逻辑", () => {
    const code = readSrc("builtins.ts");
    expect(code).toContain("externalRefHint");
    expect(code).toMatch(/\.html|\.htm|isHtmlArtifact/);
  });
});

describe("[G4] image_gen / run_script 已对齐自包含口径", () => {
  it("image_gen 把远端 url 本地化落盘（不泄漏外部链接给交付物）", () => {
    const code = readSrc("builtins.ts");
    const i = code.indexOf('case "image_gen"');
    const block = code.slice(i, i + 3200); // 覆盖到 fsWriteBinary / b64_json 所在行
    expect(block, "image_gen 未把结果落到工作区（自包含）").toContain("fsWriteBinary");
    expect(block, "image_gen 未优先内联字节（b64_json）").toContain("b64_json");
  });
  it("run_script 只透传原始执行输出，不包裹编造文案", () => {
    const code = readSrc("builtins.ts");
    const i = code.indexOf('case "run_script"');
    const block = code.slice(i, i + 1400); // 覆盖到 runShell 调用
    expect(block, "run_script 未直接透传执行结果（runShell）").toContain("runShell");
  });
});
