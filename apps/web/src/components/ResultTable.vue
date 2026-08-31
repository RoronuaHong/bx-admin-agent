<script setup lang="ts">
import { computed, ref } from "vue";
import type { TableView, TableColumnView } from "../types";
import { copyText } from "../clipboard";

const props = defineProps<{ table: TableView }>();
const expanded = ref<Set<number>>(new Set());
const copied = ref<string | null>(null);

// 图片单元格：值为 http(s) 图片 URL 时渲染缩略图（纯协议/资源类型识别，跨系统通用；
// 对齐 PC 端列表封面缩略图。扩展名判定覆盖 jpg/jpeg/png/webp/gif/avif/bmp/svg）。
const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:jpe?g|png|webp|gif|avif|bmp|svg)(?:\?\S*)?$/i;
function isImageUrl(v: unknown): v is string {
  return typeof v === "string" && IMAGE_URL_RE.test(v.trim());
}
const viewerUrl = ref("");
function openViewer(url: string) {
  viewerUrl.value = url;
}
function closeViewer() {
  viewerUrl.value = "";
}

const displayRows = computed(() => {
  const rows = props.table.rows.map((r) => ({ ...r }));
  if (props.table.footer) {
    const fr: Record<string, string> & { _isFooter?: boolean; _depth?: number } = {
      ...props.table.footer,
      _isFooter: true,
      _depth: 0,
    };
    const first = props.table.columns[0]?.key;
    if (first && !fr[first]) fr[first] = "合计";
    rows.push(fr);
  }
  return rows;
});

function toggleExpand(index: number) {
  const next = new Set(expanded.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expanded.value = next;
}
function isExpanded(index: number) {
  return expanded.value.has(index);
}
function formatKind(column: TableColumnView, raw: string): { text: string; cls: string } {
  if (raw === undefined || raw === null || raw === "" || raw === "--") {
    return { text: "--", cls: "cell cell-empty" };
  }
  switch (column.kind) {
    case "money":
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n)
        ? { text: n.toLocaleString("zh-CN"), cls: "cell cell-num" + (column.kind === "money" ? " cell-money" : "") }
        : { text: raw, cls: "cell" };
    }
    case "date":
      return { text: raw, cls: "cell cell-num" };
    case "id":
      return { text: raw, cls: "cell cell-mono cell-id" };
    case "badge":
      return { text: raw, cls: "cell cell-badge" };
    default:
      return { text: raw, cls: "cell" };
  }
}
function cellAlign(column: TableColumnView) {
  return column.align || (column.kind === "money" || column.kind === "number" ? "right" : "left");
}
// 列宽控制（2026-08-26 重构，修复「th 挤在一起」）：
//  配合 table-layout: fixed，每列都给出明确宽度（含默认），列宽不再被内容撑爆、不再互相挤压。
//  - 有 PC 端显式 width：用该宽度；
//  - 无 width（历史数据/未声明宽度的列）：按列 kind 给合理默认宽（数字/ID 窄列、时间/日期中宽、
//    普通文本列宽），并 max-width 限制超长文本 + 省略号（悬浮 title 查看全文）。
//    全部是通用布局信号（列 kind/宽度数值），零业务词。
function defaultColWidth(column: TableColumnView): number {
  const kind = column.kind;
  if (kind === "number" || kind === "money" || kind === "id") return 90;
  if (kind === "date") return 150;
  if (kind === "image") return 96;
  return 180;
}
function colStyle(column: TableColumnView): Record<string, string> {
  const w = typeof column.width === "number" && column.width > 0 ? column.width : defaultColWidth(column);
  const style: Record<string, string> = {
    width: `${w}px`,
    minWidth: `${Math.min(w, 110)}px`,
    maxWidth: `${w}px`,
  };
  // 数字列右对齐已在 cellAlign 处理；日期/ID 列禁止换行
  if (column.kind === "date" || column.kind === "id") style.whiteSpace = "nowrap";
  return style;
}
// 长文本省略：非数字/ID/日期/图片的列 ellipsis（悬浮 title 查看全文）；数字/时间内容短不省略。
function isEllipsis(column: TableColumnView) {
  const kind = column.kind;
  return kind !== "number" && kind !== "money" && kind !== "id" && kind !== "date" && kind !== "image";
}
function cellText(column: TableColumnView, row: Record<string, string> & { _depth?: number; _isFooter?: boolean }, colIndex: number) {
  let text = String(row[column.key] ?? "");
  const depth = Number(row._depth || 0);
  if (colIndex === 0 && depth > 0 && !row._isFooter) text = `${"　".repeat(depth)}└ ${text}`;
  return text;
}
async function copyCell(text: string) {
  if (!text || text === "--") return;
  const ok = await copyText(text);
  if (ok) {
    copied.value = text;
    setTimeout(() => (copied.value = null), 1200);
  }
}
async function copyTable() {
  const head = props.table.columns.map((c) => c.title);
  const rows = displayRows.value.map((r) =>
    props.table.columns.map((c) => String(r[c.key] ?? "").replace(/\n/g, " ")),
  );
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  const ok = await copyText(lines.join("\n"));
  if (ok) {
    copied.value = "table";
    setTimeout(() => (copied.value = null), 1200);
  }
}
const copiedTable = computed(() => copied.value === "table");
const cellCopied = (text: string) => copied.value === text;
</script>

