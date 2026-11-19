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

describe("ContextMenuHost 契约", () => {
  const host = read("../src/components/chat/ContextMenuHost.vue");
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const page = read("../src/pages/ChatPage.vue");

  it("DOM 骨架与菜单不变量原样保留", () => {
    expect(host).toContain('<Teleport to="body">');
    expect(host).toContain('v-if="ctxMenu.open"');
    expect(host).toContain('ref="ctxMenuEl"');
    expect(host).toContain('role="menu"');
    expect(host).toContain("@click.stop");
    expect(host).toContain("@contextmenu.prevent");
    expect(host).toContain('@keydown="emit(\'keydown\', $event)"');
    expect(host).toContain("data-ctx-confirm");
    expect(host).toContain('defineExpose({ ctxMenuEl })');
  });

  it("props 与 emits 锁定为 5 个状态、19 个动作和 1 个键盘转发", () => {
    expect(extractBlockKeys(host, "defineProps")).toEqual([
      "ctxMenu",
      "ctxTarget",
      "ctxTargetTask",
      "ctxConfirm",
      "sortMode",
    ]);
    expect(extractBlockKeys(host, "defineEmits")).toEqual([
      "keydown",
      "run-task-now",
      "open-task-conv",
      "edit-task",
      "toggle-task-enabled",
      "mark-task-read",
      "remove-task",
      "rename",
      "toggle-pin",
      "restore-recent-sort",
      "arm-clear",
      "confirm-clear",
      "ask-close-others",
      "toggle-archive",
      "toggle-mute",
      "toggle-full-access",
      "toggle-send-mode",
      "duplicate",
      "export",
      "ask-delete",
    ]);
    expect(host).not.toContain("locations");
    expect(host).not.toContain("close: []");
  });

  it("子组件不接管全局监听，core 仍对称注册/移除菜单监听", () => {
    expect(host).not.toContain("window.addEventListener");
    expect(host).not.toContain("window.removeEventListener");
    expect(core).toContain('window.addEventListener("keydown", onCtxEscape)');
    expect(core).toContain('window.addEventListener("scroll", onCtxDismiss, true)');
    expect(core).toContain('window.addEventListener("resize", onCtxDismiss)');
    expect(core).toContain('window.removeEventListener("keydown", onCtxEscape)');
    expect(core).toContain('window.removeEventListener("scroll", onCtxDismiss, true)');
    expect(core).toContain('window.removeEventListener("resize", onCtxDismiss)');
  });

  it("core 返回、页面解构、ref 桥接和替换位置全部接通", () => {
    expect(core).toContain('import ContextMenuHost from "../../components/chat/ContextMenuHost.vue";');
    expect(core).toMatch(/^\s*ContextMenuHost,$/m);
    expect(extractPageBindings(page)).toHaveLength(655);
    expect(extractPageBindings(page)).toContain("ContextMenuHost");
    expect(page).toContain("<ContextMenuHost");
    expect(page).toContain("ctxMenuEl = el?.ctxMenuEl ?? null");
    expect(page).toContain('@keydown="onCtxMenuKeydown"');
    expect(page).not.toContain('class="ctx-menu"');
  });
});
