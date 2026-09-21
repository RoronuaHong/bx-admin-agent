<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { GRAPH_CHART_TYPES } from "@bx/shared";

const props = defineProps<{
  title?: string;
  chartType: string;
  data: unknown;
  encode?: Record<string, string>;
  options?: Record<string, unknown>;
}>();

const el = ref<HTMLDivElement | null>(null);
const errMsg = ref<string | null>(null);
let instance: any = null;
let destroyed = false;
let themeObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
/** 渲染令牌：动态 import 是异步的，await 期间可能被卸载或被下一次 render 抢入。 */
let renderToken = 0;

/** 图形类走 G6（其余走 G2）：清单取自 @bx/shared，与服务端工具白名单同源，避免两端漂移。 */
const GRAPH_TYPES = new Set<string>(GRAPH_CHART_TYPES);

/** 读屏软件读到的图表名称（canvas 内容对辅助技术不可见，只能靠这个标签说明这是什么图）。
 *  有标题就直接用标题（配合 role="img" 会读成「图像：<标题>」），没标题才退回图型名。 */
const chartAriaLabel = computed(() =>
  props.title ? props.title : `${props.chartType} 图表（浏览器本地渲染）`,
);

function isDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function dispose() {
  if (instance && typeof instance.destroy === "function") {
    try {
      instance.destroy();
    } catch {
      /* ignore */
    }
  }
  instance = null;
}

async function render() {
  if (!el.value || destroyed) return;
  const token = ++renderToken;
  errMsg.value = null;
  dispose();
  // 捕获当前节点：await 之后 el.value 可能已变（重绘）或已卸载。
  const box = el.value;
  box.innerHTML = "";
  const type = (props.chartType || "").toLowerCase();
  const encode = props.encode || {};
  const options = props.options || {};
  // 本次渲染是否已作废（卸载 / 被下一次 render 抢入）。
  const stale = () => destroyed || token !== renderToken || !el.value;
  // 本次 render 自己创建的实例：作废/失败时只销毁它——instance 此时可能已被更新的渲染接管，
  // 直接调 dispose() 会误销别人的图。
  let mine: any = null;
  const discardMine = () => {
    if (!mine) return;
    try {
      mine.destroy?.();
    } catch {
      /* ignore */
    }
    if (instance === mine) instance = null;
    mine = null;
  };

  try {
    if (GRAPH_TYPES.has(type)) {
      const mod: any = await import("@antv/g6");
      if (stale()) return;
      const Graph = mod.Graph || mod.default?.Graph || mod.default;
      const graph = new Graph({
        container: box,
        autoFit: "view",
        theme: isDark() ? "dark" : "light",
        ...buildGraphData(props.data),
        layout: graphLayout(type),
        node: { style: { labelText: (d: any) => d.label ?? d.id, size: 26, fill: isDark() ? "#3a5bbf" : "#5B8FF9" } },
        edge: { style: { labelText: (d: any) => d.label ?? "", endArrow: true } },
      });
      instance = graph;
      mine = graph;
      await graph.render();
      if (stale()) {
        discardMine();
        return;
      }
    } else {
      const mod: any = await import("@antv/g2");
      if (stale()) return;
      const Chart = mod.Chart || mod.default?.Chart || mod.default;
      const chart = new Chart({
        container: box,
        autoFit: true,
        // 高度随容器（CSS 定高），不要写死：写死会让画布高于容器、底部被裁。
        height: box.clientHeight || 360,
        theme: isDark() ? "classicDark" : "classic",
      });
      buildG2(chart, type, props.data as any[], encode, options);
      instance = chart;
      mine = chart;
      // 必须 await：G2 的 render() 返回 Promise，渲染期抛错（数据字段对不上、scale 配置非法等）
      // 只会在 Promise 里拒绝——不 await 就绕过下面的 catch，既不出降级表格、又留下未处理拒绝。
      await chart.render();
      if (stale()) {
        discardMine();
        return;
      }
    }
  } catch (e: any) {
    // 半成品实例也要收尾：接管本次渲染的那次 dispose() 发生在本实例赋值**之前**，
    // 不在这里销毁就等于泄漏一个还在监听容器的实例。
    discardMine();
    if (stale()) return;
    // 降级：渲染失败（如依赖未安装 / 数据格式不符）时，用表格展示原始数据，避免整页崩溃。
    errMsg.value = `图表渲染失败：${e?.message || e}`;
    renderFallback(box, props.data);
  }
}

