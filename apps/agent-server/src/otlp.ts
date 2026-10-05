/**
 * OTLP/HTTP 导出（P2 可观测互操作性）。
 *
 * 缺口：span 已经挂上了 OTel GenAI 标准属性（`gen_ai.*`），但数据只在自家 JSONL 里——
 * 接不进任何标准后端。这里补齐「导出」这一格：把 run / span 转成 OTLP/HTTP **JSON** 编码，
 * POST 给 Collector（或任何兼容 /v1/traces 的后端）。
 *
 * 取舍：
 * - **只做 JSON 编码**，不做 protobuf：单机规模下 JSON 足够，protobuf 要引入编解码依赖，不值。
 * - **默认关闭**（未配 `OTEL_EXPORTER_OTLP_ENDPOINT` 时完全不发请求），零行为变化。
 * - **完全异步、best-effort**：导出失败只告警，绝不阻断对话、绝不重试风暴（单次超时 5s）。
 * - traceId / spanId 由 runId 稳定派生（同一 run 多次导出得到同一 id，可去重）。
 */
import { createHash } from "node:crypto";
import { listSpanTraces } from "./trace.js";
import type { RunTrace } from "./trace.js";

export interface OtlpConfig {
  endpoint?: string;
  headers: Record<string, string>;
  serviceName: string;
}

/** 每次现读（可测试、可即时生效）。 */
export function otlpConfig(): OtlpConfig {
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim().replace(/\/+$/, "");
  const serviceName = (process.env.OTEL_SERVICE_NAME || "bx-admin-agent").trim() || "bx-admin-agent";
  const headers: Record<string, string> = {};
  // 标准格式：`key1=value1,key2=value2`
  for (const part of (process.env.OTEL_EXPORTER_OTLP_HEADERS || "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) headers[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { ...(endpoint ? { endpoint } : {}), headers, serviceName };
}

/** 稳定派生 32 hex 的 traceId。 */
function traceIdOf(runId: string): string {
  return createHash("sha256").update(`trace:${runId}`).digest("hex").slice(0, 32);
}
/** 稳定派生 16 hex 的 spanId。 */
function spanIdOf(seed: string): string {
  return createHash("sha256").update(`span:${seed}`).digest("hex").slice(0, 16);
}

type AttrValue = string | number | boolean;

/** OTLP 属性值：三种形态互斥，故都写成可选字段（JSON 里只出现一个）。 */
export interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; doubleValue?: number; boolValue?: boolean };
}

function toOtlpAttrs(record: Record<string, AttrValue>): OtlpAttribute[] {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, v]): OtlpAttribute => ({
      key,
      value:
        typeof v === "number"
          ? { doubleValue: v }
          : typeof v === "boolean"
            ? { boolValue: v }
            : { stringValue: String(v) },
    }));
}

export interface OtlpSpanInput {
  runId: string;
  /** span 名（工具名 / 模型 id / `chat run`）。 */
  name: string;
  /** 起始毫秒时间戳。 */
  at: number;
  durationMs: number;
  /** 已按 OTel GenAI 语义命名的属性。 */
  attrs?: Record<string, AttrValue>;
  failed?: boolean;
}

