import { describe, expect, it } from "vitest";
import type { UiLocale } from "../src/ui-locale";
import { visibleThinking } from "../src/trace-labels";

const LAT_79 = "a".repeat(79);
const LAT_80 = "a".repeat(80);
const HAN_14 = "中".repeat(14);
const HAN_15 = "中".repeat(15);
const DEV_14 = "अ".repeat(14);
const DEV_15 = "अ".repeat(15);
const EN_12 = `${"the ".repeat(12)}${"x".repeat(50)}`;
const EN_13 = `${"the ".repeat(13)}${"x".repeat(50)}`;
const EN_13_PT_4 = `${"the ".repeat(13)}${"que ".repeat(4)}${"x".repeat(50)}`;
const EN_13_PT_5 = `${"the ".repeat(13)}${"que ".repeat(5)}${"x".repeat(50)}`;

describe("visibleThinking 当前行为固化", () => {
  it.each<[string, UiLocale, string, string]>([
    ["en 始终显示", "en", LAT_80, LAT_80],
    ["空串返回空", "zh", "", ""],
    ["空白返回空", "zh", "   \t ", ""],
    ["短句先 trim 后显示", "zh", "  hello world  ", "hello world"],
    ["lat=79 未到阈值仍显示", "zh", LAT_79, LAT_79],
    ["lat=80 且无汉字收起", "zh", LAT_80, ""],
    ["汉字占比 14/94 低于 0.15 收起", "zh", `${LAT_80}${HAN_14}`, ""],
    ["汉字占比 15/95 达到 0.15 显示", "zh", `${LAT_80}${HAN_15}`, `${LAT_80}${HAN_15}`],
    ["hi 无天城文长英文收起", "hi", LAT_80, ""],
    ["天城文占比 14/94 低于 0.15 收起", "hi", `${LAT_80}${DEV_14}`, ""],
    ["天城文占比 15/95 达到 0.15 显示", "hi", `${LAT_80}${DEV_15}`, `${LAT_80}${DEV_15}`],
    ["pt-BR 12 个英文词不收起", "pt-BR", EN_12, EN_12],
    ["pt-BR 13 个英文词收起", "pt-BR", EN_13, ""],
    ["pt-BR 13:4 超过 3 倍收起", "pt-BR", EN_13_PT_4, ""],
    ["pt-BR 13:5 未超过 3 倍显示", "pt-BR", EN_13_PT_5, EN_13_PT_5],
  ])("%s", (_label, locale, input, expected) => {
    expect(visibleThinking(input, locale)).toBe(expected);
  });
});
