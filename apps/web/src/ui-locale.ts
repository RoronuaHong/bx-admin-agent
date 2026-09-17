import { ref } from "vue";

export type UiLocale = "zh" | "en" | "pt-BR" | "hi";

/** 浏览器语言探测出的默认界面语言（设备默认，仅在对话未显式设置时兜底）。 */
export function detectDefaultLocale(): UiLocale {
  if (typeof navigator !== "undefined" && /^pt\b/i.test(navigator.language || "")) return "pt-BR";
  if (typeof navigator !== "undefined" && /^hi\b/i.test(navigator.language || "")) return "hi";
  if (typeof navigator !== "undefined" && /^en\b/i.test(navigator.language || "")) return "en";
  return "zh";
}

export function isUiLocale(value: unknown): value is UiLocale {
  return value === "zh" || value === "en" || value === "pt-BR" || value === "hi";
}

/**
 * 当前界面语言。
 * 持久化**不在前端**：语言是对话级设置（`conversation.locale`），
 * 设备默认存在后端 `session.preferences.locale`；
 * 这里只保留一个内存态供 `tx()` / `localizeToken()` 同步读取。
 */
const uiLocale = ref<UiLocale>(detectDefaultLocale());

export function getUiLocale() {
  return uiLocale;
}

/** 只改内存。落盘由调用方决定（改对话 → PATCH conversation；改设备默认 → PUT preferences）。 */
export function setUiLocale(locale: UiLocale) {
  uiLocale.value = locale;
}
