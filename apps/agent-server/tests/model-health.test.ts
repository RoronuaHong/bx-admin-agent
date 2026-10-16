// 模型健康度分档（2026-10-14 事故复盘 §5 P0-3）。
//
// 目标不是「哪个模型最强」，而是「别让长期不稳的模型排在每次请求的开场」。
// 设计约束（回归钉住，防它长成万能排序）：
//   1. 只读在线评测已落盘的确定性分数，不调模型、不另建打分器；
//   2. 只分三档，同档内保持原次序（组内仍是免费优先，不推翻既有策略）；
//   3. 样本不足一律 unknown（中性），新模型既不奖赏也不惩罚；
//   4. 纯函数可单测，不依赖真实评测文件。
import { test, expect } from "vitest";
import {
  healthOrderEnabled,
  healthTier,
  modelHealthFromRows,
  orderByHealth,
  rowIsUnstable,
  type ModelHealth,
} from "../src/model-health.js";

const rows = (spec: { model: string; failed: string[]; n: number }[]): { model?: string; failed?: unknown }[] =>
  spec.flatMap((s) => Array.from({ length: s.n }, () => ({ model: s.model, failed: s.failed })));

test("聚合：按模型统计样本与不稳定次数，只认 stability 维度", () => {
  const health = modelHealthFromRows(
    rows([
      { model: "a", failed: [], n: 6 },
      { model: "a", failed: ["stability"], n: 2 },
      { model: "b", failed: ["stability"], n: 5 },
      { model: "c", failed: ["latency"], n: 4 },
    ]),
    { window: 100 },
  );
  expect(health.get("a")).toEqual({ samples: 8, failures: 2 });
  expect(health.get("b")).toEqual({ samples: 5, failures: 5 });
  expect(health.get("c")).toEqual({ samples: 4, failures: 0 });
  expect(rowIsUnstable({ failed: ["stability"] })).toBe(true);
  expect(rowIsUnstable({ failed: ["converged"] })).toBe(false);
  expect(rowIsUnstable({})).toBe(false);
});

test("窗口只取最近 N 条：老样本不能掩盖近期状态", () => {
  // 尾部 6 条必须全被窗口覆盖，窗口才等于「最近 6 条」；否则会误把窗口外的失败算进来。
  const all = rows([{ model: "a", failed: ["stability"], n: 50 }]).concat(
    rows([{ model: "a", failed: [], n: 6 }]),
  );
  expect(modelHealthFromRows(all, { window: 6 }).get("a")?.failures).toBe(0);
  // 反向对照：窗口放大到全部时，老样本重新计入（证明确实是窗口在起作用）
  expect(modelHealthFromRows(all, { window: 100 }).get("a")?.failures).toBe(50);
});

test("分档：样本不足=中性；失败率达阈值=不稳", () => {
  const opts = { minSamples: 3, failRate: 0.5 };
  expect(healthTier(undefined, opts)).toBe("unknown");
  expect(healthTier({ samples: 2, failures: 2 }, opts)).toBe("unknown");
  expect(healthTier({ samples: 6, failures: 3 }, opts)).toBe("unhealthy");
  expect(healthTier({ samples: 6, failures: 2 }, opts)).toBe("healthy");
});

test("重排：可用 -> 未验证 -> 不稳，同档内保持原次序（稳定排序）", () => {
  const items = [{ id: "unstable1" }, { id: "unknown1" }, { id: "healthy1" }, { id: "unstable2" }, { id: "healthy2" }];
  const health: Map<string, ModelHealth> = new Map([
    ["unstable1", { samples: 10, failures: 9 }],
    ["unstable2", { samples: 4, failures: 4 }],
    ["healthy1", { samples: 20, failures: 1 }],
    ["healthy2", { samples: 5, failures: 0 }],
  ]);
  const opts = { minSamples: 3, failRate: 0.5 };
  expect(orderByHealth(items, health, opts).map((i) => i.id)).toEqual([
    "healthy1",
    "healthy2",
    "unknown1",
    "unstable1",
    "unstable2",
  ]);
  expect(orderByHealth([...items].reverse(), health, opts).map((i) => i.id)).toEqual([
    "healthy2",
    "healthy1",
    "unknown1",
    "unstable2",
    "unstable1",
  ]);
});

test("健康度缺失时 = 不排序，行为与从前一致", () => {
  expect(orderByHealth([{ id: "a" }, { id: "b" }], new Map()).map((i) => i.id)).toEqual(["a", "b"]);
});

test("开关：默认开，MODEL_AUTO_STABLE_FIRST=off 整体退回旧排序", () => {
  const prev = process.env.MODEL_AUTO_STABLE_FIRST;
  try {
    delete process.env.MODEL_AUTO_STABLE_FIRST;
    expect(healthOrderEnabled()).toBe(true);
    process.env.MODEL_AUTO_STABLE_FIRST = "off";
    expect(healthOrderEnabled()).toBe(false);
    process.env.MODEL_AUTO_STABLE_FIRST = "OFF";
    expect(healthOrderEnabled()).toBe(false);
    process.env.MODEL_AUTO_STABLE_FIRST = "on";
    expect(healthOrderEnabled()).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.MODEL_AUTO_STABLE_FIRST;
    else process.env.MODEL_AUTO_STABLE_FIRST = prev;
  }
});
