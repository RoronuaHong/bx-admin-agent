import { repairTables as r } from "../src/md-tables.js";
import MarkdownIt from "markdown-it";
const m = new MarkdownIt({ html: true, breaks: true });
const fence = "```";
const cases = [
  ["正常表格", "| a | b | c |\n|---|---|---|\n|1|2|3|"],
  ["带对齐", "| a | b |\n|:--|--:|\n|1|2|"],
  ["居中对齐", "| a | b |\n|:-:|:-:|\n|1|2|"],
  ["少列分隔行", "| a | b | c | d | e |\n|--|--|\n|1|2|3|4|5|"],
  ["少列且带对齐", "| a | b | c |\n|:--|--:|\n|1|2|3|"],
  ["分隔行粘数据", "| a | b | c | d |\n|----------|-------|78.59 | 73.87 | 78.09 |\n| x | 1 | 2 | 3 |"],
  ["无首尾管道", "a | b | c\n--|---|--\n1 | 2 | 3"],
  ["围栏内", fence + "\n| a | b | c |\n|--|--|\n" + fence],
  ["纯文本", "hello world\nsecond line"],
  ["非分隔行", "| note | value |\n| --- something |"],
];
for (const [name, s] of cases) {
  const out = r(s);
  console.log(name.padEnd(12), "table:", m.render(out).includes("<table>"), "unchanged:", out === s);
}
