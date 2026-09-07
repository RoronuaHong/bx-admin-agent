import { ref } from "vue";

export type UiLocale = "zh" | "en" | "pt-BR" | "hi";

const STORAGE_KEY = "bx-admin-agent-ui-locale-v1";

function detectDefaultLocale(): UiLocale {
  if (typeof navigator !== "undefined" && /^pt\b/i.test(navigator.language || "")) return "pt-BR";
  if (typeof navigator !== "undefined" && /^hi\b/i.test(navigator.language || "")) return "hi";
  if (typeof navigator !== "undefined" && /^en\b/i.test(navigator.language || "")) return "en";
  return "zh";
}

function readStoredLocale(): UiLocale {
  if (typeof localStorage === "undefined") return detectDefaultLocale();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "en" || raw === "zh" || raw === "pt-BR" || raw === "hi" ? raw : detectDefaultLocale();
  } catch {
    return detectDefaultLocale();
  }
}

const uiLocale = ref<UiLocale>(readStoredLocale());

export function getUiLocale() {
  return uiLocale;
}

export function setUiLocale(locale: UiLocale) {
  uiLocale.value = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}

export function toggleUiLocale() {
  const order: UiLocale[] = ["zh", "en", "pt-BR", "hi"];
  const idx = order.indexOf(uiLocale.value);
  setUiLocale(order[(idx + 1) % order.length] || "zh");
}
