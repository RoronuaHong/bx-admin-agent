import type { UiLocale } from "./ui-locale";
import { pickLocalized } from "./localize";

export type HiddenContentCategory =
  | "stored-title"
  | "stored-user-text"
  | "stored-assistant-text"
  | "knowledge-snippet"
  | "code-snippet"
  | "file-content"
  | "business-text"
  | "diagnostic-text";

export function normalizeContentLanguage(raw: string | null | undefined): string | undefined {
  const value = String(raw || "").trim().replace(/_/g, "-").toLowerCase();
  if (!value || value === "follow-input" || value === "follow_input") return undefined;
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("pt")) return "pt-BR";
  if (value.startsWith("hi")) return "hi";
  if (value.startsWith("en")) return "en";
  return value;
}

export function detectContentLanguage(text: string): string | undefined {
  const value = String(text || "").trim();
  if (!value) return undefined;
  if (/[\u0900-\u097F]/u.test(value)) return "hi";
  if (/[\u3400-\u9FFF\uF900-\uFAFF]/u.test(value)) return "zh";
  const folded = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/\b(nao|voce|para|com|uma|que|arquivo|falha|conversa|detalhe|modulo|lista|tarefa|resultado|historico)\b/.test(folded)) {
    return "pt-BR";
  }
  const latinLetters = (folded.match(/[a-z]/g) || []).length;
  if (latinLetters >= 6 && /\s/.test(folded)) return "en";
  return undefined;
}

export function contentLanguageMismatchesTarget(
  text: string,
  targetLanguage: string | null | undefined,
): boolean {
  const target = normalizeContentLanguage(targetLanguage);
  if (!target) return false;
  const detected = detectContentLanguage(text);
  if (!detected) return false;
  return detected !== target;
}

export function looksLikeCodeSnippet(text: string): boolean {
  const value = String(text || "");
  if (!value.includes("\n")) return false;
  return /```|^\s*(import |export |const |let |var |function |class |interface |type |<script|<template|SELECT |INSERT |UPDATE |DELETE )/m.test(value);
}

export function hiddenContentPlaceholder(locale: UiLocale, category: HiddenContentCategory): string {
  const table: Record<HiddenContentCategory, { zh: string; en: string; pt: string; hi: string }> = {
    "stored-title": {
      zh: "(其他语种的历史标题)",
      en: "(Stored title hidden by language policy)",
      pt: "(Titulo salvo ocultado pela politica de idioma)",
      hi: "(भाषा नीति द्वारा छिपाया गया सहेजा गया शीर्षक)",
    },
    "stored-user-text": {
      zh: "历史用户文本已按语言策略隐藏。",
      en: "Stored user text is hidden by the language policy.",
      pt: "O texto salvo do usuario foi ocultado pela politica de idioma.",
      hi: "सहेजा गया उपयोगकर्ता पाठ भाषा नीति के कारण छिपा दिया गया है।",
    },
    "stored-assistant-text": {
      zh: "历史助手文本已按语言策略隐藏。",
      en: "Stored assistant text is hidden by the language policy.",
      pt: "O texto salvo do assistente foi ocultado pela politica de idioma.",
      hi: "सहेजा गया सहायक पाठ भाषा नीति के कारण छिपा दिया गया है।",
    },
    "knowledge-snippet": {
      zh: "知识/文档摘要已按语言策略隐藏。",
      en: "The knowledge or document snippet is hidden by the language policy.",
      pt: "O trecho de conhecimento ou documento foi ocultado pela politica de idioma.",
      hi: "ज्ञान या दस्तावेज़ अंश भाषा नीति के कारण छिपा दिया गया है।",
    },
    "code-snippet": {
      zh: "源码片段已按语言策略隐藏。",
      en: "The source code snippet is hidden by the language policy.",
      pt: "O trecho de codigo-fonte foi ocultado pela politica de idioma.",
      hi: "सोर्स कोड अंश भाषा नीति के कारण छिपा दिया गया है।",
    },
    "file-content": {
      zh: "文件内容已按语言策略隐藏。",
      en: "The file content is hidden by the language policy.",
      pt: "O conteudo do arquivo foi ocultado pela politica de idioma.",
      hi: "फ़ाइल सामग्री भाषा नीति के कारण छिपा दी गई है।",
    },
    "business-text": {
      zh: "原始业务文本已按语言策略隐藏。",
      en: "The raw business text is hidden by the language policy.",
      pt: "O texto bruto de negocio foi ocultado pela politica de idioma.",
      hi: "कच्चा व्यावसायिक पाठ भाषा नीति के कारण छिपा दिया गया है।",
    },
    "diagnostic-text": {
      zh: "诊断文本已按语言策略隐藏。",
      en: "The diagnostic text is hidden by the language policy.",
      pt: "O texto de diagnostico foi ocultado pela politica de idioma.",
      hi: "डायग्नोस्टिक पाठ भाषा नीति के कारण छिपा दिया गया है।",
    },
  };
  return pickLocalized(locale, table[category]);
}
