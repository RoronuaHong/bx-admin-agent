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
  DoneToast,
  ArtifactPreviewModal,
  ConfirmDialog,
  ChatThread,
  ContextMenuHost,
  ChatSidebarList,
  MessageComposer,
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
  ctxConfirm,
  renaming,
  renameInputEl,
  RENAME_MAX,
  undoDelete,
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
    <ChatSidebarList
      :ref="(el: any) => {
        agentMenuEl = el?.agentMenuEl ?? null;
        convListEl = el?.convListEl ?? null;
      }"
      :sidebar-open="sidebarOpen"
      :sidebar-collapsed="sidebarCollapsed"
      :is-mobile="isMobile"
      :agent-menu-open="agentMenuOpen"
      :current-agent="currentAgent"
      :agents="AGENTS"
      :agent-id="AGENT_ID"
      :agent-label="AGENT_LABEL"
      :ui-locale="uiLocale"
      v-model:conv-query="convQuery"
      @conv-search-input="onConvSearchInput"
      v-model:show-archived="showArchived"
      @archived-change="reloadConversations"
      :current-id="currentId"
      :conversations-filtered="conversationsFiltered"
      :show-skeleton="showSkeleton"
      :conv-section-open="convSectionOpen"
      :pinned-count="pinnedCount"
      :archived-count="archivedCount"
      :first-archived-index="firstArchivedIndex"
      :task-section-open="taskSectionOpen"
      :task-groups="taskGroups"
      :expanded-tasks="expandedTasks"
      :dragging-id="draggingId"
      :drop-target="dropTarget"
      :renaming="renaming"
      :rename-max="RENAME_MAX"
      :clear-armed="clearArmed"
      :set-rename-input="setRenameInput"
      :task-dot-class="taskDotClass"
      :task-card-tip="taskCardTip"
      :task-health-short="taskHealthShort"
      :task-right-short="taskRightShort"
      :task-marker-text="taskMarkerText"
      :task-status-text="taskStatusText"
      :filtered-runs="filteredRuns"
      :run-time-text="runTimeText"
      :run-meta-text="runMetaText"
      :conv-status="convStatus"
      :conv-status-text="convStatusText"
      :queue-count="queueCount"
      @toggle-agent-menu="toggleAgentMenu"
      @pick-agent="onPickAgent"
      @toggle-sidebar="toggleSidebar"
      @new-conversation="newConversation"
      @open-task-list="openTaskListPage"
      @toggle-task-section="toggleTaskSection"
      @toggle-task-group="toggleTaskGroup"
      @task-group-keydown="onTaskGroupKeydown"
      @open-task-ctx="openTaskCtxMenu"
      @open-task-conversation="openTaskConversation"
      @open-run-conversation="openRunConversation"
      @run-keydown="onRunKeydown"
      @toggle-conv-section="toggleConvSection"
      @open-ctx="openCtxMenu"
      @select-conversation="selectConversation"
      @conv-keydown="onConvKeydown"
      @drag-start="onConvDragStart"
      @drag-over="onConvDragOver"
      @drop="onConvDrop"
      @drag-end="onConvDragEnd"
      @update:renameValue="(value) => renaming.value = value"
      @rename-keydown="onRenameKeydown"
      @commit-rename="commitRename"
      @ask-delete="askDeleteConversation"
      @clear-current="onClearCurrentClick"
    />
    <!-- 移动端抽屉遮罩：仅抽屉打开时渲染，点击关闭；桌面端汉堡隐藏、不会打开（指南 §6 阻断项 #2）。 -->
    <div
      v-if="sidebarOpen"
      class="sidebar-backdrop"
      aria-hidden="true"
      @click="sidebarOpen = false"
    ></div>
    <ContextMenuHost
      :ref="(el: any) => {
        ctxMenuEl = el?.ctxMenuEl ?? null;
      }"
      :ctx-menu="ctxMenu"
      :ctx-target="ctxTarget"
      :ctx-target-task="ctxTargetTask"
      :ctx-confirm="ctxConfirm"
      :sort-mode="sortMode"
      @keydown="onCtxMenuKeydown"
      @run-task-now="ctxRunTaskNow"
      @open-task-conv="ctxOpenTaskConv"
      @edit-task="ctxEditTask"
      @toggle-task-enabled="ctxToggleTaskEnabled"
      @mark-task-read="ctxMarkTaskRead"
      @remove-task="ctxRemoveTask"
      @rename="(conv) => conv && startRename(conv)"
      @toggle-pin="(conv) => conv && togglePin(conv)"
      @restore-recent-sort="restoreRecentSort"
      @arm-clear="armCtxConfirm('clear')"
      @confirm-clear="clearConversationById"
      @ask-close-others="askCloseOthers()"
      @toggle-archive="toggleArchive"
      @toggle-mute="toggleMute"
      @toggle-full-access="toggleFullAccess"
      @toggle-send-mode="toggleSendMode"
      @duplicate="duplicateCurrent"
      @export="(id, format) => exportConversation(id, format)"
      @ask-delete="askDeleteFromCtx()"
    />

    <!-- 后台任务完成提醒：切走的对话跑完后提示一次；免打扰的对话静默。 -->
    <DoneToast :done-toast="doneToast" @view="openDoneToast" @close="doneToast = null" />

    <!-- 删除确认弹窗：点删除先弹这里，确定才真正删除（撤销条仍兜底）。 -->
    <ConfirmDialog
      :ref="(el: any) => {
        confirmDialogEl = el?.confirmDialogEl ?? null;
        confirmPrimaryBtn = el?.confirmPrimaryBtn ?? null;
      }"
      :confirm-dialog="confirmDialog"
      @confirm="confirmDialogConfirm"
      @cancel="closeConfirm"
      @trap="trapConfirmFocus"
    />

    <ArtifactPreviewModal
      :preview-html="previewHtml"
      :preview-loading="previewLoading"
      :download-url="previewHtml ? workspaceDownloadUrl(currentId, previewHtml.path) : ''"
      @close="closeArtifactPreview"
    />

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
      <ChatThread
        :ref="(el: any) => { threadEl = el?.threadEl ?? null; }"
        :visible="!showTaskForm && !showTaskList"
        :booting="booting"
        :show-skeleton="showSkeleton"
        :bubble-count="current.bubbles.length"
        :visible-bubbles="visibleBubbles"
        :model-switch-hint="modelSwitchHint"
        :current-expert="currentExpert"
        :expert-starters="expertStarters"
        :latest-alert-marker-id="latestAlertMarkerId"
        :open="outlineOpen"
        :outline-items="conversationOutline"
        :active-outline-id="activeOutlineId"
        :outline-band="OUTLINE_ACTIVE_BAND"
        :pinned-outline-id="pinnedOutlineId"
        :is-mobile="isMobile"
        :sidebar-open="sidebarOpen"
        @scroll="onThreadScroll"
        @outline-user-scroll-intent="onOutlineUserScrollIntent"
        @show-earlier="showEarlierMessages"
        @dismiss-model-hint="modelSwitchHint = ''"
        @ask-starter="askStarter"
        @jump="jumpToOutline"
        @active="activeOutlineId = $event"
        @update:open="outlineOpen = $event"
      />

    <MessageComposer
      :ref="(el: any) => {
        fileInput = el?.fileInput ?? null;
        promptBoxEl = el?.promptBoxEl ?? null;
        stopBtnRef = el?.stopBtnRef ?? null;
        toolsRoot = el?.toolsRoot ?? null;
      }"
      :visible="!showTaskForm && !showTaskList"
      :current="current"
      v-model="current.input"
      :can-send="canSend"
      :images-unsupported="imagesUnsupported"
      :composer-placeholder="composerPlaceholder"
      :min-height="COMPOSER_BASE"
      :max-height="COMPOSER_AUTO_MAX"
      :tools-menu-open="toolsMenuOpen"
      :skill-open="skillOpen"
      :mcp-open="mcpOpen"
      :expert-open="expertOpen"
      :current-send-mode="currentSendMode"
      :current-expert="currentExpert"
      :ui-locale="uiLocale"
      :agent-id="AGENT_ID"
      :enabled-mcp-count="enabledMcpCount"
      v-model:skill-query="skillQuery"
      :skill-available="skillAvailable"
      :skill-filtered="skillFiltered"
      :skill-busy="skillBusy"
      :skill-add-open="skillAddOpen"
      :skill-error="skillError"
      :search-autofocus="searchAutofocus"
      :icon-style="iconStyle"
      :icon-char="iconChar"
      v-model:mcp-query="mcpQuery"
      :mcp-available="mcpAvailable"
      :mcp-filtered="mcpFiltered"
      :mcp-panel-rows="mcpPanelRows"
      :mcp-busy="mcpBusy"
      :bound-mcp-ids="boundMcpIds"
      :mcp-reconnecting="mcpReconnecting"
      :can-clear-optional-mcp="canClearOptionalMcp"
      :mcp-add-open="mcpAddOpen"
      :mcp-error="mcpError"
      :mcp-desc-text="mcpDescText"
      v-model:expert-query="expertQuery"
      :expert-filtered="expertFiltered"
      @composer-input="autoGrow"
      @keydown="onKeydown"
      @move-queue-item="moveQueueItem"
      @edit-queue-item="editQueueItem"
      @remove-queue-item="removeQueueItem"
      @send-queue-item-now="sendQueueItemNow"
      @remove-pending-image="removePendingImage"
      @remove-pending-doc="removePendingDoc"
      @pick-files="pickFiles"
      @start-composer-resize="startComposerResize"
      @reset-composer-size="resetComposerSize"
      @toggle-tools-menu="toggleToolsMenu"
      @close-tools-panels="closeToolsPanels"
      @toggle-send-mode="toggleSendModeForCurrent"
      @clear-expert="onClearExpert"
      @open-skill-panel="openSkillPanel"
      @open-mcp-panel="openMcpPanel"
      @open-expert-panel="openExpertPanel"
      @hover-flyout="hoverFlyout"
      @toggle-skill="toggleSkill"
      @skill-created="onChatSkillCreated"
      @toggle-skill-add="skillAddOpen = !skillAddOpen"
      @cancel-skill-add="skillAddOpen = false"
      @clear-skill-selection="clearSkillSelection"
      @toggle-mcp="toggleMcp"
      @reconnect-mcp="reconnectMcp"
      @remove-custom-mcp="removeCustomMcp"
      @mcp-created="onChatMcpCreated"
      @toggle-mcp-add="mcpAddOpen = !mcpAddOpen"
      @cancel-mcp-add="mcpAddOpen = false"
      @clear-mcp-selection="clearMcpSelection"
      @pick-expert="onPickExpert"
      @stop="stop"
      @send="send"
    />

      <transition name="fade">
        <div v-if="copyToast" class="copy-toast" role="status">{{ copyToast }}</div>
      </transition>
    </main>
  </div>
</template>

<style scoped src="./chat-page.css"></style>

