/**
 * Delivery reconcile: ensure AskState.requested members appear in result tables.
 * Modes:
 * - zero_fill (default): missing channel rows get measure 0
 * - explain: no row insert; message names missing members
 */

export type DeliveryTable = {
  title: string;
  cols: string[];
  rows: unknown[][];
  grain?: string;
};

export type DeliveryMode = "zero_fill" | "explain";

function findDimColIndex(cols: string[], dim: string): number {
  const want = dim.toLowerCase();
  return cols.findIndex((c) => c.toLowerCase() === want || c.toLowerCase().includes(want));
}

function isNumericCol(rows: unknown[][], colIdx: number): boolean {
  for (const row of rows.slice(0, 20)) {
    const v = row[colIdx];
    if (v == null || v === "") continue;
    if (typeof v === "number") return true;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return true;
    return false;
  }
  return true;
}

function missingRequestedChannels(
  tables: DeliveryTable[],
  requested: string[],
): string[] {
  const present = new Set<string>();
  let sawChannelCol = false;
  for (const table of tables) {
    const colIdx = findDimColIndex(table.cols || [], "channel");
    if (colIdx < 0) continue;
    sawChannelCol = true;
    for (const row of table.rows || []) {
      const v = row[colIdx];
      if (v != null && String(v) !== "") present.add(String(v));
    }
  }
  if (!sawChannelCol) return [];
  return requested.filter((ch) => ![...present].some((p) => p.toLowerCase() === ch.toLowerCase()));
}

/**
 * Zero-fill missing channel members on tables that have a channel column.
 */
export function applyDeliveryZeroFill(input: {
  tables: DeliveryTable[];
  requestedChannels?: string[];
}): { tables: DeliveryTable[]; notes: string[]; messageSuffix: string } {
  return applyDeliveryReconcile({ ...input, mode: "zero_fill" });
}

export function applyDeliveryReconcile(input: {
  tables: DeliveryTable[];
  requestedChannels?: string[];
  mode?: DeliveryMode;
}): { tables: DeliveryTable[]; notes: string[]; messageSuffix: string } {
  const mode: DeliveryMode = input.mode === "explain" ? "explain" : "zero_fill";
  const requested = [...new Set((input.requestedChannels || []).map(String).filter(Boolean))];
  if (!requested.length || !input.tables?.length) {
    return { tables: input.tables || [], notes: [], messageSuffix: "" };
  }

  const missing = missingRequestedChannels(input.tables, requested);
  if (!missing.length) {
    return { tables: input.tables, notes: [], messageSuffix: "" };
  }

  if (mode === "explain") {
    const notes = missing.map((ch) => `delivery_explain:channel:${ch}`);
    const messageSuffix = `\uff08\u672a\u51fa\u73b0\uff1a${missing.join(", ")}\uff08\u533a\u95f4\u5185\u65e0\u6570\u636e\uff09\uff09`;
    return { tables: input.tables, notes, messageSuffix };
  }

  const notes: string[] = [];
  const filledAll = new Set<string>();
  const tables = input.tables.map((table) => {
    const colIdx = findDimColIndex(table.cols || [], "channel");
    if (colIdx < 0) return table;
    const present = new Set<string>();
    for (const row of table.rows || []) {
      const v = row[colIdx];
      if (v != null && String(v) !== "") present.add(String(v));
    }
    const tableMissing = requested.filter(
      (ch) => ![...present].some((p) => p.toLowerCase() === ch.toLowerCase()),
    );
    if (!tableMissing.length) return table;

    const newRows = [...(table.rows || [])];
    for (const ch of tableMissing) {
      const row: unknown[] = table.cols.map((_, i) => {
        if (i === colIdx) return ch;
        if (isNumericCol(table.rows || [], i)) return 0;
        return null;
      });
      newRows.push(row);
      filledAll.add(ch);
      notes.push(`delivery_zero_fill:channel:${ch}`);
    }
    return { ...table, rows: newRows };
  });

  const messageSuffix = filledAll.size
    ? `\uff08\u5df2\u4e3a\u7f3a\u5931\u6e20\u9053\u8865 0\uff1a${[...filledAll].join(", ")}\uff09`
    : "";
  return { tables, notes, messageSuffix };
}
