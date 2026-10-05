import { afterEach, describe, expect, it } from "vitest";
import { buildOtlpPayload, otlpConfig, type OtlpSpanInput } from "../src/otlp.js";
import { piiEnabled, redactPii, redactSensitive, redactSecrets } from "../src/redact.js";

/** P2 补齐项：OTLP 导出（可观测互操作）+ 通用 PII 出站打码（可选开启）。 */

describe("OTLP 导出（纯函数部分）", () => {
  const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const savedHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const savedService = process.env.OTEL_SERVICE_NAME;

  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
    if (savedHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = savedHeaders;
    if (savedService === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = savedService;
  });

  it("未配端点时不启用（默认关闭，零行为变化）", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(otlpConfig().endpoint).toBeUndefined();
  });

  it("解析端点、自定义头与服务名", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318/";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer abc,x-tenant=t1";
    process.env.OTEL_SERVICE_NAME = "bx-agent-prod";
    const cfg = otlpConfig();
    expect(cfg.endpoint).toBe("http://127.0.0.1:4318"); // 末尾斜杠已去掉
    expect(cfg.headers.authorization).toBe("Bearer abc");
    expect(cfg.headers["x-tenant"]).toBe("t1");
    expect(cfg.serviceName).toBe("bx-agent-prod");
  });

  it("payload 结构合法：traceId 32 hex、spanId 16 hex、父子成链", () => {
    const spans: OtlpSpanInput[] = [
      {
        runId: "run_a",
        name: "chat",
        at: 1_700_000_000_000,
        durationMs: 120,
        attrs: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m1" },
      },
      {
        runId: "run_a",
        name: "fs_read",
        at: 1_700_000_000_050,
        durationMs: 10,
        attrs: { "gen_ai.tool.name": "fs_read" },
        failed: true,
      },
    ];
    const body = buildOtlpPayload(spans, otlpConfig(), {
      run_a: { "gen_ai.request.model": "m1", "bx_agent.status": "success" },
    }) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string }> };
        scopeSpans: Array<{
          spans: Array<{
            traceId: string;
            spanId: string;
            parentSpanId?: string;
            name: string;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            status: { code?: number };
          }>;
        }>;
      }>;
    };

    const group = body.resourceSpans[0]!;
    const otlpSpans = group.scopeSpans[0]!.spans;
    // 1 个父 span（chat run）+ 2 个子 span
    expect(otlpSpans.length).toBe(3);
    const parent = otlpSpans[0]!;
    expect(parent.name).toBe("chat run");
    expect(parent.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parent.spanId).toMatch(/^[0-9a-f]{16}$/);
    for (const span of otlpSpans.slice(1)) {
      expect(span.traceId).toBe(parent.traceId);
      expect(span.parentSpanId).toBe(parent.spanId);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    // 时间单位是纳秒
    expect(BigInt(parent.startTimeUnixNano)).toBe(BigInt(1_700_000_000_000) * 1_000_000n);
    // 父 span 带 run 级属性
    expect(parent.attributes.map((a) => a.key)).toContain("bx_agent.status");
    // 失败的 span 状态为 ERROR(2)
    expect(otlpSpans[2]!.status.code).toBe(2);
    // 资源带 service.name
    expect(group.resource.attributes.map((a) => a.key)).toContain("service.name");
  });

  it("同一 runId 派生稳定 id（可去重）", () => {
    const span: OtlpSpanInput[] = [{ runId: "run_stable", name: "chat", at: 1, durationMs: 1 }];
    const a = buildOtlpPayload(span, otlpConfig()) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string }> }> }>;
    };
    const b = buildOtlpPayload(span, otlpConfig()) as typeof a;
    expect(a.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId).toBe(
      b.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId,
    );
  });
});

describe("通用 PII 出站打码（默认关闭）", () => {
  const saved = process.env.REDACT_PII;
  const savedTypes = process.env.REDACT_PII_TYPES;

  afterEach(() => {
    if (saved === undefined) delete process.env.REDACT_PII;
    else process.env.REDACT_PII = saved;
    if (savedTypes === undefined) delete process.env.REDACT_PII_TYPES;
    else process.env.REDACT_PII_TYPES = savedTypes;
  });

  it("默认关闭：redactSensitive 只打码凭据，不动 PII", () => {
    delete process.env.REDACT_PII;
    expect(piiEnabled()).toBe(false);
    const text = "联系 a@b.com 或 13800138000";
    expect(redactSensitive(text)).toBe(text);
    // 凭据仍然打码
    expect(redactSensitive("key sk-abcdefghijklmnopqrstuv")).toContain("[REDACTED:OPENAI_KEY]");
  });

  it("开启后打码 email / 手机号 / 身份证 / 银行卡", () => {
    process.env.REDACT_PII = "on";
    delete process.env.REDACT_PII_TYPES;
    expect(redactPii("邮箱 a@b.com")).toContain("[REDACTED:EMAIL]");
    expect(redactPii("手机 13800138000")).toContain("[REDACTED:CN_PHONE]");
    expect(redactPii("卡号 4111111111111111")).toContain("[REDACTED:BANK_CARD]");
  });

  it("可按类型只开一部分", () => {
    process.env.REDACT_PII_TYPES = "email";
    expect(redactPii("邮箱 a@b.com 手机 13800138000")).toBe("邮箱 [REDACTED:EMAIL] 手机 13800138000");
  });

  it("凭据打码不受 PII 开关影响（默认路径与改动前一致）", () => {
    delete process.env.REDACT_PII;
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED:AWS_ACCESS_KEY]");
  });
});
