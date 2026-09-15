<script setup lang="ts">
/**
 * 巡检报告分享页（匿名只读）。
 *
 * 钉钉自定义机器人 text 消息无法内嵌图片，故告警文案改为附一条可点击链接指向本页：
 * 打开即看到「预警 + 趋势对比 + 渠道明细表 + 来源条深链」，人类可读、可分享。
 * 数据源：GET /agent/analytics/report/:token（token 即访问凭证）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface ScanReportRow {
  entityKey: string;
  scanValue: number | null;
  dodValue: number | null;
  wowValue: number | null;
}

interface ScanReport {
  kind: "scan";
  scanDate: string;
  metric: string;
  from: string;
  to: string;
  queryText: string;
  severity: "warn" | "critical" | "info" | null;
  parentMessage: string;
  children: string[];
  rows: ScanReportRow[];
  createdAt: number;
}

const route = useRoute();
const token = String(route.params.token || "");

const loading = ref(true);
const error = ref("");
const report = ref<ScanReport | null>(null);
const trendRef = ref<HTMLDivElement | null>(null);
const breakdownRef = ref<HTMLDivElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let breakdownChart: echarts.ECharts | null = null;

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtInt(v: number | null | undefined): string {
  const n = num(v);
  return n == null ? "—" : n.toLocaleString();
}

function pct(cur: number | null | undefined, base: number | null | undefined): number | null {
  const c = num(cur);
  const b = num(base);
  if (c == null || b == null || b === 0) return null;
  return ((c - b) / b) * 100;
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function deltaClass(v: number | null): string {
  if (v == null || v === 0) return "";
  return v < 0 ? "down" : "up";
}

const sortedRows = computed(() => {
  const rows = report.value?.rows ?? [];
  return [...rows].sort((a, b) => (num(b.scanValue) ?? 0) - (num(a.scanValue) ?? 0));
});

/** 阈值异常归属：告警细分文案里提到该渠道即视为异常（不写死阈值）。 */
function isAnomaly(key: string): boolean {
  const children = report.value?.children ?? [];
  return children.some((m) => m.includes(key));
}

const anomalyCount = computed(() => sortedRows.value.filter((r) => isAnomaly(r.entityKey)).length);

const totalWatchers = computed(() =>
  sortedRows.value.reduce((sum, r) => sum + (num(r.scanValue) ?? 0), 0),
);

const worstDrop = computed(() => {
  let worst: number | null = null;
  for (const r of sortedRows.value) {
    const d = pct(r.scanValue, r.dodValue);
    if (d != null && (worst == null || d < worst)) worst = d;
  }
  return worst;
});

const severityLabel = computed(() => {
  const s = report.value?.severity;
  if (s === "critical") return "严重";
  if (s === "warn") return "预警";
  return "正常";
});

const severityClass = computed(() => {
  const s = report.value?.severity;
  if (s === "critical") return "sev-critical";
  if (s === "warn") return "sev-warn";
  return "sev-ok";
});

const generatedAt = computed(() => {
  const t = report.value?.createdAt;
  return t ? new Date(t).toLocaleString() : "";
});

/** 深链：回到问数，带上同一时间窗与问题，用于核对来源条 / 继续下钻。 */
const sourceLink = computed(() => {
  const r = report.value;
  if (!r) return "/analytics";
  const p = new URLSearchParams({ from: r.from, to: r.to });
  if (r.queryText) p.set("q", r.queryText);
  return `/analytics?${p.toString()}`;
});

// ---- 下载 / 复制 ----
const excelUrl = computed(() => `/agent/analytics/report/${encodeURIComponent(token)}/export.xlsx`);
const pngUrl = computed(() => `/agent/analytics/report/${encodeURIComponent(token)}/image.png`);
const pdfUrl = computed(() => `/agent/analytics/report/${encodeURIComponent(token)}/report.pdf`);

const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

function flashCopied(text: string): void {
  copied.value = text;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = "";
  }, 2000);
}

/**
 * 剪贴板写入：优先 async clipboard（仅安全上下文可用），
 * 报告页常以 http://内网IP 打开（非安全上下文）→ 退回 textarea + execCommand。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallthrough 到 execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 表格 TSV：粘进 Excel/WPS 自动分列（与页面同口径：渠道 / 数值 / DoD / WoW / 状态）。 */
