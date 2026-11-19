<script setup lang="ts">
import { ref, type ComponentPublicInstance } from "vue";
import type { ConversationDto, ScheduleDto } from "../../api";
import { agentText, type AgentEntry } from "../../agents";
import { getUiLocale, type UiLocale } from "../../ui-locale";

type TaskGroupRun = {
  conversationId: string;
  at: number;
  status?: string;
  marker?: string;
  trigger?: "schedule" | "manual" | "wake";
  durationMs?: number;
  conv?: ConversationDto;
};
type ConvStatus = "" | "running" | "pending" | "error";
type DropTarget = { id: string; after: boolean } | null;
type Renaming = { id: string; value: string };

defineProps<{
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  isMobile: boolean;
  agentMenuOpen: boolean;
  currentAgent: AgentEntry | undefined;
  agents: AgentEntry[];
  agentId: string;
  agentLabel: string;
  uiLocale: UiLocale;
  convQuery: string;
  showArchived: boolean;
  currentId: string;
  conversationsFiltered: ConversationDto[];
  showSkeleton: boolean;
  convSectionOpen: boolean;
  pinnedCount: number;
  archivedCount: number;
  firstArchivedIndex: number;
  taskSectionOpen: boolean;
  taskGroups: Array<{ schedule: ScheduleDto; runs: TaskGroupRun[] }>;
  expandedTasks: Record<string, boolean>;
  draggingId: string;
  dropTarget: DropTarget;
  renaming: Renaming;
  renameMax: number;
  clearArmed: boolean;
  setRenameInput: (el: Element | ComponentPublicInstance | null) => void;
  taskDotClass: (task: ScheduleDto) => string;
  taskCardTip: (task: ScheduleDto) => string;
  taskHealthShort: (task: ScheduleDto) => string;
  taskRightShort: (task: ScheduleDto) => string;
  taskMarkerText: (marker?: string | null) => string;
  taskStatusText: (task: ScheduleDto) => string;
  filteredRuns: (runs: TaskGroupRun[]) => TaskGroupRun[];
  runTimeText: (at: number) => string;
  runMetaText: (run: TaskGroupRun) => string;
  convStatus: (conv: ConversationDto) => ConvStatus;
  convStatusText: (status: ConvStatus) => string;
  queueCount: (conv: ConversationDto) => number;
}>();

const emit = defineEmits<{
  "toggle-agent-menu": [];
  "pick-agent": [agent: AgentEntry];
  "toggle-sidebar": [];
  "new-conversation": [];
  "open-task-list": [];
  "update:convQuery": [value: string];
  "conv-search-input": [];
  "update:showArchived": [value: boolean];
  "archived-change": [];
  "toggle-task-section": [];
  "toggle-task-group": [id: string];
  "task-group-keydown": [event: KeyboardEvent, id: string];
  "open-task-ctx": [event: MouseEvent, schedule: ScheduleDto];
  "open-task-conversation": [schedule: ScheduleDto];
  "open-run-conversation": [run: TaskGroupRun];
  "run-keydown": [event: KeyboardEvent, run: TaskGroupRun];
  "toggle-conv-section": [];
  "open-ctx": [event: MouseEvent, conv: ConversationDto];
  "select-conversation": [conv: ConversationDto];
  "conv-keydown": [event: KeyboardEvent, conv: ConversationDto];
  "drag-start": [event: DragEvent, conv: ConversationDto];
  "drag-over": [event: DragEvent, conv: ConversationDto];
  drop: [event: DragEvent];
  "drag-end": [event: DragEvent];
  "update:renameValue": [value: string];
  "rename-keydown": [event: KeyboardEvent];
  "commit-rename": [];
  "ask-delete": [conv: ConversationDto];
  "clear-current": [];
}>();

const agentMenuEl = ref<HTMLElement | null>(null);
const convListEl = ref<HTMLElement | null>(null);
defineExpose({ agentMenuEl, convListEl });

const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

function onConvQueryInput(event: Event) {
  emit('update:convQuery', (event.target as HTMLInputElement).value);
  emit('conv-search-input');
}

function onArchivedChange(event: Event) {
  emit('update:showArchived', (event.target as HTMLInputElement).checked);
  emit('archived-change');
}

