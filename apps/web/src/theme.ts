import { inject, onMounted, provide, ref, type InjectionKey, type Ref } from "vue";
import { saveChatPreferences } from "./api";

type ThemeName = "light" | "dark";

/** 旧前端持久化键：**只**用于一次性迁移读取，迁移后不再使用（持久化在后端 session.preferences）。 */
export const THEME_STORAGE_KEY = "bx-agent-theme";

const themeKey: InjectionKey<{
  theme: Ref<ThemeName>;
  toggle: () => void;
  adopt: (value: string) => void;
}> = Symbol("theme");

/** 读旧本地值（迁移用，可能为空串）。 */
export function readStoredTheme(): ThemeName | "" {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore
  }
  return "";
}

/** 没有任何偏好时的兜底：跟随系统。 */
function systemTheme(): ThemeName {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 只改 DOM，不写任何本地存储（持久化交给后端）。 */
function applyTheme(next: ThemeName) {
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "dark" ? "#0c0c0b" : "#f3f3f0");
}

export function provideTheme() {
  const theme = ref<ThemeName>(systemTheme());

  /**
   * 应用主题。persist=true 时写回后端（设备态，非对话态）。
   * 乐观：先改本地立即生效，失败静默（主题不是关键路径，不打扰用户）。
   */
  function setTheme(next: ThemeName, persist = true) {
    theme.value = next;
    applyTheme(next);
    if (persist) void saveChatPreferences({ theme: next }).catch(() => undefined);
  }

  function toggle() {
    setTheme(theme.value === "dark" ? "light" : "dark");
  }

  /** 用后端偏好初始化（不再读 localStorage）。 */
  function adopt(value: string) {
    if (value === "light" || value === "dark") {
      theme.value = value;
      applyTheme(value);
    }
  }

  onMounted(() => applyTheme(theme.value));
  provide(themeKey, { theme, toggle, adopt });
  return { theme, toggle, adopt };
}

export function useTheme() {
  const api = inject(themeKey);
  if (!api) throw new Error("Theme is not provided");
  return api;
}
