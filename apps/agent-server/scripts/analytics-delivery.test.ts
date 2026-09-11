/**
 * Delivery zero-fill / explain unit tests.
 * Run: tsx scripts/analytics-delivery.test.ts
 */
import assert from "node:assert/strict";
import { applyDeliveryZeroFill, applyDeliveryReconcile } from "../src/analytics/delivery.js";
import { attachClarifyOptions } from "../src/analytics/clarify-options.js";

{
  const r = applyDeliveryZeroFill({
    tables: [
      {
        title: "t",
        cols: ["channel", "users"],
        rows: [["IndiaA", 10]],
      },
    ],
    requestedChannels: ["IndiaA", "IndiaB"],
  });
  assert.equal(r.tables[0]!.rows.length, 2);
  assert.equal(r.tables[0]!.rows[1]![0], "IndiaB");
  assert.equal(r.tables[0]!.rows[1]![1], 0);
  assert.ok(r.messageSuffix.includes("IndiaB"));
}

{
  const r = applyDeliveryReconcile({
    tables: [
      {
        title: "t",
        cols: ["channel", "users"],
        rows: [["IndiaA", 10]],
      },
    ],
    requestedChannels: ["IndiaA", "IndiaB"],
    mode: "explain",
  });
  assert.equal(r.tables[0]!.rows.length, 1);
  assert.ok(r.messageSuffix.includes("未出现"));
  assert.ok(r.messageSuffix.includes("IndiaB"));
  assert.ok(r.notes.some((n) => n.startsWith("delivery_explain:channel:IndiaB")));
}

{
  const attached = attachClarifyOptions(
    "无法识别渠道「GhostX」，请从候选中选择（不会使用未校验的渠道码查数）。",
    [{ id: "IndiaA", label: "IndiaA" }],
    { multiSelect: true, slot: "channel" },
  );
  assert.match(attached.message, /无法识别渠道/);
  assert.doesNotMatch(attached.message.slice(0, 20), /^请确认渠道/);
}

console.log("analytics-delivery.test.ts OK");
