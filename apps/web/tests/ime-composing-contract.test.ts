import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
}

describe("IME 合成态回车闸门契约", () => {
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const movie = read("../src/pages/MoviePage.vue");
  const handlers = [
    { source: core, name: "onKeydown", guard: "!event.isComposing", submit: "void send()" },
    { source: core, name: "onRenameKeydown", guard: "!e.isComposing", submit: "void commitRename()" },
    {
      source: core,
      name: "onInlineSubmitKeydown",
      guard: "event.isComposing || event.keyCode === 229",
      submit: "void submit()",
    },
    { source: movie, name: "onKeydown", guard: "event.isComposing || event.keyCode === 229", submit: "void send()" },
  ];

  it.each(handlers)("$name 在 isComposing 时先返回，不 preventDefault 不提交", (handler) => {
    const body = functionSource(handler.source, handler.name);
    expect(body).not.toBe("");
    const guard = body.indexOf(handler.guard);
    const prevent = body.indexOf("preventDefault()");
    const submit = body.indexOf(handler.submit);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(prevent).toBeGreaterThan(guard);
    expect(submit).toBeGreaterThan(prevent);
    expect(body).toContain('Enter');
  });

  it.each(handlers.filter((h) => h.guard.includes("keyCode === 229")))(
    "$name 保留 keyCode=229 旧浏览器回退",
    (handler) => {
      const body = functionSource(handler.source, handler.name);
      expect(body).toContain("event.isComposing || event.keyCode === 229");
      expect(body.indexOf("return;")).toBeLessThan(body.indexOf("preventDefault()"));
    },
  );

  it("core 的 composer/rename handler 当前仅依赖 isComposing，不改实现只固化现状", () => {
    expect(functionSource(core, "onKeydown")).not.toContain("keyCode === 229");
    expect(functionSource(core, "onRenameKeydown")).not.toContain("keyCode === 229");
  });
});
