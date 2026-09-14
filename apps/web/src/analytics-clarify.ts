/**
 * Analytics 澄清/短答续问：只解析 slotAnswers（序号 / 全部 / 按你说的来 → 选项）。
 * 请求 body.text 始终是用户原文，不把原问拼回去。
 *
 * 注意：ok 后的续问修订（如「IndiaB呢？」）由服务端 AskState TurnIntent 负责；
 * 本模块仅在 looksLikeSlotOnlyReply 为真时填槽，不拦截 revise 短句。
 */

export type ClarifyOption = { id: string; label: string };

export type ClarifyBubble = {
  role: "user" | "assistant";
  text?: string;
  status?: string;
  clarifySlot?: string;
  clarifyOptions?: ClarifyOption[];
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

/** 纯序号短答，如 1 / 1,2,3 / 1 2 4 */
export function looksLikeIndexOnlyReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (extractLocaleCodes(t).length) return false;
  if (!/^[\d\s,，、;；\-–]+$/.test(t)) return false;
  return /\d/.test(t);
}

/** 全选澄清候选项：全部 / 全选 / all */
export function looksLikeSelectAllReply(text: string): boolean {
  const t = text.trim();
  return /^(全部|全都要|全选|所有|都要|all|select\s*all)$/i.test(t);
}

/** 接受上一轮建议 / 第一种口径，不是新问也不是全选。 */
export function looksLikeAcceptSuggestionReply(text: string): boolean {
  const t = text.trim();
  return /^(按你说的(?:来|做|办)?|就按你说的(?:来)?|就按这个|就这样(?:吧|查)?|你定|你看着办|随便(?:一个|选一个)?|第一种|选第一个|用第一个)[。.!！]*$/i.test(
    t,
  );
}

export function looksLikeSlotOnlyReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (looksLikeSelectAllReply(t)) return true;
  if (looksLikeAcceptSuggestionReply(t)) return true;
  if (extractLocaleCodes(t).length > 0 && t.length < 80) return true;
  if (looksLikeIndexOnlyReply(t)) return true;
  if (
    /(\(empty\)|^\s*空(?:（未标注）)?\s*$|^\s*英语(?:（[^）]*）)?\s*$|^\s*English\s*$|^\s*en\s*$)/i.test(t) &&
    t.length < 40
  ) {
    return true;
  }
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

function findOptionId(options: ClarifyOption[], token: string): string | undefined {
  const exact = options.find((o) => o.id === token);
  if (exact) return exact.id;
  const lower = token.toLowerCase();
  return options.find((o) => o.id.toLowerCase() === lower)?.id;
}

/**
 * Resolve short reply against clarifyOptions:
 * 1) 全部/all → all option ids;
 * 2) if every token matches an option id (e.g. movieType 10), use ids;
 * 3) else if pure indexes in range, use 1-based indexes.
 */
