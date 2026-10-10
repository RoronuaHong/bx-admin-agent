/**
 * Metabase 适配器用哪把 Key。
 * 有只读 Key 就用它。生产环境没有只读 Key 时拒绝回落管理员 Key。
 * 开发环境仍可回落，方便本机只有一把 Key 时连上。
 */
export function resolveMetabaseKey(env = process.env) {
  const readonly = String(env.BI_READONLY_API_KEY || "").trim();
  if (readonly) return { key: readonly, blocked: false };
  if (env.NODE_ENV === "production") return { key: "", blocked: true };
  return { key: String(env.BI_API_KEY || "").trim(), blocked: false };
}
