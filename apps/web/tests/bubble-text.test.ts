import { describe, expect, it } from "vitest";
import { alertMarkerInfo, bubbleBody, isStoppedBubble } from "../src/bubble-text";

describe("bubble-text", () => {
  it("识别并去掉停止生成标记", () => {
    const bubble = { text: "hello（已停止生成）" };
    expect(isStoppedBubble(bubble)).toBe(true);
    expect(bubbleBody(bubble)).toBe("hello");
  });

  it("普通文本不误判为停止", () => {
    const bubble = { text: "hello" };
    expect(isStoppedBubble(bubble)).toBe(false);
    expect(bubbleBody(bubble)).toBe("hello");
  });

  it("解析助手告警徽章", () => {
    expect(alertMarkerInfo({ role: "assistant", text: "[NORMAL]\n计数 30" })).toEqual({
      marker: "NORMAL",
      body: "计数 30",
    });
  });
});
