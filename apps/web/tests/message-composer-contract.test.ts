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

describe("MessageComposer 契约", () => {
  const composer = read("../src/components/chat/MessageComposer.vue");
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const page = read("../src/pages/ChatPage.vue");

  it("footer 与 PromptBox 骨架原样保留", () => {
    expect(composer).toContain('<footer v-show="visible" class="composer">');
    expect(composer).toContain("<PromptBox");
    expect(composer).toContain("<template #top>");
    expect(composer).toContain("<template #toolbar-left>");
    expect(composer).toContain("<template #toolbar-right>");
    expect(composer).toContain('id="chat-file-input"');
    expect(composer).toContain('accept="image/*,.pdf,.docx,.xlsx,.md,.txt,.csv"');
    expect(composer).toContain("multiple");
    expect(composer).toContain("hidden");
    expect(composer).toContain('ref="fileInput"');
    expect(composer).toContain('ref="promptBoxEl"');
    expect(composer).toContain('ref="stopBtnRef"');
    expect(composer).toContain('ref="toolsRoot"');
    expect(composer).toContain('class="queue"');
    expect(composer).toContain('class="pending"');
    expect(composer).toContain('class="tools-flyout"');
    expect(composer).not.toContain("<Teleport");
    expect(composer).not.toContain("copy-toast");
  });

  it("props 锁定为 39 个状态与 helper", () => {
    expect(extractBlockKeys(composer, "defineProps")).toEqual([
      "visible",
      "current",
      "modelValue",
      "canSend",
      "imagesUnsupported",
      "composerPlaceholder",
      "minHeight",
      "maxHeight",
      "toolsMenuOpen",
      "skillOpen",
      "mcpOpen",
      "expertOpen",
      "currentSendMode",
      "currentExpert",
      "uiLocale",
      "agentId",
      "enabledMcpCount",
      "skillQuery",
      "skillAvailable",
      "skillFiltered",
      "skillBusy",
      "skillAddOpen",
      "skillError",
      "searchAutofocus",
      "iconStyle",
      "iconChar",
      "mcpQuery",
      "mcpAvailable",
      "mcpFiltered",
      "mcpPanelRows",
      "mcpBusy",
      "boundMcpIds",
      "mcpReconnecting",
      "canClearOptionalMcp",
      "mcpAddOpen",
      "mcpError",
      "mcpDescText",
      "expertQuery",
      "expertFiltered",
    ]);
    expect(composer).not.toContain("showTaskForm");
    expect(composer).not.toContain("showTaskList");
    expect(composer).not.toContain("inputEl");
  });

  it("emits 锁定为 38 个输入、工具面板和发送动作", () => {
    expect(extractBlockKeys(composer, "defineEmits")).toEqual([
      "update:modelValue",
      "composer-input",
      "keydown",
      "move-queue-item",
      "edit-queue-item",
      "remove-queue-item",
      "send-queue-item-now",
      "remove-pending-image",
      "remove-pending-doc",
      "pick-files",
      "start-composer-resize",
      "reset-composer-size",
      "toggle-tools-menu",
      "close-tools-panels",
      "toggle-send-mode",
      "clear-expert",
      "open-skill-panel",
      "open-mcp-panel",
      "open-expert-panel",
      "hover-flyout",
      "update:skillQuery",
      "toggle-skill",
      "skill-created",
      "toggle-skill-add",
      "cancel-skill-add",
      "clear-skill-selection",
      "update:mcpQuery",
      "toggle-mcp",
      "reconnect-mcp",
      "remove-custom-mcp",
      "mcp-created",
      "toggle-mcp-add",
      "cancel-mcp-add",
      "clear-mcp-selection",
      "update:expertQuery",
      "pick-expert",
      "stop",
      "send",
    ]);
  });

  it("四个 DOM ref 暴露，组件不接管全局监听或中断句柄", () => {
    expect(composer).toContain("defineExpose({ fileInput, promptBoxEl, stopBtnRef, toolsRoot })");
    for (const forbidden of [
      "window.addEventListener",
      "window.removeEventListener",
      "AbortController",
      "setTimeout",
    ]) {
      expect(composer).not.toContain(forbidden);
    }
    expect(core).toContain('window.addEventListener("mousedown", onOutsideTools)');
    expect(core).toContain('window.addEventListener("keydown", onEscTools)');
    expect(core).toContain('window.removeEventListener("mousedown", onOutsideTools)');
    expect(core).toContain('window.removeEventListener("keydown", onEscTools)');
  });

  it("关键命令路径与页面接线全部接通", () => {
    expect(composer).toContain("emit('update:modelValue'");
    expect(composer).toContain("emit('composer-input', $event)");
    expect(composer).toContain("emit('keydown', $event)");
    expect(composer).toContain("emit('send')");
    expect(composer).toContain("emit('stop')");
    expect(composer).toContain("emit('pick-files', $event)");
    expect(composer).toContain("emit('close-tools-panels')");
    expect(composer).toContain("emit('hover-flyout', 'skills')");
    expect(composer).toContain("fileInput.value?.click()");

    expect(core).toContain('import MessageComposer from "../../components/chat/MessageComposer.vue";');
    expect(core).toMatch(/^\s*MessageComposer,$/m);
    expect(extractPageBindings(page).length).toBeGreaterThanOrEqual(657);
    expect(extractPageBindings(page)).toContain("MessageComposer");
    expect(page).toContain("<MessageComposer");
    expect(page).toContain("fileInput = el?.fileInput ?? null");
    expect(page).toContain("promptBoxEl = el?.promptBoxEl ?? null");
    expect(page).toContain("stopBtnRef = el?.stopBtnRef ?? null");
    expect(page).toContain("toolsRoot = el?.toolsRoot ?? null");
    expect(page).toContain('class="copy-toast"');
    expect(page).not.toContain('<footer v-show="!showTaskForm && !showTaskList" class="composer">');
  });
});
