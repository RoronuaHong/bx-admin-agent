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

test("[B] 钉钉：无链接走 markdown；有链接走 actionCard（打开对话为按钮，dingtalk:// 内嵌打开），加签进 query", async () => {
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
  const payload = withLinks.calls[0]!.payload as {
    msgtype: string;
    actionCard: { singleTitle: string; singleURL: string; text: string };
  };
  expect(payload.msgtype).toBe("actionCard");
  expect(payload.actionCard.singleTitle).toBe("打开");
  // 按钮走 dingtalk://dingtalkclient/page/link：点击在钉钉内嵌 webview 打开，不跳系统浏览器
  expect(payload.actionCard.singleURL).toBe(
    "dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fx%2Fy&pc_slide=true",
  );
  // 正文仍是 markdown，且不再把链接折进正文（按钮承载跳转入口）
  expect(payload.actionCard.text).toBe("B");
  expect(payload.actionCard.text).not.toContain("dingtalk://");
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

test("[C2] 企业微信：markdown 单载荷、按钮折文内链接、不支持加签（secret 忽略）、判定 errcode", async () => {
  const { calls, impl } = fakeFetch();
  await sendToChannel(
    channel({ kind: "wecom", webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=tok", secret: "S" }),
    { title: "T", body: "B", links: [{ title: "打开对话", url: "https://x/y" }] },
    { fetchImpl: impl, now: 7 },
  );
  const { url, payload } = calls[0]!;
  // 企业微信机器人不支持加签：URL 不能拼 sign 参数，载荷也不带 sign
  expect(url).not.toContain("sign=");
  expect(payload).toEqual({
    msgtype: "markdown",
    markdown: { content: expect.stringContaining("[打开对话](https://x/y)") },
  });
  // 拒收判定与钉钉同形状：HTTP 200 + errcode 非 0 也必须抛错
  const rejected = fakeFetch({ errcode: 93000, errmsg: "invalid webhook url" });
  await expect(
    sendToChannel(
      channel({ kind: "wecom", webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=tok" }),
      { title: "T", body: "B" },
      { fetchImpl: rejected.impl },
    ),
  ).rejects.toThrow(/93000/);
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
  // 关键词贴在正文末尾，不要单独成段，否则钉钉卡片会把关键词当成结论。
  expect(payload.markdown.text).not.toContain("\n\nbx-agent");
  expect(payload.markdown.text.endsWith("bx-agent")).toBe(true);
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

test("[F2] IM 正文去掉工具轨迹，并躲开钉钉把下划线/方括号当格式符", () => {
  const md = [
    "[NORMAL]",
    "- 口径：country_code=IN",
    "",
    "[本轮已执行的工具]",
    '- mcp__zoho {"fields":"country_code"} → 92690 字符',
  ].join("\n");
  const out = formatForIm(md, "zh");
  expect(out).toContain("正常");
  expect(out).not.toContain("NORMAL");
  expect(out).toContain("country＿code=IN");
  expect(out).not.toContain("[本轮已执行的工具]");
  expect(out).not.toContain("92690");
  expect(out).not.toContain("_");
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
  expect(validateChannelInput({ kind: "wecom", webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" })).toBeNull();
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

test("[M0] 群消息用中文标识，不把工具字段和协议标记原样发出", () => {
  const out = formatForIm(
    [
      "[SPIKE]",
      "计数结果（工具返回）：complete:true，raw_rows 32 / unique 32",
      "小时桶（工具标注时区 Asia/Shanghai）：14:00 → 30",
      "阈值 above 10，over_count 1",
      "钉钉群推送：无法确认能否直接发到钉钉群",
      "[NORMAL] 未破线",
      "[NO_DATA]",
    ].join("\n"),
    "zh",
  );
  expect(out.startsWith("<font color=#E5484D>🔴 异常</font>")).toBe(true);
  expect(out).toContain("计数完整");
  expect(out).toContain("原始条数 32");
  expect(out).toContain("去重条数 32");
  expect(out).toContain("（上海）");
  expect(out).toContain("超过 10");
  expect(out).toContain("破线桶数 1");
  expect(out).toContain("<font color=#2F9E44>🟢 正常</font> 未破线");
  expect(out).toContain("<font color=#F5C518>🟡 警告</font>");
  expect(out).not.toMatch(/SPIKE|NORMAL|NO_DATA|complete|raw_rows|unique|above|over_count|钉钉群/);
});

test("[M] 推送正文：结论在前，记录项各自成段（钉钉会把单个换行粘成一行）", () => {
  const msg = buildScheduleDelivery({
    name: "印度对话量",
    prompt: "检查",
    status: "alert",
    text: "[SPIKE]\n最近 60 分钟 320，阈值 300",
    conversationId: "c",
    locale: "zh",
    trigger: "manual",
    durationMs: 8_000,
    at: Date.parse("2026-09-30T03:01:14Z"),
  });
  expect(msg.body.startsWith("# **任务：印度对话量**")).toBe(true);
  expect(msg.body).not.toContain("SPIKE");
  expect(msg.body.indexOf("任务：印度对话量")).toBeLessThan(msg.body.indexOf("🔴 异常"));
  expect(msg.body).toContain("\n\n状态：<font color=#E5484D>🔴 异常</font>");
  expect(msg.body).toContain("\n\n触发：手动执行");
  expect(msg.body).toContain("\n\n耗时：8 秒");
  expect(msg.title).toBe("印度对话量 · 异常");
});

test("[L] 任务名几乎全是问号时，标题和正文改用可读的「定时任务」", () => {
  const msg = buildScheduleDelivery({
    name: "??????",
    prompt: "????",
    status: "success",
    text: "已处理",
    conversationId: "c",
    locale: "zh",
  });
  expect(msg.title.startsWith("定时任务")).toBe(true);
  expect(msg.body.startsWith("# **任务：定时任务**")).toBe(true);
  expect(msg.body).not.toContain("????");
});
