import assert from "node:assert/strict";
import { renderClarificationForUser } from "../src/chat.ts";
import { synthesizeReplyFromToolResults } from "../src/report-pc-parity.ts";
import { resolveReplyLanguage } from "../src/user-prefs.ts";
import { presentToolLabel, presentToolResult } from "../../web/src/tool-result-presenter.ts";
import { localizeToken } from "../../web/src/localize.ts";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS | ${name}`);
  } catch (error) {
    console.error(`FAIL | ${name}`);
    throw error;
  }
}

console.log("========== ui-locale smoke ==========");

run("reply language falls back from input before session/ui locale", () => {
  const resolved = resolveReplyLanguage({
    prefs: { replyLanguage: "follow_input" },
    userText: "你好，继续",
    sessionLastReplyLanguage: "hi",
    uiLocale: "pt-BR",
  });
  assert.equal(resolved.tag, "zh");
});

run("tool label is localized in pt-BR", () => {
  assert.equal(presentToolLabel("export_dataset", "pt-BR"), "Exportar arquivo");
});

run("nested tool result code fields are localized", () => {
  const shown = presentToolResult(
    "get_page_schema",
    JSON.stringify({
      ok: true,
      _i18n: { code: "TOOL_GET_PAGE_SCHEMA_NOT_FOUND" },
      pages: [{ primaryType: "list", outputHintCode: "TOOL_GET_PAGE_SCHEMA_HINT_LIST" }],
    }),
    "en",
  );
  assert.match(shown, /"outputHint": "List pages should usually present results as a table\."/);
});

run("UI transport wrapper text is omitted in non-zh locale", () => {
  const shown = presentToolResult(
    "export_dataset",
    `UI_TABLE\n{"title":"表格","total":2}\nUI_FILE\n{"name":"report.xlsx","size":123}\n\n已生成 XLSX：report.xlsx`,
    "pt-BR",
  );
  assert.doesNotMatch(shown, /已生成 XLSX/);
  assert.match(shown, /"message": "A saida estruturada de tabela\/arquivo esta disponivel\./);
});

run("synthesized UI_FILE fallback respects ui locale", () => {
  const text = synthesizeReplyFromToolResults(
    [`UI_FILE\n{"name":"report.xlsx","size":123}\n\nraw wrapper text`],
    "pt-BR",
  );
  assert.equal(text, "A saida estruturada do arquivo esta disponivel nos anexos acima.");
});

run("token localization returns pt-BR text", () => {
  const text = localizeToken("pt-BR", { code: "TOOL_GET_LIST_COLUMNS_HINT" });
  assert.match(text, /Use estes titulos de coluna/);
});

run("clarification wrapper is localized in pt-BR", () => {
  const text = renderClarificationForUser(
    `CLARIFICATION_REQUIRED
${JSON.stringify({
  intent: "调用业务接口",
  missingSlots: ["module"],
  question: "你要操作哪个模块？",
  questionCode: "CLARIFY_MODULE_REQUIRED",
  options: [{ label: "查询类", value: "read", labelCode: "CLARIFY_OPTION_READ" }],
  riskLevel: "read",
  resumeTool: "call_api",
  resumeInput: {},
})}`,
    "pt-BR",
  );
  assert.doesNotMatch(text, /你要操作哪个模块|查询类|请回复序号/);
  assert.match(text, /Qual modulo voce quer usar\?/);
});

console.log("ui-locale smoke: PASS");