const tableTsv = computed(() => {
  const head = ["渠道", "当日", "昨日", "上周同期", "DoD", "WoW", "状态"].join("\t");
  const lines = sortedRows.value.map((row) =>
    [
      row.entityKey,
      row.scanValue ?? "",
      row.dodValue ?? "",
      row.wowValue ?? "",
      fmtPct(pct(row.scanValue, row.dodValue)),
      fmtPct(pct(row.scanValue, row.wowValue)),
      isAnomaly(row.entityKey) ? "异常" : "正常",
    ].join("\t"),
  );
  return [head, ...lines].join("\n");
});

async function copyTable(): Promise<void> {
  const ok = await copyText(tableTsv.value);
  flashCopied(ok ? "表格已复制，可直接粘贴到 Excel" : "复制失败，请手动选择表格复制");
}

async function copyLink(): Promise<void> {
  const ok = await copyText(window.location.href);
  flashCopied(ok ? "链接已复制" : "复制失败");
}

/**
 * 下载走 fetch+blob 而非裸 <a href>：端点失败时（如服务端没配渲染浏览器 → 503），
 * 裸链接会把错误 JSON 存成 .xlsx 文件；这里失败时给出明确提示。
 */
async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      flashCopied(`下载失败（${res.status}）：报告渲染不可用，请稍后再试`);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    flashCopied(`已开始下载 ${filename}`);
  } catch {
    flashCopied("下载失败，请检查网络后重试");
  }
}

function downloadExcel(): void {
  void downloadFile(excelUrl.value, `巡检报告-${report.value?.scanDate ?? "未知日期"}.xlsx`);
}

function downloadPng(): void {
  void downloadFile(pngUrl.value, `巡检报告-${report.value?.scanDate ?? "未知日期"}.png`);
}

function downloadPdf(): void {
  void downloadFile(pdfUrl.value, `巡检报告-${report.value?.scanDate ?? "未知日期"}.pdf`);
}

/** 单行复制文本：带字段标签，粘到聊天/文档里没有表头也能看懂。 */
function rowText(row: ScanReportRow): string {
  return [
    row.entityKey,
    `当日 ${fmtInt(row.scanValue)}`,
    `昨日 ${fmtInt(row.dodValue)}`,
    `上周同期 ${fmtInt(row.wowValue)}`,
    `DoD ${fmtPct(pct(row.scanValue, row.dodValue))}`,
    `WoW ${fmtPct(pct(row.scanValue, row.wowValue))}`,
    isAnomaly(row.entityKey) ? "异常" : "正常",
  ].join(" · ");
}

async function copyRow(row: ScanReportRow): Promise<void> {
  const ok = await copyText(rowText(row));
  flashCopied(ok ? `已复制 ${row.entityKey}` : "复制失败");
}

const breakdownHeight = computed(() => Math.max(260, sortedRows.value.length * 26 + 40));

