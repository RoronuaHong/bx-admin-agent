// POST /chat/stream 的正向工具白名单透传：显式传入才收窄，不传等价现状。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("/chat/stream toolAllowlist 接线契约", () => {
  it("body 声明 toolAllowlist，且只收字符串数组", () => {
    expect(appSource).toContain("toolAllowlist?: string[];");
    expect(appSource).toContain("Array.isArray(body.toolAllowlist)");
    expect(appSource).toContain(
      '? { toolAllowlist: body.toolAllowlist.filter((x): x is string => typeof x === "string") }',
    );
  });

  it("不传时不写字段，chatStream 的 allowBuiltins 保持 null", () => {
    expect(appSource).toContain("...(Array.isArray(body.toolAllowlist)");
    const chatSource = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(chatSource).toContain("const allowBuiltins = opts.toolAllowlist?.length");
    expect(chatSource).toContain("(!allowBuiltins || allowBuiltins.has(spec.name))");
  });
});
