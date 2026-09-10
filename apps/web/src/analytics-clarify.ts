/**
 * Analytics 澄清/短答续问：把槽位短答合并回原问，避免丢渠道/时间/口径。
 */

export type ClarifyBubble = {
  role: "user" | "assistant";
  text?: string;
  status?: string;
  clarifySlot?: string;
  welcome?: boolean;
  pending?: boolean;
  cancelled?: boolean;
};

export function extractLocaleCodes(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || "").matchAll(/\b([a-z]{2,3}-[A-Za-z]{2})\b/gi)) {
    out.push(m[1]!);
  }
  return [...new Set(out)];
}

export function looksLikeDateOnlyReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractLocaleCodes(t).length) return false;
  return /\d{4}-\d{2}-\d{2}/.test(t) || /\d{1,2}\s*月/.test(t);
}

export function looksLikeSlotOnlyReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractLocaleCodes(t).length > 0 && t.length < 80) return true;
  if (looksLikeDateOnlyReply(t) && t.length < 60) return true;
  if (/最大进度|阈值|完播/.test(t) && t.length < 40) return true;
  if (/^(宽表|长表|wide|long)$/i.test(t) || (/宽表|长表|一列|作为行/.test(t) && t.length < 40)) {
    return true;
  }
  return false;
}

export function extractLayoutAnswer(text: string): "wide" | "long" | null {
  const t = text.trim();
  if (/宽表|每种.{0,6}一列|一列一种|分列|^\s*wide\s*$/i.test(t)) return "wide";
  if (/长表|作为行|^\s*long\s*$/i.test(t)) return "long";
  return null;
}

function findOriginUserIdx(msgs: ClarifyBubble[], beforeIdx: number): number {
  let originIdx = -1;
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    if (!looksLikeSlotOnlyReply(m.text || "")) {
      originIdx = i;
      break;
    }
    originIdx = i;
  }
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    const t = m.text || "";
    if (t.length >= 20 || /渠道|完播|观看|India|Fox|统计|按/.test(t)) {
      originIdx = i;
      break;
    }
  }
  return originIdx;
}

function composeFromOrigin(
  msgs: ClarifyBubble[],
  originIdx: number,
  currentText: string,
  opts: {
    /** ok 后短答修正：当前消息里的语言覆盖历史，不把旧 locale 累加进来 */
    replaceLocalesFromCurrent?: boolean;
    lastClarify?: ClarifyBubble;
  },
): { text: string; slotAnswers?: Record<string, string[]> } {
  const originalNl = String(msgs[originIdx]!.text || "").trim();
  if (!originalNl) return { text: currentText };

  const priorUserTexts = msgs
    .slice(originIdx + 1)
    .filter((m) => m.role === "user")
    .map((m) => m.text || "");
  const supplements = [...priorUserTexts, currentText];

  const slotAnswers: Record<string, string[]> = {};

  if (opts.replaceLocalesFromCurrent && extractLocaleCodes(currentText).length) {
    slotAnswers.contentLang = extractLocaleCodes(currentText);
  } else {
    const locales = [...new Set(supplements.flatMap((s) => extractLocaleCodes(s)))];
    if (locales.length) slotAnswers.contentLang = locales;
  }

  for (const s of supplements) {
    const layout = extractLayoutAnswer(s);
    if (layout) {
      slotAnswers.result_layout = [layout];
      break;
    }
  }
  if (opts.lastClarify?.clarifySlot === "result_layout") {
    const layout = extractLayoutAnswer(currentText);
    if (layout) slotAnswers.result_layout = [layout];
  }
  // ok 后仅回宽/长表：以当前为准
  if (opts.replaceLocalesFromCurrent) {
    const layout = extractLayoutAnswer(currentText);
    if (layout) slotAnswers.result_layout = [layout];
  }

  const hasIsoInOrigin = /\d{4}-\d{2}-\d{2}/.test(originalNl) || /\d{1,2}\s*月/.test(originalNl);
  const dateBits = supplements.filter((s) => looksLikeDateOnlyReply(s) || /\d{4}-\d{2}-\d{2}/.test(s));
  let text = originalNl;
  if (!hasIsoInOrigin && dateBits.length) {
    text = `${originalNl}\n日期范围：${dateBits[dateBits.length - 1]}`;
  }

  const metricBit = supplements.find((s) => /最大进度|阈值/.test(s));
  if (metricBit && !/最大进度|阈值/.test(originalNl)) {
    text = `${text}\n口径：${metricBit}`;
  }

  return {
    text,
    slotAnswers: Object.keys(slotAnswers).length ? slotAnswers : undefined,
  };
}

/**
 * 澄清多轮 + ok 后槽位短答修正：合成 text + slotAnswers。
 */
export function buildClarifyContinuation(
  priorMessages: ClarifyBubble[],
  currentText: string,
): { text: string; slotAnswers?: Record<string, string[]> } {
  const msgs = priorMessages.filter((m) => !m.welcome && !m.pending && !m.cancelled);

  // 1) 活跃澄清链（遇到 ok/refuse/error 即停）
  let lastClarifyIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && m.status === "clarify") {
      lastClarifyIdx = i;
      break;
    }
    if (m.role === "assistant" && (m.status === "ok" || m.status === "refuse" || m.status === "error")) {
      break;
    }
  }
  if (lastClarifyIdx >= 0) {
    const originIdx = findOriginUserIdx(msgs, lastClarifyIdx);
    if (originIdx < 0) return { text: currentText };
    return composeFromOrigin(msgs, originIdx, currentText, {
      lastClarify: msgs[lastClarifyIdx],
    });
  }

  // 2) 上一条已是 ok/refuse/error，但当前是槽位短答 → 当作对上一原问的修正重跑
  if (!looksLikeSlotOnlyReply(currentText)) return { text: currentText };

  let lastResultIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && (m.status === "ok" || m.status === "refuse" || m.status === "error")) {
      lastResultIdx = i;
      break;
    }
  }
  if (lastResultIdx < 0) return { text: currentText };

  const originIdx = findOriginUserIdx(msgs, lastResultIdx);
  if (originIdx < 0) return { text: currentText };

  return composeFromOrigin(msgs, originIdx, currentText, {
    replaceLocalesFromCurrent: true,
  });
}
