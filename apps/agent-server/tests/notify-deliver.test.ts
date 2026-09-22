// 结果投递的纯逻辑覆盖（无需网络/真实机器人）：签名算法、载荷形状、成功/失败判定、
// Markdown→IM 排版、通道入参校验。真实 webhook 连通性由 /notify/channels/:id/test 端点人工验一次。
import { test, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildScheduleDelivery,
  dingtalkSign,
  feishuSign,
  formatForIm,
  sendToChannel,
  chartToLines,
  type DeliveryLang,
} from "../src/notify/deliver.js";
import { hostOf, validateChannelInput, type NotifyChannel } from "../src/notify/channels.js";

const channel = (over: Partial<NotifyChannel> = {}): NotifyChannel => ({
  id: "ch_test",
  kind: "dingtalk",
  label: "T",
  webhook: "https://oapi.dingtalk.com/robot/send?access_token=tok",
  createdAt: 0,
  ...over,
});

/** 记录请求的假 fetch：返回平台形状的成功响应。 */
function fakeFetch(body: unknown = { errcode: 0, errmsg: "ok" }) {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), payload: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("[A] 加签：钉钉/飞书算法不同且可复算（钉钉需 URL 编码）", () => {
  const ts = 1700000000000;
  const secret = "SECabc";
  // 钉钉：base64(HMAC-SHA256(secret, `${ts}\n${secret}`)) + urlencode
  const dtRaw = createHmac("sha256", secret).update(`${ts}\n${secret}`, "utf-8").digest("base64");
  expect(dingtalkSign(secret, ts)).toBe(encodeURIComponent(dtRaw));
  // 飞书：拼接串当密钥、待签数据为空字符串
  const fsRaw = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
  expect(feishuSign(secret, ts)).toBe(fsRaw);
  expect(dingtalkSign(secret, ts)).not.toBe(feishuSign(secret, ts));
});

test("[B] 钉钉：无按钮走 markdown，有按钮走 actionCard（驼峰字段 + btns），加签进 query", async () => {
  const { calls, impl } = fakeFetch();
  await sendToChannel(channel({ secret: "S" }), { title: "T", body: "B" }, { fetchImpl: impl, now: 123 });
  const plain = calls[0]!;
  expect(plain.payload.msgtype).toBe("markdown");
  expect(plain.url).toContain("timestamp=123");
  expect(plain.url).toContain(`sign=${encodeURIComponent(dingtalkSign("S", 123))}`);

  const withLinks = fakeFetch();
  await sendToChannel(
    channel(),
    { title: "T", body: "B", links: [{ title: "打开", url: "https://x/y" }] },
    { fetchImpl: withLinks.impl },
  );
  const payload = withLinks.calls[0]!.payload as { msgtype: string; actionCard: { btns: unknown[] } };
  expect(payload.msgtype).toBe("actionCard");
  // 自定义机器人的形状是驼峰 actionCard + btns[{title, actionURL}]（员工服务台机器人才是 action_card）。
  expect(payload.actionCard.btns[0]).toEqual({ title: "打开", actionURL: "https://x/y" });
});

