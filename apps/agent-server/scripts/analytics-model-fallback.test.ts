/**
 * 候选模型链 / 排序 / 冷却 单测（无网络）。
 * Run: tsx scripts/analytics-model-fallback.test.ts
 */
import assert from "node:assert/strict";
import type { ModelEntry } from "../src/config.js";
import {
  analyticsModelCooldownMs,
  clearAnalyticsModelCooldowns,
  isAnalyticsModelCooling,
  markAnalyticsModelSuccess,
  markAnalyticsModelUnavailable,
  orderAnalyticsModels,
} from "../src/analytics/pick-analytics-model.js";
import {
  isFatalModelError,
  isModelUnavailableError,
  modelErrorStatus,
  modelFallbackAttempts,
  reportModelFailure,
  reportModelQualityFailure,
  withModelFallback,
} from "../src/analytics/model-fallback.js";

function model(id: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    label: id,
    provider: "openai",
    name: id,
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    apiKeys: ["k"],
    vision: "none",
    timeoutMs: 15000,
    contextChars: 32000,
    tools: false,
    thinking: false,
    agentCapable: true,
    ...extra,
  };
}

{
  // 排序：envDefault/modelId 优先，其后 dsflash → glm-5 → flash → 其余；EOL 与无 key 不作候选
  const models = [
    model("a"),
    model("dsflash"),
    model("glm52"),
    model("glm5"),
    model("nvstepflash", { name: "stepfun-ai/step-3.7-flash" }),
    model("nokey", { apiKey: "", apiKeys: [] }),
  ];
  const ids = orderAnalyticsModels(models, { envDefault: "glm52" }).map((m) => m.id);
  assert.equal(ids[0], "glm52");
  assert.ok(ids.indexOf("dsflash") > -1 && ids.indexOf("dsflash") < ids.indexOf("glm5"));
  assert.ok(!ids.includes("nvstepflash"));
  assert.ok(!ids.includes("nokey"));

  assert.equal(orderAnalyticsModels(models, { modelId: "a" })[0]?.id, "a");

  const cooled = orderAnalyticsModels(models, { envDefault: "glm52", cooling: new Set(["glm52"]) }).map((m) => m.id);
  assert.equal(cooled[0], "dsflash");
  assert.equal(cooled[cooled.length - 1], "glm52");

  assert.deepEqual(orderAnalyticsModels([model("only", { apiKey: "", apiKeys: [] })]), []);
}

{
  // 冷却：TTL 到期自动失效；只有「不可用」类错误才登记
  clearAnalyticsModelCooldowns();
  const t0 = Date.now();
  const prevTtl = process.env.ANALYTICS_MODEL_COOLDOWN_MS;
  process.env.ANALYTICS_MODEL_COOLDOWN_MS = "1000";
  assert.equal(analyticsModelCooldownMs(), 1000);
  markAnalyticsModelUnavailable("m1", t0);
  assert.equal(isAnalyticsModelCooling("m1", t0 + 500), true);
  assert.equal(isAnalyticsModelCooling("m1", t0 + 1500), false);
  assert.equal(isAnalyticsModelCooling("m2", t0), false);

  reportModelFailure("m3", Object.assign(new Error("quota exhausted"), { status: 402 }));
  assert.equal(isAnalyticsModelCooling("m3", t0), true);
  reportModelFailure("m4", Object.assign(new Error("bad request"), { status: 400 }));
  assert.equal(isAnalyticsModelCooling("m4", t0), false);
  reportModelFailure("", new Error("quota"));

  process.env.ANALYTICS_MODEL_COOLDOWN_MS = "0";
  markAnalyticsModelUnavailable("m5", t0);
  assert.equal(isAnalyticsModelCooling("m5", t0), false);

  // TTL 覆盖 + 质量失败短冷却（≤60s）
  process.env.ANALYTICS_MODEL_COOLDOWN_MS = "300000";
  markAnalyticsModelUnavailable("m6", t0, 50);
  assert.equal(isAnalyticsModelCooling("m6", t0 + 49), true);
  assert.equal(isAnalyticsModelCooling("m6", t0 + 51), false);
  reportModelQualityFailure("m7", t0);
  assert.equal(isAnalyticsModelCooling("m7", t0 + 59999), true);
  assert.equal(isAnalyticsModelCooling("m7", t0 + 60001), false);

  if (prevTtl === undefined) delete process.env.ANALYTICS_MODEL_COOLDOWN_MS;
  else process.env.ANALYTICS_MODEL_COOLDOWN_MS = prevTtl;
  clearAnalyticsModelCooldowns();
}