function graphLayout(type: string): any {
  if (type === "sankey") return { type: "sankey" };
  if (type === "mind_map" || type === "org_chart")
    return {
      type: "compact-box",
      direction: "LR",
      getHeight: () => 32,
      getWidth: () => 120,
      getVGap: () => 10,
      getHGap: () => 60,
    };
  return { type: "force", linkDistance: 120, preventOverlap: true };
}

function buildGraphData(data: any): { data: any } {
  // 只给 nodes（无 edges）也算合法：模型常只给节点，缺连线不该把整块降级成表格。
  if (data && Array.isArray(data.nodes)) {
    return {
      data: {
        nodes: (data.nodes as any[]).map((n) => ({ id: String(n.id ?? n.name), label: n.label ?? n.name, raw: n })),
        edges: (Array.isArray(data.edges) ? data.edges : []).map((e: any) => ({
          source: String(e.source),
          target: String(e.target),
          label: e.label ?? "",
          raw: e,
        })),
      },
    };
  }
  // 层级结构：根节点 name/id 任一存在即可（label 兜底），但 children 必须是数组。
  if (data && (data.name || data.id) && Array.isArray(data.children)) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const walk = (node: any, parentId: string | null) => {
      const id = String(node.id ?? node.name);
      nodes.push({ id, label: node.label ?? node.name ?? id, raw: node });
      if (parentId) edges.push({ source: parentId, target: id });
      (Array.isArray(node.children) ? node.children : []).forEach((c: any) => walk(c, id));
    };
    walk(data, null);
    return { data: { nodes, edges } };
  }
  throw new Error("图形数据需为 {nodes,edges} 或 {name,children}");
}

function buildG2(chart: any, type: string, data: any[], encode: Record<string, string>, options: Record<string, unknown>) {
  const x = encode.x;
  const y = encode.y || "value";
  const color = encode.color || encode.x;
  const series = encode.series;
  const xTitle = (options.xTitle as string) || x || "";
  const yTitle = (options.yTitle as string) || y || "";
  const y1 = (encode.y1 as string) || "y1";

  switch (type) {
    case "pie":
      chart
        .interval()
        .data(data)
        .transform({ type: "stackY" })
        .encode("y", y)
        .encode("color", color || "name")
        .coordinate({ type: "theta" })
        .legend("color", { position: "bottom" })
        .tooltip({ channel: "y", valueFormatter: "~s" });
      break;
    case "bar":
      chart
        .interval()
        .data(data)
        .encode("x", x)
        .encode("y", y)
        .encode("color", color)
        .coordinate({ type: "transpose" })
        .axis("x", { title: xTitle })
        .axis("y", { title: yTitle });
      break;
    case "column":
      chart
        .interval()
        .data(data)
        .encode("x", x)
        .encode("y", y)
        .encode("color", color)
        .axis("x", { title: xTitle })
        .axis("y", { title: yTitle });
      break;
    case "line":
    case "area": {
      const mark = type === "area" ? chart.area() : chart.line();
      mark.data(data).encode("x", x).encode("y", y);
      if (series) mark.encode("color", series);
      mark.axis("x", { title: xTitle }).axis("y", { title: yTitle });
      break;
    }
    case "scatter":
      chart.point().data(data).encode("x", x).encode("y", y);
      if (color) chart.encode("color", color);
      break;
    case "radar":
      chart
        .line()
        .data(data)
        .coordinate({ type: "radar" })
        .encode("x", x)
        .encode("y", y);
      if (series) chart.encode("color", series);
      chart
        .area()
        .data(data)
        .coordinate({ type: "radar" })
        .encode("x", x)
        .encode("y", y)
        .encode("color", series || x);
      break;
    case "treemap":
      chart.treemap().data(data).encode("value", y).encode("color", color || x);
      break;
    case "funnel":
      chart.funnel().data(data).encode("x", x).encode("y", y);
      break;
    case "boxplot":
      chart.boxplot().data(data).encode("x", x).encode("y", y);
      break;
    case "histogram":
      chart
        .rect()
        .data(data)
        .transform({ type: "binX", y: "count", thresholds: (options.bins as number) || 20 })
        .encode("x", x)
        .encode("y", "count");
      break;
    case "waterfall":
      chart
        .interval()
        .data(data)
        .transform({ type: "symmetryY" })
        .encode("x", x)
        .encode("y", y);
      break;
    case "dual_axes":
      chart.interval().data(data).encode("x", x).encode("y", y).axis("y", { title: yTitle });
      chart
        .line()
        .data(data)
        .encode("x", x)
        .encode("y", y1)
        .scale("y", { independent: true })
        .axis("y", { position: "right", title: (options.y1Title as string) || y1 });
      break;
    default:
      chart.interval().data(data).encode("x", x).encode("y", y).encode("color", color);
  }
}

