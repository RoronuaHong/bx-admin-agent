// run_tool_code 的语言错配预检（纯函数，不起子进程）。
//
// 为什么要它：实测一次多维分析复跑里，模型反复把两种语言的 API 记混
// （language=python 却写 JS 的顶层 await / console.log），每次都拿到解释器原始
// SyntaxError，指不出"语言选错了"、也不告诉它正确写法，于是白费 4~11 次调用。
// 这里锁住两件事：① 认得出错配；② 不误伤合法的单语言代码。
import { test, expect } from "vitest";
import { detectToolCodeLanguageMismatch } from "../src/tool-code.js";

test("[A] python 里写 JS 写法 → 拦下并指出正确 API", () => {
  const cases = [
    "const r = await callTool('mcp__x__a', {});console.log(r)",
    "for (const id of ids) { console.log(id) }",
    "const f = (a) => a + 1",
  ];
  for (const code of cases) {
    const msg = detectToolCodeLanguageMismatch("python", code);
    expect(msg, `应识别为语言错配：${code}`).toBeTruthy();
    expect(msg).toContain("call_tool");
    expect(msg).toContain("node");
  }
});

test("[B] node 里写 Python 写法 → 拦下并指出正确 API", () => {
  const cases = ["print(await call_tool('mcp__x__a', {}))", "def go():\n    return 1", "if x:\n    pass\nelif y:\n    pass"];
  for (const code of cases) {
    const msg = detectToolCodeLanguageMismatch("node", code);
    expect(msg, `应识别为语言错配：${code}`).toBeTruthy();
    expect(msg).toContain("await callTool");
    expect(msg).toContain("python");
  }
  // js / javascript / 空串都按 node 处理
  expect(detectToolCodeLanguageMismatch("javascript", "print(1)")).toBeTruthy();
  expect(detectToolCodeLanguageMismatch("", "print(1)")).toBeTruthy();
});

test("[C] 不误伤：语言与写法一致时一律放行", () => {
  // 合法的 Python（异步调用工具 + print）
  expect(detectToolCodeLanguageMismatch("python", "r = call_tool('mcp__x__a', {})\nprint(r['ok'])")).toBeNull();
  // 合法的 Node
  expect(detectToolCodeLanguageMismatch("node", "const r = await callTool('mcp__x__a', {});\nconsole.log(r.ok);")).toBeNull();
  // Python 代码里出现字符串字面量 "const" 不该误判
  expect(detectToolCodeLanguageMismatch("python", "print('const x = 1')")).toBeNull();
  // 空代码不判错配（缺 code 由另一条分支报错）
  expect(detectToolCodeLanguageMismatch("python", "")).toBeNull();
  // 不支持的语言返回 null（由 runToolCode 自己报"不支持的语言"）
  expect(detectToolCodeLanguageMismatch("ruby", "print(1)")).toBeNull();
});