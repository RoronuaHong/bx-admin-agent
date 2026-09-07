import type { UiLocale } from "./ui-locale";

export type LocalizedText = {
  zh: string;
  en: string;
  pt?: string;
  hi?: string;
};

export function pickLocalized(locale: UiLocale, item: LocalizedText): string {
  if (locale === "zh") return item.zh;
  if (locale === "pt-BR") return item.pt || item.en;
  if (locale === "hi") return item.hi || item.en;
  return item.en;
}
