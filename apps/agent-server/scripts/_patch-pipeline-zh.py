# -*- coding: utf-8 -*-
"""Patch pipeline.ts user-facing Chinese via unicode escapes (ASCII-only script)."""
from pathlib import Path
import re

p = Path(r"d:/Code/bx-admin-agent/apps/agent-server/src/analytics/pipeline.ts")
t = p.read_text(encoding="utf-8")

def must_sub(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1)
    print(f"{label}: n={n}")
    return out

# attachment labels (corrupted brackets)
t = t.replace("`[????]\\n${item.text.trim()}`", "`[\u9644\u4ef6\u6587\u672c]\\n${item.text.trim()}`")
t = t.replace("`[??????] id=${id}`", "`[\u9644\u4ef6\u6587\u672c\u4e3a\u7a7a] id=${id}`")
# two similar missing lines - replace first occurrence then second with different chinese
for old, new in [
    ("`[????] id=${id}?????????`", "`[\u9644\u4ef6\u7f3a\u5931] id=${id}\uff08\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f\uff09`"),
]:
    if old in t:
        t = t.replace(old, new, 1)
for old, new in [
    ("`[????] id=${id}?????????`", "`[\u56fe\u7247\u7f3a\u5931] id=${id}\uff08\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f\uff09`"),
]:
    if old in t:
        t = t.replace(old, new, 1)
t = t.replace("`[????]\\n${desc.trim()}`", "`[\u56fe\u7247\u5185\u5bb9]\\n${desc.trim()}`")
t = t.replace("`[??????] id=${id}`", "`[\u56fe\u7247\u8f6c\u5f55\u4e3a\u7a7a] id=${id}`")
t = t.replace(
    "`[??????] ${e instanceof Error ? e.message : String(e)}`",
    "`[\u56fe\u7247\u8f6c\u5f55\u5931\u8d25] ${e instanceof Error ? e.message : String(e)}`",
)

# seal messages with only question marks
t = must_sub(
    r'message: "[?]{8,}"',
    'message: "\u9644\u4ef6\u5df2\u8fc7\u671f\u6216\u65e0\u6cd5\u8bc6\u522b\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\uff0c\u6216\u76f4\u63a5\u8f93\u5165\u95ee\u6570\u5185\u5bb9\u3002"',
    t,
    "attach_expire",
)
t = must_sub(
    r'return seal\(\{ status: "clarify", message: "[?]{8,}" \}\);',
    'return seal({ status: "clarify", message: "\u8bf7\u8f93\u5165\u95ee\u6570\u5185\u5bb9\uff0c\u6216\u9644\u5e26\u53ef\u8bc6\u522b\u7684\u6587\u672c/\u56fe\u7247\u3002" });',
    t,
    "empty_input",
)

# 澄清选择
t = must_sub(
    r'text: `\?{2,}\$\{parts\.join\("\?"\)\}`',
    'text: `\u6f84\u6e05\u9009\u62e9\uff1a${parts.join("\uff1b")}`',
    t,
    "slot_merge",
)

# time echo
t = t.replace(
    "`? ${structured.time.start}?${structured.time.end}`",
    "`\u6309 ${structured.time.start}\uff5e${structured.time.end}`",
)
t = t.replace(
    "`? ${probeRange.start}?${probeRange.end}`",
    "`\u6309 ${probeRange.start}\uff5e${probeRange.end}`",
)
t = t.replace(
    "echo: `? ${structured.time.start}?${structured.time.end}`",
    "echo: `\u6309 ${structured.time.start}\uff5e${structured.time.end}`",
)

# option hint + join
t = t.replace("`\\n?????${options", "`\\n\u5019\u9009\u793a\u4f8b\uff1a${options")
t = t.replace("`\n?????${options", "`\n\u5019\u9009\u793a\u4f8b\uff1a${options")
# join delimiter for options - careful only option joins
t = t.replace('.map((o) => o.label)\n              .join("?")', '.map((o) => o.label)\n              .join("\u3001")')

# contentLang deterministic message (ASCII islands preserved)
t = must_sub(
    r"message: `[?][^`]*te-IN[?][^`]*\$\{optionHint\}`",
    "message: `\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1\u7684\u5177\u4f53\u5185\u5bb9\u8bed\u8a00\u5217\u8868\uff08\u53ef\u591a\u9009\uff09\u3002\u8bf7\u76f4\u63a5\u5217\u51fa\u8bed\u8a00\u7801\uff08\u5982 te-IN\u3001ta-IN\uff09\u3002${optionHint}`",
    t,
    "contentLang_msg",
)

t = t.replace(
    'detail: "???????????? schema???/??/???"',
    'detail: "\u672a\u80fd\u4ece\u5bf9\u8bdd\u5f97\u5230\u5b8c\u6574\u7ed3\u6784\u5316 schema\uff08\u65f6\u95f4/\u6307\u6807/\u8fc7\u6ee4\uff09"',
)

t = must_sub(
    r"allEmpty\(results\)\s*\?\s*`[^`]+`\s*:\s*\"\"",
    'allEmpty(results)\n      ? `\uff08${range.echo} \u65e0\u6570\u636e\u884c\uff1b\u8bf7\u786e\u8ba4\u5e74\u4efd\u6216\u7b5b\u9009\u6761\u4ef6\uff09`\n      : ""',
    t,
    "empty_note",
)

t = t.replace(
    'title: sqls.length > 1 ? `?? ${i + 1}` : "??"',
    'title: sqls.length > 1 ? `\u67e5\u8be2 ${i + 1}` : "\u7ed3\u679c"',
)
t = t.replace(
    'message: "???", error: "aborted"',
    'message: "\u5df2\u53d6\u6d88", error: "aborted"',
)

t = must_sub(
    r"return `[^`]*\$\{input\.stage\}[^`]*\$\{input\.detail\}[^`]*`;",
    "return `\u5f53\u524d\u65e0\u6cd5\u5b8c\u6210\u95ee\u6570\uff08${input.stage}\uff09\uff1a${input.detail}\u3002\u8bf7\u8865\u5145\u66f4\u660e\u786e\u7684\u65f6\u95f4\u3001\u6e20\u9053\u3001\u6307\u6807\u6216\u7b5b\u9009\u6761\u4ef6\u540e\u518d\u8bd5\u3002`;",
    t,
    "diagnose_fallback",
)

p.write_text(t, encoding="utf-8", newline="\n")
print("OK ask_lang", "\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1" in t)
print("OK time", "\u6309 ${" in t)
print("??? left", t.count("???"))
