import type { InjectionKey, Ref } from "vue";
import type { UiLocale } from "../ui-locale";
import type { Bubble, ToolStep, StepStatus, SubagentStatus } from "../chat-types";

/**
 * 气泡子组件与父页面之间的共享上下文。
 * 气泡模板原本大量依赖 ChatPage 的本地函数、响应式集合与 ref；抽取成 ChatBubble 后，
 * 通过 provide/inject 把这些依赖一次性透传下去，避免逐个 prop 钻透，也避免把逻辑搬出 ChatPage。
 * 所有纯函数都保持原签名，组件内直接按原名调用即可。
 */
export interface BubbleContext {
  openReasoning: Set<number>;
  openSteps: Set<string>;
  clarifyDraft: Ref<Record<number, string>>;
  uiLocale: Ref<UiLocale>;
  currentId: Ref<string>;
  toggleReasoning: (id: number) => void;
  toggleStep: (b: Bubble, step: ToolStep) => void;
  cancelSubagent: (bubbleId: number, subagentId: string) => Promise<void> | void;
  answerToolConfirm: (bubble: Bubble, confirmed: boolean) => Promise<void> | void;
  submitClarifyFreeform: (bubble: Bubble) => Promise<void> | void;
  answerClarification: (bubble: Bubble, value?: string) => Promise<void> | void;
  copyBubble: (b: Bubble) => Promise<void> | void;
  editUserBubble: (b: Bubble) => void;
  openArtifactPreview: (a: { name: string; path: string }) => void;
  openAlertScheduleFromChat: (b?: { role: string; text: string }) => void;
  onInlineSubmitKeydown: (e: KeyboardEvent, fn: () => void) => void;
  formatBytes: (bytes: number) => string;
  reasoningTitle: (b: Bubble) => string;
  thinkLabel: (b: Bubble) => string;
  hasThinking: (b: Bubble) => boolean;
  intentOf: (b: Bubble) => string | undefined;
  thinkingDisplay: (b: Bubble) => string;
  stepKey: (b: Bubble, step: ToolStep) => string;
  stepClass: (status: StepStatus) => string;
  stepStatusText: (status: StepStatus) => string;
  toolDisplayName: (name: string, locale: UiLocale) => string;
  showToolServer: (name: string, server?: string) => boolean;
  stepSummary: (step: ToolStep) => string;
  subagentDotClass: (status: SubagentStatus) => string;
  subagentStatusText: (status: SubagentStatus) => string;
  confirmLevelText: (level: NonNullable<Bubble["pending"]>["level"]) => string;
  confirmExpiryText: (ms?: number) => string;
  usageText: (usage: NonNullable<Bubble["usage"]>) => string;
  alertChipText: (marker: string) => string;
  bubbleTimeText: (at: number) => string;
  isHtmlArtifact: (a: { name: string; path: string }) => boolean;
  renderChatMarkdown: (text: string, locale: UiLocale) => string;
  alertMarkerInfo: (b: { role: string; text: string }) => { marker: string; body: string } | null;
  bubbleBody: (b: { text: string }) => string;
  isStoppedBubble: (b: { text: string }) => boolean;
  workspaceDownloadUrl: (convId: string, path: string) => string;
}

export const bubbleContextKey: InjectionKey<BubbleContext> = Symbol("bubbleContext");
