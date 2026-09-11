# -*- coding: utf-8 -*-
"""Restore Chinese strings in pipeline.ts that were corrupted to '?'."""
from pathlib import Path

path = Path(r"d:/Code/bx-admin-agent/apps/agent-server/src/analytics/pipeline.ts")
text = path.read_text(encoding="utf-8")

# If file is already good, skip
if "请确认要统计的具体内容语言列表" in text:
    print("already ok")
    raise SystemExit(0)

# Rebuild from a known-good UTF-8 source written by this script entirely
# Use the version we intend — write full file via Python only.
src = Path(r"d:/Code/bx-admin-agent/apps/agent-server/scripts/_pipeline_utf8_body.ts")
if not src.exists():
    raise SystemExit("missing body file — create it first")
path.write_text(src.read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
print("restored from", src)
