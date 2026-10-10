const STOP_TEXT_MARKERS = [
  "（已停止生成）",
  " (stopped)",
  "(stopped)",
  " (geração interrompida)",
  "(geração interrompida)",
  " (उत्पादन रोक दिया गया)",
  "(उत्पादन रोक दिया गया)",
];

export function isStoppedBubble(bubble: { text: string }): boolean {
  return STOP_TEXT_MARKERS.some((marker) => bubble.text.endsWith(marker));
}

/** 去掉尾部停止标记。复制和渲染用这份，原文仍留在气泡上。 */
export function bubbleBody(bubble: { text: string }): string {
  for (const marker of STOP_TEXT_MARKERS) {
    if (bubble.text.endsWith(marker)) return bubble.text.slice(0, bubble.text.length - marker.length).trimEnd();
  }
  return bubble.text;
}

/**
 * 把助手结论首行的 [SPIKE]/[NORMAL]/[NO_DATA] 拆成徽章和正文。
 * 匹配「标记后换行或空白」，允许「[NORMAL] 计数 30」。
 */
export function alertMarkerInfo(bubble: { role: string; text: string }): { marker: string; body: string } | null {
  if (bubble.role !== "assistant" || !bubble.text) return null;
  const body = bubbleBody(bubble);
  const matched = body.match(/^\[(SPIKE|NORMAL|NO_DATA)\](?:[ \t]*\r?\n|[ \t]|$)/i);
  if (!matched) return null;
  return { marker: matched[1]!.toUpperCase(), body: body.slice(matched[0].length).trimStart() };
}
