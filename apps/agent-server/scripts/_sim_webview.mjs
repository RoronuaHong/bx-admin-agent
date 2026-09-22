const OWNER = "253fdd3a-7891-45fd-997c-3b5d1277421b";
const TARGET = "conv_1789958040402_k0l0kz";
const base = process.env.WEB_ORIGIN || "http://localhost:8787";

const res = await fetch(`${base}/chat/conversations?owner=${OWNER}`, {
  headers: { "Content-Type": "application/json" },
});
console.log("HTTP", res.status);
const j = await res.json();
console.log("列表总数:", j.conversations?.length);
const c = (j.conversations || []).find((x) => x.id === TARGET);
console.log("找到目标会话:", !!c);
if (c) {
  const m = c.messages || [];
  const withCharts = m.filter((x) => (x.charts && x.charts.length) || x.chart);
  console.log("消息数:", m.length, "含图表消息:", withCharts.length);
} else {
  console.log("列表中的会话 id 样本:", (j.conversations || []).slice(0, 5).map((x) => x.id));
}
