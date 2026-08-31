import { inject, onMounted, provide, ref, type InjectionKey, type Ref } from "vue";

export type ThemeName = "light" | "dark";

export const themeKey: InjectionKey<{
  theme: Ref<ThemeName>;
  toggle: () => void;
}> = Symbol("theme");

const STORAGE_KEY = "bx-agent-theme";

function readTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(next: ThemeName) {
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "dark" ? "#0c0c0b" : "#f3f3f0");
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
}

export function provideTheme() {
  const theme = ref<ThemeName>("light");

  function setTheme(next: ThemeName) {
    theme.value = next;
    applyTheme(next);
  }

  function toggle() {
    setTheme(theme.value === "dark" ? "light" : "dark");
  }

  onMounted(() => setTheme(readTheme()));
  provide(themeKey, { theme, toggle });
  return { theme, toggle };
}

export function useTheme() {
  const api = inject(themeKey);
  if (!api) throw new Error("Theme is not provided");
  return api;
}
