import type { BaselineKind, BaselineLogic, RuleSet } from "./types.js";

export interface ScanMetricRow {
  entityKey: string;
  scanValue: number | null;
  dodValue: number | null;
  wowValue: number | null;
  sample?: number;
}

export interface ThresholdChildAlert {
  entityKey: string;
  baseline: BaselineKind;
  ratio: number;
  delta: number;
  message: string;
}

export type ThresholdSeverity = "info" | "warn" | "critical" | null;

export interface ThresholdResult {
  severity: ThresholdSeverity;
  parentMessage: string;
  children: ThresholdChildAlert[];
  quietReasons: string[];
}

interface BaselineBreak {
  baseline: BaselineKind;
  ratio: number;
  delta: number;
}

function baselineValue(row: ScanMetricRow, kind: BaselineKind): number | null {
  return kind === "dod" ? row.dodValue : row.wowValue;
}

function isMissingNumber(value: number | null | undefined): boolean {
  return value === null || value === undefined || Number.isNaN(value);
}

function isValidBaseline(value: number | null | undefined): value is number {
  return !isMissingNumber(value) && value !== 0;
}

function checkBaseline(
  scan: number,
  baselineKind: BaselineKind,
  baseline: number,
  thresholdRatio: number,
  minAbsDelta: number,
): BaselineBreak | null {
  const ratio = scan / baseline;
  const delta = scan - baseline;
  if (ratio < thresholdRatio && Math.abs(delta) >= minAbsDelta) {
    return { baseline: baselineKind, ratio, delta };
  }
  return null;
}

function pickWorstBreak(breaks: BaselineBreak[]): BaselineBreak {
  return breaks.reduce((worst, current) =>
    current.ratio < worst.ratio ? current : worst,
  );
}

function formatPct(ratio: number): string {
  const drop = (1 - ratio) * 100;
  return `${drop.toFixed(1)}%`;
}

function formatChildMessage(
  entityKey: string,
  scan: number,
  br: BaselineBreak,
): string {
  const baselineLabel = br.baseline === "dod" ? "日环比" : "周同比";
  const before = scan - br.delta;
  return (
    `${entityKey}：${baselineLabel}相对下降 ${formatPct(br.ratio)}` +
    `（${before} → ${scan}，ratio=${br.ratio.toFixed(3)}）`
  );
}

function evaluateEntityBreaks(
  row: ScanMetricRow,
  ruleSet: RuleSet,
): { quietReason?: string; break?: BaselineBreak } {
  if (isMissingNumber(row.scanValue)) {
    return { quietReason: `${row.entityKey}：scan 值为空` };
  }

  const sample = row.sample ?? row.scanValue;
  if (isMissingNumber(sample) || sample < ruleSet.minSample) {
    return {
      quietReason: `${row.entityKey}：样本量 ${sample ?? "未知"} < minSample ${ruleSet.minSample}`,
    };
  }

  const scan = row.scanValue;
  const baselineBreaks: BaselineBreak[] = [];

  for (const kind of ruleSet.baselines) {
    const value = baselineValue(row, kind);
    if (!isValidBaseline(value)) {
      continue;
    }
    const br = checkBaseline(scan, kind, value, ruleSet.thresholdRatio, ruleSet.minAbsDelta);
    if (br) {
      baselineBreaks.push(br);
    }
  }

  const validBaselineCount = ruleSet.baselines.filter((kind) =>
    isValidBaseline(baselineValue(row, kind)),
  ).length;

  if (validBaselineCount === 0) {
    return { quietReason: `${row.entityKey}：基线缺失` };
  }

  const breaks = applyBaselineLogic(baselineBreaks, ruleSet.baselineLogic, ruleSet.baselines, row);
  if (!breaks.length) {
    return {};
  }

  return { break: pickWorstBreak(breaks) };
}

function applyBaselineLogic(
  breaks: BaselineBreak[],
  logic: BaselineLogic,
  configuredBaselines: BaselineKind[],
  row: ScanMetricRow,
): BaselineBreak[] {
  if (logic === "any") {
    return breaks;
  }

  const available = configuredBaselines.filter((kind) =>
    isValidBaseline(baselineValue(row, kind)),
  );
  if (available.length !== configuredBaselines.length) {
    return [];
  }

  const brokenKinds = new Set(breaks.map((b) => b.baseline));
  return configuredBaselines.every((kind) => brokenKinds.has(kind)) ? breaks : [];
}

/**
 * Pure threshold evaluation: quiet rules (§9.5) + warn/critical aggregation (§9.6).
 * No Metabase / freshness — caller supplies metric rows.
 */
export function evaluateThreshold(
  ruleSet: RuleSet,
  rows: ScanMetricRow[],
): ThresholdResult {
  const quietReasons: string[] = [];
  const entityBreaks: Array<{ entityKey: string; scan: number; br: BaselineBreak }> = [];

  if (rows.length === 0) {
    return {
      severity: null,
      parentMessage: `${ruleSet.id} 巡检：无实体数据`,
      children: [],
      quietReasons: ["empty"],
    };
  }

  for (const row of rows) {
    const result = evaluateEntityBreaks(row, ruleSet);
    if (result.quietReason) {
      quietReasons.push(result.quietReason);
      continue;
    }
    if (result.break && !isMissingNumber(row.scanValue)) {
      entityBreaks.push({
        entityKey: row.entityKey,
        scan: row.scanValue,
        br: result.break,
      });
    }
  }

  if (entityBreaks.length === 0) {
    const severity: ThresholdSeverity = quietReasons.length > 0 ? "info" : null;
    const parentMessage =
      quietReasons.length > 0
        ? `${ruleSet.id} 巡检：数据不足或未破线，未触发 warn（${quietReasons.length} 条安静原因）`
        : `${ruleSet.id} 巡检：未检测到异常`;
    return { severity, parentMessage, children: [], quietReasons };
  }

  entityBreaks.sort((a, b) => a.br.ratio - b.br.ratio);

  const warnCount = entityBreaks.length;
  const severity: ThresholdSeverity =
    warnCount >= ruleSet.criticalEntityCount ? "critical" : "warn";

  const capped = entityBreaks.slice(0, ruleSet.maxChildAlerts);
  const overflow = warnCount - capped.length;

  const children: ThresholdChildAlert[] = capped.map(({ entityKey, scan, br }) => ({
    entityKey,
    baseline: br.baseline,
    ratio: br.ratio,
    delta: br.delta,
    message: formatChildMessage(entityKey, scan, br),
  }));

  const levelLabel = severity === "critical" ? "critical" : "warn";
  let parentMessage =
    `${ruleSet.id} 巡检：${warnCount} 个实体相对基线下降超过阈值（ratio < ${ruleSet.thresholdRatio}，` +
    `≥${ruleSet.criticalEntityCount} 个升 critical）`;
  if (overflow > 0) {
    parentMessage += `；展示前 ${ruleSet.maxChildAlerts} 个，另有 ${overflow} 个细分`;
  }
  parentMessage += `（${levelLabel}）`;

  return { severity, parentMessage, children, quietReasons };
}