{
  // 错误分类与开关
  assert.equal(modelErrorStatus(Object.assign(new Error("x"), { status: 402 })), 402);
  assert.equal(modelErrorStatus(new Error("no status")), undefined);
  assert.equal(isModelUnavailableError(Object.assign(new Error("x"), { status: 402 })), true);
  assert.equal(isModelUnavailableError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isModelUnavailableError(Object.assign(new Error("x"), { status: 400 })), false);
  assert.equal(isModelUnavailableError(new Error('{"error":{"code":"401008"}}')), true);
  assert.equal(isModelUnavailableError(new Error("Model hy3-free is not supported")), true);
  assert.equal(isModelUnavailableError(new Error("llm_timeout")), false);

  assert.equal(isFatalModelError(new Error("llm_timeout")), true);
  assert.equal(isFatalModelError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isFatalModelError(new Error("boom")), false);

  assert.equal(modelFallbackAttempts({} as NodeJS.ProcessEnv), 6);
  assert.equal(modelFallbackAttempts({ ANALYTICS_MODEL_FALLBACKS: "1" } as NodeJS.ProcessEnv), 1);
  assert.equal(modelFallbackAttempts({ ANALYTICS_MODEL_FALLBACKS: "0" } as NodeJS.ProcessEnv), 6);
  assert.equal(modelFallbackAttempts({ ANALYTICS_MODEL_FALLBACKS: "99" } as NodeJS.ProcessEnv), 10);
}

{
  // 成功记忆：最近成功的模型优先；成功同时解除冷却
  clearAnalyticsModelCooldowns();
  const models = [model("a"), model("glm52"), model("b")];
  markAnalyticsModelSuccess("b", 1000);
  markAnalyticsModelSuccess("a", 2000);
  const withGood = orderAnalyticsModels(models, {
    envDefault: "glm52",
    good: new Map([
      ["a", 2000],
      ["b", 1000],
    ]),
  }).map((m) => m.id);
  assert.deepEqual(withGood.slice(0, 2), ["a", "b"]);
  assert.equal(withGood[2], "glm52");

  markAnalyticsModelUnavailable("a");
  assert.equal(isAnalyticsModelCooling("a"), true);
  markAnalyticsModelSuccess("a");
  assert.equal(isAnalyticsModelCooling("a"), false);

  // 显式指定仍然最高优先级（用户在 UI 里选的模型不被成功记忆顶掉）
  assert.equal(
    orderAnalyticsModels(models, { modelId: "glm52", good: new Map([["a", 2000]]) })[0]?.id,
    "glm52",
  );
  clearAnalyticsModelCooldowns();
}

{
  // 候选链编排
  const models = [model("m1"), model("m2"), model("m3")];

  const okSeen: string[] = [];
  const ok = await withModelFallback({
    candidates: models,
    maxAttempts: 3,
    attempt: async (m) => {
      okSeen.push(m.id);
      return `ok:${m.id}`;
    },
  });
  assert.equal(ok, "ok:m1");
  assert.deepEqual(okSeen, ["m1"]);

  const hops: Array<[string, string | undefined]> = [];
  const fell = await withModelFallback({
    candidates: models,
    maxAttempts: 3,
    attempt: async (m) => {
      if (m.id === "m1") throw Object.assign(new Error("quota exhausted"), { status: 402 });
      return `ok:${m.id}`;
    },
    onUnavailable: (m, _e, next) => hops.push([m.id, next?.id]),
  });
  assert.equal(fell, "ok:m2");
  assert.deepEqual(hops, [["m1", "m2"]]);

  await assert.rejects(
    () =>
      withModelFallback({
        candidates: models,
        maxAttempts: 3,
        attempt: async (m) => {
          throw new Error(`fail:${m.id}`);
        },
      }),
    /fail:m3/,
  );

  const capped: string[] = [];
  await assert.rejects(
    () =>
      withModelFallback({
        candidates: models,
        maxAttempts: 2,
        attempt: async (m) => {
          capped.push(m.id);
          throw new Error("x");
        },
      }),
    /x/,
  );
  assert.deepEqual(capped, ["m1", "m2"]);

  const fatal: string[] = [];
  await assert.rejects(
    () =>
      withModelFallback({
        candidates: models,
        maxAttempts: 3,
        isFatal: isFatalModelError,
        attempt: async (m) => {
          fatal.push(m.id);
          throw new Error("llm_timeout");
        },
      }),
    /llm_timeout/,
  );
  assert.deepEqual(fatal, ["m1"]);

  await assert.rejects(
    () => withModelFallback({ candidates: [], maxAttempts: 3, attempt: async () => "x" }),
    /no_model/,
  );
}

console.log("analytics-model-fallback.test.ts OK");
