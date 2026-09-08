import type { ChartView, ChatFileRef, TableView } from "./types";

export interface Bubble {
  id: number;
  role: "user" | "assistant";
  text: string;
  error?: string;
  cancelled?: boolean;
  status?: string;
  toolActive?: boolean;
  currentTool?: string;
  toolStep?: number;
  finished?: boolean;
  images?: Array<{ id: string; name: string }>;
  tables?: TableView[];
  charts?: ChartView[];
  files?: ChatFileRef[];
  toolResults?: Array<{ name: string; result: string }>;
  reasoning?: string;
  reasoningExpanded?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Bubble[];
  createdAt: number;
  updatedAt: number;
}

export interface Identity {
  countryId: string;
  loginName: string;
}

export interface ModelCache {
  id: string | null;
  label: string;
}

export const CLOSED_IDS_CAP = 100;
export const TASK_RESULTS_ID = "task-results";

export function readIdentityCache(storageKey: string): Identity | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Identity>;
    if (!parsed.countryId || !parsed.loginName) return null;
    return { countryId: parsed.countryId, loginName: parsed.loginName };
  } catch {
    return null;
  }
}

export function writeIdentityCache(storageKey: string, identity: Identity) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(identity));
  } catch {
    /* ignore storage errors */
  }
}

export function clearIdentityCache(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* ignore storage errors */
  }
}

export function readModelCache(storageKey: string): ModelCache | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelCache>;
    if (typeof parsed.label !== "string") return null;
    return { id: parsed.id ?? null, label: parsed.label };
  } catch {
    return null;
  }
}

export function writeModelCache(storageKey: string, id: string | null, label: string) {
  try {
    if (id === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify({ id, label }));
  } catch {
    /* ignore storage errors */
  }
}

export function newConversationId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isLegacyTaskConversation(id: string) {
  return id.startsWith("task-") && id !== TASK_RESULTS_ID;
}

export function isDefaultConversationTitle(title: string | null | undefined) {
  const value = String(title || "").trim();
  return !value || value === "新对话" || value === "New Chat" || value === "Novo Chat" || value === "नई चैट";
}

export function displayConversationTitle(title: string | null | undefined, defaultTitle: string) {
  return isDefaultConversationTitle(title) ? defaultTitle : String(title || "").trim();
}

function containsCjk(text: string) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(text);
}

function localeText(locale: string, zh: string, en: string, pt: string, hi: string) {
  return locale === "pt-BR" ? pt : locale === "hi" ? hi : locale === "zh" ? zh : en;
}

export function displayConversationTitleForLocale(
  title: string | null | undefined,
  defaultTitle: string,
  locale: string,
) {
  const shown = displayConversationTitle(title, defaultTitle);
  if (locale !== "zh" && containsCjk(shown)) {
    return localeText(
      locale,
      shown,
      "(Stored title in another language)",
      "(Titulo salvo em outro idioma)",
      "(दूसरी भाषा में सहेजा गया शीर्षक)",
    );
  }
  return shown;
}

export function displayAssistantTextForLocale(text: string | null | undefined, locale: string) {
  const shown = String(text || "");
  if (locale !== "zh" && containsCjk(shown)) {
    return localeText(
      locale,
      shown,
      "Stored assistant text in another language is hidden in this UI locale.",
      "O texto salvo do assistente em outro idioma foi ocultado neste locale da interface.",
      "दूसरी भाषा में सहेजा गया सहायक पाठ इस UI locale में छिपा दिया गया है।",
    );
  }
  return shown;
}

export function makeConversationTitle(messages: Bubble[], defaultTitle: string) {
  const first = messages.find((m) => m.role === "user")?.text.trim();
  return (first || defaultTitle).replace(/\s+/g, " ").slice(0, 24);
}

export function slimConversations(conversations: Conversation[]) {
  return conversations.map((c) => ({
    ...c,
    messages: c.messages
      .map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.images?.length ? { images: m.images } : {}),
        ...(m.tables?.length ? { tables: m.tables } : {}),
        ...(m.charts?.length ? { charts: m.charts } : {}),
        ...(m.files?.length ? { files: m.files } : {}),
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.toolResults?.length ? { toolResults: m.toolResults } : {}),
        ...(typeof m.toolStep === "number" ? { toolStep: m.toolStep } : {}),
        ...(m.currentTool ? { currentTool: m.currentTool } : {}),
        ...(m.status ? { status: m.status } : {}),
        ...(m.error ? { error: m.error } : {}),
        ...(m.cancelled ? { cancelled: true } : {}),
      }))
      .filter(
        (m) =>
          m.role === "user" ||
          m.text.trim().length > 0 ||
          Boolean(m.images?.length) ||
          Boolean(m.tables?.length) ||
          Boolean((m as { charts?: unknown[] }).charts?.length) ||
          Boolean(m.files?.length) ||
          Boolean((m as { toolResults?: unknown[] }).toolResults?.length) ||
          Boolean((m as { reasoning?: string }).reasoning?.trim()) ||
          Boolean((m as { error?: string }).error) ||
          Boolean((m as { cancelled?: boolean }).cancelled),
      ),
  }));
}

