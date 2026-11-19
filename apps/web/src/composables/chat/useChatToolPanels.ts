import { computed, reactive, ref, type Ref } from "vue";
import {
  fetchChatMcpServers,
  fetchChatSkills,
  getApiErrorToken,
  reloadMcpServer,
  setChatMcpServers,
  setChatSkills,
  type ConversationDto,
  type McpServerStatus,
  type SkillMeta,
} from "../../api";
import { agentText, type AgentEntry } from "../../agents";
import { localizeToken } from "../../localize";
import { loadPinyin, matchesFuzzyScoped, pinyinReady } from "../../pinyin";
import type { UiLocale } from "../../ui-locale";
import type { ConvState } from "./chat-page-types";

type Tx = (zh: string, en: string, pt?: string, hi?: string) => string;
type RowState = { cls: string; text: string };

export interface ChatToolPanelsOptions {
  agentId: string;
  currentId: Ref<string>;
  current: Readonly<Ref<ConvState>>;
  states: Map<string, ConvState>;
  stateOf: (id: string) => ConvState;
  mcpAvailable: Ref<McpServerStatus[]>;
  skillAvailable: Ref<SkillMeta[]>;
  expertAgents: AgentEntry[];
  boundMcpIds: () => string[];
  taskDraft: { mcpServers: string[]; skills: string[] };
  taskSkillAddOpen: Ref<boolean>;
  taskMcpAddOpen: Ref<boolean>;
  mcpRowState: (s: McpServerStatus, enabled?: readonly string[], bound?: boolean) => RowState;
  deferOnPage: (fn: () => void, ms: number) => void;
  syncConvLocal: (convId: string, patch: Partial<ConversationDto>) => void;
  send: () => void;
  routerPush: (path: string) => void;
  refreshMcpAvailable: () => Promise<void>;
  connectTaskMcp: (id: string) => Promise<void>;
  uiLocale: Ref<UiLocale>;
  tx: Tx;
}

/**
 * 工具面板（SCC B）：MCP / 技能 / 搜索 / 专家。
 * 机械搬迁自 useChatPageCore；共享状态留根，以同一实例/回调/getter 注入，行为零变化。
 */