<template>
  <div class="admin-table">
    <div class="caption">
      <span class="caption__title">{{ table.title }}</span>
      <span class="caption__meta">
        <span class="total">{{ table.total }} 条</span>
        <template v-if="table.tree"><span class="chip">树表</span></template>
        <template v-if="table.footer"><span class="chip">含汇总</span></template>
        <button type="button" class="copy-btn" :class="{ copied: copiedTable }" :title="copiedTable ? '已复制' : '复制表格'" @click="copyTable()">
          {{ copiedTable ? "已复制" : "复制" }}
        </button>
      </span>
    </div>
    <div class="admin-table__wrap">
      <table>
        <thead>
          <tr>
            <th
              v-for="column in table.columns"
              :key="column.key"
              :class="{ 'th-num': cellAlign(column) === 'right' }"
              :style="colStyle(column)"
            >
              {{ column.title }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!displayRows.length">
            <td :colspan="table.columns.length" class="empty">
              <span class="empty__mark">∅</span>
              <span>暂无数据</span>
            </td>
          </tr>
          <tr
            v-for="(row, index) in displayRows"
            :key="index"
            :class="['row', { 'row-footer': row._isFooter, 'row-total': isExpanded(index) && !row._isFooter }]"
            @click="!row._isFooter && toggleExpand(index)"
          >
            <td
              v-for="(column, colIndex) in table.columns"
              :key="column.key"
              :style="{ textAlign: cellAlign(column), ...colStyle(column) }"
              :title="cellText(column, row, colIndex)"
            >
              <img
                v-if="isImageUrl(cellText(column, row, colIndex))"
                class="cell-img"
                :src="cellText(column, row, colIndex)"
                :alt="column.title"
                loading="lazy"
                @click.stop="openViewer(cellText(column, row, colIndex))"
                @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
              />
              <span
                v-else
                :class="[
                  formatKind(column, cellText(column, row, colIndex)).cls,
                  { 'cell-copied': cellCopied(cellText(column, row, colIndex)), 'cell-ellipsis': isEllipsis(column) },
                ]"
                @click.stop="copyCell(cellText(column, row, colIndex))"
              >
                {{ formatKind(column, cellText(column, row, colIndex)).text }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="viewerUrl" class="table-viewer" role="dialog" aria-label="图片预览" @click.self="closeViewer()">
      <img :src="viewerUrl" alt="图片大图" />
      <button type="button" class="table-viewer__close" aria-label="关闭预览" @click="closeViewer()">×</button>
    </div>
  </div>
</template>

<style scoped>
/* ============ 表格卡片（纸感 editorial 主题，2026-08-26 美化） ============ */
.admin-table {
  margin-top: 12px;
  max-width: 100%;
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow:
    0 1px 2px rgba(20, 20, 19, 0.04),
    0 8px 24px -12px rgba(20, 20, 19, 0.10);
}
html[data-theme="dark"] .admin-table {
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.3),
    0 8px 24px -12px rgba(0, 0, 0, 0.5);
}

