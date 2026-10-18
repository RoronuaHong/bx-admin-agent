// 导出表头的字段名 → 展示名。查不到时原样返回字段名，不猜译名。
// 键为字段名，值按 locale 前缀（zh / en …）给出展示名。

type LabelEntry = Partial<Record<string, string>>;

const LABELS: Record<string, LabelEntry> = {};

function localeKey(locale?: string | null): string {
  return (locale || "zh").toLowerCase().split(/[-_]/)[0] || "zh";
}

export function translateField(key: string, locale?: string | null): string {
  const entry = LABELS[key];
  if (!entry) return key;
  return entry[localeKey(locale)] || entry.zh || key;
}
