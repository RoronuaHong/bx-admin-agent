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

export interface ThemeApi {
  theme: Ref<ThemeName>;
  toggle: () => void;
  adopt: (value: string) => void;
}

/** 建一套主题状态（provide 与兜底单例共用同一实现，避免两份行为漂移）。 */
function createThemeApi(): { api: ThemeApi; init: () => void } {
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

  return { api: { theme, toggle, adopt }, init: () => applyTheme(theme.value) };
}

/**
 * 兜底主题状态：正常路径永远走 provide/inject；只有注入链断裂时才用到这里。
 * 典型场景是开发期 HMR 重新求值本模块（`themeKey` 变成新的 Symbol，已挂载组件注入失败）——
 * 过去这种情况会直接抛错、把**整页**打成白屏；主题不是关键路径，退化即可（切换照常生效）。
 */
let fallbackApi: ThemeApi | null = null;

export function provideTheme(): ThemeApi {
  const { api, init } = createThemeApi();
  onMounted(init);
  provide(themeKey, api);
  return api;
}

export function useTheme(): ThemeApi {
  const injected = inject(themeKey, null);
  if (injected) return injected;
  if (!fallbackApi) {
    const created = createThemeApi();
    fallbackApi = created.api;
    created.init();
  }
  return fallbackApi;
}
