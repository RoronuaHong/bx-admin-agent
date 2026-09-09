import {
  clearIdentityCache,
  displayAssistantTextForLocale,
  displayConversationTitle,
  displayConversationTitleForLocale,
  displayMessageTextForLocale,
  displayReasoningTextForLocale,
  isDefaultConversationTitle,
  loadConversationsFromStorage,
  loadClosedIds,
  makeConversationTitle,
  migrateLegacyConversation,
  persistClosedIds,
  readIdentityCache,
  readModelCache,
  sanitizeBubble,
  slimConversations,
  writeIdentityCache,
  writeModelCache,
  type Bubble,
  type Conversation,
} from "../src/chat-storage.ts";
import { applyChatStreamEvent, toolStatusTextForLocale } from "../src/chat-stream-events.ts";
import { presentToolLabel, presentToolResult } from "../src/tool-result-presenter.ts";
import { setUiLocale } from "../src/ui-locale.ts";

const results: Array<{ name: string; ok: boolean }> = [];

function assert(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} | [web-chat] ${name}`);
}

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

assert("默认标题识别覆盖多语言", isDefaultConversationTitle("新对话") && isDefaultConversationTitle("New Chat") && isDefaultConversationTitle("Novo Chat") && isDefaultConversationTitle("नई चैट"));

assert(
  "标题展示对默认值回退",
  displayConversationTitle("New Chat", "新对话") === "新对话" &&
    displayConversationTitle("自定义标题", "新对话") === "自定义标题",
);
assert(
  "标题展示会按目标内容语种隐藏历史标题",
  displayConversationTitleForLocale("你好", "新对话", "hi", "en") === "(भाषा नीति द्वारा छिपाया गया सहेजा गया शीर्षक)",
);
assert(
  "助手正文会按目标内容语种隐藏历史文本",
  displayAssistantTextForLocale("你好，旧内容", "en", "pt-BR") === "Stored assistant text is hidden by the language policy.",
);
assert(
  "用户正文也会按目标内容语种隐藏历史文本",
  displayMessageTextForLocale("你好，旧需求", "user", "pt-BR", "en") === "O texto salvo do usuario foi ocultado pela politica de idioma.",
);
assert(
  "reasoning 也会按目标内容语种隐藏历史文本",
  displayReasoningTextForLocale("你好，旧推理", "en", "pt-BR") === "Stored assistant text is hidden by the language policy.",
);

assert(
  "makeConversationTitle 会压缩空白并截断",
  makeConversationTitle(
    [{ id: 1, role: "user", text: "   hello    world   from    agent   " }] as Bubble[],
    "新对话",
  ) === "hello world from agent",
);

writeIdentityCache("identity", { countryId: "india", loginName: "alice" });
assert("identity cache 可写可读", readIdentityCache("identity")?.countryId === "india" && readIdentityCache("identity")?.loginName === "alice");
clearIdentityCache("identity");
assert("identity cache 可清理", readIdentityCache("identity") === null);

writeModelCache("model", "gpt-5", "GPT 5");
assert("model cache 可写可读", readModelCache("model")?.id === "gpt-5" && readModelCache("model")?.label === "GPT 5");
writeModelCache("model", null, "Auto");
assert("model cache 可按 Auto 清理", readModelCache("model") === null);

persistClosedIds("closed", ["a", "b", "c"]);
assert("closed ids 可持久化恢复", loadClosedIds("closed").join(",") === "a,b,c");

localStorage.setItem(
  "conv-store",
  JSON.stringify({
    activeId: "conv-1",
    conversations: [
      {
        id: "conv-1",
        title: "New Chat",
        createdAt: 1,
        updatedAt: 2,
        messages: [
          { id: 1, role: "user", text: "hi" },
          { id: 2, role: "assistant", text: "", reasoning: "step", toolResults: [{ name: "read_file", result: "ok" }] },
        ],
      },
    ],
  }),
);
const restored = loadConversationsFromStorage("conv-store", "新对话", (() => {
  let id = 200;
  return () => ++id;
})());
assert(
  "loadConversationsFromStorage 会恢复默认标题并保留助手产出",
  restored.activeId === "conv-1" &&
    restored.conversations[0]?.title === "新对话" &&
    restored.conversations[0]?.messages[1]?.reasoning === "step" &&
    restored.conversations[0]?.messages[1]?.finished === true,
);

localStorage.setItem(
  "legacy-store",
  JSON.stringify([
    { role: "user", text: "legacy prompt" },
    { role: "assistant", text: "legacy answer" },
  ]),
);
const migrated = migrateLegacyConversation("legacy-store", "新对话", (() => {
  let id = 300;
  return () => ++id;
})());
assert(
  "migrateLegacyConversation 会把旧单会话迁成新结构",
  Boolean(
    migrated &&
      migrated.id.startsWith("conv_") &&
      migrated.title === "legacy prompt" &&
      migrated.messages.length === 2,
  ),
);

const slim = slimConversations([
  {
    id: "conv-1",
    title: "x",
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 1, role: "user", text: "hi" },
      { id: 2, role: "assistant", text: "", reasoning: "step", toolResults: [{ name: "read_file", result: "ok" }] },
    ],
  },
] as Conversation[]);
assert("slimConversations 保留有 reasoning/toolResults 的助手消息", slim[0]?.messages.length === 2);

const sanitized = sanitizeBubble({
  id: 3,
  role: "assistant",
  text: "x".repeat(21000),
  reasoning: "r".repeat(21000),
  toolResults: [{ name: "n".repeat(200), result: "y".repeat(13000) }],
});
assert(
  "sanitizeBubble 会截断并标记完成",
  sanitized.finished === true &&
    sanitized.text.length === 20000 &&
    sanitized.reasoning?.length === 20000 &&
    sanitized.toolResults?.[0]?.name.length === 120 &&
    sanitized.toolResults?.[0]?.result.length === 12000,
);

assert(
  "toolStatusTextForLocale 返回本地化文案",
  toolStatusTextForLocale("zh", "call_api").includes("调用接口") &&
    toolStatusTextForLocale("en", "call_api").includes("Querying data"),
);

setUiLocale("hi");
assert("tool label 在印地语下不回退中文", presentToolLabel("submit_understood_intent", "hi") === "आशय समझ");
assert("tool label 在葡语下不回退工具 id", presentToolLabel("export_dataset", "pt-BR") === "Exportar arquivo");

const understoodShown = presentToolResult(
  "submit_understood_intent",
  JSON.stringify({
    _understood: true,
    isBusinessRequest: false,
    operationType: "unknown",
    responseMode: "explain-capability",
    confidence: 0,
    summary: "用户打招呼闲聊",
  }),
  "en",
  "en",
);
assert(
  "submit_understood_intent 结果会按目标内容语种隐藏中文摘要",
  understoodShown.includes('"summary": "The raw business text is hidden by the language policy."') &&
    understoodShown.includes('"responseMode": "explain capability/path"') &&
    !understoodShown.includes("用户打招呼闲聊"),
);

const prefShown = presentToolResult(
  "update_user_preference",
  JSON.stringify({
    ok: true,
    _i18n: { code: "TOOL_PREF_SAVED" },
    preferences: { replyLanguage: "pt-BR" },
  }),
  "pt-BR",
  "pt-BR",
);
assert(
  "tool result 会本地化 _i18n token",
  prefShown.includes('"message": "A preferencia foi salva') && !prefShown.includes('"code": "TOOL_PREF_SAVED"'),
);

const hiddenChineseError = presentToolResult("call_api", "错误：请求失败；网络异常", "en");
assert(
  "tool result 会隐藏原始中文错误",
  hiddenChineseError === "The tool failed. Expand to inspect the full result.",
);

const guideShown = presentToolResult(
  "get_user_preferences",
  JSON.stringify({
    ok: true,
    _i18n: { code: "TOOL_PREF_READ" },
    guideCode: "TOOL_PREF_GUIDE",
  }),
  "en",
  "en",
);
assert(
  "tool result 会本地化 guideCode",
  guideShown.includes('"guide": "The current preference guide has been returned."'),
);

const grepNoMatchShown = presentToolResult(
  "grep_codebase",
  JSON.stringify({
    ok: true,
    _i18n: { code: "TOOL_GREP_NO_MATCH_DIR" },
    noResults: true,
  }),
  "en",
  "en",
);
assert(
  "tool result 会本地化无结果提示",
  grepNoMatchShown.includes('"message": "No matches were found in the search directory."'),
);

const hiddenHintShown = presentToolResult(
  "get_list_columns",
  JSON.stringify({
    ok: true,
    _i18n: { code: "TOOL_GET_LIST_COLUMNS_NOT_FOUND" },
    hint: "原始中文提示",
  }),
  "en",
  "en",
);
assert(
  "tool result 会隐藏诊断字段中的原始中文",
  hiddenHintShown.includes('"hint": "The diagnostic text is hidden by the language policy."'),
);

const hiddenEnglishDetailShown = presentToolResult(
  "call_api",
  JSON.stringify({
    ok: false,
    _i18n: { code: "TOOL_CALL_API_REQUEST_FAILED" },
    detail: "upstream gateway timeout while requesting report list",
  }),
  "pt-BR",
  "hi",
);
assert(
  "tool result 会按目标内容语种隐藏英文诊断字段",
  hiddenEnglishDetailShown.includes('"detail": "O texto de diagnostico foi ocultado pela politica de idioma."'),
);

const englishDetailShown = presentToolResult(
  "call_api",
  JSON.stringify({
    ok: false,
    _i18n: { code: "TOOL_CALL_API_REQUEST_FAILED" },
    detail: "upstream gateway timeout while requesting report list",
  }),
  "pt-BR",
  "en",
);
assert(
  "tool result 的诊断字段不再仅因 uiLocale 不是英文而被隐藏",
  englishDetailShown.includes('"detail": "upstream gateway timeout while requesting report list"'),
);

const hiddenKnowledgeShown = presentToolResult(
  "search_knowledge_base",
  JSON.stringify({
    ok: true,
    _i18n: { code: "TOOL_SEARCH_KB_FOUND" },
    items: [{ title: "制度", snippet: "这是中文知识摘要", sourcePath: "docs/knowledge/rules.md" }],
  }),
  "en",
  "pt-BR",
);
assert(
  "knowledge snippet 会按目标内容语种隐藏",
  hiddenKnowledgeShown.includes('"snippet": "The knowledge or document snippet is hidden by the language policy."') &&
    hiddenKnowledgeShown.includes('"sourcePath": "docs/knowledge/rules.md"'),
);

const legacyStructuredShown = presentToolResult(
  "call_api",
  JSON.stringify({
    ok: false,
    message: "历史中文业务结果",
    detail: "legacy chinese diagnostic detail",
    path: "/api/report/list",
  }),
  "en",
  "pt-BR",
);
assert(
  "无 _i18n 的结构化结果也会走 fail-closed",
  legacyStructuredShown.includes('"message": "The raw business text is hidden by the language policy."') &&
    legacyStructuredShown.includes('"path": "/api/report/list"'),
);

const pageHintShown = presentToolResult(
  "get_page_schema",
  JSON.stringify({
    ok: true,
    _i18n: { code: "TOOL_GET_PAGE_SCHEMA_NOT_FOUND" },
    pages: [{ primaryType: "list", outputHintCode: "TOOL_GET_PAGE_SCHEMA_HINT_LIST" }],
  }),
  "en",
  "en",
);
assert(
  "tool result 会递归本地化嵌套 code 字段",
  pageHintShown.includes('"outputHint": "List pages should usually present results as a table."'),
);

const uiTransportShown = presentToolResult(
  "export_dataset",
  `UI_TABLE\n{"title":"表格","total":2}\nUI_FILE\n{"name":"report.xlsx","size":123}\n\n已生成 XLSX：report.xlsx`,
  "en",
  "pt-BR",
);
assert(
  "tool result 会去掉 UI transport 的原始包装文本",
  uiTransportShown.includes('"message": "Structured table/file output is available. Raw wrapper text has been omitted."') &&
    uiTransportShown.includes('"name": "report.xlsx"') &&
    !uiTransportShown.includes("已生成 XLSX"),
);

const assistant: Bubble = {
  id: 9,
  role: "assistant",
  text: "",
  toolActive: false,
  finished: false,
};
const state = {
  suppressDelta: false,
  gotDone: false,
  toolCount: 0,
  modelNotice: "",
};
const tx = (zh: string, en: string) => zh || en;

applyChatStreamEvent({ event: { type: "tool_call", name: "call_api", input: {} }, assistant, state, locale: "zh", tx });
applyChatStreamEvent({ event: { type: "tool_result", name: "call_api", result: "ok" }, assistant, state, locale: "zh", tx });
applyChatStreamEvent({ event: { type: "reasoning", text: "step 1" }, assistant, state, locale: "zh", tx });
applyChatStreamEvent({ event: { type: "text_delta", text: "结果" }, assistant, state, locale: "zh", tx });
applyChatStreamEvent({ event: { type: "done" }, assistant, state, locale: "zh", tx });

assert(
  "stream event 会累积工具链、推理与完成态",
  assistant.toolStep === 1 &&
    assistant.toolResults?.length === 1 &&
    assistant.reasoning?.includes("step 1") &&
    assistant.text === "结果" &&
    assistant.finished === true &&
    state.gotDone === true,
);

const jsonAssistant: Bubble = { id: 10, role: "assistant", text: "", finished: false };
const jsonState = { suppressDelta: false, gotDone: false, toolCount: 0, modelNotice: "" };
applyChatStreamEvent({
  event: { type: "text", text: '{"tool_calls":[{"name":"call_api"}]}' },
  assistant: jsonAssistant,
  state: jsonState,
  locale: "zh",
  tx,
});
assert("stream event 会过滤误输出的工具 JSON", jsonAssistant.text === "");

const deltaAssistant: Bubble = { id: 12, role: "assistant", text: '{"tool', finished: false };
const deltaState = { suppressDelta: false, gotDone: false, toolCount: 0, modelNotice: "" };
applyChatStreamEvent({
  event: { type: "text_delta", text: '_calls":[{"name":"call_api"}]}' },
  assistant: deltaAssistant,
  state: deltaState,
  locale: "zh",
  tx,
});
assert("stream event 会抑制跨分片工具 JSON", deltaAssistant.text === '{"tool' && deltaState.suppressDelta === true);

const fallbackAssistant: Bubble = { id: 11, role: "assistant", text: "", finished: false };
const fallbackState = { suppressDelta: false, gotDone: false, toolCount: 0, modelNotice: "" };
applyChatStreamEvent({
  event: { type: "model", id: "x", label: "GPT-X", reason: "fallback" },
  assistant: fallbackAssistant,
  state: fallbackState,
  locale: "zh",
  tx,
});
assert("stream event 会更新模型降级提示", fallbackState.modelNotice.includes("GPT-X"));

const errorAssistant: Bubble = { id: 13, role: "assistant", text: "", finished: false };
const errorState = { suppressDelta: false, gotDone: false, toolCount: 0, modelNotice: "" };
applyChatStreamEvent({
  event: { type: "error", error: { code: "CHAT_STREAM_FAILED" } },
  assistant: errorAssistant,
  state: errorState,
  locale: "en",
  tx,
});
assert(
  "stream event 会同时保留 error token 与本地化错误",
  errorAssistant.errorToken?.code === "CHAT_STREAM_FAILED" &&
    errorAssistant.error === "Operation failed. Please try again later.",
);

const failed = results.filter((item) => !item.ok);
console.log(`\nweb-chat: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
