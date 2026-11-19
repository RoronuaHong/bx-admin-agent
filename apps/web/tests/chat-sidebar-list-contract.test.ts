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

describe("ChatSidebarList 契约", () => {
  const sidebar = read("../src/components/chat/ChatSidebarList.vue");
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const page = read("../src/pages/ChatPage.vue");

  it("aside 骨架与右键/重命名不变量原样保留", () => {
    expect(sidebar).toContain('<aside class="sidebar"');
    expect(sidebar).toContain(':class="{ open: sidebarOpen, collapsed: sidebarCollapsed }"');
    expect(sidebar).toContain('ref="agentMenuEl"');
    expect(sidebar).toContain('ref="convListEl"');
    expect(sidebar).toContain(':ref="setRenameInput"');
    expect(sidebar).toContain(':data-conv-id="conv.id"');
    expect((sidebar.match(/@contextmenu\.prevent/g) || []).length).toBe(3);
    expect(sidebar).not.toContain("sidebar-backdrop");
    expect(sidebar).toContain('emit(\'update:convQuery\'');
    expect(sidebar).toContain('emit(\'update:showArchived\'');
    expect(sidebar).toContain('emit(\'update:renameValue\'');
  });

  it("props 与 emits 锁定为 39 个状态/helper 和 29 个动作", () => {
    expect(extractBlockKeys(sidebar, "defineProps")).toEqual([
      "sidebarOpen",
      "sidebarCollapsed",
      "isMobile",
      "agentMenuOpen",
      "currentAgent",
      "agents",
      "agentId",
      "agentLabel",
      "uiLocale",
      "convQuery",
      "showArchived",
      "currentId",
      "conversationsFiltered",
      "showSkeleton",
      "convSectionOpen",
      "pinnedCount",
      "archivedCount",
      "firstArchivedIndex",
      "taskSectionOpen",
      "taskGroups",
      "expandedTasks",
      "draggingId",
      "dropTarget",
      "renaming",
      "renameMax",
      "clearArmed",
      "setRenameInput",
      "taskDotClass",
      "taskCardTip",
      "taskHealthShort",
      "taskRightShort",
      "taskMarkerText",
      "taskStatusText",
      "filteredRuns",
      "runTimeText",
      "runMetaText",
      "convStatus",
      "convStatusText",
      "queueCount",
    ]);
    expect(extractBlockKeys(sidebar, "defineEmits")).toEqual([
      "toggle-agent-menu",
      "pick-agent",
      "toggle-sidebar",
      "new-conversation",
      "open-task-list",
      "update:convQuery",
      "conv-search-input",
      "update:showArchived",
      "archived-change",
      "toggle-task-section",
      "toggle-task-group",
      "task-group-keydown",
      "open-task-ctx",
      "open-task-conversation",
      "open-run-conversation",
      "run-keydown",
      "toggle-conv-section",
      "open-ctx",
      "select-conversation",
      "conv-keydown",
      "drag-start",
      "drag-over",
      "drop",
      "drag-end",
      "update:renameValue",
      "rename-keydown",
      "commit-rename",
      "ask-delete",
      "clear-current",
    ]);
    expect(sidebar).not.toContain("sortMode");
    expect(sidebar).not.toContain("ctxMenu");
  });

  it("不接管全局监听、localStorage、路由或确认弹窗", () => {
    expect(sidebar).toContain("defineExpose({ agentMenuEl, convListEl })");
    for (const forbidden of [
      "window.addEventListener",
      "window.removeEventListener",
      "localStorage",
      "router.push",
      "confirmDialog",
      "setTimeout",
    ]) {
      expect(sidebar).not.toContain(forbidden);
    }
    expect(core).toContain('window.addEventListener("mousedown", onAgentMenuOutside)');
    expect(core).toContain('window.addEventListener("keydown", onAgentMenuEsc)');
    expect(core).toContain('window.addEventListener("keydown", onSidebarEsc)');
  });

  it("core 返回、页面解构和双 ref 桥接全部接通", () => {
    expect(core).toContain('import ChatSidebarList from "../../components/chat/ChatSidebarList.vue";');
    expect(core).toMatch(/^\s*ChatSidebarList,$/m);
    expect(extractPageBindings(page).length).toBeGreaterThanOrEqual(656);
    expect(extractPageBindings(page)).toContain("ChatSidebarList");
    expect(page).toContain("<ChatSidebarList");
    expect(page).toContain("agentMenuEl = el?.agentMenuEl ?? null");
    expect(page).toContain("convListEl = el?.convListEl ?? null");
    expect(page).toContain('v-model:conv-query="convQuery"');
    expect(page).toContain('v-model:show-archived="showArchived"');
    expect(page).toContain('class="sidebar-backdrop"');
    expect(page).not.toContain('<aside class="sidebar"');
  });

  it("侧栏品牌 CSS 归属组件，共享骨架与顶栏样式留根", () => {
    const css = read("../src/pages/chat-page.css");
    const componentCss = read("../src/components/chat/ChatSidebarList.css");

    expect(sidebar).toContain('<style scoped src="./ChatSidebarList.css"></style>');
    for (const selector of [
      ".sidebar__inner {",
      ".brand {",
      ".brand__agent {",
      ".agent-menu__item {",
      ".coming-soon {",
      ".brand__agent-caret.open {",
    ]) {
      expect(componentCss).toContain(selector);
    }
    for (const selector of [
      ".sidebar__inner {",
      ".brand__agent {",
      ".agent-menu__item {",
      ".coming-soon {",
      ".brand__agent-caret.open {",
    ]) {
      expect(css).not.toContain(selector);
    }
    for (const selector of [".sidebar {", ".sidebar-backdrop {", ".top .brand {", ".primary-btn {"]) {
      expect(css).toContain(selector);
    }
    expect(page).toContain('<style src="./chat-page.css"></style>');
    expect(page).not.toContain('<style scoped src="./chat-page.css">');
  });
});
