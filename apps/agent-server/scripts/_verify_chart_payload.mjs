import { buildScheduleDelivery } from "../src/notify/deliver.ts";

const m = buildScheduleDelivery({
  name: "测试-1",
  prompt: "INGoogle8,INGoogle10 渠道监测",
  status: "success",
  text: "以上为完整监测结果。",
  conversationId: "conv_x",
  webOrigin: "http://localhost:5173",
  ownerKey: "owner_y",
  charts: [
    { title: "来源结构", data: [{ dt: "09-21", src: "Facebook", n: 567 }, { dt: "09-20", src: "Facebook", n: 1893 }] },
    { data: { nodes: [{ id: "a" }], edges: [] } },
  ],
  locale: "zh",
});

console.log("TITLE:", m.title);
console.log("BODY:\n" + m.body);
console.log("LINKS:", JSON.stringify(m.links));
