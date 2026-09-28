// 模型级「关闭扩展思考」开关（MODEL_<ID>_DISABLE_THINKING）：
// 只针对实测「思考链被写进正文、纯属延迟负担」的模型显式开启，默认必须保持 false
// ——否则会把所有模型的思考能力一起关掉，属于不可接受的全局行为变更。
import { afterEach, describe, expect, it } from "vitest";
import { listModels } from "../src/config";

const PREFIX = "MODEL_THINKPROBE_";
const KEYS = [
  `${PREFIX}PROVIDER`,
  `${PREFIX}NAME`,
  `${PREFIX}BASE_URL`,
  `${PREFIX}API_KEY`,
  `${PREFIX}VISION`,
  `${PREFIX}DISABLE_THINKING`,
];

describe("模型级关思考开关", () => {
  const saved = new Map<string, string | undefined>();
  const savedProviders = process.env.MODEL_PROVIDERS;

  const put = (key: string, value?: string) => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    if (savedProviders === undefined) delete process.env.MODEL_PROVIDERS;
    else process.env.MODEL_PROVIDERS = savedProviders;
  });

  const register = (disableThinking?: string) => {
    process.env.MODEL_PROVIDERS = "thinkprobe";
    put(`${PREFIX}PROVIDER`, "openai");
    put(`${PREFIX}NAME`, "probe-model");
    put(`${PREFIX}BASE_URL`, "https://example.test/v1");
    put(`${PREFIX}API_KEY`, "k");
    put(`${PREFIX}DISABLE_THINKING`, disableThinking);
    return listModels()[0];
  };

  it("未配置时默认关闭（不改动既有模型行为）", () => {
    const model = register(undefined);
    expect(model).toBeTruthy();
    expect(model!.disableThinking).toBe(false);
  });

  it("显式开启时才为 true", () => {
    const model = register("true");
    expect(model!.disableThinking).toBe(true);
  });

  it("空串 / off 等无效值一律按关闭处理", () => {
    for (const raw of ["", " ", "off", "0", "false", "FALSE"]) {
      const model = register(raw);
      expect(model!.disableThinking, `raw=${JSON.stringify(raw)}`).toBe(false);
      // 同一轮重复注册会覆盖 env，需清掉再测下一个值
      delete process.env[`${PREFIX}DISABLE_THINKING`];
    }
  });

  it("大小写不敏感（True / ON 也生效）", () => {
    expect(register("True")!.disableThinking).toBe(true);
    delete process.env[`${PREFIX}DISABLE_THINKING`];
    expect(register("ON")!.disableThinking).toBe(true);
  });
});
