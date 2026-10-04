import { afterEach, describe, expect, it } from "vitest";
import { toolCodeEnv } from "../src/tool-code.js";

/**
 * run_tool_code 是免确认的只读工具，却要跑模型写的代码（可被注入操控）。
 * 子进程环境必须是最小集：跑解释器所必需的留，凭据类一律不带。
 */
describe("run_tool_code 子进程环境", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["PATH", "MONGO_URI", "ANTHROPIC_API_KEY", "GITLAB_PERSONAL_ACCESS_TOKEN", "SOME_SECRET"];
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("只留白名单里的键，凭据类变量不进子进程", () => {
    for (const key of keys) saved[key] = process.env[key];
    process.env.PATH = "C:\\bin";
    process.env.MONGO_URI = "mongodb://user:pwd@127.0.0.1:27017";
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.GITLAB_PERSONAL_ACCESS_TOKEN = "glpat-secret";
    process.env.SOME_SECRET = "leak";

    const env = toolCodeEnv({ BX_TOOL_PORT: "1234", BX_TOOL_TOKEN: "tok" });

    expect(env.PATH).toBe("C:\\bin");
    expect(env.BX_TOOL_PORT).toBe("1234");
    expect(env.BX_TOOL_TOKEN).toBe("tok");
    for (const key of ["MONGO_URI", "ANTHROPIC_API_KEY", "GITLAB_PERSONAL_ACCESS_TOKEN", "SOME_SECRET"]) {
      expect(env[key]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain("sk-secret");
    expect(JSON.stringify(env)).not.toContain("pwd");
  });
});
