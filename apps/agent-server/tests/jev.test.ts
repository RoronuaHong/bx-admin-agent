import { describe, expect, it } from "vitest";
import {
  buildSupportLabels,
  draftPromiseAction,
  isVisitorVisibleSend,
  parsePromiseProbability,
  parseSupportReading,
  supportSendAllowed,
  JEV_ACT_AT,
} from "../src/jev.js";

describe("jev support labels", () => {
  it("reads choice confidence and noul probability", () => {
    const reading = parseSupportReading({
      answers: {
        intent: { type: "choice", choice: "咨询", confidence: 0.86, probabilities: { 咨询: 0.8 } },
        emotion: { type: "choice", choice: "焦虑", probabilities: { 焦虑: 0.6 } },
        urgent: { type: "noul", probability: 0.2 },
        route: { type: "choice", choice: "留在客服", confidence: 0.4 },
        ticket: { type: "noul", noul: 0.95 },
        override: { type: "noul", probability: 0.04 },
      },
    });
    expect(reading?.intent).toEqual({ value: "咨询", confidence: 0.86 });
    expect(reading?.emotion?.confidence).toBe(0.6);
    expect(reading?.urgent).toBe(0.2);
    expect(reading?.ticket).toBe(0.95);
    const labels = buildSupportLabels(reading, { probability: 0.04, reason: "ok" });
    expect(labels.draft).toBe("keep");
    expect(labels.items.find((item) => item.id === "intent")?.value).toBe("咨询");
    expect(labels.items.find((item) => item.id === "ticket")?.value).toBe("该建单");
    expect(labels.items.find((item) => item.id === "route")?.band).toBe("low");
    expect(labels.items.some((item) => item.id === "promise")).toBe(false);
  });

  it("replaces only a high-confidence promise and fails closed when the check is missing", () => {
    expect(draftPromiseAction(0.95)).toBe("replace");
    expect(draftPromiseAction(0.6)).toBe("flag");
    expect(draftPromiseAction(0.1)).toBe("keep");
    expect(draftPromiseAction(null)).toBe("unchecked");
    expect(supportSendAllowed(0.95)).toBe(false);
    expect(supportSendAllowed(0.6)).toBe(true);
    expect(supportSendAllowed(null)).toBe(false);
    expect(JEV_ACT_AT).toBe(0.9);
    const blocked = buildSupportLabels(null, { probability: null, reason: "failed" });
    expect(blocked.draft).toBe("unchecked");
    expect(blocked.items[0]?.value).toContain("不能视为已通过");
    const unconfigured = buildSupportLabels(null, { probability: null, reason: "unconfigured" });
    expect(unconfigured.items[0]?.value).toContain("未配置");
    const replaced = buildSupportLabels(null, { probability: 0.99, reason: "ok" });
    expect(replaced.draft).toBe("replace");
  });

  it("recognizes visitor-visible send tools and ignores the list tool", () => {
    expect(isVisitorVisibleSend("mcp__zoho-salesiq__ZohoSalesIQ_sendMessageInConversation")).toBe(true);
    expect(isVisitorVisibleSend("ZohoSalesIQ_getConversationsList")).toBe(false);
    expect(parsePromiseProbability({ answers: { promise: { probability: 0.91 } } })).toBe(0.91);
  });
});
