// 复制文本到剪贴板：兼容非安全上下文（如 http://局域网IP:5173）环境。
// Clipboard API 仅在 secure context（https / localhost）下可用，局域网 HTTP 访问时
// navigator.clipboard 为 undefined 或 writeText 抛错（NotAllowedError），
// 需降级到经典的隐藏 textarea + document.execCommand("copy") 方案（不要求 secure context）。
export async function copyText(text: string): Promise<boolean> {
  // 首选 Clipboard API（异步、保留剪贴板历史）。
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 权限被拒 / 非聚焦等，降级到 execCommand */
    }
  }
  // 降级：隐藏 textarea + execCommand("copy")，兼容 http://IP 访问。
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
