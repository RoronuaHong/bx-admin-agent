<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { G6_CHART_TYPES } from "@bx/shared";

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

/** 图形类走 G6（其余走 G2）：清单取自 @bx/shared，与服务端工具白名单同源，避免两端漂移。
 *  注意 sankey 不在这里——它的数据是 {nodes,edges}，但渲染走 G2 的 sankey mark。 */
const GRAPH_TYPES = new Set<string>(G6_CHART_TYPES);

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
  // 空数据：G2 只会画出一张空坐标系（连图例都没有），比明说「没有数据」更像渲染坏了。
  if (!GRAPH_TYPES.has(type) && Array.isArray(props.data) && props.data.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = "（图表无数据）";
    box.appendChild(empty);
    return;
  }
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

/* ---------------- 字段解析（统计图公共） ----------------
 * 同一语义在不同图型、不同模型里键名并不统一（序列字段可能写在 encode.series、encode.color
 * 或 options.seriesField；轴标题可能是 xTitle/xAxisTitle）。这里把「同一语义的多种写法」
 * 收敛成一条解析链：认得出就按用户意图画；认不出也不猜——宁可单色/无标注，
 * 也不画一张标注错误的图（错误标注比没有标注更误导）。 */

/** 取第一个非空字符串（模型可能给空串、null 或数字）。 */
function pickStr(...vals: unknown[]): string {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return "";
}

/** 纯英文标识符字段名（share、users_count）当轴标题没有可读性；含中文的列名则可直接用。 */
function looksOpaque(field: string): boolean {
  if (!field) return true;
  if (/[\u4e00-\u9fa5]/.test(field)) return false;
  return /^[A-Za-z_][\w .-]*$/.test(field);
}

/** 轴标题：模型显式给的中文标题优先；否则退回字段名——但字段名是纯英文标识符时隐藏（false）。 */
function axisTitle(explicit: string, field: string): string | false {
  if (explicit) return explicit;
  return looksOpaque(field) ? false : field;
}

/** 数值刻度格式：带单位（占比 %）时拼单位；否则大数走 k/M 缩写，保证刻度不被长数字挤爆。 */
function numberLabelFormatter(unit: string): (v: unknown) => string {
  return (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? "");
    if (unit) return `${n}${unit}`;
    const abs = Math.abs(n);
    const scaled = (div: number, suffix: string) => `${Number((n / div).toFixed(1))}${suffix}`;
    if (abs >= 1e9) return scaled(1e9, "B");
    if (abs >= 1e6) return scaled(1e6, "M");
    if (abs >= 1e4) return scaled(1e3, "k");
    return String(n);
  };
}

/** 行数组的键归一化：SQL 别名常带首尾空格（"users "），键不一致会让通道取不到值、线断成两截。
 *  非数组（图形类的 {nodes,edges} / 层级结构）原样返回，交给对应图型分支处理。 */
function normalizeRows(data: unknown): any {
  if (!Array.isArray(data)) return data;
  return data.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      const key = k.trim();
      if (!(key in out)) out[key] = v;
    }
    return out;
  });
}

/** 按分类合计：饼图/矩形树这类「一个分类一块」的图，同一分类多行（长表带分组）必须先合并，
 *  否则同色会出现多块、读数被拆散（A 显示成 30% 和 20% 两块而不是合计 50%）。
 *  值不是数字时退回第一行——不做静默吞并。 */
function aggregateBy(rows: any[], key: string, value: string): any[] {
  if (!key) return rows;
  const merged: any[] = [];
  const index = new Map<string, any>();
  for (const r of rows) {
    const k = String(r?.[key] ?? "");
    const n = Number(r?.[value]);
    const hit = index.get(k);
    if (!hit) {
      const copy = { ...r };
      if (Number.isFinite(n)) copy[value] = n;
      index.set(k, copy);
      merged.push(copy);
    } else if (Number.isFinite(n) && typeof hit[value] === "number") {
      hit[value] = Number((hit[value] + n).toFixed(6));
    }
  }
  return merged;
}

/** 折线/面积图必须先按 x 有序再连线：行序乱时 G2 按出现顺序连线，画成来回穿插的乱线。
 *  有分组字段时先按分组聚类（保持分组首次出现顺序），再在组内按 x 升序。 */
function sortSeriesRows(rows: any[], x: string, group: string): any[] {
  const cmpX = (a: any, b: any) => {
    const an = Number(a?.[x]);
    const bn = Number(b?.[x]);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return String(a?.[x] ?? "").localeCompare(String(b?.[x] ?? ""));
  };
  const copy = [...rows];
  if (!group) return copy.sort(cmpX);
  const seen = new Map<string, number>();
  for (const r of copy) {
    const g = String(r?.[group] ?? "");
    if (!seen.has(g)) seen.set(g, seen.size);
  }
  return copy.sort((a, b) => {
    const ga = seen.get(String(a?.[group] ?? "")) ?? 0;
    const gb = seen.get(String(b?.[group] ?? "")) ?? 0;
    return ga !== gb ? ga - gb : cmpX(a, b);
  });
}