function renderFallback(container: HTMLElement, data: unknown) {
  const table = document.createElement("div");
  table.className = "chart-fallback";
  if (Array.isArray(data) && data.length) {
    const cols = Array.from(new Set(data.flatMap((r) => (r && typeof r === "object" ? Object.keys(r as object) : [])))).slice(
      0,
      12,
    );
    const rows = data.slice(0, 50);
    let html = '<table class="chart-fallback__table"><thead><tr>';
    html += cols.map((c) => `<th>${escapeHtml(String(c))}</th>`).join("");
    html += "</tr></thead><tbody>";
    html += rows
      .map((r) => {
        const o = (r || {}) as Record<string, unknown>;
        return "<tr>" + cols.map((c) => `<td>${escapeHtml(String(o[c] ?? ""))}</td>`).join("") + "</tr>";
      })
      .join("");
    html += "</tbody></table>";
    table.innerHTML = html;
  } else {
    table.textContent = JSON.stringify(data, null, 2);
  }
  container.appendChild(table);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

onMounted(() => {
  render();
  // 主题切换时重绘（G2/G6 主题在创建时设定，需销毁重建）。
  themeObserver = new MutationObserver(() => {
    if (instance) render();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  // 容器尺寸变化（窗口缩放、侧栏折叠、气泡宽度变化）时重适配：G2/G6 只在创建时按容器尺寸定画布，
  // 之后不跟随容器变化，不重适配会把图永久留在首次测量的尺寸上。
  if (el.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (destroyed || !instance) return;
      // G2 的 forceFit() 也是 Promise：外层 try/catch 只能兜住同步抛错，
      // 异步拒绝要显式 catch，否则每次窗口缩放失败都会冒一个未处理拒绝。
      try {
        if (typeof instance.forceFit === "function") void Promise.resolve(instance.forceFit()).catch(() => undefined);
        else if (typeof instance.resize === "function") instance.resize();
      } catch {
        /* 忽略：重适配失败不影响已有画面 */
      }
    });
    resizeObserver.observe(el.value);
  }
});

watch(
  () => [props.chartType, props.data, props.encode, props.options, props.title],
  () => render(),
  { deep: true },
);

onBeforeUnmount(() => {
  destroyed = true;
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
  dispose();
});
</script>

<template>
  <div class="chart-card">
    <div v-if="title" class="chart-card__title">{{ title }}</div>
    <!-- canvas 对读屏软件是不可见内容：标成一张图并给出可读名称，否则整块被跳过。 -->
    <div ref="el" class="chart-card__canvas" role="img" :aria-label="chartAriaLabel"></div>
    <div v-if="errMsg" class="chart-card__err">{{ errMsg }}</div>
  </div>
</template>

<style scoped>
.chart-card {
  margin: 10px 0;
  padding: 12px 14px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  background: var(--surface, #fff);
  /* 宽度跟随宿主容器（.bubble-wrap.has-chart 已给出确定宽度与上限）。
     另留一个 min-width 兜底：宿主若没给出确定宽度，canvas 的固有尺寸会把容器反向钳成窄条（实测 159px）。 */
  width: 100%;
  min-width: 280px;
  max-width: 100%;
}
.chart-card__title {
  font-weight: 600;
  margin-bottom: 8px;
  font-size: 14px;
}
.chart-card__canvas {
  /* 绘图区给确定高度（min-height 之外再定 height），保证 G2/G6 拿到非零尺寸的容器。 */
  height: 300px;
  min-height: 120px;
}
.chart-card__err {
  margin-top: 8px;
  font-size: 12px;
  color: #b91c1c;
}
.chart-fallback {
  max-height: 320px;
  overflow: auto;
}
.chart-fallback__table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
.chart-fallback__table th,
.chart-fallback__table td {
  border: 1px solid var(--border, #e5e7eb);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
}
</style>
