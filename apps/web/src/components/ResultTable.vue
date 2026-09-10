<script setup lang="ts">
import { computed, h, ref, type PropType, type VNode } from "vue";
import {
  FlexRender,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type CellContext,
  type ColumnDef,
} from "@tanstack/vue-table";
import type { TableView, TableColumnView } from "../types";
import { enrichTableColumns, formatDisplayDate, looksLikeDateValue } from "../table-columns";
import { copyText } from "../clipboard";
import { getUiLocale } from "../ui-locale";

type RowData = Record<string, string> & { _depth?: number; _isFooter?: boolean; _rowKey?: string };

const props = defineProps({
  table: { type: Object as PropType<TableView>, required: true },
  emptyHint: { type: String, default: "" },
});
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const expanded = ref<Set<number>>(new Set());
const copied = ref<string | null>(null);
const viewerUrl = ref("");
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:jpe?g|png|webp|gif|avif|bmp|svg)(?:\?\S*)?$/i;
function isImageUrl(v: unknown): v is string {
  return typeof v === "string" && IMAGE_URL_RE.test(v.trim());
}
function openViewer(url: string) {
  viewerUrl.value = url;
}
function closeViewer() {
  viewerUrl.value = "";
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

const bodyRows = computed<RowData[]>(() =>
  props.table.rows.map((r, i) => ({ ...r, _rowKey: `r${i}` })),
);

const resolvedColumns = computed(() => enrichTableColumns(props.table.columns, bodyRows.value));

const footerRow = computed<RowData | null>(() => {
  if (!props.table.footer) return null;
  const fr: RowData = {
    ...props.table.footer,
    _isFooter: true,
    _depth: 0,
    _rowKey: "footer",
  };
  const first = props.table.columns[0]?.key;
  if (first && !fr[first]) fr[first] = tx("合计", "Total", "Total", "कुल");
  return fr;
});

const isEmpty = computed(() => bodyRows.value.length === 0);

function defaultColWidth(column: TableColumnView): number {
  const kind = column.kind;
  if (kind === "number" || kind === "money" || kind === "id") return 104;
  if (kind === "date") return 128;
  if (kind === "image") return 96;
  return 200;
}

function cellAlign(column: TableColumnView) {
  return column.align || (column.kind === "money" || column.kind === "number" ? "right" : "left");
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
      return { text: formatDisplayDate(raw), cls: "cell cell-date" };
    case "id":
      return { text: raw, cls: "cell cell-mono cell-id" };
    case "badge":
      return { text: raw, cls: "cell cell-badge" };
    default:
      if (looksLikeDateValue(raw)) {
        return { text: formatDisplayDate(raw), cls: "cell cell-date" };
      }
      return { text: raw, cls: "cell" };
  }
}

function displayCell(column: TableColumnView, row: RowData, colIndex: number): string {
  return formatKind(column, cellText(column, row, colIndex)).text;
}

function isEllipsis(column: TableColumnView) {
  const kind = column.kind;
  return kind !== "number" && kind !== "money" && kind !== "id" && kind !== "date" && kind !== "image";
}

