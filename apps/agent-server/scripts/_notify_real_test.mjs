import fs from "node:fs";
import { buildScheduleDelivery, deliverToChannels } from "../src/notify/deliver.ts";
import { getChannel as loadChannel } from "../src/notify/channels.ts";

// 真实通道
const channel = loadChannel("dingtalk");
if (!channel) {
  console.error("未找到 dingtalk 通道");
  process.exit(1);
}

// 模拟「监测任务」的图表 + 正文（用真实会话，验证「打开对话」能落到有内容的对话）
const delivery = buildScheduleDelivery({
  name: "INGoogle8,INGoogle10 渠道监测",
  prompt: "INGoogle8,INGoogle10 渠道监测",
  status: "success",
  text: "本次监测完成，各渠道注册量如下。",
  conversationId: "conv_1789958040402_k0l0kz",
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:5173",
  ownerKey: "253fdd3a-7891-45fd-997c-3b5d1277421b",
  charts: [
    {
      title: "近 7 日来源结构",
      data: [
        { dt: "09-16", src: "Facebook", n: 1234 },
        { dt: "09-17", src: "Facebook", n: 1502 },
        { dt: "09-18", src: "TikTok", n: 980 },
        { dt: "09-19", src: "TikTok", n: 1103 },
      ],
    },
  ],
  locale: "zh",
});

console.log("===== 即将发送的正文 =====");
console.log(delivery.body);
console.log("==========================");

console.log("===== 实际生成的『打开对话』链接 =====");
for (const l of delivery.links || []) console.log(`${l.title} -> ${l.url}`);
console.log("=====================================");

const summary = await deliverToChannels([channel], delivery);
console.log("SENT:", summary.sent, "OK:", summary.ok, "ERROR:", summary.error ?? "无");

// 顺带用 webview 视角（带 owner）核实链接指向的会话能解析到、且含图表
if (summary.ok && delivery.links?.[0]?.url) {
  try {
    const base = process.env.WEB_ORIGIN || "http://localhost:8787";
    const res = await fetch(`${base}/chat/conversations?owner=${encodeURIComponent("253fdd3a-7891-45fd-997c-3b5d1277421b")}`, {
      headers: { "Content-Type": "application/json" },
    });
    const j = await res.json();
    const c = (j.conversations || []).find((x) => x.id === "conv_1789958040402_k0l0kz");
    console.log("[webview 验证] HTTP", res.status, "找到会话:", !!c, c ? `消息数=${(c.messages || []).length} 含图表=${(c.messages || []).filter((m) => (m.charts || []).length).length}` : "");
  } catch (e) {
    console.log("[webview 验证] 跳过（本地服务未启动或不可达）:", String(e).slice(0, 80));
  }
}
process.exit(summary.ok ? 0 : 1);
