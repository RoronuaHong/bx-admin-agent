import { describe, expect, it } from "vitest";
import {
  buildSupportLabels,
  draftPromiseAction,
  isVisitorVisibleSend,
  outboundText,
  parsePromiseProbability,
  parseSupportReading,
  supportDraftState,
  supportSeatState,
  supportSendAllowed,
  visitorSendRefusal,
  JEV_ACT_AT,
  JEV_REVIEW_AT,
} from "../src/jev.js";

describe("jev support labels", () => {
  it("reads choice confidence and noul probability", () => {
    const reading = parseSupportReading({
      answers: {
        task: { type: "choice", choice: "查制度", confidence: 0.86, probabilities: { 查制度: 0.8 } },
        send: { type: "noul", probability: 0.2 },
        route: { type: "choice", choice: "留在客服", confidence: 0.4 },
        override: { type: "noul", probability: 0.04 },
      },
    });
    expect(reading?.task).toEqual({ value: "查制度", confidence: 0.86 });
    expect(reading?.send).toBe(0.2);
    const labels = buildSupportLabels(reading, { probability: 0.04, reason: "ok" });
    expect(labels.draft).toBe("keep");
    expect(labels.items.find((item) => item.id === "task")?.value).toBe("查制度");
    expect(labels.items.find((item) => item.id === "send")?.value).toBe("不代发 0.20");
    expect(labels.items.find((item) => item.id === "override")?.value).toBe("不像 0.04");
    expect(labels.items.find((item) => item.id === "override")?.band).toBe("high");
    expect(labels.items.find((item) => item.id === "send")?.band).not.toBe("alert");
    expect(labels.items.find((item) => item.id === "route")?.band).toBe("low");
    expect(labels.items.some((item) => item.id === "emotion" || item.id === "intent" || item.id === "ticket")).toBe(false);
    expect(labels.items.some((item) => item.id === "promise")).toBe(false);
  });

  it("marks a high-confidence promise without treating a missing check as a pass", () => {
    expect(draftPromiseAction(0.95)).toBe("risk");
    expect(draftPromiseAction(0.6)).toBe("flag");
    expect(draftPromiseAction(0.1)).toBe("keep");
    expect(draftPromiseAction(null)).toBe("unchecked");
    expect(supportSendAllowed(0.95)).toBe(false);
    // CJK 地板抬到 0.6：p>=0.6 的模糊一带也 fail-open 拒发，仅 p<0.6 才放行
    expect(supportSendAllowed(0.6)).toBe(false);
    expect(supportSendAllowed(0.5)).toBe(true);
    expect(supportSendAllowed(null)).toBe(false);
    expect(JEV_ACT_AT).toBe(0.9);
    expect(JEV_REVIEW_AT).toBe(0.6);
    const blocked = buildSupportLabels(null, { probability: null, reason: "failed" });
    expect(blocked.draft).toBe("unchecked");
    expect(blocked.items[0]?.value).toContain("不能视为已通过");
    const unconfigured = buildSupportLabels(null, { probability: null, reason: "unconfigured" });
    expect(unconfigured.items[0]?.value).toContain("未配置");
    const risk = buildSupportLabels(null, { probability: 0.99, reason: "ok" });
    expect(risk.draft).toBe("risk");
    expect(risk.items.find((item) => item.id === "promise")?.band).toBe("alert");
    expect(risk.items.find((item) => item.id === "promise")?.value).toContain("正文未改");
    expect(risk.items.find((item) => item.id === "input")?.value).toContain("没有分类结果");
    const flagged = buildSupportLabels(null, { probability: 0.6, reason: "ok" });
    expect(flagged.items.find((item) => item.id === "promise")?.value).toContain("0.60");
    const send = buildSupportLabels(
      { task: null, send: 0.95, route: null, override: 0.95 },
      { probability: 0.1, reason: "ok" },
    );
    expect(send.items.find((item) => item.id === "send")?.band).toBe("alert");
    expect(send.items.find((item) => item.id === "override")?.band).toBe("alert");
    expect(supportSeatState("  你好  ")).toEqual({ 说话人: "坐席", 原文: "你好" });
    expect(supportDraftState("草稿")).toEqual({ 说话人: "助手草稿", 原文: "草稿" });
  });

  it("recognizes visitor-visible send tools and ignores the list tool", async () => {
    expect(isVisitorVisibleSend("mcp__zoho-salesiq__ZohoSalesIQ_sendMessageInConversation")).toBe(true);
    expect(isVisitorVisibleSend("ZohoSalesIQ_getConversationsList")).toBe(false);
    expect(parsePromiseProbability({ answers: { promise: { probability: 0.91 } } })).toBe(0.91);
    const empty = await visitorSendRefusal("ZohoSalesIQ_sendMessageInConversation", {});
    expect(empty).toContain("没有可检查的正文");
    expect(await visitorSendRefusal("ZohoSalesIQ_getConversationsList", {})).toBeNull();
  });

  it("阶段四代发：从嵌套 body 对象提取正文，文件类 body 仍按空正文拒绝", async () => {
    expect(isVisitorVisibleSend("mcp__zoho-salesiq__ZohoSalesIQ_replyToMessage")).toBe(true);
    // Zoho 发送接口的 body 是对象：文本 {text}，文件 {file, comment}。
    expect(outboundText({ body: { text: "a", comment: "b" } })).toBe("a\nb");
    const nested = await visitorSendRefusal("ZohoSalesIQ_sendMessageInConversation", {
      body: { text: "这边帮您确认一下" },
      path_variables: { screenname: "castleapp", conversation_id: "988573000012517267" },
    });
    // 测试环境没有 JEV_API_KEY：正文提取成功时是「未配置 Jev」拒绝，而不是「空正文」拒绝。
    expect(nested).toContain("未配置 Jev");
    const fileOnly = await visitorSendRefusal("ZohoSalesIQ_sendMessageInConversation", {
      body: { file: "a.png", comment: "" },
    });
    expect(fileOnly).toContain("没有可检查的正文");
  });
});
