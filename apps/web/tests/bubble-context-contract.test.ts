import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const EXPECTED_KEYS = [
  "openReasoning",
  "openSteps",
  "clarifyDraft",
  "uiLocale",
  "currentId",
  "toggleReasoning",
  "toggleStep",
  "cancelSubagent",
  "answerToolConfirm",
  "submitClarifyFreeform",
  "answerClarification",
  "copyBubble",
  "editUserBubble",
  "openArtifactPreview",
  "openAlertScheduleFromChat",
  "onInlineSubmitKeydown",
  "formatBytes",
  "reasoningTitle",
  "thinkLabel",
  "hasThinking",
  "intentOf",
  "thinkingDisplay",
  "stepKey",
  "stepClass",
  "stepStatusText",
  "toolDisplayName",
  "showToolServer",
  "stepSummary",
  "subagentDotClass",
  "subagentStatusText",
  "confirmLevelText",
  "confirmExpiryText",
  "usageText",
  "alertChipText",
  "bubbleTimeText",
  "isHtmlArtifact",
  "renderChatMarkdown",
  "alertMarkerInfo",
  "bubbleBody",
  "isStoppedBubble",
  "workspaceDownloadUrl",
] as const;

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function extractProvideKeys(source: string): string[] {
  const sf = ts.createSourceFile("core.ts", source, ts.ScriptTarget.Latest, true);
  let keys: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "bubbleContext" &&
      node.initializer
    ) {
      const initializer = ts.isSatisfiesExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isObjectLiteralExpression(initializer)) {
        keys = initializer.properties.map((property) =>
          property.name ? property.name.getText(sf) : property.getText(sf),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return keys;
}

function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const sf = ts.createSourceFile("bubble-context.ts", source, ts.ScriptTarget.Latest, true);
  let fields: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      fields = node.members.map((member) => (member.name ? member.name.getText(sf) : ""));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return fields;
}

function extractChatBubbleDestructure(source: string): string[] {
  const match = source.match(/const ctx = inject\(bubbleContextKey\)!;\s*const \{([\s\S]*?)\} = ctx;/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

describe("bubbleContext 契约", () => {
  const core = read("../src/composables/chat/useChatPageCore.ts");
  const context = read("../src/components/bubble-context.ts");
  const bubble = read("../src/components/ChatBubble.vue");

  it("provide 对象锁定 41 键及顺序", () => {
    expect(EXPECTED_KEYS).toHaveLength(41);
    expect(extractProvideKeys(core)).toEqual([...EXPECTED_KEYS]);
  });

  it("BubbleContext 字段与 ChatBubble 解构逐项对齐", () => {
    expect(extractInterfaceFields(context, "BubbleContext")).toEqual([...EXPECTED_KEYS]);
    expect(extractChatBubbleDestructure(bubble)).toEqual([...EXPECTED_KEYS]);
  });

  it("core 源码包含 satisfies 与 DEV 数量断言", () => {
    expect(core).toContain("const bubbleContext = {");
    expect(core).toContain("} satisfies BubbleContext;");
    expect(core).toContain("import.meta.env.DEV && Object.keys(bubbleContext).length !== 41");
    expect(core).toContain("provide(bubbleContextKey, bubbleContext)");
  });
});
