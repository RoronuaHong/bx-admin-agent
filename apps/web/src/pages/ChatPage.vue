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
  ChatTaskPanel,
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

function patchTaskDraft(patch: Record<string, unknown>) {
  Object.assign(taskDraft, patch);
}
function patchTaskRepeat(patch: Record<string, unknown>) {
  Object.assign(taskRepeat, patch);
}
function patchChannelDraft(patch: Record<string, unknown>) {
  Object.assign(channelDraft, patch);
}
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
        <ChatTaskPanel
      :ref="(el: any) => {
        dtRoot = el?.dtRoot ?? null;
        dtPanel = el?.dtPanel ?? null;
        taskToolsRoot = el?.taskToolsRoot ?? null;
        taskToolsPanel = el?.taskToolsPanel ?? null;
      }"
      :visible="showTaskForm"
      :editing-task-id="editingTaskId"
      :editing-task="editingTask"
      :tasks-busy="tasksBusy"
      :task-draft="taskDraft"
      :task-error="taskError"
      :notify-summary="notifySummary"
      :notify-dialog-open="notifyDialogOpen"
      :notify-channels="notifyChannels"
      :channel-draft="channelDraft"
      :notify-busy="notifyBusy"
      :notify-note="notifyNote"
      :freq-dialog-open="freqDialogOpen"
      :task-freq-summary="taskFreqSummary"
      :cron-unparsed="cronUnparsed"
      :editing-cron="editingCron"
      :repeat-preview="repeatPreview"
      :task-repeat="taskRepeat"
      :repeat-freqs="REPEAT_FREQS"
      :minutely-intervals="MINUTELY_INTERVALS"
      :weekdays="WEEKDAYS"
      :dt-open="dtOpen"
      :dt-pos="dtPos"
      :dt-display="dtDisplay"
      :dt-shortcuts="DT_SHORTCUTS"
      :dt-month-label="dtMonthLabel"
      :dt-weekdays="DT_WEEKDAYS"
      :dt-cells="dtCells"
      :is-dt-today="isDtToday"
      :is-dt-picked="isDtPicked"
      :dt-hour="dtHour"
      :dt-minute="dtMinute"
      :dt-hours="DT_HOURS"
      :dt-minutes="DT_MINUTES"
      :dt-hour-part="dtHourPart"
      :dt-minute-part="dtMinutePart"
      :task-search-autofocus="taskSearchAutofocus"
      :task-tools-open="taskToolsOpen"
      :task-tools-pos="taskToolsPos"
      :task-skill-open="taskSkillOpen"
      :task-skill-query="taskSkillQuery"
      :task-skill-filtered="taskSkillFiltered"
      :skill-available="skillAvailable"
      :task-skill-add-open="taskSkillAddOpen"
      :task-mcp-open="taskMcpOpen"
      :task-mcp-query="taskMcpQuery"
      :task-mcp-filtered="taskMcpFiltered"
      :mcp-available="mcpAvailable"
      :task-mcp-count="taskMcpCount"
      :mcp-reconnecting="mcpReconnecting"
      :mcp-busy="mcpBusy"
      :task-mcp-add-open="taskMcpAddOpen"
      :task-expert-open="taskExpertOpen"
      :task-expert-query="taskExpertQuery"
      :task-expert-filtered="taskExpertFiltered"
      :task-agent-label="taskAgentLabel"
      :agent-id="AGENT_ID"
      :ui-locale="uiLocale"
      :icon-style="iconStyle"
      :icon-char="iconChar"
      :mcp-desc-text="mcpDescText"
      :task-conv-text="taskConvText"
      :notify-kind-label="notifyKindLabel"
      @close-task-form="closeTaskForm"
      @submit-task="submitTask"
      @apply-task-purpose="applyTaskPurpose"
      @open-task-conversation="openTaskConversation"
      @patch-task-draft="patchTaskDraft"
      @update:notifyDialogOpen="notifyDialogOpen = $event"
      @save-channel="saveChannelDraft"
      @toggle-channel="toggleChannelEnabled"
      @test-channel="testChannel"
      @remove-channel="removeChannel"
      @patch-channel-draft="patchChannelDraft"
      @update:freqDialogOpen="freqDialogOpen = $event"
      @patch-task-repeat="patchTaskRepeat"
      @toggle-weekday="toggleWeekday"
      @open-dt-picker="openDtPicker"
      @update:dtOpen="dtOpen = $event"
      @shift-month="shiftMonth"
      @pick-day="pickDay"
      @dt-hour-input="dtHourPart.onInput"
      @dt-hour-change="dtHourPart.onChange"
      @dt-minute-input="dtMinutePart.onInput"
      @dt-minute-change="dtMinutePart.onChange"
      @update:taskSkillQuery="taskSkillQuery = $event"
      @toggle-task-skill="toggleTaskSkill"
      @task-skill-created="onTaskSkillCreated"
      @toggle-task-skill-add="taskSkillAddOpen = !taskSkillAddOpen"
      @cancel-task-skill-add="taskSkillAddOpen = false"
      @clear-task-skills="clearTaskSkills"
      @update:taskMcpQuery="taskMcpQuery = $event"
      @toggle-task-server="toggleTaskServer"
      @reconnect-mcp="reconnectMcp"
      @remove-custom-mcp="removeCustomMcp"
      @task-mcp-created="onTaskMcpCreated"
      @toggle-task-mcp-add="taskMcpAddOpen = !taskMcpAddOpen"
      @cancel-task-mcp-add="taskMcpAddOpen = false"
      @clear-task-mcp="clearTaskMcp"
      @update:taskExpertQuery="taskExpertQuery = $event"
      @toggle-task-tools="toggleTaskTools"
      @open-task-flyout="openTaskFlyout"
      @hover-task-flyout="hoverTaskFlyout"
    />


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

<!-- 抽取到独立组件后，模板元素不再带 ChatPage 的 scoped 属性；保持全局样式才能让子组件与 Teleport 内容继续命中这些规则。 -->
<style src="./chat-page.css"></style>