export function resolveOptionIndexes(
  text: string,
  options: ClarifyOption[] | undefined,
): string[] | null {
  if (!options?.length) return null;
  const t = text.trim();
  if (!t) return null;

  if (looksLikeSelectAllReply(t)) {
    return options.map((o) => o.id);
  }
  if (looksLikeAcceptSuggestionReply(t)) {
    return [options[0]!.id];
  }

  const tokens = t.split(/[\s,，、;；]+/).filter(Boolean);
  if (!tokens.length) return null;

  const asIds = tokens.map((tok) => findOptionId(options, tok));
  if (asIds.every((id): id is string => Boolean(id))) {
    return [...new Set(asIds)];
  }

  if (!looksLikeIndexOnlyReply(t)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (!Number.isFinite(n) || n < 1 || n > options.length) continue;
    const id = options[n - 1]!.id;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? ids : null;
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
): { slotAnswers?: Record<string, string[]> } {
  const originalNl = String(msgs[originIdx]!.text || "").trim();
  if (!originalNl) return {};

  const slotAnswers: Record<string, string[]> = {};

  // Replay user turns after origin against the clarify they answered (incl. indexes → ids)
  for (let i = originIdx + 1; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    const turnText = m.text || "";
    let clarify: ClarifyBubble | undefined;
    for (let j = i - 1; j > originIdx; j--) {
      const prev = msgs[j]!;
      if (prev.role === "assistant" && prev.status === "clarify") {
        clarify = prev;
        break;
      }
    }
    const indexed = resolveOptionIndexes(turnText, clarify?.clarifyOptions);
    if (indexed && clarify?.clarifySlot) {
      slotAnswers[clarify.clarifySlot] = indexed;
      continue;
    }
    const locales = extractLocaleCodes(turnText);
    if (locales.length) {
      slotAnswers.contentLang = opts.replaceLocalesFromCurrent
        ? locales
        : [...new Set([...(slotAnswers.contentLang || []), ...locales])];
    }
    if (/\(empty\)|空(?:（未标注）)?|英语|English|\ben\b/i.test(turnText)) {
      slotAnswers.contentLang = [...new Set([...(slotAnswers.contentLang || []), "(empty)"])];
    }
    const layout = extractLayoutAnswer(turnText);
    if (layout) slotAnswers.result_layout = [layout];
  }

  // Current turn (not yet in msgs)
  const lastClarify = opts.lastClarify;
  const indexed = resolveOptionIndexes(currentText, lastClarify?.clarifyOptions);
  if (indexed && lastClarify?.clarifySlot) {
    slotAnswers[lastClarify.clarifySlot] = indexed;
  } else if (
    lastClarify?.clarifySlot === "table" &&
    /^[A-Za-z][A-Za-z0-9_]{2,64}$/.test(currentText.trim())
  ) {
    slotAnswers.table = [currentText.trim()];
  } else if (opts.replaceLocalesFromCurrent && extractLocaleCodes(currentText).length) {
    slotAnswers.contentLang = extractLocaleCodes(currentText);
  } else {
    const locales = extractLocaleCodes(currentText);
    if (locales.length) {
      slotAnswers.contentLang = [...new Set([...(slotAnswers.contentLang || []), ...locales])];
    }
    if (/\(empty\)|空(?:（未标注）)?|英语|English|\ben\b/i.test(currentText)) {
      slotAnswers.contentLang = [...new Set([...(slotAnswers.contentLang || []), "(empty)"])];
    }
  }
  if (lastClarify?.clarifySlot === "result_layout") {
    if (indexed?.length === 1 && (indexed[0] === "wide" || indexed[0] === "long")) {
      slotAnswers.result_layout = [indexed[0]];
    } else {
      const layout = extractLayoutAnswer(currentText);
      if (layout) slotAnswers.result_layout = [layout];
    }
  } else {
    const layout = extractLayoutAnswer(currentText);
    if (layout) slotAnswers.result_layout = [layout];
  }

  return { slotAnswers: Object.keys(slotAnswers).length ? slotAnswers : undefined };
}

/**
 * 澄清多轮 + ok 后槽位短答修正：只填 slotAnswers，text 保持用户原文。
 */
export function buildClarifyContinuation(
  priorMessages: ClarifyBubble[],
  currentText: string,
): { slotAnswers?: Record<string, string[]> } {
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
    if (originIdx < 0) return {};
    return composeFromOrigin(msgs, originIdx, currentText, {
      lastClarify: msgs[lastClarifyIdx],
    });
  }

  // 2) 上一条已是 ok/refuse/error，但当前是槽位短答 → 当作对上一原问的修正重跑
  if (!looksLikeSlotOnlyReply(currentText)) return {};

  let lastResultIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && (m.status === "ok" || m.status === "refuse" || m.status === "error")) {
      lastResultIdx = i;
      break;
    }
  }
  if (lastResultIdx < 0) return {};

  const originIdx = findOriginUserIdx(msgs, lastResultIdx);
  if (originIdx < 0) return {};

  return composeFromOrigin(msgs, originIdx, currentText, {
    replaceLocalesFromCurrent: true,
  });
}
