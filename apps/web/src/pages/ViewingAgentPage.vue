<script setup lang="ts">
import AgentPlaceholderPage from "../components/AgentPlaceholderPage.vue";

const page = {
  title: { zh: "观影助手 Agent", en: "Viewing Agent", pt: "Agent de Visualizacao", hi: "व्यूइंग एजेंट" },
  kicker: { zh: "方案已定 · 页面先行", en: "Spec Ready · UI Placeholder", pt: "Especificacao pronta · Placeholder", hi: "स्पेक तैयार · UI प्लेसहोल्डर" },
  lead: {
    zh: "该 Agent 已纳入门户入口，但当前版本先提供能力说明与产品位置，不伪造完整工作台。后续接入真实 Worker、登录策略和交互流程后，再升级为正式页面。",
    en: "This agent is now represented in the portal, but this version intentionally stops at capability overview and product positioning. The full workspace should arrive only after its worker, auth model, and interaction flow are implemented.",
    pt: "Este agente ja aparece no portal, mas esta versao se limita a explicar o posicionamento e as capacidades planejadas. O workspace completo so deve chegar quando worker, autenticacao e fluxo real forem implementados.",
    hi: "यह एजेंट अब पोर्टल में मौजूद है, लेकिन यह संस्करण जानबूझकर केवल क्षमता परिचय और उत्पाद स्थिति तक सीमित है। पूरा वर्कस्पेस तभी जोड़ा जाएगा जब इसका worker, auth model और interaction flow लागू हो जाए।",
  },
  bullets: [
    { zh: "目标：面向观影场景的独立 Agent 入口", en: "Goal: independent entry for viewing workflows", pt: "Objetivo: entrada independente para fluxos de visualizacao", hi: "लक्ष्य: व्यूइंग वर्कफ़्लो के लिए स्वतंत्र प्रवेश" },
    { zh: "现状：文档方案已存在，代码能力尚未完整落地", en: "Status: design exists, implementation is not complete yet", pt: "Status: o desenho existe, a implementacao ainda nao esta completa", hi: "स्थिति: डिजाइन मौजूद है, इम्प्लीमेंटेशन अभी पूर्ण नहीं है" },
    { zh: "原则：不做假登录、不做假工作台", en: "Principle: no fake login and no fake workspace", pt: "Principio: sem login falso e sem workspace falso", hi: "सिद्धांत: नकली लॉगिन नहीं, नकली वर्कस्पेस नहीं" },
  ],
} as const;
</script>

<template>
  <AgentPlaceholderPage v-bind="page" />
</template>
