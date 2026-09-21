import { ref } from "vue";

export type UiLocale = "zh" | "en" | "pt-BR" | "hi";

/**
 * 首屏显示语言缓存（仅防 FOUC 用，非真相源）。
 * 真相在服务端 `session.preferences.locale` / `conversation.locale`；
 * 但服务端偏好要等 `fetchChatPreferences()` 异步回来才能 apply，`setUiLocale` 前首帧
 * 会先用浏览器默认语言渲染，刷新时就有「英文→中文」的文案闪动。
 * 这里把「上次实际生效的语言」同步存一份，让首帧直接命中用户真实语言，消除闪动；
 * 服务端回来若不一致，`setUiLocale` 会覆盖并更新本缓存（跨设备改语言属罕见场景）。
 */
const DISPLAY_LOCALE_KEY = "bx-agent-display-locale";

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

/** 首帧语言：优先用上次的显示缓存，否则回退浏览器默认（避免刷新闪一下浏览器语言）。 */
function initialLocale(): UiLocale {
  try {
    const cached = localStorage.getItem(DISPLAY_LOCALE_KEY);
    if (isUiLocale(cached)) return cached;
  } catch {
    /* 隐私模式 / 不可用时忽略，回退浏览器默认 */
  }
  return detectDefaultLocale();
}

/**
 * 当前界面语言。
 * 持久化**不在前端**：语言是对话级设置（`conversation.locale`），
 * 设备默认存在后端 `session.preferences.locale`；
 * 这里只保留一个内存态供 `tx()` / `localizeToken()` 同步读取。
 */
const uiLocale = ref<UiLocale>(initialLocale());

export function getUiLocale() {
  return uiLocale;
}

/** `<html lang>` 用的 BCP-47 标签。 */
const HTML_LANG: Record<UiLocale, string> = { zh: "zh-CN", en: "en", "pt-BR": "pt-BR", hi: "hi" };

/**
 * 只改内存。落盘由调用方决定（改对话 → PATCH conversation；改设备默认 → PUT preferences）。
 * 顺带同步 `<html lang>`：index.html 里写死的 `lang="zh-CN"` 只对首次加载有效，
 * 切到英文/葡语/印地语后不改它，读屏会继续用中文语音合成去念那些文案（WCAG 3.1.1 Language of Page）。
 * 同时把生效语言写进显示缓存，供下次首帧直接命中、消除刷新闪动。
 */
export function setUiLocale(locale: UiLocale) {
  uiLocale.value = locale;
  if (typeof document !== "undefined") document.documentElement.lang = HTML_LANG[locale];
  try {
    localStorage.setItem(DISPLAY_LOCALE_KEY, locale);
  } catch {
    /* 隐私模式不可写时忽略，仅影响首帧命中率 */
  }
}
