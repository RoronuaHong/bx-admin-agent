/**
 * 代码执行器（run_tool_code）的设备级口径提示——与 BI SQL 体检的 DEVICE_LEVEL_COUNT 同源。
 *
 * 背景：2026-10-16 /chat 实跑，Agent 在「运行代码」里用 guid（设备）去重算日活人数，
 * 复刻 BI 的 1.6 倍虚高（一号多机）。SQL 体检已拦 SQL 路径，但代码执行器没有任何口径钩子，
 * 于是设备级计数从代码路径漏网。这里补上同源的 advisory 告警。
 *
 * 性质：advisory（fail-open）——检测到 guid 与计数/去重动词邻近就提示「按 uid 去重」，
 * 确实要数设备时可忽略。命中只给提示、不改执行结果，误报代价低（模型/用户可忽略）。
 */
const COUNT_VERB = /(nunique|unique|drop_duplicates|value_counts|groupby\([^)]*\)\s*\.\s*size|\.count\(|len\s*\(|set\s*\()/i;

function stripCodeNoise(code: string): string {
  return (code || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n\r]*/g, "$1 ")
    .replace(/#[^\n\r]*/g, " "); // Python 注释
}

export function lintToolCodeForDeviceLevelCount(code: string): string | null {
  const stripped = stripCodeNoise(code);
  if (!/\bguid\b/i.test(stripped)) return null;
  const near = new RegExp(
    `\\bguid\\b[\\s\\S]{0,60}?${COUNT_VERB.source}|${COUNT_VERB.source}[\\s\\S]{0,60}?\\bguid\\b`,
    "i",
  );
  if (near.test(stripped)) {
    return (
      "[口径提示] 检测到代码按 guid（设备）去重/计数：设备级宽表一号多机，统计「用户/会员/日活人数」" +
      "请按账号 uniqExact(uid) / 去重到 uid；若确实要数设备，可忽略本条。"
    );
  }
  return null;
}