export function useChatToolPanels(options: ChatToolPanelsOptions) {
  const {
    agentId,
    currentId,
    current,
    states,
    stateOf,
    mcpAvailable,
    skillAvailable,
    expertAgents,
    boundMcpIds,
    taskDraft,
    taskSkillAddOpen,
    taskMcpAddOpen,
    mcpRowState,
    deferOnPage,
    syncConvLocal,
    send,
    routerPush,
    refreshMcpAvailable,
    connectTaskMcp,
    uiLocale,
    tx,
  } = options;

function patchMcpRow(id: string, patch: Partial<McpServerStatus>) {
  const idx = mcpAvailable.value.findIndex((s) => s.id === id);
  if (idx < 0) return;
  mcpAvailable.value[idx] = { ...mcpAvailable.value[idx], ...patch };
}

const mcpOpen = ref(false);

const mcpBusy = ref(false);

const mcpReconnecting = reactive(new Set<string>());

const mcpError = ref("");

async function loadMcp(convId = currentId.value) {
  // 草稿态没有对话 id。不带 conversationId 的 GET 会回退到服务端 activeConversationId，
  // 只能取全局 available，不能把别的对话的启用集写进草稿。
  if (!convId) {
    const data = await fetchChatMcpServers().catch(() => null);
    if (data) mcpAvailable.value = data.available;
    void ensureBoundMcp("");
    return;
  }
  const data = await fetchChatMcpServers(convId).catch(() => null);
  if (!data) return;
  mcpAvailable.value = data.available;
  const state = states.get(convId);
  if (state) state.settings.mcpEnabled = data.enabled;
  void ensureBoundMcp(convId);
}

function openMcpPanel(focusSearch = true) {
  // 已展开则保持：仅确保互斥，不重置搜索框/焦点/重新拉取（hover 重复进入不应清空用户输入）。
  if (mcpOpen.value) {
    skillOpen.value = false;
    expertOpen.value = false;
    return;
  }
  mcpOpen.value = true;
  skillOpen.value = false;
  expertOpen.value = false;
  mcpAddOpen.value = false;
  mcpQuery.value = "";
  searchAutofocus.value = focusSearch;
  loadPinyin();
  void loadMcp();
}

function isBoundMcp(id: string): boolean {
  return boundMcpIds().includes(id);
}

let bindingBoundMcp = false;

async function ensureBoundMcp(convId: string) {
  const bound = boundMcpIds().filter((id) => mcpAvailable.value.some((server) => server.id === id));
  if (!bound.length || bindingBoundMcp) return;
  const state = convId ? states.get(convId) : current.value;
  if (!state) return;
  const missing = bound.filter((id) => !state.settings.mcpEnabled.includes(id));
  if (!missing.length) return;
  const next = [...new Set([...state.settings.mcpEnabled, ...missing])];
  if (!convId) {
    state.settings.mcpEnabled = next;
    for (const id of missing) void connectTaskMcp(id);
    return;
  }
  bindingBoundMcp = true;
  try {
    const data = await setChatMcpServers(next, convId);
    const live = states.get(convId);
    if (live) live.settings.mcpEnabled = data.enabled;
    mcpAvailable.value = data.available;
    syncConvLocal(convId, { mcpServers: data.enabled });
  } catch {
    /* 补启用失败时不打断对话；连接器面板仍会把这一项标成客服自带 */
  } finally {
    bindingBoundMcp = false;
  }
}

async function toggleMcp(id: string, on: boolean) {
  if (!on && isBoundMcp(id)) return;
  const convId = currentId.value;
  const state = current.value;
  const prev = state.settings.mcpEnabled;
  const next = on ? [...new Set([...prev, id])] : prev.filter((item) => item !== id);
  state.settings.mcpEnabled = next;
  // 草稿态只改内存，对齐模型选择：首条消息创建对话时再落库（createConvFromDraft）。
  // 勾选时预热连接，行状态才能从「未启用」变成连接中/已连接。
  if (!convId) {
    if (on) void connectTaskMcp(id);
    return;
  }
  mcpBusy.value = true;
  mcpError.value = "";
  try {
    const data = await setChatMcpServers(next, convId);
    mcpAvailable.value = data.available;
    state.settings.mcpEnabled = data.enabled;
    syncConvLocal(convId, { mcpServers: data.enabled });
    // 连接是异步的，稍后刷新一次拿到真实连接状态。
    deferOnPage(() => void loadMcp(convId), 1500);
  } catch (err) {
    state.settings.mcpEnabled = prev;
    mcpError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("操作失败", "Request failed", "Falha na solicitação", "अनुरोध विफल"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

async function clearMcpSelection() {
  const convId = currentId.value;
  const state = current.value;
  const prev = state.settings.mcpEnabled;
  const keep = boundMcpIds().filter((id) => mcpAvailable.value.some((server) => server.id === id));
  state.settings.mcpEnabled = keep;
  if (!convId) return;
  mcpBusy.value = true;
  mcpError.value = "";
  try {
    const data = await setChatMcpServers(keep, convId);
    mcpAvailable.value = data.available;
    state.settings.mcpEnabled = data.enabled;
    syncConvLocal(convId, { mcpServers: data.enabled });
  } catch (err) {
    state.settings.mcpEnabled = prev;
    mcpError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("操作失败", "Request failed", "Falha na solicitação", "अनुरोध विफल"),
    );
  } finally {
    mcpBusy.value = false;
  }
}

async function reconnectMcp(id: string) {
  const convId = currentId.value;
  mcpReconnecting.add(id);
  mcpError.value = "";
  // 立即给这一行「连接中」的反馈：reload 可能要几十秒，不能让人以为点了没反应。
  patchMcpRow(id, { connecting: true, connected: false, error: undefined, toolsError: undefined });
  try {
    await reloadMcpServer(id);
    // 任务表单可能没有对话 id：仍要刷新 available 才能看到「已连接」。
    if (convId) await loadMcp(convId);
    else await refreshMcpAvailable();
  } catch (err) {
    patchMcpRow(id, {
      connecting: false,
      connected: false,
      error: (err as Error)?.message || tx("连接失败", "connect failed", "falha na conexão", "कनेक्शन विफल"),
    });
    mcpError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("连接失败", "connect failed", "falha na conexão", "कनेक्ट विफल"),
    );
  } finally {
    mcpReconnecting.delete(id);
  }
}

const skillOpen = ref(false);

const skillAddOpen = ref(false);

const mcpAddOpen = ref(false);

const skillBusy = ref(false);

const skillError = ref("");

async function loadSkills(convId = currentId.value) {
  const data = await fetchChatSkills(convId || undefined).catch(() => null);
  if (!data) return;
  skillAvailable.value = data.available;
  // 草稿态：不带 id 的响应会带回服务端当前活动对话的勾选，不能写进草稿。
  if (!convId) return;
  const state = stateOf(convId);
  state.settings.skillsEnabled = data.enabled;
}

async function onChatSkillCreated(dir: string) {
  skillAddOpen.value = false;
  await loadSkills();
  if (!current.value.settings.skillsEnabled.includes(dir)) await toggleSkill(dir, true);
}

async function onTaskSkillCreated(dir: string) {
  taskSkillAddOpen.value = false;
  await loadSkills();
  if (!taskDraft.skills.includes(dir)) taskDraft.skills.push(dir);
}

async function onChatMcpCreated(id: string) {
  mcpAddOpen.value = false;
  await loadMcp();
  if (!current.value.settings.mcpEnabled.includes(id)) await toggleMcp(id, true);
}

async function onTaskMcpCreated(id: string) {
  taskMcpAddOpen.value = false;
  await loadMcp();
  if (!taskDraft.mcpServers.includes(id)) {
    taskDraft.mcpServers.push(id);
    // 与对话区一致：新建即预热连接，否则行状态会停在「未连接」。
    void connectTaskMcp(id);
  }
}

function openSkillPanel(focusSearch = true) {
  // 已展开则保持：仅确保互斥，不重置搜索框/焦点/重新拉取（hover 重复进入不应清空用户输入）。
  if (skillOpen.value) {
    mcpOpen.value = false;
    expertOpen.value = false;
    return;
  }
  skillOpen.value = true;
  mcpOpen.value = false;
  expertOpen.value = false;
  skillAddOpen.value = false;
  // 每次从关闭→打开都从空关键词开始，避免残留上次搜索词导致列表看着「少了几项」。
  skillQuery.value = "";
  searchAutofocus.value = focusSearch;
  loadPinyin();
  void loadSkills();
}

async function toggleSkill(dir: string, on: boolean) {
  const convId = currentId.value;
  if (skillBusy.value) return;
  const state = convId ? stateOf(convId) : current.value;
  const prev = state.settings.skillsEnabled;
  const next = on ? [...prev, dir] : prev.filter((x) => x !== dir);
  state.settings.skillsEnabled = next;
  // 草稿态只改内存；创建对话时再落库（对齐 toggleMcp / saveModelChoice）。
  if (!convId) return;
  skillBusy.value = true;
  skillError.value = "";
  try {
    const data = await setChatSkills(next, convId);
    stateOf(convId).settings.skillsEnabled = data.enabled;
    syncConvLocal(convId, { skillsEnabled: data.enabled });
  } catch (err) {
    state.settings.skillsEnabled = prev;
    skillError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("技能勾选失败", "Failed to update skills", "Falha ao atualizar habilidades", "स्किल अपडेट विफल"),
    );
  } finally {
    skillBusy.value = false;
  }
}

async function clearSkillSelection() {
  const convId = currentId.value;
  const state = convId ? stateOf(convId) : current.value;
  const prev = state.settings.skillsEnabled;
  state.settings.skillsEnabled = [];
  if (!convId) return;
  skillBusy.value = true;
  skillError.value = "";
  try {
    const data = await setChatSkills([], convId);
    stateOf(convId).settings.skillsEnabled = data.enabled;
    syncConvLocal(convId, { skillsEnabled: data.enabled });
  } catch (err) {
    state.settings.skillsEnabled = prev;
    skillError.value = localizeToken(
      uiLocale.value,
      getApiErrorToken(err),
      (err as Error)?.message || tx("技能勾选失败", "Failed to update skills", "Falha ao atualizar habilidades", "स्किल अपडेट विफल"),
    );
  } finally {
    skillBusy.value = false;
  }
}

const toolsMenuOpen = ref(false);

const skillQuery = ref("");

const mcpQuery = ref("");

const searchAutofocus = ref(true);

const skillFiltered = computed(() => {
  const q = skillQuery.value.trim().toLowerCase();
  // 读 pinyinReady 建立依赖：字典异步就绪后触发重算，启用拼音匹配。
  void pinyinReady.value;
  if (!q) return skillAvailable.value;
  // 单字母关键词只匹配可见名称；目录名与描述归「长字段」，避免任意字母命中一堆英文标识。
  return skillAvailable.value.filter((s) => matchesFuzzyScoped([s.name], [s.dir, s.description], q));
});

const mcpFiltered = computed(() => {
  const q = mcpQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  if (!q) return mcpAvailable.value;
  return mcpAvailable.value.filter((s) => matchesFuzzyScoped([s.label], [s.id], q));
});

const mcpBoundRows = computed(() => mcpFiltered.value.filter((server) => isBoundMcp(server.id)));

const mcpOptionalRows = computed(() => mcpFiltered.value.filter((server) => !isBoundMcp(server.id)));

const mcpPanelRows = computed(() => {
  void uiLocale.value;
  const rows: Array<
    | { kind: "label"; key: string; text: string }
    | {
        kind: "server";
        key: string;
        server: (typeof mcpAvailable.value)[number];
        bound: boolean;
        state: { cls: string; text: string };
      }
  > = [];
  if (mcpBoundRows.value.length) {
    rows.push({
      kind: "label",
      key: "bound",
      text: tx("客服已启用", "Included with support", "Incluído no suporte", "सहायता के साथ शामिल"),
    });
    // 行内连接状态每行只算一次（mcpRowState 是纯函数），模板只读取，避免一处渲染重复算三遍。
    for (const server of mcpBoundRows.value)
      rows.push({ kind: "server", key: server.id, server, bound: true, state: mcpRowState(server, current.value.settings.mcpEnabled, true) });
  }
  if (mcpOptionalRows.value.length) {
    if (mcpBoundRows.value.length) {
      rows.push({
        kind: "label",
        key: "optional",
        text: tx("其他连接器", "Other connectors", "Outros conectores", "अन्य कनेक्टर"),
      });
    }
    for (const server of mcpOptionalRows.value)
      rows.push({ kind: "server", key: server.id, server, bound: false, state: mcpRowState(server, current.value.settings.mcpEnabled, false) });
  }
  return rows;
});

const canClearOptionalMcp = computed(() => {
  if (!mcpAvailable.value.length) return enabledMcpCount.value > 0 && !boundMcpIds().length;
  return current.value.settings.mcpEnabled.some(
    (id) => !isBoundMcp(id) && mcpAvailable.value.some((server) => server.id === id),
  );
});

const enabledMcpCount = computed(() => {
  const ids = current.value.settings.mcpEnabled;
  if (!mcpAvailable.value.length) return ids.length;
  return ids.filter((id) => mcpAvailable.value.some((s) => s.id === id)).length;
});

function toggleToolsMenu() {
  toolsMenuOpen.value = !toolsMenuOpen.value;
  if (toolsMenuOpen.value) {
    // 打开菜单就预取两份列表：飞出面板秒开无等待。
    void loadSkills();
    void loadMcp();
    // 后台拉起拼音字典，之后打开任一搜索面板都能用拼音（首屏不背这体积）。
    loadPinyin();
  } else {
    skillOpen.value = false;
    mcpOpen.value = false;
    expertOpen.value = false;
  }
}

function mcpDescText(s: McpServerStatus): string {
  const parts = [`${s.transport} · ${s.tools} ${tx("工具", "tools", "ferramentas", "टूल")}`];
  if (s.error) parts.push(s.error);
  else if (s.toolsError) parts.push(s.toolsError);
  return parts.join(" · ");
}

const expertOpen = ref(false);

const currentExpert = computed(() => expertAgents.find((a) => a.id === agentId));

const expertStarters = computed(() => {
  if (agentId !== "support") return [] as string[];
  void uiLocale.value;
  return [
    tx(
      "最近 60 分钟，印度的 SalesIQ 会话有多少？",
      "How many SalesIQ chats from India in the last 60 minutes?",
      "Quantas conversas do SalesIQ da Índia nos últimos 60 minutos?",
      "पिछले 60 मिनट में भारत की कितनी SalesIQ बातचीत हुईं?",
    ),
    tx(
      "列出最近打开的会话",
      "List the most recently opened chats",
      "Listar as conversas abertas mais recentes",
      "हाल ही में खुली बातचीत दिखाएँ",
    ),
    tx(
      "考勤制度里，迟到怎么规定？",
      "What do the attendance rules say about being late?",
      "O que as regras de ponto dizem sobre atraso?",
      "उपस्थिति नियमों में देरी के बारे में क्या है?",
    ),
  ];
});

const composerPlaceholder = computed(() =>
  agentId === "support"
    ? tx(
        "问会话量、某个地区的会话，或公司制度…",
        "Ask about chat volume, a region's chats, or company policy…",
        "Pergunte sobre volume de chats, conversas de uma região ou políticas…",
        "बातचीत की संख्या, किसी क्षेत्र की चैट या कंपनी नीति पूछें…",
      )
    : tx("输入消息…", "Type a message…", "Digite uma mensagem…", "संदेश लिखें…"),
);

function askStarter(text: string) {
  const state = current.value;
  if (!state || state.sending) return;
  state.input = text;
  void send();
}

const expertQuery = ref("");

const expertFiltered = computed(() => {
  const q = expertQuery.value.trim().toLowerCase();
  void pinyinReady.value;
  if (!q) return expertAgents;
  return expertAgents.filter((a) =>
    matchesFuzzyScoped(
      [agentText(a.label, uiLocale.value)],
      [a.id, ...Object.values(a.label), ...Object.values(a.description)],
      q,
    ),
  );
});

function openExpertPanel(focusSearch = true) {
  // 已展开则保持：仅确保互斥，不重置搜索框/焦点（hover 重复进入不应清空用户输入）。
  if (expertOpen.value) {
    skillOpen.value = false;
    mcpOpen.value = false;
    return;
  }
  expertOpen.value = true;
  skillOpen.value = false;
  mcpOpen.value = false;
  expertQuery.value = "";
  searchAutofocus.value = focusSearch;
  loadPinyin();
}

function closeToolsPanels() {
  toolsMenuOpen.value = false;
  expertOpen.value = false;
  skillOpen.value = false;
  mcpOpen.value = false;
}

function onPickExpert(agent: AgentEntry) {
  closeToolsPanels();
  routerPush(agent.path);
}

function onClearExpert() {
  closeToolsPanels();
  routerPush("/chat");
}

  return {
    mcpOpen,
    mcpBusy,
    mcpReconnecting,
    mcpError,
    patchMcpRow,
    loadMcp,
    openMcpPanel,
    isBoundMcp,
    bindingBoundMcp,
    ensureBoundMcp,
    toggleMcp,
    clearMcpSelection,
    reconnectMcp,
    skillOpen,
    skillAddOpen,
    mcpAddOpen,
    skillBusy,
    skillError,
    loadSkills,
    onChatSkillCreated,
    onTaskSkillCreated,
    onChatMcpCreated,
    onTaskMcpCreated,
    openSkillPanel,
    toggleSkill,
    clearSkillSelection,
    toolsMenuOpen,
    skillQuery,
    mcpQuery,
    searchAutofocus,
    skillFiltered,
    mcpFiltered,
    mcpBoundRows,
    mcpOptionalRows,
    mcpPanelRows,
    canClearOptionalMcp,
    enabledMcpCount,
    toggleToolsMenu,
    mcpDescText,
    expertOpen,
    expertStarters,
    currentExpert,
    composerPlaceholder,
    askStarter,
    expertQuery,
    expertFiltered,
    openExpertPanel,
    closeToolsPanels,
    onPickExpert,
    onClearExpert,
  };
}
