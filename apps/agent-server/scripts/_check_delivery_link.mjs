import { buildScheduleDelivery } from "../src/notify/deliver.ts";

const msg = buildScheduleDelivery({
  name: "测试-1",
  prompt: "INGoogle8,INGoogle10两个渠道...",
  status: "success",
  text: "已完成监测。",
  conversationId: "conv_1789958040402_k0l0kz",
  webOrigin: "http://localhost:5173",
  locale: "zh",
  ownerKey: "253fdd3a-7891-45fd-997c-3b5d1277421b",
});

console.log(JSON.stringify(msg, null, 2));