function renderCharts(): void {
  const rows = sortedRows.value;
  if (!rows.length) return;
  const top = rows.slice(0, 12);

  if (trendRef.value) {
    if (!trendChart) trendChart = echarts.init(trendRef.value, undefined, { renderer: "canvas" });
    trendChart.setOption(
      {
        backgroundColor: "#fff",
        tooltip: { trigger: "axis" },
        legend: { top: 4, textStyle: { color: "#333", fontSize: 12 } },
        grid: { left: 8, right: 16, top: 42, bottom: 8, containLabel: true },
        xAxis: {
          type: "category",
          data: top.map((r) => r.entityKey),
          axisLabel: { color: "#666", fontSize: 11, rotate: top.length > 8 ? 30 : 0 },
          axisTick: { show: false },
          axisLine: { lineStyle: { color: "#d9d9d9" } },
        },
        yAxis: {
          type: "value",
          axisLabel: { color: "#666", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(226,226,226,0.6)" } },
        },
        series: [
          { name: "当日", type: "bar", data: top.map((r) => num(r.scanValue) ?? 0) },
          { name: "昨日", type: "bar", data: top.map((r) => num(r.dodValue) ?? 0) },
          { name: "上周同期", type: "bar", data: top.map((r) => num(r.wowValue) ?? 0) },
        ],
      },
      true,
    );
    trendChart.resize();
  }

  if (breakdownRef.value) {
    const ordered = [...rows].reverse();
    if (!breakdownChart) breakdownChart = echarts.init(breakdownRef.value, undefined, { renderer: "canvas" });
    breakdownChart.setOption(
      {
        backgroundColor: "#fff",
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { left: 8, right: 48, top: 16, bottom: 8, containLabel: true },
        xAxis: {
          type: "value",
          axisLabel: { color: "#666", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(226,226,226,0.6)" } },
        },
        yAxis: {
          type: "category",
          data: ordered.map((r) => r.entityKey),
          axisLabel: { color: "#666", fontSize: 11 },
          axisTick: { show: false },
        },
        series: [
          {
            name: "当日观看人数",
            type: "bar",
            data: ordered.map((r) => num(r.scanValue) ?? 0),
            itemStyle: { color: "#019680" },
          },
        ],
      },
      true,
    );
    breakdownChart.resize();
  }
}

function safeResize(): void {
  trendChart?.resize();
  breakdownChart?.resize();
}

onMounted(async () => {
  try {
    const res = await fetch(`/agent/analytics/report/${encodeURIComponent(token)}`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(String(res.status));
    report.value = (await res.json()) as ScanReport;
    document.title = `巡检报告 ${report.value.scanDate}`;
  } catch {
    error.value = "报告不存在、已过期，或链接不完整。";
  } finally {
    loading.value = false;
    await nextTick();
    renderCharts();
    window.addEventListener("resize", safeResize);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", safeResize);
  if (copiedTimer) clearTimeout(copiedTimer);
  trendChart?.dispose();
  breakdownChart?.dispose();
  trendChart = null;
  breakdownChart = null;
});
</script>

<template>
  <div class="report-page">
    <div class="report-shell">
      <div v-if="loading" class="state">加载中…</div>

      <div v-else-if="error" class="state state-error">
        <p>{{ error }}</p>
        <router-link class="link" to="/analytics">前往问数</router-link>
      </div>

      <template v-else-if="report">
        <header class="head">
          <div class="head-main">
            <h1>数据分析巡检报告</h1>
            <p class="head-sub">
              指标 {{ report.metric }} · 巡检日 {{ report.scanDate }}
              <span v-if="generatedAt"> · 生成于 {{ generatedAt }}</span>
            </p>
          </div>
          <span class="badge" :class="severityClass">{{ severityLabel }}</span>
        </header>

        <section class="actions">
          <button type="button" class="act" @click="copyTable">复制表格</button>
          <button type="button" class="act" @click="downloadExcel">下载 Excel</button>
          <button type="button" class="act" @click="downloadPdf">下载 PDF</button>
          <button type="button" class="act" @click="copyLink">复制链接</button>
          <span v-if="copied" class="copied">{{ copied }}</span>
        </section>

        <section class="banner" :class="severityClass">
          <p class="banner-title">{{ report.parentMessage }}</p>
          <ul v-if="report.children.length" class="banner-list">
            <li v-for="(child, i) in report.children" :key="i">{{ child }}</li>
          </ul>
        </section>

        <section class="kpis">
          <div class="kpi">
            <span class="kpi-label">渠道数</span>
            <span class="kpi-value">{{ sortedRows.length }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">异常渠道</span>
            <span class="kpi-value" :class="{ danger: anomalyCount > 0 }">{{ anomalyCount }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">当日总观看人数</span>
            <span class="kpi-value">{{ totalWatchers.toLocaleString() }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">最大降幅</span>
            <span class="kpi-value" :class="{ danger: (worstDrop ?? 0) < 0 }">{{ fmtPct(worstDrop) }}</span>
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">趋势对比（当日 vs 昨日 vs 上周同期）</h2>
          <div ref="trendRef" class="chart chart-trend" />
        </section>

        <section class="card">
          <h2 class="card-title">渠道当日观看人数</h2>
          <div ref="breakdownRef" class="chart" :style="{ height: breakdownHeight + 'px' }" />
        </section>

        <section class="card">
          <div class="card-head">
            <h2 class="card-title">渠道明细</h2>
            <button type="button" class="act act-sm" @click="copyTable">复制全部</button>
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>渠道</th>
                  <th class="num">当日</th>
                  <th class="num">昨日</th>
                  <th class="num">上周同期</th>
                  <th class="num">DoD</th>
                  <th class="num">WoW</th>
                  <th>状态</th>
                  <th class="op">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in sortedRows"
                  :key="row.entityKey"
                  :class="{ 'row-warn': isAnomaly(row.entityKey) }"
                >
                  <td class="key">{{ row.entityKey }}</td>
                  <td class="num">{{ fmtInt(row.scanValue) }}</td>
                  <td class="num">{{ fmtInt(row.dodValue) }}</td>
                  <td class="num">{{ fmtInt(row.wowValue) }}</td>
                  <td class="num" :class="deltaClass(pct(row.scanValue, row.dodValue))">
                    {{ fmtPct(pct(row.scanValue, row.dodValue)) }}
                  </td>
                  <td class="num" :class="deltaClass(pct(row.scanValue, row.wowValue))">
                    {{ fmtPct(pct(row.scanValue, row.wowValue)) }}
                  </td>
                  <td>
                    <span v-if="isAnomaly(row.entityKey)" class="tag tag-warn">异常</span>
                    <span v-else class="tag">正常</span>
                  </td>
                  <td class="op">
                    <button type="button" class="row-copy" @click="copyRow(row)">复制</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <footer class="foot">
          <p>报告为只读快照；如需下钻细分维度或核对来源条（SQL），可在对话中继续追问。</p>
          <router-link class="link" :to="sourceLink">在对话中核对来源条 →</router-link>
        </footer>
      </template>
    </div>
  </div>
</template>

<style scoped>
.report-page {
  min-height: 100vh;
  background: #f5f7fa;
  padding: 20px 16px 40px;
}
.report-shell {
  max-width: 960px;
  margin: 0 auto;
}
.state {
  padding: 60px 16px;
  text-align: center;
  color: #666;
  font-size: 14px;
}
.state-error p {
  margin-bottom: 12px;
}
.link {
  color: #019680;
  text-decoration: none;
  font-weight: 600;
}
.link:hover {
  text-decoration: underline;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.act {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid #d9dee5;
  border-radius: 6px;
  background: #fff;
  color: #1f2329;
  font-size: 13px;
  cursor: pointer;
  text-decoration: none;
}
.act:hover {
  border-color: #019680;
  color: #019680;
}
.copied {
  font-size: 12px;
  color: #389e0d;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.card-head .card-title {
  margin: 0;
}
.act-sm {
  padding: 4px 10px;
  font-size: 12px;
}
.tbl th.op,
.tbl td.op {
  text-align: right;
}
.row-copy {
  padding: 2px 8px;
  border: 1px solid #d9dee5;
  border-radius: 4px;
  background: #fff;
  color: #5a6470;
  font-size: 12px;
  cursor: pointer;
}
.row-copy:hover {
  border-color: #019680;
  color: #019680;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.head-main h1 {
  margin: 0;
  font-size: 20px;
  color: #1f2329;
  line-height: 1.3;
}
.head-sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #8a9099;
}
.badge {
  flex: none;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}
.badge.sev-critical {
  background: #d4380d;
}
.badge.sev-warn {
  background: #d46b08;
}
.badge.sev-ok {
  background: #389e0d;
}

.banner {
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 16px;
  border: 1px solid transparent;
}
.banner.sev-critical {
  background: #fff1f0;
  border-color: #ffccc7;
}
.banner.sev-warn {
  background: #fff7e6;
  border-color: #ffe0a3;
}
.banner.sev-ok {
  background: #f6ffed;
  border-color: #b7eb8f;
}
.banner-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #1f2329;
  line-height: 1.5;
}
.banner-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: #434343;
  line-height: 1.7;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.kpi {
  background: #fff;
  border: 1px solid #eef0f3;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kpi-label {
  font-size: 12px;
  color: #8a9099;
}
.kpi-value {
  font-size: 20px;
  font-weight: 700;
  color: #1f2329;
}
.kpi-value.danger {
  color: #d4380d;
}

.card {
  background: #fff;
  border: 1px solid #eef0f3;
  border-radius: 10px;
  padding: 14px 16px 18px;
  margin-bottom: 16px;
}
.card-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: #1f2329;
}
.chart {
  width: 100%;
}
.chart-trend {
  height: 320px;
}

.table-wrap {
  overflow-x: auto;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 640px;
}
.tbl th,
.tbl td {
  padding: 8px 10px;
  border-bottom: 1px solid #f0f0f0;
  text-align: left;
  white-space: nowrap;
}
/* 数值列显式深色：页面继承自外层壳的灰字会让数字几乎不可读 */
.tbl td {
  color: #1f2329;
}
.tbl th {
  color: #8a9099;
  font-weight: 500;
  background: #fafbfc;
}
.tbl td.num,
.tbl th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.tbl td.key {
  font-weight: 600;
  color: #1f2329;
}
.tbl td.up {
  color: #389e0d;
}
.tbl td.down {
  color: #d4380d;
}
.row-warn {
  background: #fff9f8;
}
.tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  color: #8a9099;
  background: #f2f3f5;
}
.tag-warn {
  color: #d4380d;
  background: #fff1f0;
}

.foot {
  padding: 4px 2px 0;
  font-size: 13px;
  color: #8a9099;
  line-height: 1.8;
}
.foot p {
  margin: 0 0 4px;
}

@media (max-width: 640px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .head-main h1 {
    font-size: 18px;
  }
}
</style>
