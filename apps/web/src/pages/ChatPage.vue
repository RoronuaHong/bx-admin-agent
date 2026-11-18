<script setup lang="ts">
import type { ScheduleDto } from "../api";
import { useRouter } from "vue-router";
import { useChatPageCore } from "../composables/chat/useChatPageCore";

const agentProps = defineProps<{ agentId?: string; agentLabel?: string }>();
const router = useRouter();
const {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
  BackToTop,
  ConversationOutline,
  ModelSelect,
  PromptBox,
  ToolsSearch,
  SkillAddForm,
  McpAddForm,
  ThemeToggle,
  UiLocaleSelect,
  UiSelect,
  ChatBubble,
  bubbleContextKey,
  renderChatMarkdown,
  applyStreamEvent,
  dedupeRepeats,
  MINUTELY_INTERVALS,
  REPEAT_FREQS,
  WEEKDAYS,
  buildCronFromForm,
  parseCron,
  toLocalInput,
  useOnceAtPicker,
  alertMarkerInfo,
  bubbleBody,
  isStoppedBubble,
  taskCardTipOf,
  taskConvTextOf,
  taskDotClassOf,
  taskHealthShortOf,
  taskKindTextOf,
  taskMarkerTextOf,
  taskNextRunTextOf,
  taskNextShortOf,
  taskRightShortOf,
  taskRunTextOf,
  taskStatusTextOf,
  matchesFuzzyScoped,
  matchesFuzzy,
  loadPinyin,
  pinyinReady,
  getUiLocale,
  detectDefaultLocale,
  isUiLocale,
  setUiLocale,
  showToolServer,
  toolDisplayName,
  visibleThinking,
  localizeToken,
  AGENTS,
  agentText,
  findAgent,
  readStoredTheme,
  useTheme,
  cancelChatTask,
  clearConversation,
  clearConversationContext,
  confirmToolCall,
  createConversation,
  apiCancelSubagent,
  conversationExportUrl,
  NOT_MODEL_FAULT_CODES,
  createChatSchedule,
  deleteChatSchedule,
  runChatSchedule,
  restartChatSchedule,
  apiDeleteConversation,
  deleteNotifyChannel,
  duplicateConversation,
  deleteCustomMcpServer,
  fetchChatMcpServers,
  fetchChatPreferences,
  fetchChatSkills,
  fetchChatTaskStatus,
  fetchConversation,
  fetchConversations,
  fetchModels,
  fetchMemory,
  fetchNotifyChannels,
  fetchSchedules,
  fetchWorkspaceFiles,
  getApiErrorToken,
  getApiErrorCode,
  addMemoryItem,
  readWorkspaceFile,
  workspaceDownloadUrl,
  removeMemoryItem,
  isChatTaskRunning,
  patchChatSchedule,
  patchConversation,
  enqueueConversationMessage,
  dequeueConversationMessage,
  reloadMcpServer,
  reorderConversations,
  resumeChatTaskEvents,
  saveChatPreferences,
  saveConversationMessages,
  saveNotifyChannel,
  setChatMcpServers,
  setChatSkills,
  streamChat,
  testNotifyChannel,
  uploadFiles,
  MODEL_AUTO_ID,
  parseAlertMarker,
  tasks,
  tasksBusy,
  showTaskForm,
  showTaskList,
  taskError,
  taskDraft,
  editingTaskId,
  cronUnparsed,
  editingCron,
  freqDialogOpen,
  notifyDialogOpen,
  loadTasks,
  tasksPollTimer,
  conversationSyncing,
  pendingSyncId,
  startTasksPoll,
  stopTasksPoll,
  refreshConversationsQuiet,
  refreshMcpAvailable,
  patchMcpRow,
  toggleTaskServer,
  connectTaskMcp,
  ensureTaskMcpConnected,
  toggleTaskSkill,
  taskCardFacts,
  taskStatusText,
  taskRunText,
  taskMarkerText,
  taskDotClass,
  taskHealthShort,
  taskRightShort,
  taskNextRunText,
  taskNextShort,
  taskKindText,
  taskConvText,
  taskCardTip,
  NOTIFY_KIND_LABELS,
  notifyKindLabel,
  notifyChannels,
  notifyBusy,
  notifyNote,
  channelDraft,
  notifySummary,
  loadNotifyChannels,
  channelErrorText,
  saveChannelDraft,
  testChannel,
  removeChannel,
  toggleChannelEnabled,
  taskToolsOpen,
  taskSkillOpen,
  taskSkillAddOpen,
  taskMcpAddOpen,
  taskMcpOpen,
  taskExpertOpen,
  taskSkillQuery,
  taskMcpQuery,
  taskExpertQuery,
  taskSearchAutofocus,
  taskToolsRoot,
  taskToolsPanel,
  taskToolsPos,
  closeTaskFlyouts,
  updateTaskToolsPos,
  syncTaskToolsPos,
  toggleTaskTools,
  openTaskFlyout,
  hoverTaskFlyout,
  onOutsideTaskTools,
  taskSkillFiltered,
  taskMcpFiltered,
  taskExpertFiltered,
  taskMcpCount,
  clearTaskSkills,
  clearTaskMcp,
  taskAgentLabel,
  taskRepeat,
  buildCron,
  ALERT_PROMPT_SCAFFOLD,
  applyTaskPurpose,
  bubbleHasAlertMarker,
  draftAlertPromptFromChat,
  applyAlertDraftFromChat,
  openAlertScheduleFromChat,
  repeatUnit,
  toggleWeekday,
  repeatPreview,
  taskFreqSummary,
  dtOpen,
  dtRoot,
  dtPanel,
  dtPos,
  dtDisplay,
  openDtPicker,
  syncDtPos,
  pickDay,
  shiftMonth,
  DT_SHORTCUTS,
  DT_WEEKDAYS,
  dtMonthLabel,
  dtCells,
  isDtToday,
  isDtPicked,
  DT_HOURS,
  DT_MINUTES,
  dtHour,
  dtMinute,
  dtHourPart,
  dtMinutePart,
  onOutsideDt,
  openTaskForm,
  closeTaskForm,
  openTaskListPage,
  onTaskFormEsc,
  submitTask,
  toggleTask,
  removeTask,
  runningNow,
  runTaskNow,
  restartTask,
  runStatusFilter,
  runMatchesFilter,
  filteredRuns,
  editingTask,
  openConversationById,
  openTaskConversation,
  openRunConversation,
  LOCAL_KEYS,
  adoptTheme,
  uiLocale,
  tx,
  blankState,
  threadEl,
  models,
  modelsLoaded,
  conversations,
  persistedCount,
  convQuery,
  conversationsFiltered,
  onConvSearchInput,
  AGENT_ID,
  AGENT_LABEL,
  MOBILE_QUERY,
  sidebarOpen,
  sidebarCollapsed,
  isMobile,
  navExpanded,
  updateIsMobile,
  toggleSidebar,
  agentMenuOpen,
  agentMenuEl,
  currentAgent,
  toggleAgentMenu,
  onPickAgent,
  onAgentMenuOutside,
  onAgentMenuEsc,
  onSidebarEsc,
  showArchived,
  currentId,
  booting,
  showSkeleton,
  SKELETON_DELAY_MS,
  ctxMenu,
  ctxMenuEl,
  ctxTriggerEl,
  ctxConfirm,
  renaming,
  renameInputEl,
  RENAME_MAX,
  UNDO_DELETE_MS,
  undoDelete,
  undoDeleteTimer,
  confirmDialog,
  confirmDialogEl,
  confirmPrimaryBtn,
  confirmReturnFocus,
  previewHtml,
  previewLoading,
  isHtmlArtifact,
  openArtifactPreview,
  closeArtifactPreview,
  askDeleteConversation,
  askDeleteFromCtx,
  askCloseOthers,
  closeConfirm,
  confirmDialogConfirm,
  trapConfirmFocus,
  sortMode,
  convListEl,
  draggingId,
  dropTarget,
  DRAG_SCROLL_STEP,
  DRAG_SCROLL_EDGE,
  fileInput,
  promptBoxEl,
  inputEl,
  stopBtnRef,
  COMPOSER_H_KEY,
  COMPOSER_H_MIN,
  COMPOSER_H_MAX,
  COMPOSER_BASE,
  COMPOSER_AUTO_MAX,
  composerSize,
  loadComposerSize,
  autoGrow,
  onWindowResizeGrow,
  startComposerResize,
  resetComposerSize,
  deviceLocale,
  browserTimeZone,
  settingsError,
  blank,
  states,
  stateOf,
  current,
  latestAlertMarkerId,
  alertMarkerCache,
  EMPTY_BUBBLES,
  bubbleArrIds,
  bubbleArrSeq,
  bubbleArrId,
  THREAD_WINDOW_STEP,
  threadWindow,
  visibleBubbles,
  showEarlierMessages,
  OUTLINE_LABEL_MAX,
  outlineLabel,
  outlineCache,
  conversationOutline,
  outlineOpen,
  activeOutlineId,
  pinnedOutlineId,
  outlineJumpActive,
  outlineJumpFallback,
  outlineScrollEndHandler,
  outlineIgnoreScrollUntil,
  finishOutlineScroll,
  releaseOutlinePin,
  OUTLINE_NAV_KEYS,
  onOutlineUserScrollIntent,
  OUTLINE_WINDOW_MARGIN,
  OUTLINE_ACTIVE_BAND,
  OUTLINE_LANDING_INSET,
  jumpToOutline,
  modelId,
  lastGoodModelId,
  failedModelIds,
  resolveModel,
  settingsErrorTimer,
  showSettingsError,
  syncConvLocal,
  applyConversationLocale,
  modelChoiceLabel,
  modelSwitchHint,
  saveModelChoice,
  onLocaleChange,
  resolvedModelId,
  modelSupportsImages,
  imagesUnsupported,
  mcpOpen,
  mcpAvailable,
  mcpBusy,
  mcpReconnecting,
  mcpError,
  seq,
  scrollQueued,
  scrollForce,
  canSend,
  queueScrollIfCurrent,
  followBottom,
  nearBottom,
  atBottomNow,
  onThreadScroll,
  queueScroll,
  openReasoning,
  reasoningCollapsedByUser,
  toggleReasoning,
  openReasoningPanel,
  closeReasoningPanel,
  openSteps,
  stepKey,
  toggleStep,
  stepSummary,
  hasRunningStep,
  hasThinking,
  INTENT_RE,
  intentOf,
  thinkingDisplay,
  thinkStarts,
  thinkPhaseStart,
  thinkPhaseEnd,
  thinkLabel,
  thinkStickQueued,
  stickThinkingToBottom,
  reasoningTitle,
  chartsOf,
  settleStep,
  SNAPSHOT_DETAIL_TAIL,
  SNAPSHOT_THINKING_CAP,
  SNAPSHOT_STEP_RESULT_CAP,
  capTail,
  toStored,
  bubblesFromStored,
  upgradeConversationDetail,
  applyServerThread,
  tailSig,
  serverThreadAhead,
  syncOpenConversation,
  pendingPersists,
  persistChains,
  waitPendingPersists,
  persist,
  persistNow,
  selectConversation,
  newConversation,
  createConvFromDraft,
  CONV_ORDER_STEP,
  convRank,
  resortConversations,
  applyConversationOrder,
  restoreRecentSort,
  onConvDragStart,
  onConvDragOver,
  onConvDragEnd,
  onConvDrop,
  moveConversation,
  onConvKeydown,
  pinnedCount,
  archivedCount,
  firstArchivedIndex,
  taskConvIds,
  taskGroups,
  TASK_GROUP_KEY,
  expandedTasks,
  readTaskGroupState,
  toggleTaskGroup,
  onTaskGroupKeydown,
  TASK_SECTION_KEY,
  taskSectionOpen,
  readTaskSectionState,
  toggleTaskSection,
  CONV_SECTION_KEY,
  convSectionOpen,
  readConvSectionState,
  toggleConvSection,
  onRunKeydown,
  runTimeText,
  runMetaText,
  clearTaskUnread,
  ctxTarget,
  ctxTargetTask,
  ctxOpenTaskConv,
  ctxRunTaskNow,
  ctxEditTask,
  ctxToggleTaskEnabled,
  ctxMarkTaskRead,
  ctxRemoveTask,
  removeConversation,
  deleteConversationOnServer,
  flushPendingDelete,
  scheduleUndoDelete,
  undoRemoveConversation,
  ctxAnchorPos,
  placeCtxMenu,
  openCtxMenu,
  openTaskCtxMenu,
  closeCtxMenu,
  armCtxConfirm,
  reloadConversations,
  toggleArchive,
  toggleMute,
  toggleFullAccess,
  draftSendMode,
  currentSendMode,
  toggleSendModeForCurrent,
  toggleSendMode,
  duplicateCurrent,
  exportConversation,
  cancelSubagent,
  onCtxMenuKeydown,
  onCtxEscape,
  onCtxDismiss,
  setRenameInput,
  startRename,
  cancelRename,
  commitRename,
  onRenameKeydown,
  togglePin,
  clearConversationById,
  closeOtherConversations,
  clearArmedFor,
  clearArmTimer,
  clearArmed,
  onClearCurrentClick,
  clearCurrent,
  convStatus,
  convStatusText,
  pickFiles,
  removePendingImage,
  removePendingDoc,
  MAX_QUEUE,
  queueSetChains,
  enqueueMessage,
  setQueue,
  drainQueue,
  send,
  RESUME_ATTEMPTS,
  RESUME_BACKOFF_MS,
  sleep,
  applyChatEvent,
  resumeRun,
  runTurn,
  stop,
  doneToast,
  doneToastTimer,
  bgWatch,
  queueWatch,
  pageUnmounted,
  unmountTimers,
  deferOnPage,
  watchAndDrain,
  showDoneToast,
  openDoneToast,
  watchBackgroundDone,
  appendNotice,
  settleInterruptedRun,
  ensureRunPrompt,
  attachRunningTask,
  queueCount,
  moveQueueItem,
  removeQueueItem,
  editQueueItem,
  queueNowDispatching,
  sendQueueItemNow,
  answerToolConfirm,
  clarifyDraft,
  submitClarifyFreeform,
  answerClarification,
  scheduleConfirmExpiry,
  confirmLevelText,
  confirmExpiryText,
  loadMcp,
  openMcpPanel,
  boundMcpIds,
  isBoundMcp,
  bindingBoundMcp,
  ensureBoundMcp,
  toggleMcp,
  clearMcpSelection,
  reconnectMcp,
  removeCustomMcp,
  mcpRowState,
  taskRowState,
  skillOpen,
  skillAddOpen,
  mcpAddOpen,
  skillAvailable,
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
  toolsRoot,
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
  expertAgents,
  currentExpert,
  expertStarters,
  composerPlaceholder,
  askStarter,
  expertQuery,
  expertFiltered,
  openExpertPanel,
  closeToolsPanels,
  onPickExpert,
  onClearExpert,
  hoverFlyout,
  onEscTools,
  onOutsideTools,
  iconStyle,
  iconChar,
  resOpen,
  resRoot,
  memoryItems,
  memoryText,
  memoryBusy,
  wsFiles,
  wsFileContent,
  wsLoading,
  onOutsideRes,
  toggleResPanel,
  loadMemory,
  addMemoryEntry,
  removeMemoryEntry,
  loadWorkspaceFiles,
  openWorkspaceFile,
  formatBytes,
  stepClass,
  stepStatusText,
  subagentDotClass,
  subagentStatusText,
  usageText,
  alertChipText,
  copyToast,
  copyToastTimer,
  copyBubble,
  editUserBubble,
  onKeydown,
  onInlineSubmitKeydown,
  initialConversationId,
  activeReportTimer,
  skeletonTimer,
  reportActiveConversation,
  migrateLocalPrefs,
  nowClock,
  nowZone,
  nowClockTimer,
  messageTimes,
  buildBubbleTimeFormatter,
  bubbleTimeZone,
  bubbleTimeFormatter,
  bubbleTimeCache,
  bubbleTimeText,
  refreshNowClock,
} = useChatPageCore({ agentProps, router });
</script>

