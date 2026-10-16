import { describe, expect, test } from "vitest";
import { lintToolCodeForDeviceLevelCount } from "../src/tool-code-lint.js";

describe("lintToolCodeForDeviceLevelCount（与 SQL DEVICE_LEVEL_COUNT 同源，advisory）", () => {
  test("设备级去重/计数命中：guid 邻近计数动词即告警", () => {
    expect(lintToolCodeForDeviceLevelCount(`df['guid'].nunique()`)).not.toBeNull();
    expect(lintToolCodeForDeviceLevelCount(`len(df.guid.unique())`)).not.toBeNull();
    expect(lintToolCodeForDeviceLevelCount(`df.drop_duplicates('guid')`)).not.toBeNull();
    expect(lintToolCodeForDeviceLevelCount(`df[df.guid != ''].value_counts()`)).not.toBeNull();
    expect(lintToolCodeForDeviceLevelCount(`users = set(df['guid'])`)).not.toBeNull();
    // 动词在前、guid 在后也命中
    expect(lintToolCodeForDeviceLevelCount(`nunique = df.guid.nunique`)).not.toBeNull();
  });

  test("账号级 / 无计数 / 无 guid 不告警", () => {
    expect(lintToolCodeForDeviceLevelCount(`df['uid'].nunique()`)).toBeNull();
    expect(lintToolCodeForDeviceLevelCount(`len(df.users)`)).toBeNull();
    // 仅引用 guid 但未做计数/去重（如过滤单个设备）不告警
    expect(lintToolCodeForDeviceLevelCount(`row = df[df.guid == 'abc']`)).toBeNull();
    expect(lintToolCodeForDeviceLevelCount(`print("hello")`)).toBeNull();
    expect(lintToolCodeForDeviceLevelCount("")).toBeNull();
  });

  test("注释里的 guid 不误报", () => {
    expect(lintToolCodeForDeviceLevelCount(`# 注释里提 guid 和 nunique\nprint(x.nunique())`)).toBeNull();
  });
});
