// 运行时目录发现 + 全挂重检：纯函数与重检编排（HTTP 用本地 mock，不依赖外网）。
import { afterEach, beforeEach, expect, test } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelEntry } from "../src/config.js";
import {
  looksFreeTier,
  parseOpenRouterCatalog,
  recheckModelAvailability,
  resetCatalogForTest,
} from "../src/model-catalog.js";
import {
  clearModelCooldown,
  quotaCooldownStatus,
  quotaCooldownUntil,
} from "../src/model-availability.js";
import { resetQuotaPreflightForTest } from "../src/model-quota.js";

beforeEach(() => {
  quotaCooldownUntil.clear();
  quotaCooldownStatus.clear();
  resetQuotaPreflightForTest();
  resetCatalogForTest();
  delete process.env.MODEL_CATALOG_DISCOVERY;
  process.env.MODEL_QUOTA_PREFLIGHT_HOSTS = "127.0.0.1";
  process.env.MODEL_CATALOG_HOSTS = "127.0.0.1";
});

afterEach(() => {
  quotaCooldownUntil.clear();
  quotaCooldownStatus.clear();
  resetQuotaPreflightForTest();
  resetCatalogForTest();
});

test("[A] 目录解析：只收 prompt+completion 都为 0 的 :free / openrouter/free，排除生图生音", () => {
  const rows = parseOpenRouterCatalog({
    data: [
      { id: "a/b:free", pricing: { prompt: "0", completion: "0" }, context_length: 1000 },
      { id: "openrouter/free", pricing: { prompt: 0, completion: 0 }, context_length: 2000 },
      { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" }, context_length: 3000 },
      { id: "paid/model", pricing: { prompt: "0.001", completion: "0.002" }, context_length: 4000 },
      { id: "no-price/model:free", pricing: {}, context_length: 5000 },
      { id: "bad/model:free", pricing: { prompt: "0", completion: "0" } },
    ],
  });
  expect(rows.map((r) => r.id)).toEqual(["a/b:free", "openrouter/free", "bad/model:free"]);
  expect(rows[0]!.contextLength).toBe(1000);
  expect(rows[2]!.contextLength).toBe(128000); // context_length 缺失 → 兜底窗口
});

test("[B] looksFreeTier 与 chat.ts 同口径：:free / free 标签 / 中文「免费」", () => {
  expect(looksFreeTier({ id: "a/b:free", name: "", label: "" })).toBe(true);
  expect(looksFreeTier({ id: "x", name: "space-bunny-free", label: "" })).toBe(true);
  expect(looksFreeTier({ id: "x", name: "", label: "某模型(OR免费)" })).toBe(true);
  expect(looksFreeTier({ id: "paid", name: "gpt-5", label: "付费" })).toBe(false);
});

function mk(id: string, name: string, baseUrl: string): ModelEntry {
  return {
    id,
    label: `${name}(免费)`,
    provider: "openai",
    name,
    baseUrl,
    apiKey: "k-test",
    apiKeys: ["k-test"],
    vision: "none",
    timeoutMs: 1000,
    contextWindow: 128000,
  };
}

async function withServer(
  handlers: { quotaRemaining?: number | null; catalog?: unknown },
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/key") {
      const remaining = handlers.quotaRemaining === undefined ? 40 : handlers.quotaRemaining;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: { free_model_daily_requests: { used: 50 - (remaining ?? 0), limit: 50, remaining: remaining ?? 0 } },
        }),
      );
      return;
    }
    if (req.url === "/api/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(handlers.catalog ?? { data: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("[C] 全挂重检：额度回充清 402 冷却；目录新增模型补进候选；重新上架清 404 冷却", async () => {
  await withServer(
    {
      quotaRemaining: 40,
      catalog: {
        data: [
          { id: "kept/model:free", pricing: { prompt: "0", completion: "0" }, context_length: 99999 },
          { id: "back/model:free", pricing: { prompt: "0", completion: "0" }, context_length: 77777 },
          { id: "new/model:free", pricing: { prompt: "0", completion: "0" }, context_length: 88888 },
        ],
      },
    },
    async (baseUrl) => {
      const kept = mk("kept", "kept/model:free", baseUrl);
      const back = mk("back", "back/model:free", baseUrl);
      // 上一轮：kept 因额度耗尽被冷却到日切，back 因 404 冷却。
      quotaCooldownUntil.set("kept", Date.now() + 100_000);
      quotaCooldownStatus.set("kept", "402");
      quotaCooldownUntil.set("back", Date.now() + 100_000);
      quotaCooldownStatus.set("back", "404");

      const result = await recheckModelAvailability([kept, back]);
      expect(result.recovered).toEqual(expect.arrayContaining(["kept", "back"]));
      expect(result.delisted).toEqual([]);
      expect(result.added.length).toBe(1);
      const added = result.models.find((m) => m.id === result.added[0])!;
      expect(added.name).toBe("new/model:free");
      expect(added.contextWindow).toBe(88888);
      expect(added.apiKeys).toEqual(["k-test"]);
      expect(quotaCooldownUntil.has("kept")).toBe(false);
      expect(quotaCooldownUntil.has("back")).toBe(false);
    },
  );
});

test("[D] 目录里消失的免费模型被冷却；目录非空但条目不命中也算下架", async () => {
  await withServer({ quotaRemaining: 40, catalog: { data: [] } }, async (baseUrl) => {
    // 目录为空数组 = 拉取成功但没有免费模型 → 不下架任何模型（fail-open，防端点异常误杀）。
    const kept = mk("kept", "kept/model:free", baseUrl);
    const r1 = await recheckModelAvailability([kept]);
    expect(r1.delisted).toEqual([]);
    expect(r1.added).toEqual([]);
  });

  await withServer(
    {
      quotaRemaining: 40,
      catalog: { data: [{ id: "b/model:free", pricing: { prompt: "0", completion: "0" } }] },
    },
    async (baseUrl) => {
      const a = mk("a", "a/model:free", baseUrl);
      const b = mk("b", "b/model:free", baseUrl);
      const r = await recheckModelAvailability([a, b]);
      expect(r.delisted).toEqual(["a"]);
      expect(r.delisted).not.toContain("b");
      expect(quotaCooldownStatus.get("a")).toBe("404");
    },
  );
});

test("[E] 端点不可用 / 开关关闭 → fail-open，名单原样返回", async () => {
  await withServer({ catalog: null }, async (baseUrl) => {
    const m = mk("only", "only/model:free", baseUrl);
    const r = await recheckModelAvailability([m]);
    expect(r.models.map((x) => x.id)).toEqual(["only"]);
    expect(r.added).toEqual([]);
    expect(r.recovered).toEqual([]);
  });
  process.env.MODEL_CATALOG_DISCOVERY = "off";
  const m = mk("only", "only/model:free", "http://127.0.0.1:1/v1");
  const r = await recheckModelAvailability([m]);
  expect(r.models.map((x) => x.id)).toEqual(["only"]);
  expect(r.added).toEqual([]);
});

test("[F] clearModelCooldown 清掉进程内冷却表", () => {
  quotaCooldownUntil.set("m", Date.now() + 60_000);
  quotaCooldownStatus.set("m", "402");
  expect(clearModelCooldown("m")).toBe(true);
  expect(quotaCooldownUntil.has("m")).toBe(false);
  expect(quotaCooldownStatus.has("m")).toBe(false);
  expect(clearModelCooldown("m")).toBe(false);
});