/** x/y 轴与图例的公共设置（各图型共用，避免同一件事各写一遍、行为不一致）。 */
function decorateMark(
  mark: any,
  opts: { xField: string; yField: string; xTitle?: string; yTitle?: string; unit?: string; colorBy?: string },
): void {
  mark.axis("x", { title: axisTitle(opts.xTitle || "", opts.xField) });
  mark.axis("y", { title: axisTitle(opts.yTitle || "", opts.yField), labelFormatter: numberLabelFormatter(opts.unit || "") });
  // 有 colorBy（单序列按分类上色 / 多序列按分组上色）就给底部图例，方便对照配色。
  if (opts.colorBy) mark.legend("color", { position: "bottom" });
}

/** 柱/点/饼类图型的提示框：项名用模型给的中文轴标题（G2 的项名只接受字符串，
 *  传函数会被原样打印成源码——实测），单位拼在数值上；两者都没有时用 G2 默认。
 *  默认为英文列名（share、value），读起来才知道是什么。 */
function seriesTooltip(mark: any, opts: { yTitle?: string; unit?: string }): void {
  const name = opts.yTitle || "";
  const unit = opts.unit || "";
  if (!name && !unit) return;
  const item: Record<string, unknown> = { channel: "y" };
  if (name) item.name = name;
  if (unit) item.valueFormatter = (v: unknown) => `${v}${unit}`;
  mark.tooltip({ items: [item] });
}

/** 柱图的序列排布：G2 v5 不会自动并排——不声明时多个序列会画在同一位置互相覆盖（读数是错的）。
 *  显式声明：堆叠用 stackY，并列用 dodgeX。 */
function layoutSeries(mark: any, group: string, stack: boolean): void {
  if (!group) return;
  mark.transform({ type: stack ? "stackY" : "dodgeX" });
}

/** 图表配色板：单序列按分类上色 / 多序列按分组上色时用的和谐色板（比 G2 默认更克制耐看）。 */
const CHART_PALETTE = [
  "#5B8FF9", "#5AD8A6", "#5D7092", "#F6BD16", "#E8684A",
  "#6DC8EC", "#9270CA", "#FF9D4D", "#269A99", "#FF99C3",
];

