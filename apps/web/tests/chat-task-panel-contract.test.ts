import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function extractBlockKeys(source: string, macro: "defineProps" | "defineEmits"): string[] {
  const match = source.match(new RegExp(`${macro}<\\{([\\s\\S]*?)\\}>\\(\\)`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)).map(
    (m) => m[1] || m[2],
  );
}

function extractPageBindings(page: string): string[] {
  const match = page.match(/const \{([\s\S]*?)\} = useChatPageCore/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

describe("ChatTaskPanel 契约", () => {
  const panel = read("../src/components/chat/ChatTaskPanel.vue");
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const page = read("../src/pages/ChatPage.vue");

  it("外层 Teleport、内部 Teleport 与四个 ref 原样保留", () => {
    expect(panel).toContain('<Teleport v-if="visible" to="#task-panel-host">');
    expect((panel.match(/<Teleport to="body">/g) || []).length).toBe(2);
    expect(panel).toContain('class="task-panel"');
    expect(panel).toContain('class="modal-mask"');
    expect(panel).toContain('class="tools-flyout"');
    expect(panel).toContain('ref="dtRoot"');
    expect(panel).toContain('ref="dtPanel"');
    expect(panel).toContain('ref="taskToolsRoot"');
    expect(panel).toContain('ref="taskToolsPanel"');
    expect(panel).not.toContain("resRoot");
    expect(panel).not.toContain("showTaskForm");
  });

  it("props 锁定为 63 个状态、helper 与常量", () => {
    expect(extractBlockKeys(panel, "defineProps")).toEqual([
      "visible",
      "editingTaskId",
      "editingTask",
      "tasksBusy",
      "taskDraft",
      "taskError",
      "notifySummary",
      "notifyDialogOpen",
      "notifyChannels",
      "channelDraft",
      "notifyBusy",
      "notifyNote",
      "freqDialogOpen",
      "taskFreqSummary",
      "cronUnparsed",
      "editingCron",
      "repeatPreview",
      "taskRepeat",
      "repeatFreqs",
      "minutelyIntervals",
      "weekdays",
      "dtOpen",
      "dtPos",
      "dtDisplay",
      "dtShortcuts",
      "dtMonthLabel",
      "dtWeekdays",
      "dtCells",
      "isDtToday",
      "isDtPicked",
      "dtHour",
      "dtMinute",
      "dtHours",
      "dtMinutes",
      "dtHourPart",
      "dtMinutePart",
      "taskSearchAutofocus",
      "taskToolsOpen",
      "taskToolsPos",
      "taskSkillOpen",
      "taskSkillQuery",
      "taskSkillFiltered",
      "skillAvailable",
      "taskSkillAddOpen",
      "taskMcpOpen",
      "taskMcpQuery",
      "taskMcpFiltered",
      "mcpAvailable",
      "taskMcpCount",
      "mcpReconnecting",
      "mcpBusy",
      "taskMcpAddOpen",
      "taskExpertOpen",
      "taskExpertQuery",
      "taskExpertFiltered",
      "taskAgentLabel",
      "agentId",
      "uiLocale",
      "iconStyle",
      "iconChar",
      "mcpDescText",
      "taskConvText",
      "notifyKindLabel",
    ]);
  });

  it("emits 锁定为 40 个表单、配置、日期与工具动作", () => {
    expect(extractBlockKeys(panel, "defineEmits")).toEqual([
      "close-task-form",
      "submit-task",
      "apply-task-purpose",
      "open-task-conversation",
      "patch-task-draft",
      "update:notifyDialogOpen",
      "save-channel",
      "toggle-channel",
      "test-channel",
      "remove-channel",
      "patch-channel-draft",
      "update:freqDialogOpen",
      "patch-task-repeat",
      "toggle-weekday",
      "open-dt-picker",
      "update:dtOpen",
      "shift-month",
      "pick-day",
      "dt-hour-input",
      "dt-hour-change",
      "dt-minute-input",
      "dt-minute-change",
      "update:taskSkillQuery",
      "toggle-task-skill",
      "task-skill-created",
      "toggle-task-skill-add",
      "cancel-task-skill-add",
      "clear-task-skills",
      "update:taskMcpQuery",
      "toggle-task-server",
      "reconnect-mcp",
      "remove-custom-mcp",
      "task-mcp-created",
      "toggle-task-mcp-add",
      "cancel-task-mcp-add",
      "clear-task-mcp",
      "update:taskExpertQuery",
      "toggle-task-tools",
      "open-task-flyout",
      "hover-task-flyout",
    ]);
  });

  it("四个 DOM ref 暴露，全局监听与 body overflow 留根", () => {
    expect(panel).toContain("defineExpose({ dtRoot, dtPanel, taskToolsRoot, taskToolsPanel })");
    for (const forbidden of [
      "window.addEventListener",
      "window.removeEventListener",
      "AbortController",
      "setTimeout",
      "document.body",
    ]) {
      expect(panel).not.toContain(forbidden);
    }
    expect(core).toContain('window.addEventListener("keydown", onTaskFormEsc, true)');
    expect(core).toContain('window.addEventListener("mousedown", onOutsideTaskTools)');
    expect(core).toContain('window.addEventListener("scroll", syncTaskToolsPos, true)');
    expect(core).toContain('window.addEventListener("resize", syncTaskToolsPos)');
    expect(core).toContain('window.addEventListener("scroll", syncDtPos, true)');
    expect(core).toContain('window.removeEventListener("keydown", onTaskFormEsc, true)');
  });

  it("根层接线、patch 桥与关键事件全部接通", () => {
    expect(panel).toContain("emit('patch-task-draft'");
    expect(panel).toContain("emit('patch-task-repeat'");
    expect(panel).toContain("emit('patch-channel-draft'");
    expect(panel).toContain("emit('submit-task')");
    expect(panel).toContain("emit('close-task-form')");

    expect(core).toContain('import ChatTaskPanel from "../../components/chat/ChatTaskPanel.vue";');
    expect(core).toMatch(/^\s*ChatTaskPanel,$/m);
    expect(extractPageBindings(page).length).toBeGreaterThanOrEqual(658);
    expect(extractPageBindings(page)).toContain("ChatTaskPanel");
    expect(page).toContain("<ChatTaskPanel");
    expect(page).toContain('id="task-panel-host"');
    expect(page).toContain("function patchTaskDraft");
    expect(page).toContain("function patchTaskRepeat");
    expect(page).toContain("function patchChannelDraft");
    expect(page).toContain("dtRoot = el?.dtRoot ?? null");
    expect(page).toContain("dtPanel = el?.dtPanel ?? null");
    expect(page).toContain("taskToolsRoot = el?.taskToolsRoot ?? null");
    expect(page).toContain("taskToolsPanel = el?.taskToolsPanel ?? null");
    expect(page).not.toContain('<Teleport v-if="showTaskForm" to="#task-panel-host">');
    expect(page).toContain('<style src="./chat-page.css"></style>');
    expect(page).not.toContain('<style scoped src="./chat-page.css">');
  });
});
