from pathlib import Path
t = Path(r"d:/Code/bx-admin-agent/apps/agent-server/src/analytics/pipeline.ts").read_text(encoding="utf-8")
Path(r"d:/Code/bx-admin-agent/apps/agent-server/.tmp-zh-check.txt").write_text(
    "\n".join(
        [
            f"ask_lang={('\u8bf7\u786e\u8ba4\u8981\u7edf\u8ba1' in t)}",
            f"time_echo={('\u6309 ${structured.time.start}' in t)}",
            f"qqq={t.count('???')}",
            f"empty_input={('\u8bf7\u8f93\u5165\u95ee\u6570' in t)}",
        ]
    ),
    encoding="utf-8",
)