<template>
  <div class="chat" @click="closeCtxMenu()">
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
              @click="toggleAgentMenu()"
            >
              <span class="brand__agent-name">{{
                currentAgent
                  ? agentText(currentAgent.label, uiLocale)
                  : AGENT_LABEL || tx("小助手", "Assistant", "Assistente", "सहायक")
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
              v-for="a in AGENTS"
              :key="a.id"
              type="button"
              role="menuitem"
              class="agent-menu__item"
              :class="{ active: a.id === AGENT_ID }"
              @click="onPickAgent(a)"
            >
              <span class="agent-menu__icon" aria-hidden="true">{{ a.icon }}</span>
              <span class="agent-menu__label">{{ agentText(a.label, uiLocale) }}</span>
              <svg
                v-if="a.id === AGENT_ID"
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
          @click="toggleSidebar()"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>
      <!-- CodeBuddy 版式：顶部「图标 + 文字」操作导航行（创建入口集中在这），分组列表收在下方。 -->
      <nav class="side-nav" :aria-label="tx('快捷操作', 'Quick actions', 'Ações rápidas', 'त्वरित क्रियाएँ')">
        <button class="side-nav__item" type="button" @click="newConversation">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <span>{{ tx("新建对话", "New chat", "Nova conversa", "नई चैट") }}</span>
        </button>
        <button class="side-nav__item" type="button" @click="openTaskListPage()">
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
          v-model="convQuery"
          class="conv-search__input"
          type="text"
          :placeholder="tx('搜索对话', 'Search chats', 'Buscar conversas', 'चैट खोजें')"
          :aria-label="tx('搜索对话', 'Search chats', 'Buscar conversas', 'चैट खोजें')"
          @input="onConvSearchInput"
        />
      </div>
      <label class="conv-archived-toggle" :title="tx('显示已归档的对话', 'Show archived chats', 'Mostrar conversas arquivadas', 'आर्काइव की चैट दिखाएं')">
        <input type="checkbox" v-model="showArchived" @change="reloadConversations" />
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
            @click="toggleTaskSection"
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
                @click="toggleTaskGroup(g.schedule.id)"
                @keydown="onTaskGroupKeydown($event, g.schedule.id)"
                @contextmenu.prevent="openTaskCtxMenu($event, g.schedule)"
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
                  @click.stop="openTaskConversation(g.schedule)"
                >{{ g.schedule.unreadRuns }}</button>
                <span class="task-group__next">{{ taskRightShort(g.schedule) }}</span>
                <button
                  class="task-group__open"
                  type="button"
                  :title="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                  :aria-label="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                  @click.stop="openTaskConversation(g.schedule)"
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
                  @click="openRunConversation(r)"
                  @keydown="onRunKeydown($event, r)"
                  @contextmenu.prevent="r.conv && openCtxMenu($event, r.conv)"
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
          @click="toggleConvSection"
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
            @click="selectConversation(conv)"
            @contextmenu.prevent="openCtxMenu($event, conv)"
            @keydown="onConvKeydown($event, conv)"
            @dragstart="onConvDragStart($event, conv)"
            @dragover="onConvDragOver($event, conv)"
            @drop="onConvDrop"
            @dragend="onConvDragEnd"
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
              v-model="renaming.value"
              class="conv-rename"
              type="text"
              :maxlength="RENAME_MAX"
              :aria-label="tx('重命名对话', 'Rename chat', 'Renomear conversa', 'चैट का नाम बदलें')"
              @keydown="onRenameKeydown"
              @blur="commitRename"
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
                @click.stop="askDeleteConversation(conv)"
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
        @click="onClearCurrentClick"
      >
        {{
          clearArmed
            ? tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)")
            : tx("清空当前对话", "Clear current chat", "Limpar conversa atual", "वर्तमान चैट खाली करें")
        }}
      </button>
      </div>
    </aside>
    <!-- 移动端抽屉遮罩：仅抽屉打开时渲染，点击关闭；桌面端汉堡隐藏、不会打开（指南 §6 阻断项 #2）。 -->
    <div
      v-if="sidebarOpen"
      class="sidebar-backdrop"
      aria-hidden="true"
      @click="sidebarOpen = false"
    ></div>
    <Teleport to="body">
      <div
        v-if="ctxMenu.open"
        ref="ctxMenuEl"
        class="ctx-menu"
        role="menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent
        @keydown="onCtxMenuKeydown"
      >
        <!-- 定时任务菜单：右键任务分组头时渲染；与对话菜单互斥（ctxTargetTask / ctxTarget 二选一）。 -->
        <template v-if="ctxTargetTask">
          <button type="button" class="ctx-item" role="menuitem" :disabled="!!ctxTargetTask.runRequestedAt" @click="ctxRunTaskNow">
            {{ ctxTargetTask.runRequestedAt ? tx("即将执行", "Queued", "Na fila", "कतार में") : tx("立即执行", "Run now", "Executar agora", "अभी चलाएँ") }}
          </button>
          <button type="button" class="ctx-item" role="menuitem" @click="ctxOpenTaskConv">
            {{ tx("打开结果对话", "Open results chat", "Abrir conversa de resultados", "परिणाम चैट खोलें") }}
          </button>
          <button type="button" class="ctx-item" role="menuitem" @click="ctxEditTask">
            {{ tx("编辑任务", "Edit task", "Editar tarefa", "कार्य संपादित करें") }}
          </button>
          <button type="button" class="ctx-item" role="menuitem" @click="ctxToggleTaskEnabled">
            {{ ctxTargetTask.enabled ? tx("暂停任务", "Pause task", "Pausar tarefa", "कार्य रोकें") : tx("恢复任务", "Resume task", "Retomar tarefa", "कार्य फिर से चलाएं") }}
          </button>
          <button v-if="ctxTargetTask.unreadRuns" type="button" class="ctx-item" role="menuitem" @click="ctxMarkTaskRead">
            {{ tx("标记已读", "Mark read", "Marcar como lido", "पढ़ा हुआ मार्क करें") }}
          </button>
          <div class="ctx-sep" role="separator"></div>
          <button type="button" class="ctx-item danger" role="menuitem" @click="ctxRemoveTask">
            {{ tx("删除任务", "Delete task", "Excluir tarefa", "कार्य हटाएं") }}
          </button>
        </template>
        <template v-else>
        <button type="button" class="ctx-item" role="menuitem" @click="ctxTarget && startRename(ctxTarget)">
          <span>{{ tx("重命名", "Rename", "Renomear", "नाम बदलें") }}</span>
          <kbd class="ctx-kbd">F2</kbd>
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="ctxTarget && togglePin(ctxTarget)">
          {{ ctxTarget?.pinnedAt ? tx("取消置顶", "Unpin", "Desafixar", "अनपिन करें") : tx("置顶", "Pin", "Fixar", "पिन करें") }}
        </button>
        <button
          v-if="sortMode === 'manual'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="restoreRecentSort"
        >
          {{ tx("恢复自动排序", "Sort by recent", "Ordenar por recentes", "हाल के अनुसार क्रम") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <!-- 清空对话无撤销入口：首点进入待确认，再点才执行；关闭其它对话走下方确认弹窗。 -->
        <button
          v-if="ctxConfirm !== 'clear'"
          type="button"
          class="ctx-item"
          role="menuitem"
          @click="armCtxConfirm('clear')"
        >
          {{ tx("清空对话", "Clear chat", "Limpar conversa", "चैट खाली करें") }}
        </button>
        <button
          v-else
          data-ctx-confirm
          type="button"
          class="ctx-item danger"
          role="menuitem"
          @click="clearConversationById(ctxMenu.targetId)"
        >
          {{ tx("确认清空（不可恢复）", "Confirm clear (can't be undone)", "Confirmar limpeza (irreversível)", "खाली करने की पुष्टि (अपरिवर्तनीय)") }}
        </button>
        <button
          type="button"
          class="ctx-item danger"
          role="menuitem"
          @click="askCloseOthers()"
        >
          {{ tx("关闭其它对话", "Close other chats", "Fechar outras conversas", "अन्य चैट बंद करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="toggleArchive(ctxMenu.targetId)">
          {{ ctxTarget?.archived ? tx("取消归档", "Unarchive", "Desarquivar", "अनआर्काइव करें") : tx("归档", "Archive", "Arquivar", "आर्काइव करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="toggleMute(ctxMenu.targetId)">
          {{
            ctxTarget?.muted
              ? tx("取消免打扰", "Unmute", "Reativar notificações", "सूचनाएं चालू करें")
              : tx("免打扰", "Mute", "Silenciar", "सूचनाएं बंद करें")
          }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="toggleFullAccess(ctxMenu.targetId)">
          {{
            ctxTarget?.fullAccess === false
              ? tx("开启完全访问", "Enable full access", "Ativar acesso total", "पूर्ण एक्सेस चालू करें")
              : tx("关闭完全访问", "Disable full access", "Desativar acesso total", "पूर्ण एक्सेस बंद करें")
          }}
        </button>
        <button
          type="button"
          class="ctx-item"
          role="menuitem"
          :title="(ctxTarget?.sendMode ?? 'preempt') === 'preempt'
            ? tx('当前：抢占式（新消息接管正在生成的回复）', 'Current: preempt (new message takes over)', 'Atual: preemptiva (nova mensagem assume)', 'वर्तमान: preempt (नया संदेश अधिग्रहण करेगा)')
            : tx('当前：排队等待（新消息等本轮完成后按顺序发出）', 'Current: queue (new messages wait for the current turn)', 'Atual: fila (novas mensagens esperam a vez)', 'वर्तमान: कतार (नया संदेश अपनी बारी का इंतजार करेगा)')"
          @click="toggleSendMode(ctxMenu.targetId)"
        >
          {{
            (ctxTarget?.sendMode ?? "preempt") === "preempt"
              ? tx("发送模式：切到排队等待", "Send mode: switch to queue", "Modo de envio: mudar para fila", "भेजने का मोड: कतार पर बदलें")
              : tx("发送模式：切到抢占式", "Send mode: switch to preempt", "Modo de envio: mudar para preemptiva", "भेजने का मोड: preempt पर बदलें")
          }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="duplicateCurrent(ctxMenu.targetId)">
          {{ tx("复制对话", "Duplicate", "Duplicar", "डुप्लिकेट करें") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="exportConversation(ctxMenu.targetId, 'md')">
          {{ tx("导出 Markdown", "Export Markdown", "Exportar Markdown", "मार्कडाउन निर्यात") }}
        </button>
        <button type="button" class="ctx-item" role="menuitem" @click="exportConversation(ctxMenu.targetId, 'json')">
          {{ tx("导出 JSON", "Export JSON", "Exportar JSON", "JSON निर्यात") }}
        </button>
        <div class="ctx-sep" role="separator"></div>
        <button type="button" class="ctx-item danger" role="menuitem" @click="askDeleteFromCtx()">
          {{ tx("删除对话", "Delete chat", "Excluir conversa", "चैट हटाएं") }}
        </button>
        </template>
      </div>
    </Teleport>

    <!-- 后台任务完成提醒：切走的对话跑完后提示一次；免打扰的对话静默。 -->
    <Teleport to="body">
      <div v-if="doneToast" class="done-toast" role="status" aria-live="polite">
        <span class="done-toast__text">
          {{ tx("「", '"', '"', '"') }}{{ doneToast.title }}{{ tx("」已完成", '" finished', '" concluído', '" पूर्ण') }}
        </span>
        <button type="button" class="done-toast__view" @click="openDoneToast">
          {{ tx("查看", "View", "Ver", "देखें") }}
        </button>
        <button
          type="button"
          class="done-toast__close"
          :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')"
          @click="doneToast = null"
        >
          ×
        </button>
      </div>
    </Teleport>

    <!-- 删除确认弹窗：点删除先弹这里，确定才真正删除（撤销条仍兜底）。 -->
    <Teleport to="body">
      <div v-if="confirmDialog" class="modal-mask" @click.self="closeConfirm">
        <div
          ref="confirmDialogEl"
          class="modal modal--confirm"
          role="alertdialog"
          aria-modal="true"
          :aria-label="confirmDialog.title"
          tabindex="-1"
          @keydown.esc.stop="closeConfirm"
          @keydown.tab="trapConfirmFocus"
        >
          <div class="modal__body confirm-body">
            <span
              class="confirm-icon"
              :class="{ 'confirm-icon--danger': confirmDialog.danger }"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              </svg>
            </span>
            <div class="confirm-text">
              <div class="confirm-title">{{ confirmDialog.title }}</div>
              <p class="confirm-message">{{ confirmDialog.message }}</p>
            </div>
          </div>
          <div class="modal__foot">
            <button type="button" class="ghost-btn" @click="closeConfirm">
              {{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}
            </button>
            <button
              ref="confirmPrimaryBtn"
              type="button"
              class="ghost-btn"
              :class="{ 'ghost-btn-danger': confirmDialog.danger }"
              @click="confirmDialogConfirm"
            >
              {{ confirmDialog.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="previewHtml" class="modal-mask" @click.self="closeArtifactPreview">
        <div class="modal modal--preview" role="dialog" aria-modal="true" :aria-label="previewHtml.name">
          <div class="modal__head">
            <span class="modal__title">{{ previewHtml.name }}</span>
            <div class="modal__head-actions">
              <a
                class="ghost-btn"
                :href="workspaceDownloadUrl(currentId, previewHtml.path)"
                :download="previewHtml.name"
              >{{ tx("下载", "Download", "Descargar", "डाउनलोड") }}</a>
              <button class="modal__close" type="button" aria-label="Close" @click="closeArtifactPreview">×</button>
            </div>
          </div>
          <div class="modal__body preview-body">
            <div v-if="previewLoading" class="preview-loading">{{ tx("加载中…", "Loading…", "Cargando…", "लोड हो रहा है…") }}</div>
            <iframe v-else class="preview-frame" :srcdoc="previewHtml.content" sandbox="allow-scripts"></iframe>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- v-if 挂在 Teleport 上：宿主 #task-panel-host 在 <main> 里、由本组件渲染，
         若 Teleport 随组件一起挂载会在宿主存在前解析目标而报错；
         推迟到表单打开时才挂载，此时宿主早已就位。 -->
    <Teleport v-if="showTaskForm" to="#task-panel-host">
      <!-- 内嵌主区的定时任务表单（不再是弹窗）：只有「取消」/「×」/ Esc 能退出（见 onTaskFormEsc）。 -->
      <div class="task-panel" role="region" :aria-label="tx('定时任务表单', 'Scheduled task form', 'Formulário de tarefa agendada', 'अनुसूचित कार्य फ़ॉर्म')">
        <div class="task-panel__head">
          <span class="task-panel__title">{{
            editingTaskId
              ? tx("编辑定时任务", "Edit scheduled task", "Editar tarefa agendada", "अनुसूचित कार्य संपादित करें")
              : tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य")
          }}</span>
          <!-- 操作按钮放标题行右上角（对齐 CodeBuddy）：底部不再占一条，composer 直接贴住表单底缘。 -->
          <div class="task-panel__head-actions">
            <button class="ghost-btn" type="button" @click="closeTaskForm">{{ tx("取消", "Cancel", "Cancelar", "रद्द करें") }}</button>
            <button class="primary-btn" type="button" :disabled="tasksBusy" @click="submitTask">
              {{ editingTaskId ? tx("保存", "Save", "Salvar", "सहेजें") : tx("创建", "Create", "Criar", "बनाएं") }}
            </button>
          </div>
        </div>
        <div class="task-panel__body">
            <label class="field field--name">
              <span class="field__label"
                >{{ tx("名称", "Name", "Nome", "नाम") }}<span class="field__req" aria-hidden="true">*</span></span
              >
              <input class="field__input" v-model="taskDraft.name" :placeholder="tx('例如：每日流量日报', 'e.g. Daily traffic report', 'Ex.: relatório diário de tráfego', 'उदा. दैनिक ट्रैफ़िक रिपोर्ट')" />
            </label>
            <!-- 用途：报告 / 预警一键带默认（对齐 ChatGPT Monitoring + Datadog 主路径），不是参数仓库。 -->
            <div class="task-row">
              <span class="task-row__label">{{ tx("用途", "Purpose", "Finalidade", "उद्देश्य") }}</span>
              <div class="task-row__body">
                <div
                  class="seg seg--inline"
                  role="radiogroup"
                  :title='taskDraft.purpose === "alert" ? tx(
                    "数据预警：保存后马上检查一次并发启动确认，之后仅异常时推送",
                    "Data alert: runs once on save and sends a start confirmation, then notifies only on anomaly",
                    "Alerta de dados: roda uma vez ao salvar e confirma o início, depois só em anomalia",
                    "डेटा अलर्ट: सहेजते ही एक बार जाँच और आरंभ पुष्टि, फिर केवल असामान्य पर सूचित",
                  ) : tx(
                    "周期报告：到点出报告并推送结果",
                    "Recurring report: produce and push a report on schedule",
                    "Relatório periódico: produz e envia no horário",
                    "आवधिक रिपोर्ट: शेड्यूल पर रिपोर्ट बनाकर भेजें",
                  )'
                >
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="taskDraft.purpose === 'report'"
                    class="seg__btn"
                    :class="{ active: taskDraft.purpose === 'report' }"
                    @click="applyTaskPurpose('report')"
                  >{{ tx("周期报告", "Report", "Relatório", "रिपोर्ट") }}</button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="taskDraft.purpose === 'alert'"
                    class="seg__btn"
                    :class="{ active: taskDraft.purpose === 'alert' }"
                    @click="applyTaskPurpose('alert')"
                  >{{ tx("数据预警", "Data alert", "Alerta de dados", "डेटा अलर्ट") }}</button>
                </div>
              </div>
            </div>
            <!-- 分组：任务标识（名称）之后是「到点怎么跑、结果往哪送」；任务内容（要执行的指令）放在表单最底部。 -->
            <div class="task-section">
              <span class="task-section__label">{{
                tx("到点运行时", "At run time", "Na execução", "रन के समय")
              }}</span>
              <!-- 结果去向：每个任务独占一个对话（服务端创建），每期结果只回到那里。
                   只在编辑已有任务时显示（显示专属对话名 + 打开入口）；新建时是改不了的静态事实，不占一行。 -->
              <div
                v-if="editingTask"
                class="task-row"
                :title='tx(
                  "本任务专属对话，每期结果只写这里",
                  "This chat is exclusive to this task; each run result is written here",
                  "Conversa exclusiva desta tarefa; cada resultado é escrito aqui",
                  "यह चैट केवल इस कार्य की है; हर रन का परिणाम यहीं",
                )'
              >
                <span class="task-row__label">{{ tx("结果回到", "Results go to", "Resultado em", "परिणाम यहाँ") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ taskConvText(editingTask!) }}</span>
                </div>
                <button
                  class="notify-btn"
                  type="button"
                  @click="openTaskConversation(editingTask!)"
                >{{ tx("打开", "Open", "Abrir", "खोलें") }}</button>
              </div>
              <!-- 结果落点（docs/scheduled-task-sessions-plan.md §3.11）：对齐 ChatGPT 的 standalone / in-chat 两种任务；
                   切换只影响**此后**的运行，不动已有会话。两种落点的差异说明放悬浮提示，不铺段落。 -->
              <div class="task-row">
                <span class="task-row__label">{{ tx("结果落点", "Where results land", "Onde os resultados ficam", "परिणाम कहाँ जाएँ") }}</span>
                <div class="task-row__body">
                  <div
                    class="seg seg--inline"
                    role="radiogroup"
                    :title='taskDraft.runMode === "same" ? tx(
                      "同一会话：沿用上下文，适合连续跟踪",
                      "Same chat: keeps context, for continuous tracking",
                      "Mesma conversa: mantém contexto, para acompanhamento contínuo",
                      "वही चैट: संदर्भ बनाए रखती है, निरंतर ट्रैकिंग के लिए",
                    ) : tx(
                      "每期新会话：可单独回看与对比（默认）",
                      "New chat per run: reviewable and comparable (default)",
                      "Nova conversa por execução: revisável e comparável (padrão)",
                      "हर रन के लिए नई चैट: अलग देखी/तुलना की जा सके (डिफ़ॉल्ट)",
                    )'
                  >
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.runMode === 'new'"
                      class="seg__btn"
                      :class="{ active: taskDraft.runMode === 'new' }"
                      @click="taskDraft.runMode = 'new'"
                    >{{ tx("每期新会话", "New chat per run", "Nova conversa por execução", "हर रन के लिए नई चैट") }}</button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.runMode === 'same'"
                      class="seg__btn"
                      :class="{ active: taskDraft.runMode === 'same' }"
                      @click="taskDraft.runMode = 'same'"
                    >{{ tx("同一会话", "Same chat", "Mesma conversa", "वही चैट") }}</button>
                  </div>
                </div>
              </div>
              <!-- 结果通知策略：通道仍由「启用」总闸控制；这里只选「每期都推 / 仅异常时推」。 -->
              <div
                class="task-row"
                :title='taskDraft.notifyPolicy === "on_alert" ? tx(
                  "仅异常时推送：正常不推，破线每期都推。没写完结论的失败先推一条，满 60 分钟再推。模型接口报错每期写明对应状态码和原因。启用后第一次会发启动确认",
                  "On alert only: quiet when normal, every breach is pushed. A run with no conclusion notifies once, then again after 60 minutes. A model API error states its status code every run. The first run after enabling sends a start confirmation",
                  "Só em alerta: silêncio no normal, cada ruptura é enviada. Sem conclusão, avisa uma vez e de novo após 60 minutos. Erro da API do modelo informa o código em cada execução. A primeira após ativar confirma o início",
                  "केवल अलर्ट पर: सामान्य में चुप, हर उल्लंघन भेजें। बिना निष्कर्ष एक बार, फिर 60 मिनट बाद। मॉडल API त्रुटि हर बार कोड लिखे। चालू करने के बाद पहली बार आरंभ पुष्टि जाती है",
                ) : tx(
                  "每期都推。新建后马上跑一期，并发一条启动确认",
                  "Every run. A new task runs once right away and sends a start confirmation",
                  "Cada execução. Uma tarefa nova roda na hora e confirma o início",
                  "हर बार भेजें। नया कार्य तुरंत एक बार चलता है और आरंभ पुष्टि भेजता है",
                )'
              >
                <span class="task-row__label">{{ tx("通知策略", "Notify policy", "Política de notificação", "सूचना नीति") }}</span>
                <div class="task-row__body">
                  <div class="seg seg--inline" role="radiogroup">
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.notifyPolicy === 'always'"
                      class="seg__btn"
                      :class="{ active: taskDraft.notifyPolicy === 'always' }"
                      @click="taskDraft.notifyPolicy = 'always'"
                    >{{ tx("每期都推", "Every run", "Cada execução", "हर रन") }}</button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="taskDraft.notifyPolicy === 'on_alert'"
                      class="seg__btn"
                      :class="{ active: taskDraft.notifyPolicy === 'on_alert' }"
                      @click="taskDraft.notifyPolicy = 'on_alert'"
                    >{{ tx("仅异常时推", "On alert only", "Só em alerta", "केवल अलर्ट पर") }}</button>
                  </div>
                </div>
              </div>
              <!-- 结果通知通道：任务到点跑完即向所有已启用通道推送（由通道「启用」开关控制，无需逐任务勾选）。 -->
              <div
                class="task-row"
                :title='tx(
                  "向哪些通道推：由下方「管理」里各通道的启用开关控制。",
                  "Which channels get the push: controlled by each channel’s enabled switch under Manage.",
                  "Para quais canais enviar: controlado pelo interruptor de cada canal em Gerenciar.",
                  "किन चैनलों पर भेजें: प्रबंधित में प्रत्येक चैनल के सक्षम स्विच से।",
                )'
              >
                <span class="task-row__label">{{ tx("通知通道", "Notify channels", "Canais de notificação", "अधिसूचना चैनल") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ notifySummary }}</span>
                </div>
                <button class="notify-btn" type="button" @click="notifyDialogOpen = true">{{
                  tx("管理", "Manage", "Gerenciar", "प्रबंधित करें")
                }}</button>
              </div>
              <!-- 通知通道管理弹窗：通道增删改 / 启停 / 测试都在弹窗里做，主表单只留一行摘要（整体不超一屏）。
                   modal-mask 是 position:fixed，放在任务表单的 Teleport 内不影响层级。 -->
              <div v-if="notifyDialogOpen" class="modal-mask" @click.self="notifyDialogOpen = false">
                <div class="modal" role="dialog" :aria-label="tx('通知通道', 'Notify channels', 'Canais de notificação', 'अधिसूचना चैनल')">
                  <div class="modal__head">
                    <span class="modal__title">{{ tx("通知通道", "Notify channels", "Canais de notificação", "अधिसूचना चैनल") }}</span>
                    <button class="modal__close" type="button" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="notifyDialogOpen = false">×</button>
                  </div>
                  <div class="modal__body">
                    <p class="repeat-preview">{{
                      tx(
                        "任务到点运行结束时，会向所有已启用的通知通道推送结果（成功与失败都推）；只需启用通道、无需逐任务勾选。",
                        "On completion the result is pushed to every enabled notify channel (success and failure); no per-task selection needed.",
                        "Ao concluir, o resultado é enviado a todo canal de notificação ativado (sucesso e falha); sem seleção por tarefa.",
                        "पूर्ण होने पर परिणाम हर सक्षम अधिसूचना चैनल को भेजा जाता है (सफल/विफल); कोई कार्य-वार चयन नहीं।",
                      )
                    }}</p>
                    <div class="notify-manage">
                <details class="notify-collapse" open>
                  <summary>{{ tx("管理通知通道", "Manage channels", "Gerenciar canais", "चैनल प्रबंधित करें") }}</summary>
                  <div class="notify-form">
                  <!-- 自定义下拉（antd/vben 风格）：原生 select 的 option 样式无法控制，与弹窗风格割裂。 -->
                  <UiSelect
                    v-model="channelDraft.kind"
                    class="notify-kind"
                    block
                    :options="[
                      { value: 'dingtalk', label: 'DingTalk' },
                      { value: 'feishu', label: 'Feishu' },
                      { value: 'wecom', label: '企业微信' },
                    ]"
                    :aria-label="tx('通道类型', 'Channel type', 'Tipo de canal', 'चैनल प्रकार')"
                  />
                  <input class="field__input" v-model="channelDraft.label" :placeholder="tx('备注名（如：数据群）', 'Label (e.g. data group)', 'Nome (ex.: grupo de dados)', 'नाम (जैसे: डेटा ग्रुप)')" />
                  <input class="field__input notify-wide" v-model="channelDraft.webhook" placeholder="Webhook URL" />
                  <input class="field__input" v-model="channelDraft.secret" :placeholder="tx('加签密钥（可选）', 'Sign secret (optional)', 'Segredo da assinatura (opcional)', 'हस्ताक्षर सीक्रेट (वैकल्पिक)')" />
                  <input class="field__input" v-model="channelDraft.keyword" :placeholder="tx('关键词（可选）', 'Keyword (optional)', 'Palavra-chave (opcional)', 'कीवर्ड (वैकल्पिक)')" />
                  <button class="primary-btn" type="button" :disabled="notifyBusy" @click="saveChannelDraft">
                    {{ tx("保存通道", "Save channel", "Salvar canal", "चैनल सहेजें") }}
                  </button>
                </div>
                </details>
                <ul v-if="notifyChannels.length" class="notify-list">
                  <li v-for="ch in notifyChannels" :key="ch.id" class="notify-item">
                    <button
                      type="button"
                      class="notify-item__switch"
                      role="switch"
                      :aria-checked="Boolean(ch.enabled)"
                      :aria-label="tx('通道启用', 'Channel enabled', 'Canal ativo', 'चैनल सक्रिय')"
                      @click="toggleChannelEnabled(ch)"
                    >
                      <span class="notify-switch" :class="{ on: Boolean(ch.enabled) }" aria-hidden="true">
                        <span class="notify-switch__knob"></span>
                      </span>
                    </button>
                    <span class="notify-item__text">
                      <span class="notify-item__label">{{ ch.label }}</span>
                      <span class="notify-item__host"
                        >{{ notifyKindLabel(ch.kind) }} · {{ ch.host }}<template v-if="ch.hasSecret"> · {{ tx("已配密钥", "secret set", "com segredo", "सीक्रेट सेट") }}</template></span
                      >
                    </span>
                    <button class="notify-btn" type="button" :disabled="notifyBusy" @click="testChannel(ch.id)">
                      {{ tx("测试", "Test", "Testar", "टेस्ट") }}
                    </button>
                    <button class="notify-btn notify-btn--danger" type="button" :disabled="notifyBusy" :title="tx('删除通道', 'Delete channel', 'Excluir canal', 'चैनल हटाएँ')" @click="removeChannel(ch.id)">×</button>
                  </li>
                </ul>
                <p v-if="notifyNote" class="notify-note">{{ notifyNote }}</p>
              </div>
                </div>
                <div class="modal__foot">
                  <button class="primary-btn" type="button" @click="notifyDialogOpen = false">{{
                    tx("完成", "Done", "Concluído", "पूर्ण")
                  }}</button>
                </div>
              </div>
            </div>
              <div class="task-row">
                <span class="task-row__label">{{ tx("执行频率", "Frequency", "Frequência", "आवृत्ति") }}</span>
                <div class="task-row__body">
                  <span class="task-row__value">{{ taskFreqSummary }}</span>
                </div>
                <button class="notify-btn" type="button" @click="freqDialogOpen = true">{{
                  tx("设置", "Configure", "Configurar", "कॉन्फ़िगर करें")
                }}</button>
              </div>
            <!-- 执行频率弹窗：周期 / 时刻 / 星期多选 / 高级表达式只读展示收进来，主表单只留一行摘要。 -->
            <div v-if="freqDialogOpen" class="modal-mask" @click.self="freqDialogOpen = false">
              <div class="modal" role="dialog" :aria-label="tx('执行频率', 'Frequency', 'Frequência', 'आवृत्ति')">
                <div class="modal__head">
                  <span class="modal__title">{{ tx("执行频率", "Frequency", "Frequência", "आवृत्ति") }}</span>
                  <button class="modal__close" type="button" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="freqDialogOpen = false">×</button>
                </div>
                <div class="modal__body">
              <div class="freq-row">
                <div class="seg seg--inline" role="radiogroup">
                  <button type="button" role="radio" :aria-checked="taskDraft.scheduleType === 'recurring'" class="seg__btn" :disabled="cronUnparsed" :class="{ active: taskDraft.scheduleType === 'recurring' }" @click="taskDraft.scheduleType = 'recurring'">{{ tx("周期", "Recurring", "Recorrente", "आवधिक") }}</button>
                  <button type="button" role="radio" :aria-checked="taskDraft.scheduleType === 'once'" class="seg__btn" :disabled="cronUnparsed" :class="{ active: taskDraft.scheduleType === 'once' }" @click="taskDraft.scheduleType = 'once'">{{ tx("一次性", "Once", "Única", "एक बार") }}</button>
                </div>
                <template v-if="!cronUnparsed && taskDraft.scheduleType === 'recurring'">
                  <span class="freq-text">{{ tx("每", "Every", "A cada", "हर") }}</span>
                  <input
                    class="field__input freq-num"
                    type="number"
                    min="1"
                    max="99"
                    :aria-label="tx('间隔', 'Interval', 'Intervalo', 'अंतराल')"
                    v-model.number="taskRepeat.interval"
                    @change="taskRepeat.freq === 'MINUTELY' && (taskRepeat.interval = (MINUTELY_INTERVALS as readonly number[]).includes(Number(taskRepeat.interval)) ? Number(taskRepeat.interval) : 10)"
                  />
                  <UiSelect
                    v-model="taskRepeat.freq"
                    class="freq-unit"
                    :options="REPEAT_FREQS.map((f) => ({ value: f.code, label: tx(f.unitZh, f.unitEn, f.unitPt, f.unitHi) }))"
                    :aria-label="tx('重复频率', 'Repeat', 'Repetição', 'दोहराव')"
                  />
                  <template v-if="taskRepeat.freq !== 'HOURLY' && taskRepeat.freq !== 'MINUTELY'">
                    <span class="freq-text">{{ tx("于", "at", "às", "को") }}</span>
                    <input class="field__input freq-time" type="time" v-model="taskRepeat.time" :aria-label="tx('执行时刻', 'Run at', 'Horário', 'समय')" />
                  </template>
                </template>
                <!-- 显式 else-if：cronUnparsed 时两边都不渲染（那种任务只在下面展示原表达式）。 -->
                <template v-else-if="taskDraft.scheduleType === 'once'">
                  <div ref="dtRoot" class="dt dt--inline">
                <button
                  type="button"
                  class="field__input dt__field"
                  :aria-expanded="dtOpen"
                  @click="dtOpen ? (dtOpen = false) : openDtPicker()"
                >
                  <span :class="{ 'dt__placeholder': !taskDraft.scheduledAt }">{{
                    taskDraft.scheduledAt ? dtDisplay : tx("选择日期和时间", "Select date and time", "Selecione data e hora", "तारीख और समय चुनें")
                  }}</span>
                  <svg class="dt__icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
                    <path d="M3 9.5h18" stroke="currentColor" stroke-width="1.6" />
                    <path d="M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
                <Teleport to="body">
                  <div
                    v-if="dtOpen"
                    ref="dtPanel"
                    class="dt__panel"
                    :style="{ top: dtPos.top + 'px', left: dtPos.left + 'px' }"
                  >
                  <div class="dt__short">
                    <button v-for="s in DT_SHORTCUTS" :key="s.en" type="button" class="dt__short-btn" @click="s.fn()">
                      {{ tx(s.zh, s.en, s.pt, s.hi) }}
                    </button>
                  </div>
                  <div class="dt__head">
                    <span class="dt__nav">
                      <button type="button" class="dt__nav-btn" :aria-label="tx('上一年', 'Previous year', 'Ano anterior', 'पिछला वर्ष')" @click="shiftMonth(-12)">«</button>
                      <button type="button" class="dt__nav-btn" :aria-label="tx('上个月', 'Previous month', 'Mês anterior', 'पिछला महीना')" @click="shiftMonth(-1)">‹</button>
                    </span>
                    <span class="dt__month">{{ dtMonthLabel }}</span>
                    <span class="dt__nav">
                      <button type="button" class="dt__nav-btn" :aria-label="tx('下个月', 'Next month', 'Próximo mês', 'अगला महीना')" @click="shiftMonth(1)">›</button>
                      <button type="button" class="dt__nav-btn" :aria-label="tx('下一年', 'Next year', 'Próximo ano', 'अगला वर्ष')" @click="shiftMonth(12)">»</button>
                    </span>
                  </div>
                  <div class="dt__grid" role="grid">
                    <span v-for="w in DT_WEEKDAYS" :key="w.en" class="dt__wd">{{ tx(w.zh, w.en, w.pt, w.hi) }}</span>
                    <template v-for="(c, i) in dtCells" :key="i">
                      <span v-if="c === null" class="dt__cell dt__cell--empty"></span>
                      <button
                        v-else
                        type="button"
                        class="dt__cell"
                        :class="{ today: isDtToday(c), sel: isDtPicked(c) }"
                        @click="pickDay(c)"
                      >{{ c }}</button>
                    </template>
                  </div>
                  <div class="dt__foot">
                    <span class="dt__time-label">{{ tx("时刻", "Time", "Hora", "समय") }}</span>
                    <input
                      class="dt__sel"
                      list="dt-hour-list"
                      maxlength="2"
                      inputmode="numeric"
                      :value="dtHour"
                      :aria-label="tx('小时', 'Hour', 'Hora', 'घंटा')"
                      @input="dtHourPart.onInput"
                      @change="dtHourPart.onChange"
                    />
                    <datalist id="dt-hour-list">
                      <option v-for="h in DT_HOURS" :key="h" :value="h"></option>
                    </datalist>
                    <span class="dt__colon">:</span>
                    <input
                      class="dt__sel"
                      list="dt-minute-list"
                      maxlength="2"
                      inputmode="numeric"
                      :value="dtMinute"
                      :aria-label="tx('分钟', 'Minute', 'Minuto', 'मिनट')"
                      @input="dtMinutePart.onInput"
                      @change="dtMinutePart.onChange"
                    />
                    <datalist id="dt-minute-list">
                      <option v-for="m in DT_MINUTES" :key="m" :value="m"></option>
                    </datalist>
                    <button type="button" class="dt__ok" @click="dtOpen = false">{{ tx("确定", "OK", "OK", "ठीक है") }}</button>
                  </div>
                  </div>
                </Teleport>
                  </div>
                </template>
              </div>
              <!-- 每周：星期多选单独一行（7 个圆片塞不进频率行）。 -->
              <div v-if="!cronUnparsed && taskDraft.scheduleType === 'recurring' && taskRepeat.freq === 'WEEKLY'" class="repeat-row">
                <button
                  v-for="w in WEEKDAYS"
                  :key="w.code"
                  type="button"
                  class="wd-chip"
                  :class="{ active: taskRepeat.byday.includes(w.code) }"
                  @click="toggleWeekday(w.code)"
                >{{ tx(w.zh, w.en, w.pt, w.hi) }}</button>
              </div>
              <!-- 外部建的表达式：只读展示原样，不猜一个相近的覆盖它（保存时整段频率都不回传）。 -->
              <p v-if="cronUnparsed" class="repeat-preview">
                {{
                  tx(
                    "该任务用的是外部创建的高级表达式，下方选项表达不了它，本次保存不会改动频率：",
                    "This task uses an advanced expression created outside the UI; the options below cannot express it, so saving leaves the schedule untouched:",
                    "Esta tarefa usa uma expressão avançada criada fora da interface; salvar não altera o agendamento:",
                    "यह कार्य UI के बाहर बनाई गई उन्नत अभिव्यक्ति का उपयोग करता है; सहेजने पर समय-सारिणी नहीं बदलेगी:",
                  )
                }}
                <code class="cron-raw">{{ editingCron }}</code>
              </p>
              <!-- 周期任务的纯文本预览（保存的是 cron，用户看的是这句话）。 -->
              <p v-else-if="taskDraft.scheduleType === 'recurring'" class="repeat-preview">{{ repeatPreview }}</p>
                </div>
                <div class="modal__foot">
                  <button class="primary-btn" type="button" @click="freqDialogOpen = false">{{
                    tx("完成", "Done", "Concluído", "पूर्ण")
                  }}</button>
                </div>
              </div>
            </div>
          </div>
            <div class="field task-composer">
              <span class="field__label field__label--row"
                >{{ tx("任务内容", "Task prompt", "Conteúdo da tarefa", "कार्य निर्देश") }}<span class="field__req" aria-hidden="true">*</span></span>
              <!-- 直接复用对话输入区那套外壳（PromptBox）；工具选择也照对话区的样子放进底部工具条，
                   不再单独占一块字段——「要执行的指令」和「带哪些工具」本来就是同一件事的两半。 -->
              <PromptBox
                v-model="taskDraft.prompt"
                :min-height="104"
                auto-grow
                :aria-label="tx('任务内容', 'Task prompt', 'Conteúdo da tarefa', 'कार्य निर्देश')"
                :placeholder="taskDraft.purpose === 'alert'
                  ? tx(
                      '写清：数据源、范围、时间窗口、超过多少算异常；取不到不要猜。例：Zoho 统计印度(IN)最近 60 分钟对话数，>300 异常。短窗口+最少字段。',
                      'State source, scope, window, threshold; do not guess if incomplete. e.g. Zoho India (IN) chats in last 60m; alert if >300. Prefer short window + minimal fields.',
                      'Fonte, escopo, janela, limiar; não invente se incompleto. Ex.: Zoho Índia (IN) últimos 60 min; alerta se >300. Janela curta + poucos campos.',
                      'स्रोत, दायरा, विंडो, थ्रेशोल्ड; अधूरा हो तो अनुमान न लगाएँ। उदा. Zoho भारत (IN) 60 मिनट; >300 अलर्ट। छोटी विंडो + कम फ़ील्ड।',
                    )
                  : tx('智能体要自动执行的自然语言指令…', 'Natural-language instruction for the agent…', 'Instrução em linguagem natural para o agente executar…', 'एजेंट के लिए स्वतः निष्पादित होने वाला प्राकृतिक-भाषा निर्देश…')"
                :hint="tx('Shift+Enter 换行', 'Shift+Enter for a new line', 'Shift+Enter nova linha', 'Shift+Enter नई पंक्ति')"
              >
                <template #toolbar-left>
                  <div ref="taskToolsRoot" class="tools-menu-box">
                    <button
                      type="button"
                      class="icon-btn"
                      :class="{ on: taskToolsOpen || taskSkillOpen || taskMcpOpen || taskExpertOpen }"
                      :aria-expanded="taskToolsOpen || taskSkillOpen || taskMcpOpen || taskExpertOpen"
                      aria-haspopup="menu"
                      :title="tx('任务工具（到点运行时生效）', 'Task tools (apply at run time)', 'Ferramentas da tarefa (valem na execução)', 'कार्य टूल (रन के समय लागू)')"
                      :aria-label="tx('任务工具（到点运行时生效）', 'Task tools (apply at run time)', 'Ferramentas da tarefa (valem na execução)', 'कार्य टूल (रन के समय लागू)')"
                      @click="toggleTaskTools"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <!-- 菜单与飞出整体 Teleport 到 body（弹窗 overflow:auto 会裁剪 absolute 面板）：
                       锚盒 fixed 钉在触发器（左/底/高一致），内部复用对话区同款菜单/飞出样式。 -->
                  <Teleport to="body">
                    <div
                      v-if="taskToolsOpen"
                      ref="taskToolsPanel"
                      class="tools-menu-box task-tools-pop"
                      :style="{
                        left: taskToolsPos.left + 'px',
                        bottom: taskToolsPos.bottom + 'px',
                        height: taskToolsPos.height + 'px',
                      }"
                    >
                      <div class="tools-menu" role="menu">
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskSkillOpen"
                          @click="openTaskFlyout('skills')"
                          @mouseenter="hoverTaskFlyout('skills')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.8 20 12 17l-4.8 3 1.2-6.4L4 10l5.8-1.6z" />
                          </svg>
                          <span>{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</span>
                          <span v-if="taskDraft.skills.length" class="tools-badge">{{ taskDraft.skills.length }}</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskMcpOpen"
                          @click="openTaskFlyout('mcp')"
                          @mouseenter="hoverTaskFlyout('mcp')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M9 6a3 3 0 1 1 6 0v1h2.5A1.5 1.5 0 0 1 19 8.5v3a3 3 0 0 1-3 3h-1v1a3 3 0 0 1-6 0v-1H7a3 3 0 0 1-3-3v-3A1.5 1.5 0 0 1 5.5 7H9z" />
                          </svg>
                          <span>{{ tx("连接器", "Connectors", "Conectores", "कनेक्टर") }}</span>
                          <span v-if="taskMcpCount" class="tools-badge">{{ taskMcpCount }}</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                        <button
                          class="tools-menu__row"
                          type="button"
                          role="menuitem"
                          :aria-expanded="taskExpertOpen"
                          @click="openTaskFlyout('expert')"
                          @mouseenter="hoverTaskFlyout('expert')"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="12" cy="8" r="3.4" />
                            <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                          </svg>
                          <span>{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</span>
                          <span v-if="taskAgentLabel" class="tools-badge">1</span>
                          <span class="tools-menu__chev">›</span>
                        </button>
                      </div>

                      <!-- 技能飞出：勾选写入任务草稿；面板结构对齐对话区（搜索 / 列表 / 取消全部）。 -->
                      <div v-if="taskSkillOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务技能', 'Task skills', 'Habilidades da tarefa', 'कार्य स्किल')">
                        <ToolsSearch v-model="taskSkillQuery" :placeholder="tx('搜索技能', 'Search skills', 'Buscar habilidades', 'स्किल खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="!taskSkillFiltered.length" class="empty-hint">
                            {{
                              skillAvailable.length
                                ? tx("没有匹配的技能", "No matching skills", "Nenhuma habilidade correspondente", "कोई मेल खाता स्किल नहीं")
                                : tx("没有可勾选的技能（默认技能无需勾选即已生效）", "No selectable skills (default skills are already in effect)", "Nenhuma habilidade selecionável (as padrão já estão ativas)", "कोई चयन-योग्य स्किल नहीं (डिफ़ॉल्ट स्किल पहले से लागू हैं)")
                            }}
                          </div>
                          <button
                            v-for="s in taskSkillFiltered"
                            :key="s.dir"
                            type="button"
                            class="tools-item"
                            :class="{ on: taskDraft.skills.includes(s.dir) }"
                            @click="toggleTaskSkill(s.dir)"
                          >
                            <span class="tools-item__icon" :style="iconStyle(s.dir)" aria-hidden="true">{{ iconChar(s.name) }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name"
                                ><span class="tools-item__label" :title="s.name">{{ s.name }}</span></span
                              >
                              <span class="tools-item__desc" :title="s.description || ''">{{ s.description || tx("（无描述）", "(no description)", "(sem descrição)", "(कोई विवरण नहीं)") }}</span>
                            </span>
                            <svg v-if="taskDraft.skills.includes(s.dir)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("勾选的技能随任务每期运行注入；默认生效的技能无需勾选。", "Checked skills are injected on every run; default skills need no check.", "Habilidades marcadas são injetadas a cada execução; as padrão dispensam marcação.", "चुने गए स्किल हर रन में लगते हैं; डिफ़ॉल्ट स्किल को चिह्नित करने की आवश्यकता नहीं।") }}
                          </p>
                          <SkillAddForm v-if="taskSkillAddOpen" @created="onTaskSkillCreated" @cancel="taskSkillAddOpen = false" />
                          <div class="tools-flyout__foot-row">
                            <button class="tools-flyout__add" type="button" :aria-expanded="taskSkillAddOpen" @click="taskSkillAddOpen = !taskSkillAddOpen">
                              <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                              {{ tx("添加技能", "Add skill", "Adicionar habilidade", "स्किल जोड़ें") }}
                            </button>
                            <RouterLink class="tools-flyout__manage" to="/skills">{{ tx("管理", "Manage", "Gerenciar", "प्रबंधित करें") }}</RouterLink>
                            <button
                              class="tools-flyout__action"
                              type="button"
                              :disabled="!taskDraft.skills.length"
                              @click="clearTaskSkills"
                            >
                              {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                            </button>
                          </div>
                        </div>
                      </div>

                      <!-- 连接器飞出：结构对齐对话区（搜索 / 状态点 / 工具清单 / 取消全部）；勾选写入任务草稿。 -->
                      <div v-if="taskMcpOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务连接器', 'Task connectors', 'Conectores da tarefa', 'कार्य कनेक्टर')">
                        <ToolsSearch v-model="taskMcpQuery" :placeholder="tx('搜索连接器', 'Search connectors', 'Buscar conectores', 'कनेक्टर खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="!taskMcpFiltered.length" class="empty-hint">
                            {{
                              mcpAvailable.length
                                ? tx("没有匹配的连接器", "No matching connectors", "Nenhum conector correspondente", "कोई मेल खाता कनेक्टर नहीं")
                                : tx("没有可选的 MCP 服务器", "No MCP server available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं")
                            }}
                          </div>
                          <div
                            v-for="item in taskMcpFiltered"
                            :key="item.server.id"
                            class="tools-item"
                            :class="{ on: taskDraft.mcpServers.includes(item.server.id) }"
                          >
                            <button
                              type="button"
                              class="tools-item__main"
                              @click="toggleTaskServer(item.server.id)"
                            >
                              <span class="tools-item__icon" :style="iconStyle(item.server.id)" aria-hidden="true">{{ iconChar(item.server.label) }}</span>
                              <span class="tools-item__body">
                                <span class="tools-item__name"
                                  ><span class="tools-item__label" :title="item.server.label">{{ item.server.label }}</span>
                                  <span class="mcp-status" :class="item.state.cls">
                                    <span class="mcp-dot" :class="item.state.cls"></span>
                                    {{ item.state.text }}
                                  </span>
                                </span>
                                <span class="tools-item__desc" :title="mcpDescText(item.server)">{{ mcpDescText(item.server) }}</span>
                              </span>
                              <!-- 勾选圆点在按钮内：整行（含圆圈）都是点击目标，与对话区连接器面板同构。 -->
                              <span class="tools-item__check-slot" aria-hidden="true">
                                <svg v-if="taskDraft.mcpServers.includes(item.server.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                                </svg>
                              </span>
                            </button>
                            <span class="tools-item__ops">
                              <button
                                class="mcp-mini"
                                type="button"
                                :disabled="!taskDraft.mcpServers.includes(item.server.id) || !!item.server.connecting || mcpReconnecting.has(item.server.id)"
                                :title="tx('重连', 'Reconnect', 'Reconectar', 'पुनः कनेक्ट')"
                                @click.stop="reconnectMcp(item.server.id)"
                              >
                                ⟳
                              </button>
                              <!-- 不可移除时占位（ghost），保证各行 ⟳ 纵向对齐。 -->
                              <button
                                class="mcp-mini"
                                :class="{ 'is-ghost': !item.server.removable }"
                                type="button"
                                :disabled="!item.server.removable || mcpBusy"
                                :tabindex="item.server.removable ? undefined : -1"
                                :title="item.server.removable ? tx('移除', 'Remove', 'Remover', 'हटाएँ') : undefined"
                                :aria-hidden="!item.server.removable"
                                @click.stop="item.server.removable && removeCustomMcp(item.server.id)"
                              >
                                ×
                              </button>
                            </span>
                          </div>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("不勾选不带 MCP；写操作到点仍按风险策略确认。", "Unchecked = no MCP; writes still confirm at run time.", "Desmarcado = sem MCP; escritas ainda confirmam na execução.", "अनचेक = बिना MCP; रन पर राइट की पुष्टि रहेगी।") }}
                          </p>
                          <McpAddForm v-if="taskMcpAddOpen" @created="onTaskMcpCreated" @cancel="taskMcpAddOpen = false" />
                          <div class="tools-flyout__foot-row">
                            <button class="tools-flyout__add" type="button" :aria-expanded="taskMcpAddOpen" @click="taskMcpAddOpen = !taskMcpAddOpen">
                              <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                              {{ tx("添加连接器", "Add connector", "Adicionar conector", "कनेक्टर जोड़ें") }}
                            </button>
                            <button
                              class="tools-flyout__action"
                              type="button"
                              :disabled="!taskMcpCount"
                              @click="clearTaskMcp"
                            >
                              {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                            </button>
                          </div>
                        </div>
                      </div>

                      <!-- 助手飞出：任务角色（选入草稿，不跳转页面）；面板结构对齐对话区（搜索 / 列表）。 -->
                      <div v-if="taskExpertOpen" class="tools-flyout" role="dialog" :aria-label="tx('任务助手', 'Task assistant', 'Assistente da tarefa', 'कार्य सहायक')">
                        <ToolsSearch v-model="taskExpertQuery" :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')" :autofocus="taskSearchAutofocus" />
                        <div class="tools-list">
                          <div v-if="taskExpertQuery.trim() && !taskExpertFiltered.length" class="empty-hint">
                            {{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाता सहायक नहीं") }}
                          </div>
                          <button
                            v-if="!taskExpertQuery.trim()"
                            type="button"
                            class="tools-item"
                            :class="{ on: !taskDraft.agentId }"
                            @click="taskDraft.agentId = ''"
                          >
                            <span class="tools-item__icon" :style="iconStyle(AGENT_ID)" aria-hidden="true">{{ iconChar(AGENT_ID) }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name"
                                ><span class="tools-item__label">{{ tx("跟随当前入口", "Follow this page", "Seguir esta página", "इस पेज के अनुसार") }}</span></span
                              >
                              <span class="tools-item__desc">{{ tx("用打开本页的角色运行任务", "Run the task as this page's agent", "Executar a tarefa como o agente desta página", "इस पेज के एजेंट के रूप में चलें") }}</span>
                            </span>
                            <svg v-if="!taskDraft.agentId" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                          <button
                            v-for="a in taskExpertFiltered"
                            :key="a.id"
                            type="button"
                            class="tools-item"
                            :class="{ on: taskDraft.agentId === a.id }"
                            @click="taskDraft.agentId = a.id"
                          >
                            <span class="tools-item__icon" :style="iconStyle(a.id)" aria-hidden="true">{{ a.icon }}</span>
                            <span class="tools-item__body">
                              <span class="tools-item__name"
                                ><span class="tools-item__label" :title="agentText(a.label, uiLocale)">{{ agentText(a.label, uiLocale) }}</span></span
                              >
                              <span class="tools-item__desc" :title="agentText(a.description, uiLocale)">{{ agentText(a.description, uiLocale) }}</span>
                            </span>
                            <svg v-if="taskDraft.agentId === a.id" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          </button>
                        </div>
                        <div class="tools-flyout__foot">
                          <p class="flyout-hint">
                            {{ tx("角色决定每期运行的人设与技能可见性；编辑时选「跟随当前入口」保持任务原有角色不变。", "The agent decides each run's persona and skill visibility; \"Follow this page\" when editing keeps the task's current agent.", "O papel define a persona e a visibilidade de habilidades; ao editar, \"Seguir esta página\" mantém o papel atual.", "भूमिका हर रन की persona और स्किल दृश्यता तय करती है; संपादन में \"इस पेज के अनुसार\" मौजूदा भूमिका रखता है।") }}
                          </p>
                        </div>
                      </div>
                </div>
              </Teleport>
            </template>
            <template #toolbar-right>
              <button class="primary-btn" type="button" :disabled="tasksBusy" @click="submitTask">
                {{ editingTaskId ? tx("保存", "Save", "Salvar", "सहेजें") : tx("创建", "Create", "Criar", "बनाएं") }}
              </button>
            </template>
          </PromptBox>
            </div>

            <p v-if="taskError" class="field__error">{{ taskError }}</p>
        </div>
      </div>
    </Teleport>

    <main class="main">
      <header class="top">
        <button
          v-show="!navExpanded"
          type="button"
          class="hamburger"
          :aria-expanded="navExpanded"
          :aria-label="tx('打开会话列表', 'Open conversations', 'Abrir conversas', 'चैट खोलें')"
          @click="toggleSidebar()"
        >
          <span class="hamburger__bar" aria-hidden="true"></span>
        </button>
        <time class="now-clock" :datetime="nowClock" :title="nowZone">{{ nowClock }}</time>
        <div class="top-actions">
          <ModelSelect v-model="modelId" :models="models" />
          <span v-if="false" ref="resRoot" class="mcp-box">
            <button
              type="button"
              class="mcp-btn"
              :aria-expanded="resOpen"
              aria-haspopup="dialog"
              :title="tx('长期记忆与工作区文件', 'Memory & workspace files', 'Memória e arquivos', 'मेमोरी और वर्कस्पेस')"
              @click="toggleResPanel"
            >
              {{ tx("资源", "Files", "Arquivos", "फ़ाइलें") }}
            </button>
            <div v-if="resOpen" class="mcp-panel res-panel" role="dialog" :aria-label="tx('资源', 'Resources', 'Recursos', 'संसाधन')">
              <div class="mcp-panel__head">
                <span>{{ tx("长期记忆", "Long-term memory", "Memória de longo prazo", "दीर्घकालिक मेमोरी") }}</span>
                <span class="mcp-row__sub">{{ memoryItems.length }}{{ tx(" 条", " items", " itens", " आइटम") }}</span>
              </div>
              <div class="res-memory-add">
                <input
                  v-model="memoryText"
                  class="res-memory-input"
                  type="text"
                  :placeholder="tx('要长期记住的事实或偏好…', 'A fact or preference to remember…', 'Un hecho o preferencia para recordar…', 'याद रखने के लिए तथ्य…')"
                  maxlength="500"
                  @keydown="onInlineSubmitKeydown($event, addMemoryEntry)"
                />
                <button class="mcp-mini" type="button" :disabled="memoryBusy || !memoryText.trim()" @click="addMemoryEntry">＋</button>
              </div>
              <div class="res-list">
                <div v-if="!memoryItems.length" class="empty-hint">
                  {{ tx("还没有长期记忆", "No long-term memory yet", "Aún no hay memoria", "अभी कोई मेमोरी नहीं") }}
                </div>
                <div v-for="m in memoryItems" :key="m.id" class="res-row">
                  <span class="res-row__text">{{ m.text }}</span>
                  <button class="mcp-mini" type="button" :title="tx('删除', 'Delete', 'Excluir', 'हटाएं')" @click="removeMemoryEntry(m.id)">×</button>
                </div>
              </div>

              <div class="mcp-panel__head res-head">
                <span>{{ tx("工作区文件", "Workspace files", "Archivos del espacio", "वर्कस्पेस फ़ाइलें") }}</span>
                <button class="mcp-link" type="button" @click="loadWorkspaceFiles">
                  {{ tx("刷新", "Refresh", "Actualizar", "रिफ्रेश") }}
                </button>
              </div>
              <div class="res-list">
                <div v-if="wsLoading" class="empty-hint">{{ tx("加载中…", "Loading…", "Cargando…", "लोड हो रहा है…") }}</div>
                <div v-else-if="!wsFiles.length" class="empty-hint">
                  {{ tx("工作区为空（对话里可用 fs_write 保存文件）", "Workspace is empty (use fs_write in chat to save files)", "El espacio está vacío (usa fs_write)", "वर्कस्पेस खाली है (fs_write का उपयोग करें)") }}
                </div>
                <div
                  v-for="f in wsFiles"
                  :key="f.path"
                  class="res-file"
                >
                  <button
                    class="res-file__view"
                    type="button"
                    :title="tx('查看', 'View', 'Ver', 'देखें')"
                    @click="openWorkspaceFile(f.path)"
                  >
                    <span class="res-row__text">{{ f.path }}</span>
                    <span class="mcp-row__sub">{{ formatBytes(f.bytes) }}</span>
                  </button>
                  <a
                    class="res-file__dl"
                    :href="workspaceDownloadUrl(currentId, f.path)"
                    :download="f.path.split('/').pop() || f.path"
                    :title="tx('下载', 'Download', 'Descargar', 'डाउनलोड')"
                  >⤓</a>
                </div>
              </div>
              <pre v-if="wsFileContent" class="res-preview">{{ wsFileContent?.content }}</pre>
            </div>
          </span>
          <UiLocaleSelect @change="onLocaleChange" />
          <ThemeToggle />
        </div>

        <!-- 删除撤销条：挂在头部内做绝对定位，left:50% 才是「对话区中心」而非「视口中心」。
             之前 Teleport 到 body + position:fixed，桌面端会偏左半个侧栏宽（256/2=128px），
             并且 top:20px 正好压住模型/语言选择器。 -->
        <div v-if="undoDelete" class="undo-toast" role="status" aria-live="polite">
          <span class="undo-toast__text">{{ tx("已删除对话", "Chat deleted", "Conversa excluída", "चैट हटा दी गई") }}</span>
          <button type="button" class="undo-toast__undo" @click="undoRemoveConversation">
            {{ tx("撤销", "Undo", "Desfazer", "पूर्ववत करें") }}
          </button>
        </div>
      </header>

      <div v-if="settingsError" class="warn-line header-warn" role="status">{{ settingsError }}</div>

      <!-- 定时任务表单宿主：表单不再是弹窗，直接内嵌主区（Teleport 目标；空态时零占位）。 -->
      <div id="task-panel-host" class="task-host"></div>

      <!-- 主区「定时任务」页（对齐 CodeBuddy）：标题 + 右上主按钮；列表行 = 名称 + 元信息 + 状态 + 行内操作
           （暂停/启用、编辑、删除、打开最近一期），行点击展开各期运行（与侧栏分组共用数据源与展开状态）。
           右键行 = 原任务上下文菜单（与侧栏同口径）。 -->
      <section
        v-show="showTaskList && !showTaskForm"
        class="task-page"
        role="region"
        :aria-label="tx('定时任务', 'Scheduled tasks', 'Tarefas agendadas', 'अनुसूचित कार्य')"
      >
        <header class="task-page__head">
          <span class="task-page__title">{{ tx("定时任务", "Scheduled tasks", "Tarefas agendadas", "अनुसूचित कार्य") }}</span>
          <span v-if="taskGroups.length" class="task-page__count">({{ taskGroups.length }})</span>
          <div class="task-page__actions">
            <button class="primary-btn" type="button" @click="openTaskForm()">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {{ tx("新建定时任务", "New scheduled task", "Nova tarefa agendada", "नया अनुसूचित कार्य") }}
            </button>
          </div>
        </header>
        <div class="task-page__list">
          <div v-if="!taskGroups.length" class="task-page__empty">
            <p>{{ tx("还没有定时任务", "No scheduled tasks yet", "Nenhuma tarefa agendada", "कोई अनुसूचित कार्य नहीं") }}</p>
            <button class="primary-btn" type="button" @click="openTaskForm()">
              {{ tx("新建第一个定时任务", "Create your first task", "Criar a primeira tarefa", "पहला कार्य बनाएँ") }}
            </button>
          </div>
          <div
            v-for="g in taskGroups"
            :key="g.schedule.id"
            class="task-page__item"
            :class="{ open: expandedTasks[g.schedule.id] }"
          >
            <div
              class="task-page__row"
              role="button"
              tabindex="0"
              :aria-expanded="expandedTasks[g.schedule.id] ? 'true' : 'false'"
              :aria-label="g.schedule.name || g.schedule.prompt"
              @click="toggleTaskGroup(g.schedule.id)"
              @keydown="onTaskGroupKeydown($event, g.schedule.id)"
              @contextmenu.prevent="openTaskCtxMenu($event, g.schedule)"
            >
              <span class="task-page__caret" :class="{ open: expandedTasks[g.schedule.id] }" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </span>
              <div class="task-page__text">
                <span class="task-page__name" :title="taskCardTip(g.schedule)">{{ g.schedule.name || g.schedule.prompt }}</span>
                <span class="task-page__meta">
                  {{ taskKindText(g.schedule) }} · {{ taskNextShort(g.schedule) }} ·
                  {{ tx("结果回到", "Results to", "Resultado em", "परिणाम यहाँ") }}：{{ taskConvText(g.schedule) }}
                </span>
              </div>
              <!-- 与侧栏角标同口径：点击直接打开最新一期（打开即清零）。 -->
              <button
                v-if="g.schedule.unreadRuns"
                type="button"
                class="task-page__unread"
                :title="tx('有新的运行结果，点击查看', 'New run results — click to view', 'Novos resultados — clique para ver', 'नए रन परिणाम — देखने के लिए क्लिक करें')"
                :aria-label="tx('打开最新一期运行结果', 'Open latest run result', 'Abrir o resultado mais recente', 'नवीनतम रन परिणाम खोलें')"
                @click.stop="openTaskConversation(g.schedule)"
              >{{ g.schedule.unreadRuns }}</button>
              <span class="task-page__status" :class="{ paused: !g.schedule.enabled }">
                {{ g.schedule.enabled ? tx("启用中", "Active", "Ativa", "सक्रिय") : tx("已暂停", "Paused", "Pausada", "रुका हुआ") }}
              </span>
              <button
                class="notify-btn"
                type="button"
                :disabled="!!g.schedule.runRequestedAt || !!runningNow[g.schedule.id]"
                :title="tx('多跑一期，不改变下次定时', 'Run once without moving the next slot', 'Executa uma vez sem mudar o próximo horário', 'अगला समय बदले बिना एक बार चलाएँ')"
                @click.stop="runTaskNow(g.schedule.id)"
              >
                {{ g.schedule.runRequestedAt ? tx("即将执行", "Queued", "Na fila", "कतार में") : tx("立即执行", "Run now", "Executar agora", "अभी चलाएँ") }}
              </button>
              <button class="notify-btn" type="button" @click.stop="toggleTask(g.schedule.id)">
                {{ g.schedule.enabled ? tx("暂停", "Pause", "Pausar", "रोकें") : tx("启用", "Resume", "Retomar", "फिर से चलाएँ") }}
              </button>
              <button
                class="notify-btn"
                type="button"
                :disabled="!!runningNow[g.schedule.id]"
                :title="tx('清掉卡住的「即将执行」、重新启用并跑一期', 'Clear stuck queued state, re-enable and run once', 'Limpa estado travado, reativa e executa uma vez', 'फँसी हुई अवस्था साफ़ करें, पुनः सक्रिय करें और एक बार चलाएँ')"
                @click.stop="restartTask(g.schedule.id)"
              >
                {{ tx("重启", "Restart", "Reiniciar", "पुनः आरंभ") }}
              </button>
              <button class="notify-btn" type="button" @click.stop="openTaskForm(g.schedule)">
                {{ tx("编辑", "Edit", "Editar", "संपादित करें") }}
              </button>
              <button
                class="notify-btn notify-btn--danger"
                type="button"
                @click.stop="removeTask(g.schedule.id)"
              >{{ tx("删除", "Delete", "Excluir", "हटाएँ") }}</button>
              <button
                class="notify-btn"
                type="button"
                :title="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                :aria-label="tx('打开最近一期', 'Open latest run', 'Abrir execução mais recente', 'नवीनतम रन खोलें')"
                @click.stop="openTaskConversation(g.schedule)"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M9 7h8v8" />
                </svg>
              </button>
            </div>
            <div v-if="expandedTasks[g.schedule.id]" class="task-page__runs">
              <p v-if="!filteredRuns(g.runs).length" class="task-page__run-empty">
                {{ tx("没有符合筛选的运行记录", "No runs match this filter", "Nenhuma execução neste filtro", "इस फ़िल्टर में कोई रन नहीं") }}
              </p>
              <button
                v-for="r in filteredRuns(g.runs)"
                :key="r.conversationId"
                class="task-page__run"
                :class="{ active: r.conversationId === currentId }"
                type="button"
                @click="openRunConversation(r)"
              >
                <span
                  v-if="r.status"
                  class="conv-dot"
                  :class="r.status"
                  :title="taskStatusText({ ...g.schedule, lastStatus: r.status as ScheduleDto['lastStatus'] })"
                  role="img"
                ></span>
                <span class="task-page__run-title">{{ r.conv?.title || runTimeText(r.at) }}</span>
                <span class="task-page__run-at">{{ runMetaText(r) }}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- tabindex="-1"：给「回到顶部」点击后的焦点落点（不进入 Tab 序列），也方便键盘直接滚动对话区。 -->
      <div
        v-show="!showTaskForm && !showTaskList"
        ref="threadEl"
        class="thread"
        tabindex="-1"
        @scroll="onThreadScroll"
        @wheel.passive="onOutlineUserScrollIntent"
        @touchstart.passive="onOutlineUserScrollIntent"
        @keydown="onOutlineUserScrollIntent"
      >
        <!-- 首屏慢加载才亮骨架；快加载时 booting 期间留空、不闪空态，直接等真实内容出现。 -->
        <div v-if="showSkeleton" class="boot-skeleton" aria-hidden="true">
          <div class="boot-skeleton__row boot-skeleton__row--agent"></div>
          <div class="boot-skeleton__row boot-skeleton__row--user"></div>
          <div class="boot-skeleton__row boot-skeleton__row--agent boot-skeleton__row--short"></div>
        </div>
        <div v-else-if="!booting && !current.bubbles.length && currentExpert" class="expert-home">
          <div class="expert-home__mark" aria-hidden="true">{{ currentExpert.icon }}</div>
          <h2 class="expert-home__title">{{ agentText(currentExpert.label, uiLocale) }}</h2>
          <p class="expert-home__desc">{{ agentText(currentExpert.description, uiLocale) }}</p>
          <div v-if="expertStarters.length" class="expert-home__prompts">
            <button
              v-for="prompt in expertStarters"
              :key="prompt"
              type="button"
              class="expert-home__prompt"
              @click="askStarter(prompt)"
            >
              {{ prompt }}
            </button>
          </div>
        </div>
        <div v-else-if="!booting && !current.bubbles.length" class="empty">
          {{ tx("想聊点什么？", "Want to chat about something?", "Quer conversar sobre algo?", "कुछ बात करना चाहते हैं?") }}
        </div>
        <div v-if="modelSwitchHint" class="model-switch-hint" role="status">
          <span class="model-switch-hint__icon" aria-hidden="true">i</span>
          <span>{{ modelSwitchHint }}</span>
          <button type="button" class="model-switch-hint__close" :aria-label="tx('关闭', 'Dismiss', 'Fechar', 'बंद करें')" @click="modelSwitchHint = ''">×</button>
        </div>
        <button
          v-if="current.bubbles.length > visibleBubbles.length"
          type="button"
          class="thread-earlier"
          @click="showEarlierMessages"
        >
          {{ tx("显示更早的消息", "Show earlier messages", "Mostrar mensagens anteriores", "पुराने संदेश दिखाएं") }}
        </button>
        <ChatBubble v-for="b in visibleBubbles" :key="b.id" :bubble="b" :is-latest="b.id === latestAlertMarkerId" />
          <!-- 回到顶部：挂在对话滚动容器内（滚动容器由组件自动识别），长对话翻久了可一键回顶；
             avoid-selector 让按钮抬到底部输入区上方，不压住输入框与发送键。
             threshold 用 120（约一个气泡高）：对话区可滚高度常常只有一两百像素（几轮对话），
             沿用页面级的 240 会几乎不出现。 -->
        <BackToTop :threshold="120" avoid-selector=".composer" focus-target=".thread" />

        <!-- 对话大纲浮层（docs/conversation-outline-panel-plan.md）：右缘悬浮，列出本会话用户指令，点击跳转。
             移动端打开侧栏抽屉时隐藏：抽屉 z-60 与本浮层同档且 DOM 靠后，同 z 会盖住遮罩，直接隐藏最稳。
             跳转逻辑在页面（要扩 threadWindow + 滚动 .thread），组件只管展示与高亮跟踪。 -->
        <ConversationOutline
          v-show="!(isMobile && sidebarOpen)"
          v-model:open="outlineOpen"
          :items="conversationOutline"
          :active-id="activeOutlineId"
          :band="OUTLINE_ACTIVE_BAND"
          :pinned-id="pinnedOutlineId"
          @jump="jumpToOutline"
          @active="activeOutlineId = $event"
        />

      </div>

      <footer v-show="!showTaskForm && !showTaskList" class="composer">
        <div v-if="current.queue.length" class="queue" role="region" :aria-label="tx('待发队列', 'Message queue', 'Fila de envio', 'प्रेषण कतार')">
          <div class="queue__head">
            <span>{{ tx("排队中", "Queued", "Na fila", "कतार में") }} · {{ current.queue.length }}</span>
            <span class="queue__hint">{{ tx("生成结束后按序自动发送", "Sent in order after the current reply", "Enviadas em ordem após a resposta atual", "वर्तमान उत्तर के बाद क्रम से स्वतः भेजा जाएगा") }}</span>
          </div>
          <div v-for="(item, i) in current.queue" :key="item.at" class="queue__item">
            <span class="queue__text">{{ item.text || (item.docs && item.docs.length ? `（${item.docs.length} 个附件）` : tx("（仅图片）", "(images only)", "(apenas imagens)", "(केवल छवियाँ)")) }}</span>
            <span class="queue__ops">
              <button
                type="button"
                :disabled="i === 0"
                :title="tx('上移', 'Move up', 'Mover para cima', 'ऊपर ले जाएं')"
                :aria-label="tx('上移', 'Move up', 'Mover para cima', 'ऊपर ले जाएं')"
                @click="moveQueueItem(i, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                :disabled="i === current.queue.length - 1"
                :title="tx('下移', 'Move down', 'Mover para baixo', 'नीचे ले जाएं')"
                :aria-label="tx('下移', 'Move down', 'Mover para baixo', 'नीचे ले जाएं')"
                @click="moveQueueItem(i, 1)"
              >
                ↓
              </button>
              <button type="button" @click="editQueueItem(i)">{{ tx("编辑", "Edit", "Editar", "संपादित करें") }}</button>
              <button type="button" :title="tx('移除', 'Remove', 'Remover', 'हटाएं')" :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')" @click="removeQueueItem(i)">
                ×
              </button>
              <button type="button" class="queue__send" @click="sendQueueItemNow(i)">
                {{ tx("立即发送", "Send now", "Enviar agora", "अभी भेजें") }}
              </button>
            </span>
          </div>
        </div>
        <div v-if="current.pendingImages.length" class="pending">
          <span v-for="img in current.pendingImages" :key="img.id" class="chip">
            {{ img.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              @click="removePendingImage(img.id)"
            >
              ×
            </button>
          </span>
        </div>
        <div v-if="current.pendingDocs.length" class="pending">
          <span v-for="doc in current.pendingDocs" :key="doc.id" class="chip">
            📎 {{ doc.name }}
            <button
              type="button"
              :title="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              :aria-label="tx('移除', 'Remove', 'Remover', 'हटाएं')"
              @click="removePendingDoc(doc.id)"
            >
              ×
            </button>
          </span>
        </div>
        <div v-if="imagesUnsupported" class="warn-line">
          {{
            tx(
              "当前模型不支持图片，这些图片不会被发送给模型。请改用支持图片的模型。",
              "The current model can't read images, so they won't be sent. Pick a vision-capable model.",
              "O modelo atual não suporta imagens, então elas não serão enviadas. Escolha um modelo com suporte a visão.",
              "वर्तमान मॉडल छवियों का समर्थन नहीं करता, इसलिए वे भेजी नहीं जाएंगी। छवि-सक्षम मॉडल चुनें।",
            )
          }}
        </div>
        <div class="composer-row">
          <input
            id="chat-file-input"
            ref="fileInput"
            type="file"
            name="files"
            accept="image/*,.pdf,.docx,.xlsx,.md,.txt,.csv"
            multiple
            hidden
            @change="pickFiles"
          />
          <PromptBox
            ref="promptBoxEl"
            v-model="current.input"
            id="chat-input"
            name="message"
            rows="1"
            :min-height="COMPOSER_BASE"
            :max-height="COMPOSER_AUTO_MAX"
            :pad-top="6"
            :placeholder="composerPlaceholder"
            :hint="tx('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line', 'Enter envia · Shift+Enter nova linha', 'भेजने के लिए Enter · नई पंक्ति के लिए Shift+Enter')"
            @input="autoGrow"
            @keydown="onKeydown"
          >
            <template #top>
              <div
                class="composer-grip"
                :title="tx('拖拽调整输入框高度，双击恢复自动', 'Drag to resize the input, double-click to reset', 'Arraste para redimensionar a entrada; duplo clique para restaurar', 'इनपुट का आकार बदलने के लिए खींचें; स्वतः बहाल करने के लिए डबल-क्लिक करें')"
                @mousedown.prevent="startComposerResize"
                @dblclick="resetComposerSize"
              >
                <span class="composer-grip__bar"></span>
              </div>
            </template>
            <template #toolbar-left>
              <div ref="toolsRoot" class="tools-menu-box">
                <button
                  type="button"
                  class="icon-btn"
                  :class="{ on: toolsMenuOpen || mcpOpen || skillOpen || expertOpen }"
                  :aria-expanded="toolsMenuOpen || mcpOpen || skillOpen || expertOpen"
                  aria-haspopup="menu"
                  :title="tx('工具', 'Tools', 'Ferramentas', 'टूल')"
                  :aria-label="tx('工具', 'Tools', 'Ferramentas', 'टूल')"
                  @click="toggleToolsMenu"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>

                <!-- 发送模式快捷切换（与 + 并列）：抢占 / 排队。右键菜单里也有同一开关。 -->
                <button
                  type="button"
                  class="sendmode-btn"
                  :class="{ 'is-queue': currentSendMode === 'queue' }"
                  :title="currentSendMode === 'preempt'
                    ? tx('当前：抢占式 · 点击查看排队模式（新消息等本轮完成）', 'Preempt: new message takes over · click to queue', 'Atual: preemptiva · clique para enfileirar', 'वर्तमान: preempt · कतार चुनने के लिए क्लिक करें')
                    : tx('当前：排队等待 · 点击切回抢占式（新消息接管本轮）', 'Queue: new messages wait · click to preempt', 'Atual: fila · clique para preemptar', 'वर्तमान: कतार · preempt पर लौटने के लिए क्लिक करें')"
                  :aria-label="currentSendMode === 'preempt'
                    ? tx('发送模式：抢占式，点击切换到排队等待', 'Send mode: preempt, click to switch to queue', 'Modo: preemptiva, clique para fila', 'मोड: preempt, कतार पर बदलें')
                    : tx('发送模式：排队等待，点击切换到抢占式', 'Send mode: queue, click to switch to preempt', 'Modo: fila, clique para preemptiva', 'मोड: कतार, preempt पर बदलें')"
                  @click="toggleSendModeForCurrent"
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <template v-if="currentSendMode === 'preempt'">
                      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                    </template>
                    <template v-else>
                      <path d="M4 6h16M4 12h16M4 18h16" />
                    </template>
                  </svg>
                </button>

                <!-- 已选专家 chip（对齐 CodeBuddy）：选中专家后显示在 + 旁，仅点 × 取消选中回通用；无 chip = 通用。 -->
                <div
                  v-if="currentExpert"
                  class="expert-chip"
                >
                  <span class="expert-chip__label">{{ agentText(currentExpert.label, uiLocale) }}</span>
                  <button
                    type="button"
                    class="expert-chip__close"
                    :title="tx('取消选中助手，回到通用助手', 'Deselect assistant, back to general assistant', 'Desmarcar assistente, voltar ao assistente geral', 'सहायक चयन रद्द करें, सामान्य सहायक पर वापस')"
                    aria-label="取消选中助手"
                    @click.stop="onClearExpert"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div v-if="toolsMenuOpen" class="tools-menu" role="menu">
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    @click="fileInput?.click(); closeToolsPanels()"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                      <circle cx="8.75" cy="10" r="1.5" />
                      <path d="M20.5 15.5 15.75 11 9.5 17.5" />
                    </svg>
                    <span>{{ tx("添加文件", "Add files", "Adicionar arquivos", "फ़ाइल जोड़ें") }}</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="skillOpen"
                    @click="openSkillPanel()"
                    @mouseenter="hoverFlyout('skills')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.8 20 12 17l-4.8 3 1.2-6.4L4 10l5.8-1.6z" />
                    </svg>
                    <span>{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</span>
                    <span v-if="current.settings.skillsEnabled.length" class="tools-badge">{{ current.settings.skillsEnabled.length }}</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="mcpOpen"
                    @click="openMcpPanel()"
                    @mouseenter="hoverFlyout('mcp')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M9 6a3 3 0 1 1 6 0v1h2.5A1.5 1.5 0 0 1 19 8.5v3a3 3 0 0 1-3 3h-1v1a3 3 0 0 1-6 0v-1H7a3 3 0 0 1-3-3v-3A1.5 1.5 0 0 1 5.5 7H9z" />
                    </svg>
                    <span>{{ tx("连接器", "Connectors", "Conectores", "कनेक्टर") }}</span>
                    <span v-if="enabledMcpCount" class="tools-badge">{{ enabledMcpCount }}</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                  <button
                    class="tools-menu__row"
                    type="button"
                    role="menuitem"
                    :aria-expanded="expertOpen"
                    @click="openExpertPanel()"
                    @mouseenter="hoverFlyout('expert')"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="12" cy="8" r="3.4" />
                      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                    </svg>
                    <span>{{ tx("助手", "Assistant", "Assistente", "सहायक") }}</span>
                    <span v-if="currentExpert" class="tools-badge">1</span>
                    <span class="tools-menu__chev">›</span>
                  </button>
                </div>

                <div v-if="skillOpen" class="tools-flyout" role="dialog" :aria-label="tx('技能', 'Skills', 'Habilidades', 'स्किल')">
                  <ToolsSearch v-model="skillQuery" :placeholder="tx('搜索技能', 'Search skills', 'Buscar habilidades', 'स्किल खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!skillFiltered.length" class="empty-hint">
                      {{
                        skillAvailable.length
                          ? tx("没有匹配的技能", "No matching skills", "Nenhuma habilidade correspondente", "कोई मेल खाता स्किल नहीं")
                          : tx("没有可勾选的技能（默认技能无需勾选即已生效）", "No selectable skills (default skills are already in effect)", "Nenhuma habilidade selecionável (as padrão já estão ativas)", "कोई चयन-योग्य स्किल नहीं (डिफ़ॉल्ट स्किल पहले से लागू हैं)")
                      }}
                    </div>
                    <button
                      v-for="s in skillFiltered"
                      :key="s.dir"
                      type="button"
                      class="tools-item"
                      :class="{ on: current.settings.skillsEnabled.includes(s.dir) }"
                      :disabled="skillBusy"
                      @click="toggleSkill(s.dir, !current.settings.skillsEnabled.includes(s.dir))"
                    >
                      <span class="tools-item__icon" :style="iconStyle(s.dir)" aria-hidden="true">{{ iconChar(s.name) }}</span>
                      <span class="tools-item__body">
                        <span class="tools-item__name"
                          ><span class="tools-item__label" :title="s.name">{{ s.name }}</span></span
                        >
                        <span class="tools-item__desc" :title="s.description || ''">{{ s.description || tx("（无描述）", "(no description)", "(sem descrição)", "(कोई विवरण नहीं)") }}</span>
                      </span>
                      <svg v-if="current.settings.skillsEnabled.includes(s.dir)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    </button>
                  </div>

                  <div class="tools-flyout__foot">
                    <p class="flyout-hint">
                      {{
                        tx(
                          "勾选的技能全文会注入本对话的系统提示；未勾选的技能模型仍可按需加载。",
                          "Checked skills are injected in full into this conversation's system prompt; unchecked ones load on demand.",
                          "Habilidades marcadas são injetadas por completo; as demais são carregadas sob demanda.",
                          "चुने गए स्किल पूर्ण रूप से इंजेक्ट होते हैं; बाकी ऑन-डिमांड लोड होते हैं।",
                        )
                      }}
                    </p>
                    <SkillAddForm v-if="skillAddOpen" @created="onChatSkillCreated" @cancel="skillAddOpen = false" />
                    <div class="tools-flyout__foot-row">
                      <button class="tools-flyout__add" type="button" :aria-expanded="skillAddOpen" @click="skillAddOpen = !skillAddOpen">
                        <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                        {{ tx("添加技能", "Add skill", "Adicionar habilidade", "स्किल जोड़ें") }}
                      </button>
                      <RouterLink class="tools-flyout__manage" to="/skills">{{ tx("管理", "Manage", "Gerenciar", "प्रबंधित करें") }}</RouterLink>
                      <button
                        class="tools-flyout__action"
                        type="button"
                        :disabled="!current.settings.skillsEnabled.length || skillBusy"
                        @click="clearSkillSelection"
                      >
                        {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                      </button>
                    </div>
                  </div>
                  <div v-if="skillError" class="mcp-error">{{ skillError }}</div>
                </div>

                <div v-if="mcpOpen" class="tools-flyout" role="dialog" :aria-label="tx('MCP 连接', 'MCP connections', 'Conexões MCP', 'MCP कनेक्शन')">
                  <ToolsSearch v-model="mcpQuery" :placeholder="tx('搜索连接器', 'Search connectors', 'Buscar conectores', 'कनेक्टर खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!mcpFiltered.length" class="empty-hint">
                      {{
                        mcpAvailable.length
                          ? tx("没有匹配的连接器", "No matching connectors", "Nenhum conector correspondente", "कोई मेल खाता कनेक्टर नहीं")
                          : tx("没有可选的 MCP 服务器", "No MCP server available", "Nenhum servidor MCP disponível", "कोई MCP सर्वर उपलब्ध नहीं")
                      }}
                    </div>
                    <template v-for="row in mcpPanelRows" :key="row.key">
                    <div v-if="row.kind === 'label'" class="tools-section">{{ row.text }}</div>
                    <div
                      v-else
                      class="tools-item"
                      :class="{ on: row.bound || current.settings.mcpEnabled.includes(row.server.id), 'is-bound': row.bound }"
                    >
                      <button
                        type="button"
                        class="tools-item__main"
                        :disabled="mcpBusy"
                        @click="row.bound || toggleMcp(row.server.id, !current.settings.mcpEnabled.includes(row.server.id))"
                      >
                        <span class="tools-item__icon" :style="iconStyle(row.server.id)" aria-hidden="true">{{ iconChar(row.server.label) }}</span>
                        <span class="tools-item__body">
                          <span class="tools-item__name">
                            <span class="tools-item__label" :title="row.server.label">{{ row.server.label }}</span>
                            <span v-if="row.bound" class="tools-item__pin">{{ tx("已启用", "On", "Ativo", "चालू") }}</span>
                            <span class="mcp-status" :class="row.state.cls">
                              <span class="mcp-dot" :class="row.state.cls"></span>
                              {{ row.state.text }}
                            </span>
                          </span>
                          <span class="tools-item__desc" :title="row.bound ? tx('客服助手自带，不能在这里关闭', 'Included with the support assistant and cannot be turned off here', 'Incluído no assistente de suporte e não pode ser desligado aqui', 'सहायता सहायक के साथ शामिल, यहाँ बंद नहीं किया जा सकता') : mcpDescText(row.server)">{{ row.bound ? tx("客服助手自带，不能在这里关闭", "Included with the support assistant and cannot be turned off here", "Incluído no assistente de suporte e não pode ser desligado aqui", "सहायता सहायक के साथ शामिल, यहाँ बंद नहीं किया जा सकता") : mcpDescText(row.server) }}</span>
                        </span>
                        <!-- 勾选圆点在按钮内：整行（含圆圈）都是点击目标。圆点是可见控件，
                             放在按钮外会形成「看得见点不着」的死区（曾有点击圆圈无反应的反馈）。 -->
                        <span class="tools-item__check-slot" aria-hidden="true">
                          <svg v-if="!row.bound && current.settings.mcpEnabled.includes(row.server.id)" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        </span>
                      </button>
                      <span class="tools-item__ops">
                        <button
                          class="mcp-mini"
                          type="button"
                          :disabled="!current.settings.mcpEnabled.includes(row.server.id) || mcpReconnecting.has(row.server.id)"
                          :title="tx('重连', 'Reconnect', 'Reconectar', 'पुनः कनेक्ट')"
                          @click.stop="reconnectMcp(row.server.id)"
                        >
                          ⟳
                        </button>
                        <!-- 不可移除时占位（ghost），保证各行 ⟳ 纵向对齐。 -->
                        <button
                          class="mcp-mini"
                          :class="{ 'is-ghost': !row.server.removable }"
                          type="button"
                          :disabled="!row.server.removable || mcpBusy"
                          :tabindex="row.server.removable ? undefined : -1"
                          :title="row.server.removable ? tx('移除', 'Remove', 'Remover', 'हटाएँ') : undefined"
                          :aria-hidden="!row.server.removable"
                          @click.stop="row.server.removable && removeCustomMcp(row.server.id)"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                    </template>
                  </div>

                  <div class="tools-flyout__foot">
                    <p v-if="boundMcpIds.length" class="flyout-hint">
                      {{
                        tx(
                          "带「已启用」的是客服助手自带的数据源，不能在这里关闭。下面的连接器仍可按需勾选。",
                          "Items marked On come with the support assistant and cannot be turned off here. Connectors below can still be selected.",
                          "Itens marcados Ativo vêm com o assistente e não podem ser desligados aqui. Os conectores abaixo ainda podem ser escolhidos.",
                          "「चालू」 सहायता सहायक के साथ आता है और यहाँ बंद नहीं होता। नीचे के कनेक्टर चुने जा सकते हैं।",
                        )
                      }}
                    </p>
                    <McpAddForm v-if="mcpAddOpen" @created="onChatMcpCreated" @cancel="mcpAddOpen = false" />
                    <div class="tools-flyout__foot-row">
                      <button class="tools-flyout__add" type="button" :aria-expanded="mcpAddOpen" @click="mcpAddOpen = !mcpAddOpen">
                        <span class="tools-flyout__add-plus" aria-hidden="true">+</span>
                        {{ tx("添加连接器", "Add connector", "Adicionar conector", "कनेक्टर जोड़ें") }}
                      </button>
                      <button
                        class="tools-flyout__action"
                        type="button"
                        :disabled="!canClearOptionalMcp || mcpBusy"
                        @click="clearMcpSelection"
                      >
                        {{ tx("取消全部", "Clear", "Limpar", "साफ़ करें") }}
                      </button>
                    </div>
                  </div>
                  <div v-if="mcpError" class="mcp-error">{{ mcpError }}</div>
                </div>

                <div v-if="expertOpen" class="tools-flyout" role="dialog" :aria-label="tx('助手', 'Assistant', 'Assistente', 'सहायक')">
                  <ToolsSearch v-model="expertQuery" :placeholder="tx('搜索助手', 'Search assistants', 'Buscar assistentes', 'सहायक खोजें')" :autofocus="searchAutofocus" />

                  <div class="tools-list">
                    <div v-if="!expertFiltered.length" class="empty-hint">
                      {{ tx("没有匹配的助手", "No matching assistants", "Nenhum assistente correspondente", "कोई मेल खाता सहायक नहीं") }}
                    </div>
                    <button
                      v-for="a in expertFiltered"
                      :key="a.id"
                      type="button"
                      class="tools-item"
                      :class="{ on: a.id === AGENT_ID }"
                      @click="onPickExpert(a)"
                    >
                      <span class="tools-item__icon" :style="iconStyle(a.id)" aria-hidden="true">{{ a.icon }}</span>
                      <span class="tools-item__body">
                        <span class="tools-item__name"
                          ><span class="tools-item__label" :title="agentText(a.label, uiLocale)">{{ agentText(a.label, uiLocale) }}</span></span
                        >
                        <span class="tools-item__desc" :title="agentText(a.description, uiLocale)">{{ agentText(a.description, uiLocale) }}</span>
                      </span>
                      <svg v-if="a.id === AGENT_ID" class="tools-item__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7.5" />
                      </svg>
                    </button>
                  </div>
                  <div class="tools-flyout__foot">
                    <p class="flyout-hint">
                      {{
                        tx(
                          "切换助手会跳转到对应角色页面，会话按角色隔离。",
                          "Switching expert jumps to that role's page; conversations are isolated per role.",
                          "Trocar especialista vai para a página daquele papel; conversas isoladas por papel.",
                          "विशेषज्ञ बदलने से उस भूमिका के पृष्ठ पर जाता है; वार्तालाप भूमिका के अनुसार अलग रहते हैं।",
                        )
                      }}
                    </p>
                  </div>
                </div>
              </div>
            </template>
            <template #toolbar-right>
              <button
                v-if="current.sending"
                ref="stopBtnRef"
                class="send stop"
                type="button"
                :title="tx('停止', 'Stop', 'Parar', 'रोकें')"
                :aria-label="tx('停止', 'Stop', 'Parar', 'रोकें')"
                @click="stop"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
              <button
                v-else
                class="send"
                type="button"
                :disabled="!canSend"
                :title="tx('发送', 'Send', 'Enviar', 'भेजें')"
                :aria-label="tx('发送', 'Send', 'Enviar', 'भेजें')"
                @click="send"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </template>
          </PromptBox>
        </div>
      </footer>
      <transition name="fade">
        <div v-if="copyToast" class="copy-toast" role="status">{{ copyToast }}</div>
      </transition>
    </main>
  </div>
</template>

<style scoped src="./chat-page.css"></style>