function onRenameInput(event: Event) {
  emit('update:renameValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <aside class="sidebar" :class="{ open: sidebarOpen, collapsed: sidebarCollapsed }" :aria-label="tx('会话列表', 'Conversations', 'Conversas', 'चैट सूची')">
    <div class="sidebar__inner">
    <div class="brand">
      <div ref="agentMenuEl" class="brand__agent">
        <h1 class="brand__name">
          <button
            type="button"
            class="brand__switch"
            :aria-expanded="agentMenuOpen ? 'true' : 'false'"
            aria-haspopup="menu"
            :title="tx('切换助手', 'Switch assistant', 'Trocar assistente', 'सहायक बदलें')"
            @click="emit('toggle-agent-menu')"
          >
            <span class="brand__agent-name">{{
              currentAgent
                ? agentText(currentAgent.label, uiLocale)
                : agentLabel || tx("小助手", "Assistant", "Assistente", "सहायक")
            }}</span>
            <svg
              class="brand__agent-caret"
              :class="{ open: agentMenuOpen }"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </h1>
        <!-- 助手下拉：列出全部角色（对齐 CodeBuddy 的助手选择）；当前项打勾，点击即整页切换。 -->
        <div v-if="agentMenuOpen" class="agent-menu" role="menu" :aria-label="tx('切换助手', 'Switch assistant', 'Trocar assistente', 'सहायक बदलें')">
          <button
            v-for="a in agents"
            :key="a.id"
            type="button"
            role="menuitem"
            class="agent-menu__item"
            :class="{ active: a.id === agentId }"
            @click="emit('pick-agent', a)"
          >
            <span class="agent-menu__icon" aria-hidden="true">{{ a.icon }}</span>
            <span class="agent-menu__label">{{ agentText(a.label, uiLocale) }}</span>
            <svg
              v-if="a.id === agentId"
              class="agent-menu__check"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m5 13 4 4L19 7" />
            </svg>
          </button>
        </div>
      </div>
      <RouterLink to="/" class="brand__home" :title="tx('返回门户', 'Back to portal', 'Voltar ao portal', 'पोर्टल पर वापस')">⌂</RouterLink>
      <button
        v-if="!isMobile"
        type="button"
        class="brand__collapse"
        :aria-label="tx('收起会话列表', 'Collapse conversations', 'Recolher conversas', 'सूची समेटें')"
        :title="tx('收起会话列表', 'Collapse conversations', 'Recolher conversas', 'सूची समेटें')"
        @click="emit('toggle-sidebar')"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
    </div>
    <!-- CodeBuddy 版式：顶部「图标 + 文字」操作导航行（创建入口集中在这），分组列表收在下方。 -->
    <nav class="side-nav" :aria-label="tx('快捷操作', 'Quick actions', 'Ações rápidas', 'त्वरित क्रियाएँ')">
      <button class="side-nav__item" type="button" @click="emit('new-conversation')">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M8 12h8" />
        </svg>
        <span>{{ tx("新建对话", "New chat", "Nova conversa", "नई चैट") }}</span>
      </button>
      <button class="side-nav__item" type="button" @click="emit('open-task-list')">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>{{ tx("定时任务", "Scheduled tasks", "Tarefas agendadas", "अनुसूचित कार्य") }}</span>
      </button>
    </nav>
    <div class="conv-search" role="search">
      <svg class="conv-search__icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle>
        <path d="m20 20-3.2-3.2"></path>
      </svg>
      <input
        :value="convQuery"
        class="conv-search__input"
        type="text"
        :placeholder="tx('搜索对话', 'Search chats', 'Buscar conversas', 'चैट खोजें')"
        :aria-label="tx('搜索对话', 'Search chats', 'Buscar conversas', 'चैट खोजें')"
        @input="onConvQueryInput"
      />
    </div>
    <label class="conv-archived-toggle" :title="tx('显示已归档的对话', 'Show archived chats', 'Mostrar conversas arquivadas', 'आर्काइव की चैट दिखाएं')">
      <input type="checkbox" :checked="showArchived" @change="onArchivedChange" />
      {{ tx("显示归档", "Archived", "Arquivadas", "आर्काइव") }}
    </label>
    <div ref="convListEl" class="conv-list">
      <!-- 定时任务区（docs/scheduled-task-sessions-plan.md §3.10）：置顶为可折叠分组。
           父 = 任务（未读角标 + 下次运行），子 = 各期会话（时间 + 状态点），默认折叠。
           与 CodeBuddy「定时任务收在任务名下」、Finder/VS Code「分组置顶 + 箭头折叠」同口径：
           分组头整行可点、chevron 箭头旋转、带 aria-expanded。 -->
      <template v-if="!convQuery.trim()">
        <button
          class="group-head"
          type="button"
          :aria-expanded="taskSectionOpen ? 'true' : 'false'"
          :aria-label="tx('定时任务', 'Scheduled', 'Agendados', 'अनुसूचित कार्य')"
          @click="emit('toggle-task-section')"
        >
          <span class="group-head__label">{{ tx("定时任务", "Scheduled", "Agendados", "अनुसूचित कार्य") }}</span>
          <span class="group-head__count">({{ taskGroups.length }})</span>
          <span class="group-head__caret" :class="{ open: taskSectionOpen }" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </span>
        </button>
        <div v-if="taskSectionOpen && !taskGroups.length" class="task-groups-empty">
          {{ tx("还没有定时任务，点上方「新建」即可创建", "No tasks yet — click “New” above", "Nenhuma tarefa ainda — clique em “Novo” acima", "अभी कोई कार्य नहीं — ऊपर “नया” पर क्लिक करें") }}
        </div>
        <div v-if="taskSectionOpen" class="task-groups">
          <div v-for="g in taskGroups" :key="g.schedule.id" class="task-group">
            <div
              class="task-group__head"
              role="button"
              tabindex="0"
              :aria-expanded="expandedTasks[g.schedule.id] ? 'true' : 'false'"
              :aria-label="g.schedule.name || g.schedule.prompt"
              @click="emit('toggle-task-group', g.schedule.id)"
              @keydown="emit('task-group-keydown', $event, g.schedule.id)"
              @contextmenu.prevent="emit('open-task-ctx', $event, g.schedule)"
            >
              <span class="task-group__caret" :class="{ open: expandedTasks[g.schedule.id] }" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </span>
              <span
                class="conv-dot"
                :class="taskDotClass(g.schedule)"
                :title="taskCardTip(g.schedule)"
                :aria-label="taskHealthShort(g.schedule)"
                role="img"
              ></span>
              <span class="task-group__main">
                <span class="task-group__title" :title="taskCardTip(g.schedule)">{{ g.schedule.name || g.schedule.prompt }}</span>
                <span class="task-group__health" :title="taskCardTip(g.schedule)">{{ taskHealthShort(g.schedule) }}</span>
              </span>
              <!-- 未读角标可点击：打开最新一期（打开会话即清零），不用再找入口（2026-10-08 用户反馈「点不掉」）。 -->
              <button
                v-if="g.schedule.unreadRuns"
                type="button"
                class="task-group__unread"
                :title="tx('有新的运行结果，点击查看', 'New run results — click to view', 'Novos resultados — clique para ver', 'नए रन परिणाम — देखने के लिए क्लिक करें')"
                :aria-label="tx('打开最新一期运行结果', 'Open latest run result', 'Abrir o resultado mais recente', 'नवीनतम रन परिणाम खोलें')"
                @click.stop="emit('open-task-conversation', g.schedule)"
              >{{ g.schedule.unreadRuns }}</button>
              <span class="task-group__next">{{ taskRightShort(g.schedule) }}</span>
              <button
                class="task-group__open"
                type="button"
                :title="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                :aria-label="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                @click.stop="emit('open-task-conversation', g.schedule)"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M9 7h8v8" />
                </svg>
              </button>
            </div>
            <template v-if="expandedTasks[g.schedule.id]">
              <div v-if="!filteredRuns(g.runs).length" class="task-groups-empty">
                {{ tx("没有符合筛选的运行记录", "No runs match this filter", "Nenhuma execução neste filtro", "इस फ़िल्टर में कोई रन नहीं") }}
              </div>
              <div
                v-for="r in filteredRuns(g.runs)"
                :key="r.conversationId"
                class="conv-item conv-item--run"
                :class="{ active: r.conversationId === currentId }"
                role="button"
                tabindex="0"
                :aria-current="r.conversationId === currentId ? 'true' : undefined"
                @click="emit('open-run-conversation', r)"
                @keydown="emit('run-keydown', $event, r)"
                @contextmenu.prevent="r.conv && emit('open-ctx', $event, r.conv)"
              >
                <span
                  v-if="r.status || r.marker"
                  class="conv-dot"
                  :class="r.marker === 'SPIKE' ? 'alert' : r.marker === 'NO_DATA' ? 'nodata' : (r.status || 'idle')"
                  :title="(r.marker ? taskMarkerText(r.marker) + ' · ' : '') + taskStatusText({ ...g.schedule, lastStatus: r.status as ScheduleDto['lastStatus'] })"
                  role="img"
                ></span>
                <span class="conv-title">{{ r.conv?.title || runTimeText(r.at) }}{{ r.marker ? ` · ${taskMarkerText(r.marker)}` : "" }}</span>
                <span class="conv-run-at">{{ runMetaText(r) }}</span>
              </div>
            </template>
          </div>
        </div>
      </template>
      <!-- 对话分组头：与定时任务分组头同款（CodeBuddy「名称 (数量) ›」口径），可整列折叠；搜索时直接让位给结果。 -->
      <button
        v-if="!convQuery.trim() && conversationsFiltered.length"
        class="group-head"
        type="button"
        :aria-expanded="convSectionOpen ? 'true' : 'false'"
        :aria-label="tx('对话', 'Chats', 'Conversas', 'चैट')"
        @click="emit('toggle-conv-section')"
      >
        <span class="group-head__label">{{ tx("对话", "Chats", "Conversas", "चैट") }}</span>
        <span class="group-head__count">({{ conversationsFiltered.length }})</span>
        <span class="group-head__caret" :class="{ open: convSectionOpen }" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </span>
      </button>
      <template v-if="convSectionOpen || convQuery.trim()">
      <!-- 首屏慢加载才亮骨架行；快加载时不闪，直接等真实条目出现。 -->
      <template v-if="showSkeleton">
        <div class="conv-skeleton" aria-hidden="true"></div>
        <div class="conv-skeleton" aria-hidden="true"></div>
        <div class="conv-skeleton" aria-hidden="true"></div>
      </template>
      <template v-for="(conv, i) in conversationsFiltered" :key="conv.id">
        <div v-if="!convQuery.trim() && pinnedCount > 0 && i === pinnedCount" class="conv-divider" role="separator">
          {{ tx("置顶", "Pinned", "Fixadas", "पिन किए गए") }}
        </div>
        <!-- 归档区固定在列表末尾（由 convRank 保证），勾选「显示归档」后才有内容。 -->
        <div v-if="!convQuery.trim() && archivedCount > 0 && i === firstArchivedIndex" class="conv-divider" role="separator">
          {{ tx("归档", "Archived", "Arquivadas", "आर्काइव") }}
        </div>
        <div
          class="conv-item"
          :class="{
            active: conv.id === currentId,
            pinned: !!conv.pinnedAt,
            'conv-archived': !!conv.archived,
            dragging: draggingId === conv.id,
            'drop-before': dropTarget?.id === conv.id && !dropTarget?.after,
            'drop-after': dropTarget?.id === conv.id && !!dropTarget?.after,
          }"
          :data-conv-id="conv.id"
          role="button"
          tabindex="0"
          :aria-current="conv.id === currentId ? 'true' : undefined"
          aria-haspopup="menu"
          :draggable="renaming.id !== conv.id && !conv.archived && !convQuery.trim()"
          @click="emit('select-conversation', conv)"
          @contextmenu.prevent="emit('open-ctx', $event, conv)"
          @keydown="emit('conv-keydown', $event, conv)"
          @dragstart="emit('drag-start', $event, conv)"
          @dragover="emit('drag-over', $event, conv)"
          @drop="emit('drop', $event)"
          @dragend="emit('drag-end', $event)"
        >
          <span
            v-if="convStatus(conv)"
            class="conv-dot"
            :class="convStatus(conv)"
            :title="convStatusText(convStatus(conv))"
            :aria-label="convStatusText(convStatus(conv))"
            role="img"
          ></span>
          <input
            v-if="renaming.id === conv.id"
            :ref="setRenameInput"
            :value="renaming.value"
            class="conv-rename"
            type="text"
            :maxlength="renameMax"
            :aria-label="tx('重命名对话', 'Rename chat', 'Renomear conversa', 'चैट का नाम बदलें')"
            @input="onRenameInput"
            @keydown="emit('rename-keydown', $event)"
            @blur="emit('commit-rename')"
            @click.stop
          />
          <template v-else>
            <span class="conv-title">{{ conv.title || tx("新对话", "New chat", "Nova conversa", "नई चैट") }}</span>
            <span
              v-if="conv.muted"
              class="conv-muted"
              :title="tx('免打扰：该对话的完成提醒已静默', 'Muted: completion alerts are silenced', 'Silenciado: alertas silenciados', 'मूक: पूर्णता सूचनाएं बंद')"
              :aria-label="tx('免打扰', 'Muted', 'Silenciado', 'मूक')"
            >{{ tx("免打扰", "Muted", "Silenciado", "मूक") }}</span>
            <span
              v-if="queueCount(conv)"
              class="conv-queue"
              :title="tx('有排队消息', 'Has queued messages', 'Mensagens na fila', 'कतार में संदेश हैं')"
              :aria-label="tx('有排队消息', 'Has queued messages', 'Mensagens na fila', 'कतार में संदेश हैं')"
            >{{ queueCount(conv) }}</span>
            <button
              class="conv-del"
              type="button"
              :title="tx('删除对话', 'Delete chat', 'Excluir conversa', 'चैट हटाएं')"
              @click.stop="emit('ask-delete', conv)"
            >
              ×
            </button>
          </template>
        </div>
      </template>
      </template>
    </div>
    <p v-if="convQuery.trim() && !conversationsFiltered.length" class="conv-empty">
      {{ tx("没有匹配的对话", "No matching chats", "Nenhuma conversa correspondente", "कोई मेल खाने वाली चैट नहीं") }}
    </p>
    <button
      class="ghost-btn"
      :class="{ 'ghost-btn-danger': clearArmed }"
      type="button"
      @click="emit('clear-current')"
    >
      {{
        clearArmed
          ? tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)")
          : tx("清空当前对话", "Clear current chat", "Limpar conversa atual", "वर्तमान चैट खाली करें")
      }}
    </button>
    </div>
  </aside>
</template>
