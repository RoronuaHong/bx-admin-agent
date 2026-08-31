<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, toRaw } from "vue";
import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ChartView } from "../types";

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps<{ chart: ChartView }>();
const elRef = ref<HTMLDivElement | null>(null);
/** 勿命名为 chart：会与 prop 同名导致模板绑错 */
let chartInst: echarts.ECharts | null = null;
let resizing = false;

/** 与 PC `components2/chartOptions.js` 一致 */
const PC_X_AXIS = {
  type: "category" as const,
  splitLine: {
    show: true,
    lineStyle: {
      width: 1,
      type: "solid" as const,
      color: "rgba(226,226,226,0.5)",
    },
  },
  axisLabel: {
    color: "#666",
    fontSize: 12,
    formatter(v: string) {
      const reg = /(\d{4})-(\d{2})-(\d{2})至(\d{4})-(\d{2})-(\d{2})/;
      if (typeof v === "string" && v.match(reg)) {
        return v.replace(reg, "$2-$3至$5-$6");
      }
      return v;
    },
  },
  axisTick: { show: false },
  axisLine: { lineStyle: { color: "#d9d9d9" } },
};

const PC_GRID = { left: 34, right: 46, top: 40, bottom: 10, containLabel: true };

function buildOption() {
  const raw = toRaw(props.chart);
  const categories = [...(raw.categories || [])];
  const seriesIn = Array.isArray(raw.series) ? raw.series : [];

  const selected: Record<string, boolean> = {};
  for (const s of seriesIn) selected[s.name] = s.selected ?? false;
  if (!Object.values(selected).some(Boolean) && seriesIn[0]) {
    selected[seriesIn[0].name] = true;
  }

  return {
    // 与 PC Analysis.vue 一致：报表图画布白底
    backgroundColor: "#fff",
    animation: true,
    // 标题放在画布外，图例 top:6 与 PC 对齐
    legend: {
      left: 30,
      top: 6,
      data: seriesIn.map((s) => s.name),
      selected,
      textStyle: { color: "#333", fontSize: 12 },
      formatter(name: string) {
        return name.indexOf("：") > -1 ? name.slice(0, name.indexOf("：")) : name;
      },
      tooltip: { show: true },
    },
    tooltip: {
      trigger: "axis" as const,
      axisPointer: {
        type: "line" as const,
        lineStyle: { width: 1, color: "#019680" },
      },
      extraCssText: "white-space:pre-wrap",
      formatter(params: unknown) {
        const list = Array.isArray(params) ? params : [];
        if (!list.length) return "";
        const first = list[0] as { axisValue?: string };
        let html = `<div style="padding:2px 4px"><p style="margin:0 0 6px;font-weight:600">${first.axisValue || ""}</p>`;
        for (const p of list) {
          const item = p as { marker?: string; seriesName?: string; value?: number };
          let name = item.seriesName || "";
          if (name.indexOf("：") > -1) name = name.slice(0, name.indexOf("："));
          let val: string | number = item.value ?? "";
          // 通用展示层格式化：百分比列补 % 号（PC Analysis.vue 同款启发式），其余原样
          if (name.includes("占比") || name.includes("率")) val = `${val}%`;
          html += `<div style="display:flex;align-items:center;gap:4px;margin:2px 0">`;
          html += `<span>${item.marker || ""}</span>`;
          html += `<span style="padding:0 16px 0 4px">${name}</span>`;
          html += `<span style="margin-left:auto;font-weight:600">${val}</span>`;
          html += `</div>`;
        }
        html += `</div>`;
        return html;
      },
    },
    grid: { ...PC_GRID },
    xAxis: {
      ...PC_X_AXIS,
      data: categories,
    },
    yAxis: [
      {
        type: "value" as const,
        splitNumber: 4,
        axisTick: { show: false },
        scale: true,
        splitArea: { show: true, areaStyle: {} },
        axisLine: { show: false },
        axisLabel: { color: "#666", fontSize: 12 },
        splitLine: { lineStyle: { color: "rgba(226,226,226,0.5)" } },
      },
    ],
    // 拷贝 data，避免改写响应式数组；配色走 ECharts 默认（与 PC 一致）
    series: seriesIn.map((s) => ({
      name: s.name,
      type: (s.type || "line") as "line" | "bar",
      smooth: true,
      data: [...(s.data || [])].map((n) => Number(n) || 0),
      showSymbol: true,
      symbolSize: 4,
      itemStyle: {},
    })),
  };
}

function render() {
  if (!elRef.value || !props.chart?.categories?.length) return;
  if (!chartInst) chartInst = echarts.init(elRef.value, undefined, { renderer: "canvas" });
  chartInst.setOption(buildOption(), true);
  safeResize();
}

function safeResize() {
  if (!chartInst || !elRef.value || resizing) return;
  const { clientWidth, clientHeight } = elRef.value;
  if (clientWidth < 8 || clientHeight < 8) return;
  resizing = true;
  try {
    chartInst.resize();
  } finally {
    requestAnimationFrame(() => {
      resizing = false;
    });
  }
}

onMounted(() => {
  nextTick(() => {
    render();
    window.addEventListener("resize", safeResize);
  });
});

onUnmounted(() => {
  window.removeEventListener("resize", safeResize);
  chartInst?.dispose();
  chartInst = null;
});

watch(
  () => [
    props.chart.title,
    props.chart.categories?.join("|"),
    props.chart.series?.map((s) => `${s.name}:${s.data?.join(",")}`).join(";"),
  ],
  () => nextTick(render),
);
</script>

<template>
  <!-- 外层对齐 PC dataReport-chart：白底画布，高度默认 280 -->
  <div class="result-chart pc-analysis">
    <div v-if="chart.title" class="chart-caption">{{ chart.title }}</div>
    <div
      ref="elRef"
      class="chart-canvas"
      :style="{ height: (chart.height || 280) + 'px', width: '100%' }"
      role="img"
      :aria-label="chart.title"
    />
  </div>
</template>

<style scoped>
.result-chart.pc-analysis {
  margin-top: 10px;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 2px;
  overflow: hidden;
}
.chart-caption {
  padding: 8px 12px 0;
  font-size: 13px;
  font-weight: 600;
  color: #333;
  line-height: 1.4;
}
.chart-canvas {
  width: 100%;
  min-height: 200px;
  background: #fff;
}
</style>
