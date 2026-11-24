import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
}

describe("定时任务分组契约", () => {
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const sidebar = read("../src/components/chat/ChatSidebarList.vue");

  it("任务会话从平铺列表移出，搜索态不隐藏", () => {
    expect(core).toContain("const taskConvIds = computed(() => {");
    expect(core).toContain('if (t.ownConversation && t.conversationId) set.add(t.conversationId);');
    expect(core).toContain("for (const r of t.runs || []) set.add(r.conversationId);");
    expect(core).toContain(
      "const base = q ? conversations.value : conversations.value.filter((c) => !taskConvIds.value.has(c.id));",
    );
  });

  it("分组按任务聚合，老任务用专属对话顶一条且按最近一期倒序", () => {
    expect(core).toContain(".filter((t) => t.ownConversation)");
    expect(core).toContain("t.runs?.length");
    expect(core).toContain("? [{ conversationId: t.conversationId, at: t.lastRunAt ?? t.createdAt }]");
    expect(core).toContain(".sort((a, b) => b.at - a.at)");
    expect(core).toContain(".sort((a, b) => (b.runs[0]?.at || 0) - (a.runs[0]?.at || 0))");
    expect(core).toContain(".filter((g) => g.runs.length)");
  });

  it("点击某一期打开该期自己的 conversationId，键盘路径同源", () => {
    expect(core).toContain("function openRunConversation(run: TaskGroupRun): void {");
    expect(core).toContain('void openConversationById(run.conversationId, "run");');
    expect(core).toContain("void openRunConversation(run);");
    expect(sidebar).toContain("@click=\"emit('open-run-conversation', r)\"");
    expect(sidebar).toContain("@keydown=\"emit('run-keydown', $event, r)\"");
    expect(sidebar).toContain('"open-run-conversation": [run: TaskGroupRun];');
  });

  it("未读清零的两处入口都是乐观置 0 后再 PATCH，不改失败路径", () => {
    expect(core).toContain('function clearTaskUnread(convId: string) {');
    expect(core).toContain("t.unreadRuns = 0;\n  void patchChatSchedule(t.id, { unreadRuns: 0 }).catch(() => undefined);");
    expect(core).toContain("function ctxMarkTaskRead() {");
    expect(core.match(/t\.unreadRuns = 0;\n  void patchChatSchedule\(t\.id, \{ unreadRuns: 0 \}\)\.catch\(\(\) => undefined\);/g)?.length).toBe(2);
  });
});
