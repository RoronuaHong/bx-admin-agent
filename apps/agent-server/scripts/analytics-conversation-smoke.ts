import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";

const ORIG =
  "按观看日期和渠道分组，统计 IndiaA 渠道在 2026-08-19 至 2026-08-25、指定影片类型为电影，电视剧，真人秀，短剧，动漫，肥皂剧，四种内容语言的人均观看时长";

const messages = [
  { role: "user" as const, text: ORIG },
  {
    role: "assistant" as const,
    text: "请确认要筛选的具体语言列表（可多选或直接列出取值）。",
  },
  { role: "user" as const, text: "ta-IN、te-IN、ml-IN" },
  {
    role: "assistant" as const,
    text: "请确认要筛选的具体影片类型列表。",
  },
  { role: "user" as const, text: "电影，电视剧，真人秀，短剧，动漫，肥皂剧" },
];

const r = await analyticsAsk("电影，电视剧，真人秀，短剧，动漫，肥皂剧", {
  clock: new Date("2026-09-11T12:00:00+08:00"),
  messages,
});

console.log(
  JSON.stringify(
    {
      status: r.status,
      clarifySlot: r.clarifySlot,
      message: r.message?.slice(0, 200),
      sqlSource: r.sqlSource,
      cols: r.tables?.[0]?.cols,
      rowCount: r.tables?.[0]?.rows?.length,
      sqlPreview: r.sqls?.[0]?.slice(0, 700),
      askedDate: /日期范围/.test(r.message || ""),
      hasIndiaA: /IndiaA/.test(r.sqls?.[0] || ""),
      hasAvg: /avg_watch_second|watchSecond/.test(r.sqls?.[0] || ""),
      hasUniqOnly: /^\s*uniq\(/m.test(r.sqls?.[0] || "") && !/sum\(watchSecond\)/.test(r.sqls?.[0] || ""),
    },
    null,
    2,
  ),
);

// 期望：不应再无故要日期；理想 ok+compile，或 clarify 缺第4语言/布局
if (r.status === "clarify" && r.clarifySlot === "time_range") process.exitCode = 1;
if (r.status === "ok" && !/IndiaA/.test(r.sqls?.[0] || "")) process.exitCode = 1;