/* ---- 标题栏：编号感 caption，对齐纸感衬线 ---- */
.caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--fill) 92%, var(--line));
}
.caption__title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink);
}
.caption__meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.total {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.chip {
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: var(--radius-pill);
  color: var(--muted);
  background: color-mix(in srgb, var(--fill) 55%, var(--line));
  border: 1px solid var(--line);
}
.copy-btn {
  font-family: var(--font-body);
  font-size: 11px;
  line-height: 1;
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  color: var(--muted);
  background: var(--fill);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  -webkit-tap-highlight-color: transparent;
}
.copy-btn:hover {
  color: var(--ink);
  border-color: var(--ink);
}
.copy-btn:active { transform: translateY(1px); }

/* ---- 表格主体 ---- */
.admin-table__wrap { overflow: auto; max-height: 60vh; }
/* table-layout: fixed（2026-08-26）：列宽由 th 的 width 决定，不再被单元格长内容撑爆、
   避免 10+ 列互相挤压（修复「th 挤在一起」）。列宽通过 colStyle 按 PC 端 width / 默认宽度分配。 */
table {
  border-collapse: collapse;
  min-width: 100%;
  width: 100%;
  table-layout: fixed;
  font-size: 13px;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: var(--fill);
  border-bottom: 1px solid var(--line-strong);
  white-space: nowrap;
}
thead th.th-num { text-align: right; }
tbody td {
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
  line-height: 1.5;
}
tbody tr:last-child td { border-bottom: none; }

/* 行：悬停细腻反馈 + 选中态 + 斑马纹极淡 */
tbody tr {
  transition: background 0.12s ease;
}
tbody tr:not(.row-footer):hover {
  background: color-mix(in srgb, var(--fill) 50%, var(--line) 6%);
}
tbody tr:nth-child(even):not(.row-footer):not(.row-total) {
  background: color-mix(in srgb, var(--fill) 97%, var(--line));
}
tbody tr:nth-child(even):hover {
  background: color-mix(in srgb, var(--fill) 50%, var(--line) 8%);
}
.row-total {
  background: color-mix(in srgb, var(--fill) 40%, var(--line) 10%);
}
.row-footer {
  font-weight: 700;
  background: color-mix(in srgb, var(--fill) 60%, var(--ink) 5%);
}
.row-footer td { border-top: 1px solid var(--line-strong); }

/* ---- 单元格类型 ---- */
.cell {
  cursor: copy;
  word-break: break-word;
  min-width: 40px;
}
.cell:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
/* 长文本省略（2026-08-26）：普通文本列超长内容截断为省略号，悬浮 title 查看全文；
   table-layout:fixed 下 td 宽度受限，span 设 display:block + nowrap 使 ellipsis 生效。
   数字/ID/日期列不省略（内容短）；超长内容（多渠道名、长介绍）省略避免列撑爆。 */
.cell-ellipsis {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}
/* 单元格内容竖排多个 span（如树表缩进 + 值）时，ellipsis 只作用于最后一个文本 span；
   容器不换行由 fixed 布局保证。 */
td .cell:not(.cell-empty):not(.cell-ellipsis) {
  word-break: break-word;
}
.cell-num { font-variant-numeric: tabular-nums; }
.cell-money { font-variant-numeric: tabular-nums; }
.cell-mono {
  font-family: var(--font-mono);
  font-size: 12.5px;
  letter-spacing: -0.01em;
}
.cell-id {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.cell-empty { color: var(--muted); cursor: default; }
.cell-empty:hover { text-decoration: none; }

/* badge：圆角小标签（是/否/状态等短值） */
.cell-badge {
  display: inline-block;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink);
  background: color-mix(in srgb, var(--fill) 40%, var(--line));
  border: 1px solid var(--line);
  cursor: copy;
}
.cell-badge:hover { text-decoration: none; }

/* 复制反馈 */
.copy-btn.copied,
.cell-copied::after {
  content: "已复制";
  margin-left: 6px;
  font-size: 11px;
  color: var(--ok);
}

/* ---- 空态 ---- */
.empty {
  text-align: center;
  color: var(--muted);
  padding: 32px 16px;
}
.empty__mark {
  display: block;
  font-size: 26px;
  line-height: 1;
  margin-bottom: 8px;
  opacity: 0.5;
}

/* ---- 封面/图片缩略图 ---- */
.cell-img {
  display: block;
  height: 48px;
  width: auto;
  max-width: 96px;
  object-fit: cover;
  border-radius: 8px;
  background: color-mix(in srgb, var(--fill) 60%, var(--line));
  cursor: zoom-in;
  transition: filter 0.15s ease, transform 0.15s ease;
}
.cell-img:hover {
  filter: brightness(1.06);
  transform: scale(1.04);
}

/* ---- 滚动条（细、融入主题） ---- */
.admin-table__wrap::-webkit-scrollbar { width: 8px; height: 8px; }
.admin-table__wrap::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: var(--radius-pill);
}
.admin-table__wrap::-webkit-scrollbar-thumb:hover { background: var(--muted); }
.admin-table__wrap::-webkit-scrollbar-track { background: transparent; }

/* ---- 图片放大预览（组件内 lightbox） ---- */
.table-viewer {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
  padding: 16px;
  animation: fade-in 0.2s ease both;
}
.table-viewer img {
  max-width: 92vw;
  max-height: 86vh;
  object-fit: contain;
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  animation: zoom-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.table-viewer__close {
  position: fixed;
  top: 14px;
  right: 16px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  font-size: 24px;
  line-height: 1;
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.table-viewer__close:hover { background: rgba(255, 255, 255, 0.32); }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}

/* ---- 移动端：紧凑适配 ---- */
@media (max-width: 640px) {
  .caption { padding: 10px 12px; }
  .caption__title { font-size: 13.5px; }
  .admin-table__wrap { max-height: 52vh; }
  thead th, tbody td { padding: 7px 10px; }
}
</style>