function cellText(column: TableColumnView, row: RowData, colIndex: number) {
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
  const cols = resolvedColumns.value;
  const head = cols.map((c) => c.title);
  const allRows = footerRow.value ? [...bodyRows.value, footerRow.value] : bodyRows.value;
  const rows = allRows.map((r) =>
    cols.map((c, ci) => displayCell(c, r, ci).replace(/\n/g, " ")),
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

function csvEscape(cell: string): string {
  if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

function downloadCsv() {
  const cols = resolvedColumns.value;
  const head = cols.map((c) => csvEscape(c.title));
  const allRows = footerRow.value ? [...bodyRows.value, footerRow.value] : bodyRows.value;
  const lines = [
    head.join(","),
    ...allRows.map((r) =>
      cols.map((c, ci) => csvEscape(displayCell(c, r, ci).replace(/\n/g, " "))).join(","),
    ),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = (props.table.title || "analytics").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
  a.href = url;
  a.download = `${safe}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  copied.value = "csv";
  setTimeout(() => (copied.value = null), 1200);
}

const copiedTable = computed(() => copied.value === "table");
const copiedCsv = computed(() => copied.value === "csv");
const cellCopied = (text: string) => copied.value === text;

function toggleExpand(index: number) {
  const next = new Set(expanded.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expanded.value = next;
}
function isExpanded(index: number) {
  return expanded.value.has(index);
}

function renderCell(column: TableColumnView, colIndex: number, ctx: CellContext<typeof features, RowData, unknown>): VNode {
  const row = ctx.row.original;
  const text = cellText(column, row, colIndex);
  if (isImageUrl(text)) {
    return h("img", {
      class: "cell-img",
      src: text,
      alt: column.title,
      loading: "lazy",
      onClick: (e: Event) => {
        e.stopPropagation();
        openViewer(text);
      },
      onError: (e: Event) => {
        (e.target as HTMLImageElement).style.display = "none";
      },
    });
  }
  const formatted = formatKind(column, text);
  return h(
    "span",
    {
      class: [
        formatted.cls,
        { "cell-copied": cellCopied(text), "cell-ellipsis": isEllipsis(column) },
      ],
      title: text,
      onClick: (e: Event) => {
        e.stopPropagation();
        void copyCell(text);
      },
    },
    formatted.text,
  );
}

const columns = computed(() => {
  const defs: Array<ColumnDef<typeof features, RowData>> = resolvedColumns.value.map((column, colIndex) => {
    const width = typeof column.width === "number" && column.width > 0 ? column.width : defaultColWidth(column);
    const align = cellAlign(column);
    const numeric = column.kind === "number" || column.kind === "money";
    const compact = numeric || column.kind === "date" || column.kind === "id";
    return {
      id: column.key,
      accessorKey: column.key,
      header: column.title,
      size: width,
      minSize: compact ? Math.min(width, 88) : Math.min(width, 120),
      maxSize: compact ? width : Math.max(width * 2, 320),
      enableSorting: numeric || column.kind === "date" || column.kind === "text" || !column.kind,
      meta: { align, column, colIndex },
      cell: (ctx) => renderCell(column, colIndex, ctx),
      sortFn: numeric
        ? (rowA, rowB, columnId) => {
            const a = Number(rowA.getValue(columnId));
            const b = Number(rowB.getValue(columnId));
            const aOk = Number.isFinite(a);
            const bOk = Number.isFinite(b);
            if (aOk && bOk) return a === b ? 0 : a > b ? 1 : -1;
            if (aOk) return 1;
            if (bOk) return -1;
            return String(rowA.getValue(columnId) ?? "").localeCompare(String(rowB.getValue(columnId) ?? ""));
          }
        : "alphanumeric",
    };
  });
  return defs;
});

const dataTable = useTable({
  key: "result-table",
  features,
  columns,
  data: bodyRows,
  getRowId: (row, index) => row._rowKey || `row-${index}`,
  initialState: {
    pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
  },
});

/** Subscribe to sort/pagination atoms so Vue re-renders after interactions (TanStack Table v9). */
const tableRows = computed(() => {
  dataTable.atoms.sorting?.get();
  dataTable.atoms.pagination?.get();
  return dataTable.getRowModel().rows;
});
const headerGroups = computed(() => {
  dataTable.atoms.sorting?.get();
  return dataTable.getHeaderGroups();
});
const pagination = computed(() => dataTable.atoms.pagination?.get() ?? { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
const pageCount = computed(() => {
  dataTable.atoms.pagination?.get();
  dataTable.atoms.sorting?.get();
  return dataTable.getPageCount();
});
const showPager = computed(() => pageCount.value > 1 || bodyRows.value.length > DEFAULT_PAGE_SIZE);

function onPageSizeChange(ev: Event) {
  const value = Number((ev.target as HTMLSelectElement).value);
  if (!Number.isFinite(value) || value <= 0) return;
  dataTable.setPageSize(value);
}

function footerCellText(column: TableColumnView, colIndex: number) {
  if (!footerRow.value) return "";
  return cellText(column, footerRow.value, colIndex);
}

function headerStyle(header: {
  column: { columnDef: { size?: number; minSize?: number; maxSize?: number; meta?: { align?: string } } };
}) {
  const size = header.column.columnDef.size ?? 180;
  const minSize = header.column.columnDef.minSize ?? Math.min(size, 110);
  const maxSize = header.column.columnDef.maxSize ?? size;
  const align = header.column.columnDef.meta?.align || "left";
  return {
    width: `${size}px`,
    minWidth: `${minSize}px`,
    maxWidth: `${maxSize}px`,
    textAlign: align as "left" | "right" | "center",
  };
}

function cellStyle(cell: {
  column: {
    columnDef: {
      size?: number;
      minSize?: number;
      maxSize?: number;
      meta?: { align?: string; column?: TableColumnView };
    };
  };
}) {
  const size = cell.column.columnDef.size ?? 180;
  const minSize = cell.column.columnDef.minSize ?? Math.min(size, 110);
  const maxSize = cell.column.columnDef.maxSize ?? size;
  const align = cell.column.columnDef.meta?.align || "left";
  const kind = cell.column.columnDef.meta?.column?.kind;
  const style: Record<string, string> = {
    width: `${size}px`,
    minWidth: `${minSize}px`,
    maxWidth: `${maxSize}px`,
    textAlign: align,
  };
  if (kind === "date" || kind === "id") style.whiteSpace = "nowrap";
  return style;
}
</script>

<template>
  <!-- Empty / no-results: avoid dead table chrome (headers + copy on 0 rows) -->
  <div v-if="isEmpty" class="result-empty" role="status">
    <div class="result-empty__head">
      <span class="result-empty__title">{{ table.title }}</span>
      <span class="result-empty__badge">{{ tx("无数据", "No data", "Sem dados", "कोई डेटा नहीं") }}</span>
    </div>
    <p class="result-empty__lead">
      {{
        tx(
          "当前条件下没有返回任何行。这不等于业务指标为 0，可能是时间窗、维度或筛选与数据未对齐。",
          "This query returned no rows. That is not the same as a business metric of zero — the time window, dimensions, or filters may not match the data.",
          "Esta consulta nao retornou linhas. Isso nao significa que o indicador seja zero — a janela de tempo, dimensoes ou filtros podem nao coincidir com os dados.",
          "इस क्वेरी से कोई पंक्ति नहीं मिली। इसका मतलब व्यावसायिक मीट्रिक शून्य नहीं है — समय सीमा, आयाम या फ़िल्टर डेटा से मेल नहीं खा सकते।",
        )
      }}
    </p>
    <p v-if="emptyHint" class="result-empty__hint">{{ emptyHint }}</p>
    <ul class="result-empty__tips">
      <li>{{ tx("核对时间范围（缺年时默认业务年）", "Check the time range (default business year when year is omitted)") }}</li>
      <li>{{ tx("放宽渠道 / 语言 / 包体等筛选", "Broaden channel / language / package filters") }}</li>
      <li>{{ tx("换一种 grain（按天 / 汇总）再问", "Try another grain (daily / aggregate)") }}</li>
    </ul>
  </div>

  <div v-else class="admin-table">
    <div class="caption">
      <span class="caption__title">{{ table.title }}</span>
      <span class="caption__meta">
        <span class="total">{{
          uiLocale === "zh"
            ? `${table.total} 条`
            : uiLocale === "pt-BR"
              ? `${table.total} linhas`
              : uiLocale === "hi"
                ? `${table.total} पंक्तियां`
                : `${table.total} rows`
        }}</span>
        <template v-if="table.tree"><span class="chip">{{ tx("树表", "Tree", "Arvore", "ट्री") }}</span></template>
        <template v-if="table.footer"><span class="chip">{{ tx("含汇总", "Summary", "Resumo", "सारांश") }}</span></template>
        <button
          type="button"
          class="copy-btn"
          :class="{ copied: copiedTable }"
          :title="copiedTable ? tx('已复制', 'Copied', 'Copiado', 'कॉपी हो गया') : tx('复制表格', 'Copy table', 'Copiar tabela', 'तालिका कॉपी करें')"
          @click="copyTable()"
        >
          {{ copiedTable ? tx("已复制", "Copied", "Copiado", "कॉपी हो गया") : tx("复制", "Copy", "Copiar", "कॉपी करें") }}
        </button>
        <button
          type="button"
          class="copy-btn"
          :class="{ copied: copiedCsv }"
          :title="tx('下载 CSV', 'Download CSV', 'Baixar CSV', 'CSV डाउनलोड')"
          @click="downloadCsv()"
        >
          {{ copiedCsv ? tx("已下载", "Saved", "Salvo", "सहेजा गया") : "CSV" }}
        </button>
      </span>
    </div>

    <div class="admin-table__wrap">
      <table>
        <thead>
          <tr v-for="headerGroup in headerGroups" :key="headerGroup.id">
            <th
              v-for="header in headerGroup.headers"
              :key="header.id"
              :class="{
                'th-num': header.column.columnDef.meta?.align === 'right',
                'th-sortable': header.column.getCanSort(),
                'th-sorted': !!header.column.getIsSorted(),
              }"
              :style="headerStyle(header)"
              @click="header.column.getToggleSortingHandler()?.($event)"
            >
              <template v-if="!header.isPlaceholder">
                <span class="th-inner">
                  <FlexRender :header="header" />
                  <span
                    v-if="header.column.getCanSort()"
                    class="sort-mark"
                    :data-dir="header.column.getIsSorted() || 'none'"
                    aria-hidden="true"
                  />
                </span>
              </template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in tableRows"
            :key="row.id"
            :class="['row', { 'row-total': isExpanded(index) }]"
            @click="toggleExpand(index)"
          >
            <td
              v-for="cell in row.getAllCells()"
              :key="cell.id"
              :style="cellStyle(cell)"
            >
              <FlexRender :cell="cell" />
            </td>
          </tr>
        </tbody>
        <tfoot v-if="footerRow">
          <tr class="row row-footer">
            <td
              v-for="(column, colIndex) in resolvedColumns"
              :key="column.key"
              :style="{
                textAlign: cellAlign(column),
                width: `${typeof column.width === 'number' && column.width > 0 ? column.width : defaultColWidth(column)}px`,
              }"
            >
              <span
                :class="formatKind(column, footerCellText(column, colIndex)).cls"
                :title="footerCellText(column, colIndex)"
              >
                {{ formatKind(column, footerCellText(column, colIndex)).text }}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="showPager" class="table-pager">
      <div class="table-pager__info">
        {{
          tx(
            `第 ${pagination.pageIndex + 1} / ${pageCount} 页`,
            `Page ${pagination.pageIndex + 1} / ${pageCount}`,
            `Pagina ${pagination.pageIndex + 1} / ${pageCount}`,
            `पृष्ठ ${pagination.pageIndex + 1} / ${pageCount}`,
          )
        }}
      </div>
      <div class="table-pager__actions">
        <button type="button" class="pager-btn" :disabled="!dataTable.getCanPreviousPage()" @click="dataTable.firstPage()">
          «
        </button>
        <button type="button" class="pager-btn" :disabled="!dataTable.getCanPreviousPage()" @click="dataTable.previousPage()">
          ‹
        </button>
        <button type="button" class="pager-btn" :disabled="!dataTable.getCanNextPage()" @click="dataTable.nextPage()">
          ›
        </button>
        <button type="button" class="pager-btn" :disabled="!dataTable.getCanLastPage()" @click="dataTable.lastPage()">
          »
        </button>
        <label class="pager-size">
          <span>{{ tx("每页", "Rows", "Linhas", "पंक्तियाँ") }}</span>
          <select :value="pagination.pageSize" @change="onPageSizeChange">
            <option v-for="size in PAGE_SIZE_OPTIONS" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>
    </div>

    <div
      v-if="viewerUrl"
      class="table-viewer"
      role="dialog"
      :aria-label="tx('图片预览', 'Image preview', 'Pre-visualizacao da imagem', 'छवि पूर्वावलोकन')"
      @click.self="closeViewer()"
    >
      <img :src="viewerUrl" :alt="tx('图片大图', 'Large preview image', 'Imagem ampliada', 'बड़ी पूर्वावलोकन छवि')" />
      <button
        type="button"
        class="table-viewer__close"
        :aria-label="tx('关闭预览', 'Close preview', 'Fechar pre-visualizacao', 'पूर्वावलोकन बंद करें')"
        @click="closeViewer()"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.result-empty {
  margin-top: 12px;
  max-width: min(640px, 100%);
  padding: 16px 18px;
  border: 1px dashed color-mix(in srgb, var(--accent, var(--ink)) 28%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--fill) 88%, var(--accent, var(--ink)) 4%);
}
.result-empty__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.result-empty__title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}
.result-empty__badge {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 999px;
  color: color-mix(in srgb, var(--accent, #0f766e) 85%, var(--ink));
  background: color-mix(in srgb, var(--accent, #0f766e) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #0f766e) 22%, var(--line));
}
.result-empty__lead {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink);
}
.result-empty__hint {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.result-empty__tips {
  margin: 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.result-empty__tips li {
  margin: 2px 0;
}

.admin-table {
  margin-top: 12px;
  max-width: 100%;
  background: color-mix(in srgb, var(--fill) 96%, var(--agent-accent, var(--accent, var(--ink))) 4%);
  border: 1px solid color-mix(in srgb, var(--agent-accent, var(--accent, var(--line))) 18%, var(--line));
  border-radius: calc(var(--radius) + 2px);
  overflow: hidden;
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--fill) 70%, transparent),
    0 10px 28px -18px color-mix(in srgb, var(--ink) 28%, transparent);
}
html[data-theme="dark"] .admin-table {
  background: color-mix(in srgb, var(--fill) 94%, var(--agent-accent, var(--accent, var(--ink))) 6%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04),
    0 12px 32px -18px rgba(0, 0, 0, 0.55);
}

.caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px 11px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--agent-accent, var(--line)) 12%, var(--line));
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--agent-accent, var(--accent, var(--ink))) 7%, var(--fill)) 0%,
      color-mix(in srgb, var(--fill) 92%, transparent) 100%
    );
}
.caption__title {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: color-mix(in srgb, var(--agent-accent, var(--accent, var(--ink))) 22%, var(--ink));
}
.caption__meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.total {
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--agent-accent, var(--accent, var(--muted))) 55%, var(--muted));
  padding: 4px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--fill) 70%, var(--agent-accent, var(--line)) 8%);
  border: 1px solid color-mix(in srgb, var(--agent-accent, var(--line)) 16%, var(--line));
}
.chip {
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: var(--radius-pill);
  color: var(--muted);
  background: color-mix(in srgb, var(--fill) 70%, var(--line));
  border: 1px solid var(--line);
}
.copy-btn {
  font-family: var(--font-body);
  font-size: 11px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--agent-accent, var(--line)) 14%, var(--line));
  color: var(--muted);
  background: color-mix(in srgb, var(--fill) 88%, transparent);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, transform 0.12s ease;
  -webkit-tap-highlight-color: transparent;
}
.copy-btn:hover {
  color: var(--ink);
  border-color: color-mix(in srgb, var(--agent-accent, var(--ink)) 35%, var(--line));
  background: color-mix(in srgb, var(--agent-accent, var(--ink)) 8%, var(--fill));
}
.copy-btn:active { transform: translateY(1px); }

.admin-table__wrap { overflow: auto; max-height: 60vh; }
table {
  border-collapse: separate;
  border-spacing: 0;
  min-width: 100%;
  width: max-content;
  table-layout: fixed;
  font-size: 13px;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 9px 12px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  background: color-mix(in srgb, var(--fill) 86%, var(--line));
  backdrop-filter: blur(8px);
  border-bottom: 1px solid color-mix(in srgb, var(--agent-accent, var(--line-strong)) 18%, var(--line-strong));
  white-space: nowrap;
  user-select: none;
}
thead th.th-num { text-align: right; }
thead th.th-sortable { cursor: pointer; }
thead th.th-sortable:hover,
thead th.th-sorted {
  color: color-mix(in srgb, var(--agent-accent, var(--accent, var(--ink))) 40%, var(--ink));
  background: color-mix(in srgb, var(--agent-accent, var(--accent, var(--ink))) 8%, var(--fill));
}
.th-inner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}
.th-num .th-inner { justify-content: flex-end; width: 100%; }
.sort-mark {
  position: relative;
  width: 8px;
  height: 12px;
  flex: 0 0 auto;
  opacity: 0.35;
}
.sort-mark::before,
.sort-mark::after {
  content: "";
  position: absolute;
  left: 1px;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
}
.sort-mark::before {
  top: 0;
  border-bottom: 4px solid currentColor;
}
.sort-mark::after {
  bottom: 0;
  border-top: 4px solid currentColor;
}
.th-sortable:hover .sort-mark { opacity: 0.7; }
.sort-mark[data-dir="asc"],
.sort-mark[data-dir="desc"] {
  opacity: 1;
  color: var(--agent-accent, var(--accent, var(--ink)));
}
.sort-mark[data-dir="asc"]::after { opacity: 0.25; }
.sort-mark[data-dir="desc"]::before { opacity: 0.25; }
tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 88%, transparent);
  vertical-align: middle;
  line-height: 1.45;
}
tbody tr:last-child td { border-bottom: none; }

tbody tr {
  transition: background 0.12s ease;
}
tbody tr:not(.row-footer):hover {
  background: color-mix(in srgb, var(--agent-accent, var(--accent, var(--ink))) 7%, var(--fill));
}
.row-total {
  background: color-mix(in srgb, var(--fill) 40%, var(--line) 10%);
}
.row-footer {
  font-weight: 700;
  background: color-mix(in srgb, var(--agent-accent, var(--ink)) 6%, var(--fill));
}
.row-footer td {
  border-top: 1px solid color-mix(in srgb, var(--agent-accent, var(--line-strong)) 22%, var(--line-strong));
}

.table-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px 10px 14px;
  border-top: 1px solid color-mix(in srgb, var(--agent-accent, var(--line)) 12%, var(--line));
  background: color-mix(in srgb, var(--fill) 90%, var(--line));
}
.table-pager__info {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.table-pager__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--fill) 70%, var(--line));
  border: 1px solid var(--line);
}
.pager-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  line-height: 1;
  font-size: 14px;
}
.pager-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--agent-accent, var(--accent, var(--ink))) 12%, var(--fill));
}
.pager-btn:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}
.pager-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
.pager-size select {
  height: 28px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--fill);
  color: var(--ink);
  padding: 0 8px;
}
.pager-size select:hover,
.pager-size select:focus {
  border-color: color-mix(in srgb, var(--agent-accent, var(--line)) 28%, var(--line));
  outline: none;
}

.cell {
  cursor: copy;
  word-break: break-word;
  min-width: 40px;
}
.cell:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
.cell-ellipsis {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}
td .cell:not(.cell-empty):not(.cell-ellipsis) {
  word-break: break-word;
}
.cell-num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: color-mix(in srgb, var(--ink) 92%, var(--agent-accent, var(--ink)));
}
.cell-date {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  letter-spacing: 0.01em;
}
.cell-money { font-variant-numeric: tabular-nums; font-weight: 600; }
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

.copy-btn.copied,
.cell-copied::after {
  content: "✓";
  margin-left: 6px;
  font-size: 11px;
  color: var(--ok);
}

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

.admin-table__wrap::-webkit-scrollbar { width: 8px; height: 8px; }
.admin-table__wrap::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: var(--radius-pill);
}
.admin-table__wrap::-webkit-scrollbar-thumb:hover { background: var(--muted); }
.admin-table__wrap::-webkit-scrollbar-track { background: transparent; }

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

@media (max-width: 640px) {
  .caption { padding: 10px 12px; }
  .caption__title { font-size: 13.5px; }
  .admin-table__wrap { max-height: 52vh; }
  thead th, tbody td { padding: 7px 10px; }
  .result-empty { padding: 14px; }
}
</style>