/** 纯函数：把若干 span 组装成 OTLP/HTTP JSON body（可测试，不发请求）。 */
export function buildOtlpPayload(
  spans: OtlpSpanInput[],
  config: OtlpConfig,
  runAttrs: Record<string, Record<string, AttrValue>> = {},
): unknown {
  const grouped = new Map<string, OtlpSpanInput[]>();
  for (const span of spans) {
    const list = grouped.get(span.runId) || [];
    list.push(span);
    grouped.set(span.runId, list);
  }
  const resourceSpans = [...grouped.entries()].map(([runId, list]) => {
    const traceId = traceIdOf(runId);
    const parentSpanId = spanIdOf(`${runId}:run`);
    const otlpSpans = [
      // 父 span：代表这次 run 本身（与子 span 同 traceId，形成一条链）
      {
        traceId,
        spanId: parentSpanId,
        name: "chat run",
        kind: 1 /* SPAN_KIND_INTERNAL */,
        startTimeUnixNano: String(Math.min(...list.map((s) => s.at)) * 1e6),
        endTimeUnixNano: String(Math.max(...list.map((s) => s.at + s.durationMs)) * 1e6),
        attributes: toOtlpAttrs({
          ...(runAttrs[runId] || {}),
          "gen_ai.conversation.id": runId,
          "service.name": config.serviceName,
        }),
        status: {},
      },
      ...list.map((span, i) => ({
        traceId,
        spanId: spanIdOf(`${runId}:${i}:${span.name}`),
        parentSpanId,
        name: span.name,
        kind: 1,
        startTimeUnixNano: String(span.at * 1e6),
        endTimeUnixNano: String((span.at + span.durationMs) * 1e6),
        attributes: toOtlpAttrs(span.attrs || {}),
        status: span.failed ? { code: 2 /* STATUS_CODE_ERROR */ } : { code: 1 /* STATUS_CODE_OK */ },
      })),
    ];
    return {
      resource: {
        attributes: toOtlpAttrs({ "service.name": config.serviceName }),
      },
      scopeSpans: [{ scope: { name: "bx-admin-agent" }, spans: otlpSpans }],
    };
  });
  return { resourceSpans };
}

/**
 * 导出一次 run 的 span（best-effort）。未配置端点时直接返回，不发任何请求。
 * 调用方应「发了就忘」（void），不要 await 到对话主链路上。
 */
export async function exportSpansOtlp(spans: OtlpSpanInput[]): Promise<boolean> {
  const config = otlpConfig();
  if (!config.endpoint || !spans.length) return false;
  const url = `${config.endpoint}/v1/traces`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(buildOtlpPayload(spans, config)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[otlp] 导出失败：HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[otlp] 导出异常：${String((err as Error)?.message || err)}`);
    return false;
  }
}

/**
 * 导出一次 run：run 级属性 + 该 run 的全部 span。
 * 没有 span（如被配额拦下、校验即失败的运行）就不导出——没有可导出的调用链。
 */
export async function exportRunOtlp(rt: RunTrace): Promise<boolean> {
  const config = otlpConfig();
  if (!config.endpoint) return false;
  const spans = listSpanTraces(rt.runId, 200);
  if (!spans.length) return false;
  const runAttrs: Record<string, Record<string, AttrValue>> = {
    [rt.runId]: {
      ...(rt.model ? { "gen_ai.request.model": rt.model } : {}),
      ...(rt.release ? { "service.version": rt.release } : {}),
      ...(typeof rt.rounds === "number" ? { "bx_agent.rounds": rt.rounds } : {}),
      ...(typeof rt.tokens === "number" ? { "gen_ai.usage.total_tokens": rt.tokens } : {}),
      "bx_agent.status": rt.status,
    },
  };
  const inputs: OtlpSpanInput[] = spans.map((span) => ({
    runId: rt.runId,
    name: span.name || span.kind,
    at: span.at,
    durationMs: span.durationMs,
    ...(span.attrs ? { attrs: span.attrs } : {}),
    failed: span.ok === false,
  }));
  return exportSpansOtlpWithAttrs(inputs, config, runAttrs);
}

async function exportSpansOtlpWithAttrs(
  spans: OtlpSpanInput[],
  config: OtlpConfig,
  runAttrs: Record<string, Record<string, AttrValue>>,
): Promise<boolean> {
  if (!config.endpoint || !spans.length) return false;
  try {
    const res = await fetch(`${config.endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(buildOtlpPayload(spans, config, runAttrs)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[otlp] 导出失败：HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[otlp] 导出异常：${String((err as Error)?.message || err)}`);
    return false;
  }
}