test("[C] 飞书：走交互卡片，密钥进载荷，判定 code 而非 errcode", async () => {
  const { calls, impl } = fakeFetch({ code: 0, msg: "success" });
  await sendToChannel(
    channel({ kind: "feishu", webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/tok", secret: "S" }),
    { title: "T", body: "B" },
    { fetchImpl: impl, now: 55 },
  );
  const { payload } = calls[0]!;
  expect(payload.msg_type).toBe("interactive");
  expect(payload.timestamp).toBe("55");
  expect(payload.sign).toBe(feishuSign("S", 55));
});

test("[D] 平台拒收：HTTP 200 但错误码非 0 必须抛错（关键词/签名配错的典型场景）", async () => {
  const ding = fakeFetch({ errcode: 310000, errmsg: "keywords not in content" });
  await expect(
    sendToChannel(channel(), { title: "T", body: "B" }, { fetchImpl: ding.impl }),
  ).rejects.toThrow(/310000/);

  const feishu = fakeFetch({ code: 19021, msg: "sign match fail" });
  await expect(
    sendToChannel(channel({ kind: "feishu" }), { title: "T", body: "B" }, { fetchImpl: feishu.impl }),
  ).rejects.toThrow(/19021/);
});

test("[E] 关键词安全设置：正文/标题自动补关键词（平台要求消息含指定词）", async () => {
  const { calls, impl } = fakeFetch();
  await sendToChannel(channel({ keyword: "bx-agent" }), { title: "标题", body: "正文" }, { fetchImpl: impl });
  const payload = calls[0]!.payload as { markdown: { title: string; text: string } };
  expect(payload.markdown.text).toContain("bx-agent");
  expect(payload.markdown.title).toContain("bx-agent");
});

test("[F] Markdown → IM：表格折成「列=值」行、跳过分隔行、超出部分如实注明", () => {
  const md = ["结果如下：", "", "| 名称 | 数量 |", "| --- | --- |", "| A | 1 |", "| B | 2 |"].join("\n");
  const out = formatForIm(md, "zh");
  expect(out).toContain("• 名称=A；数量=1");
  expect(out).toContain("• 名称=B；数量=2");
  // 分隔行不能变成数据行（否则 IM 里会出现一行 `---=---`）
  expect(out).not.toContain("---=");
  expect(out).toContain("结果如下：");
});

test("[G] 超长正文截断并注明（钉钉/飞书都有字节上限，宁可截断也不能被拒收）", () => {
  const out = formatForIm("x".repeat(5000), "zh");
  expect(out.length).toBeLessThan(5000);
  expect(out).toContain("已截断");
  const en = formatForIm("x".repeat(5000), "en");
  expect(en).toContain("truncated");
});

test("[H] 结果通知：标题=任务名+状态、正文带时间、按钮带对话链接；无 webOrigin 时不造按钮", () => {
  const msg = buildScheduleDelivery({
    name: "每日巡检",
    prompt: "巡检",
    status: "failed",
    text: "| a | b |\n| --- | --- |\n| 1 | 2 |",
    conversationId: "conv_1",
    webOrigin: "https://web.example.com/",
    locale: "zh",
  });
  expect(msg.title).toBe("每日巡检 · 失败");
  expect(msg.body).toContain("状态：失败");
  expect(msg.body).toContain("• a=1；b=2");
  expect(msg.links?.[0]?.url).toBe("https://web.example.com/chat?conv=conv_1");

  const noOrigin = buildScheduleDelivery({
    prompt: "巡检",
    status: "success",
    text: "ok",
    conversationId: "conv_1",
  });
  expect(noOrigin.links).toBeUndefined();
  expect(noOrigin.title).toBe("巡检 · 成功");
});

test("[I] 语言：四语状态词按 locale 前缀选择（认不出的回落中文）", () => {
  const cases: Array<[string, string]> = [
    ["en-US", "Success"],
    ["pt-BR", "Sucesso"],
    ["hi", "सफल"],
    ["zh-CN", "成功"],
    ["", "成功"],
  ];
  for (const [locale, expected] of cases) {
    const lang: DeliveryLang = locale.startsWith("en") ? "en" : locale.startsWith("pt") ? "pt" : locale.startsWith("hi") ? "hi" : "zh";
    const msg = buildScheduleDelivery({ prompt: "p", status: "success", text: "t", conversationId: "c", locale });
    expect(msg.title).toBe(`p · ${expected}`);
    expect(lang).toBeTruthy();
  }
});

test("[K] 图表数据折进正文：IM 渲染不了图，图里的数字必须一并送到（否则只剩一句收尾话）", () => {
  const msg = buildScheduleDelivery({
    name: "监测",
    prompt: "p",
    status: "success",
    text: "以上为完整监测结果。",
    conversationId: "conv_1",
    charts: [
      { title: "来源结构", data: [{ dt: "09-21", source: "Facebook", n: 567 }, { dt: "09-20", source: "Facebook", n: 1893 }] },
      { data: { nodes: [{ id: "a" }], edges: [] } }, // 无标题 + 非表格形态
    ],
    locale: "zh",
  });
  expect(msg.body).toContain("本次图表数据（2 张");
  expect(msg.body).toContain("### 来源结构");
  expect(msg.body).toContain("• dt=09-21；source=Facebook；n=567");
  // 无标题回落通用词、非表格形态原样预览（不做猜测式排版）
  expect(msg.body).toContain("### 图表");
  expect(msg.body).toContain("nodes");
  // 无图表时不留空标题
  const noChart = buildScheduleDelivery({ prompt: "p", status: "success", text: "t", conversationId: "c" });
  expect(noChart.body).not.toContain("本次图表数据");
});

test("[L] 图表折行：超出部分如实注明，空值不落", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ i, v: i % 2 ? "" : i }));
  const lines = chartToLines({ title: "T", data: rows }, "zh");
  expect(lines[1]).toBe("• i=0；v=0");
  expect(lines[2]).toBe("• i=1"); // 空值不落，避免出现一串 `v=`
  expect(lines.at(-1)).toBe("（表格共 9 行，此处仅列前 6 行）");
});

test("[J] 通道校验：只放行已知机器人域名（SSRF 出口必须堵住），自建网关需显式加白", () => {
  expect(hostOf("https://oapi.dingtalk.com/robot/send?access_token=x")).toBe("oapi.dingtalk.com");
  expect(hostOf("not-a-url")).toBe("");
  expect(validateChannelInput({ kind: "dingtalk", webhook: "https://oapi.dingtalk.com/robot/send?a=1" })).toBeNull();
  expect(validateChannelInput({ kind: "feishu", webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x" })).toBeNull();
  expect(validateChannelInput({ kind: "dingtalk", webhook: "http://127.0.0.1:9000/hook" })).toMatch(/域名不在允许列表/);
  expect(validateChannelInput({ kind: "http", webhook: "https://oapi.dingtalk.com/x" } as never)).toMatch(/类型非法/);
  expect(validateChannelInput({ kind: "dingtalk", webhook: "" })).toMatch(/必填/);
  // 显式加白后放行（自建网关场景）
  process.env.NOTIFY_ALLOWED_HOSTS = "hooks.internal.example";
  try {
    expect(validateChannelInput({ kind: "dingtalk", webhook: "https://hooks.internal.example/notify" })).toBeNull();
  } finally {
    delete process.env.NOTIFY_ALLOWED_HOSTS;
  }
  // 加白是按完整域名段匹配，不能被「后缀包含」绕过
  process.env.NOTIFY_ALLOWED_HOSTS = "example.com";
  try {
    expect(validateChannelInput({ kind: "dingtalk", webhook: "https://evilexample.com/x" })).toMatch(/域名不在允许列表/);
  } finally {
    delete process.env.NOTIFY_ALLOWED_HOSTS;
  }
});