function buildG2(chart: any, type: string, rawData: any[], encode: Record<string, string>, options: Record<string, unknown>) {
  // 统一配色板：所有走 color 通道的图（柱/饼/树图等）共用，保证多图同屏风格一致、不刺眼。
  chart.scale("color", { range: CHART_PALETTE });
  const data = normalizeRows(rawData);
  const x = pickStr(encode.x, options.xField);
  const y = pickStr(encode.y, options.yField) || "value";
  // 序列/分组字段：折线面积语义在 encode.series，柱图饼图语义在 encode.color，模型也常写进 options。
  const groupField = pickStr(encode.series, encode.color, options.seriesField, options.colorField);
  // 与 x 相同的「分组字段」只代表「按分类上色」、不是多序列分组：layoutSeries 不对其做并排/堆叠，
  // 但仍按分类上色（每根柱一种颜色更直观），图例也据此显示。
  const group = groupField && groupField !== x ? groupField : "";
  const xTitle = pickStr(options.xTitle, options.xAxisTitle);
  const yTitle = pickStr(options.yTitle, options.yAxisTitle);
  const unit = pickStr(options.unit, options.yUnit, options.suffix);
  const stack = options.stack === true;
  const y1 = pickStr(encode.y1, options.y1Field) || "y1";
  // 横向柱与漏斗都要转置坐标。三点都是 G2 5.4.8 实测结论：
  //   ① transpose 是「坐标变换」不是坐标类型，写成 type:"transpose" 会被拒绝（Unknown coordinate）；
  //   ② 必须设在 chart 级——mark 级转置会让 interval 的位置/宽度算错（柱子跑到画布中部并互相重叠）；
  //   ③ 必须在创建 mark 之前设好——建完 mark 再设会失效（图形仍按未转置的画）。
  if (type === "bar" || type === "funnel") chart.coordinate({ transform: [{ type: "transpose" }] });

  switch (type) {
    case "pie": {
      const category = pickStr(encode.color, encode.x, options.colorField, options.categoryField) || "name";
      // 一个扇区＝一个分类：同分类多行先合计（见 aggregateBy），否则同色会出现多个扇区、读数被拆散。
      const rows = aggregateBy(data, category, y);
      const mark = chart
        .interval()
        .data(rows)
        .transform({ type: "stackY" })
        .encode("y", y)
        .encode("color", category)
        .coordinate({ type: "theta" })
        .legend("color", { position: "bottom" })
        // 扇形上直接标数值：只看图例 + 面积估比例，读不准确切数值。
        .label({ text: (d: any) => `${d?.[y] ?? ""}${unit}`, position: "outside" });
      seriesTooltip(mark, { yTitle, unit });
      break;
    }
    case "bar":
    case "column": {
      // 单序列按分类上色（每根柱一种颜色，比统一单色更直观）；有分组字段时按分组上色。
      const colorBy = group || x;
      const mark = chart.interval().data(data).encode("x", x).encode("y", y);
      if (colorBy) mark.encode("color", colorBy);
      layoutSeries(mark, group, stack);
      decorateMark(mark, { xField: x, yField: y, xTitle, yTitle, unit, colorBy });
      seriesTooltip(mark, { yTitle, unit });
      break;
    }
    case "line":
    case "area": {
      const rows = sortSeriesRows(data, x, group);
      const mark = (type === "area" ? chart.area() : chart.line()).data(rows).encode("x", x).encode("y", y);
      if (group) mark.encode("color", group);
      // 面积图默认不堆叠：多条序列的填充会互相覆盖，半透明才看得清每条各自的轮廓。
      if (type === "area" && group) mark.style("fillOpacity", 0.35);
      decorateMark(mark, { xField: x, yField: y, xTitle, yTitle, unit, colorBy: group });
      break;
    }
    case "scatter": {
      const mark = chart.point().data(data).encode("x", x).encode("y", y);
      if (group) mark.encode("color", group);
      decorateMark(mark, { xField: x, yField: y, xTitle, yTitle, unit, colorBy: group });
      seriesTooltip(mark, { yTitle, unit });
      break;
    }
    case "radar": {
      // G2 的雷达坐标是「平行坐标 + 极坐标」：数据必须是「每行一条序列、每列一个维度」的宽表，
      // 并且各维度要用 encode("position", [维度...]) 声明（只有 line mark 支持；area 会缺 x 通道报错）。
      // 模型给的是长表（维度/数值两列），这里就地透视；已经是宽表时按原样用。
      const seriesField = group || (data[0] && "series" in data[0] ? "series" : "");
      let wide: any[] = data;
      if (x && seriesField) {
        const bySeries = new Map<string, Record<string, unknown>>();
        for (const r of data) {
          const name = String(r?.[seriesField] ?? "—");
          const row = bySeries.get(name) ?? { [seriesField]: name };
          // 同一序列同一维度出现多行时取最后一行（模型给的通常是已聚合的透视数据）
          row[String(r?.[x] ?? "")] = r?.[y];
          bySeries.set(name, row);
        }
        wide = [...bySeries.values()];
      }
      const dims = wide[0] ? Object.keys(wide[0]).filter((k) => k !== seriesField) : [];
      // 没有维度就画不出雷达：抛错走降级表格（比留一张空坐标系诚实）。
      if (!dims.length) throw new Error("雷达图需要「维度 + 数值」数据（维度写在 encode.x，数值写在 encode.y）");
      const mark = chart.line().data(wide).coordinate({ type: "radar" }).encode("position", dims);
      if (seriesField) mark.encode("color", seriesField).legend("color", { position: "bottom" });
      break;
    }
    case "treemap": {
      const category = pickStr(encode.color, encode.x, options.colorField);
      // 矩形树要的是 d3-stratify 形态（每行带唯一 id 与父 id）的扁平数据：模型给的是
      // 「分类 + 数值」行数组，这里就地树化——根节点 name 用通用占位，分类值必须是字符串。
      // 同时按分类合计：一个矩形＝一个分类，同分类多行不合并会出现多个同名矩形。
      const rows = aggregateBy(data, category, y);
      const rootId = "__root__";
      const tree = [
        { name: "root", id: rootId },
        ...rows.map((r, i) => ({
          name: String((category ? r?.[category] : undefined) ?? `#${i + 1}`),
          id: `n${i}`,
          parentId: rootId,
          value: Number(r?.[y]) || 0,
        })),
      ];
      // 颜色按分类取：treemap 的默认取色走层级 path，本结构（单层分类）取不到值会导致矩形全是同色。
      chart
        .treemap()
        .data(tree)
        .encode("value", "value")
        .encode("color", (d: any) => String(d?.data?.name ?? ""));
      break;
    }
    case "sankey": {
      // 桑基图走 G2 的 sankey mark（G6 没有桑基布局，用 G6 画只会得到一堆叠在一起的节点）。
      // 它吃「平坦连线数组」[{source,target,value}]、节点由连线自动生成；模型给的是 {nodes,edges}
      // 关系结构，这里拍平（缺 value 的边按 1 计，否则带宽算不出来）。
      const raw: any = data;
      const edges = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.links)
          ? raw.links
          : Array.isArray(raw?.edges)
            ? raw.edges
            : [];
      const rows = edges
        .map((e: any) => ({
          source: String(e?.source ?? e?.from ?? ""),
          target: String(e?.target ?? e?.to ?? ""),
          value: Number(e?.value ?? e?.weight ?? 1) || 1,
        }))
        .filter((e: any) => e.source && e.target);
      if (!rows.length) throw new Error("桑基图需要连线数据（[{source,target,value}] 或 {nodes,edges}）");
      chart.sankey().data(rows).encode("color", "source");
      break;
    }
    case "funnel": {
      // G2 没有 funnel mark：漏斗是 interval 的一种形状（shape: funnel），配合转置坐标 + symmetryY
      // 才是漏斗的样子（不转置会画成一排「山」形色块）。
      // 同理先按阶段合计：同一阶段多行不合并会出现重叠的多段。
      const rows = aggregateBy(data, x, y);
      const mark = chart
        .interval()
        .data(rows)
        .encode("x", x)
        .encode("y", y)
        .encode("shape", "funnel")
        .transform({ type: "symmetryY" });
      decorateMark(mark, { xField: x, yField: y, xTitle, yTitle, unit });
      seriesTooltip(mark, { yTitle, unit });
      break;
    }
    case "boxplot": {
      // G2 的箱线图吃「明细行」（每行一个数值）：模型若给的是「每行一组样本」的数组，
      // 就地展开成明细行——否则一组样本会被当成一个点，画出来是一条线。
      const rows = data.flatMap((r: any) => {
        const raw = r?.[y];
        if (!Array.isArray(raw)) return [r];
        return raw.map((v) => ({ ...r, [y]: v }));
      });
      const mark = chart.boxplot().data(rows).encode("x", x).encode("y", y);
      mark.axis("x", { title: axisTitle(xTitle, x) });
      break;
    }
    case "histogram": {
      const mark = chart
        .rect()
        .data(data)
        .transform({ type: "binX", y: "count", thresholds: (options.bins as number) || 20 })
        .encode("x", x)
        .encode("y", "count");
      mark.axis("x", { title: axisTitle(xTitle, x) });
      break;
    }
    case "waterfall": {
      // 瀑布图＝把「增减值」累加成区间逐段画（from→to）。实测：G2 的 symmetryY 会把负值对称成正的
      // （B 段 -3 显示成 4，读数直接错），diffY 在整段同号时画不出东西——所以在前端构造累积区间，
      // 用 y/y1 双端画每段的上下界，并按增减着色。
      let acc = 0;
      const rows = data.map((r: any) => {
        const from = acc;
        acc += Number(r?.[y]) || 0;
        return { ...r, __from: from, __to: acc };
      });
      const mark = chart
        .interval()
        .data(rows)
        .encode("x", x)
        .encode("y", "__to")
        .encode("y1", "__from")
        .encode("color", (d: any) => (Number(d?.[y]) >= 0 ? "增加" : "减少"))
        .legend("color", { position: "bottom" });
      mark.axis("y1", false);
      decorateMark(mark, { xField: x, yField: y, xTitle, yTitle, unit });
      // 提示框显示原始的增减值（区间字段是内部构造，读它对用户没意义）。
      const tipItem: Record<string, unknown> = { field: y, name: yTitle || "数值" };
      if (unit) tipItem.valueFormatter = (v: unknown) => `${v}${unit}`;
      mark.tooltip({ items: [tipItem] });
      break;
    }
    case "dual_axes":
      chart
        .interval()
        .data(data)
        .encode("x", x)
        .encode("y", y)
        .axis("y", { title: axisTitle(yTitle, y), labelFormatter: numberLabelFormatter(unit) });
      chart
        .line()
        .data(data)
        .encode("x", x)
        .encode("y", y1)
        .scale("y", { independent: true })
        .axis("y", { position: "right", title: pickStr(options.y1Title, options.y1AxisTitle) || y1 });
      break;
    default: {
      const colorBy = group || x;
      const mark = chart.interval().data(data).encode("x", x).encode("y", y);
      if (colorBy) mark.encode("color", colorBy);
      layoutSeries(mark, group, stack);
      decorateMark(mark, { xField: x, yField: y, xTitle, yTitle, unit, colorBy });
      seriesTooltip(mark, { yTitle, unit });
    }
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
  /* 绘图区给确定高度（min-height 之外再定 height），保证 G2/G6 拿到非零尺寸的容器。
     320px 是在「底部图例 + 轴标题」也占高之后仍留足绘图区的高度（300px 时图例会挤压折线区）。 */
  height: 320px;
  min-height: 120px;
}
.chart-card__err {
  margin-top: 8px;
  font-size: 12px;
  color: #b91c1c;
}
.chart-empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted, #6b7280);
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