export function loadClosedIds(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string").slice(-CLOSED_IDS_CAP);
  } catch {
    return [];
  }
}

export function persistClosedIds(storageKey: string, ids: Iterable<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...ids].slice(-CLOSED_IDS_CAP)));
  } catch {
    /* ignore storage errors */
  }
}

export function sanitizeBubble(m: Bubble): Bubble {
  const text = typeof m.text === "string" ? m.text.slice(0, 20000) : "";
  const reasoning = typeof m.reasoning === "string" ? m.reasoning.slice(0, 20000) : undefined;
  const toolResults = Array.isArray(m.toolResults)
    ? m.toolResults
        .slice(0, 20)
        .map((item) => ({ name: String(item?.name || "").slice(0, 120), result: String(item?.result || "").slice(0, 12000) }))
    : undefined;
  const tables = Array.isArray(m.tables)
    ? m.tables.slice(0, 3).map((t) => ({
        ...t,
        rows: Array.isArray(t.rows) ? t.rows.slice(0, 200) : [],
      }))
    : undefined;
  const charts = Array.isArray(m.charts)
    ? m.charts.slice(0, 3).map((c) => ({
        ...c,
        categories: Array.isArray(c.categories) ? c.categories.slice(0, 93) : [],
        series: Array.isArray(c.series)
          ? c.series.slice(0, 8).map((s) => ({
              ...s,
              data: Array.isArray(s.data) ? s.data.slice(0, 93).map((n) => Number(n) || 0) : [],
            }))
          : [],
      }))
    : undefined;
  return {
    ...m,
    text,
    ...(m.role === "assistant" ? { finished: true } : {}),
    ...(reasoning ? { reasoning, reasoningExpanded: false } : {}),
    ...(toolResults?.length ? { toolResults } : {}),
    ...(tables?.length ? { tables } : {}),
    ...(charts?.length ? { charts } : {}),
  };
}

export function dedupeConversationList(list: Conversation[]): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const conv of list) {
    const prev = byId.get(conv.id);
    if (!prev || (conv.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(conv.id, conv);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function loadConversationsFromStorage(
  storageKey: string,
  defaultTitle: string,
  nextBubbleId: () => number,
): { conversations: Conversation[]; activeId: string } {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { conversations: [], activeId: "" };
    if (raw.length > 2_500_000) {
      localStorage.removeItem(storageKey);
      return { conversations: [], activeId: "" };
    }
    const parsed = JSON.parse(raw) as { activeId?: string; conversations?: Conversation[] };
    if (!Array.isArray(parsed.conversations)) return { conversations: [], activeId: "" };
    const conversations = dedupeConversationList(
      parsed.conversations
        .filter((c) => c && Array.isArray(c.messages))
        .slice(0, 20)
        .map((c) => ({
          id: c.id,
          title: isDefaultConversationTitle(c.title) ? defaultTitle : String(c.title || ""),
          messages: (c.messages as Bubble[])
            .filter((m) => m && (m.role === "user" || m.role === "assistant"))
            .slice(-80)
            .map((m) => sanitizeBubble({ ...m, id: m.id || nextBubbleId() })),
          createdAt: c.createdAt || 0,
          updatedAt: c.updatedAt || 0,
        })),
    );
    const activeId = conversations.some((c) => c.id === parsed.activeId) ? String(parsed.activeId) : conversations[0]?.id || "";
    return { conversations, activeId };
  } catch {
    return { conversations: [], activeId: "" };
  }
}

export function migrateLegacyConversation(
  legacyKey: string,
  defaultTitle: string,
  nextBubbleId: () => number,
): Conversation | null {
  try {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return null;
    const arr = JSON.parse(raw) as Array<{ role: string; text: string }>;
    if (!Array.isArray(arr)) return null;
    const bubbles: Bubble[] = arr
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({ id: nextBubbleId(), role: item.role as Bubble["role"], text: item.text }));
    if (!bubbles.length) return null;
    const now = Date.now();
    return {
      id: newConversationId(),
      title: makeConversationTitle(bubbles, defaultTitle),
      messages: bubbles,
      createdAt: now,
      updatedAt: now,
    };
  } catch {
    return null;
  }
}
