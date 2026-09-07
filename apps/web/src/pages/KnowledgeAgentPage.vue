<script setup lang="ts">
import AgentPlaceholderPage from "../components/AgentPlaceholderPage.vue";

const page = {
  title: { zh: "知识库 / RAG Agent", en: "Knowledge / RAG Agent", pt: "Agent de Conhecimento / RAG", hi: "नॉलेज / RAG एजेंट" },
  kicker: { zh: "知识检索入口 · 占位页", en: "Knowledge entry · Placeholder", pt: "Entrada de conhecimento · Placeholder", hi: "नॉलेज एंट्री · प्लेसहोल्डर" },
  lead: {
    zh: "该 Agent 用于承接知识库、制度、流程、文档检索类能力。当前版本先占住产品入口，并明确能力范围；等独立工作台、登录策略与检索交互整理完成后，再升级为正式 RAG Agent 页面。",
    en: "This agent is reserved for knowledge-base, policy, process, and document retrieval workflows. For now it exists as a product entry and capability placeholder. It should become a full RAG workspace only after its standalone UX, auth rules, and retrieval flow are ready.",
    pt: "Este agente e reservado para fluxos de base de conhecimento, politicas, processos e busca documental. Por enquanto ele existe como entrada de produto e placeholder de capacidades. O workspace completo de RAG so deve chegar quando UX, autenticacao e fluxo de recuperacao estiverem prontos.",
    hi: "यह एजेंट नॉलेज बेस, नीति, प्रक्रिया और दस्तावेज़ खोज वर्कफ़्लो के लिए आरक्षित है। अभी यह उत्पाद प्रवेश और क्षमता प्लेसहोल्डर के रूप में रहेगा। पूरा RAG वर्कस्पेस तभी आएगा जब इसका स्वतंत्र UX, auth rules और retrieval flow तैयार हो जाए।",
  },
  bullets: [
    { zh: "定位：独立的知识库 / RAG Agent 产品入口", en: "Positioning: standalone product entry for a knowledge / RAG agent", pt: "Posicionamento: entrada de produto independente para um agente de conhecimento / RAG", hi: "स्थिति: नॉलेज / RAG एजेंट के लिए स्वतंत्र उत्पाद प्रवेश" },
    { zh: "当前不伪造可用工作台，只展示入口与边界", en: "This page intentionally does not fake a working workspace", pt: "Esta pagina intencionalmente nao finge um workspace funcional", hi: "यह पृष्ठ जानबूझकर कार्यशील वर्कस्पेस का दिखावा नहीं करता" },
    { zh: "后续可承接本地文档、制度流程、企业知识库等检索能力", en: "It can later host local docs, policy/process lookup, and enterprise knowledge retrieval", pt: "No futuro pode hospedar documentos locais, consulta de politicas/processos e recuperacao de conhecimento empresarial", hi: "आगे चलकर यह local docs, policy/process lookup और enterprise knowledge retrieval को संभाल सकता है" },
  ],
} as const;
</script>

<template>
  <AgentPlaceholderPage v-bind="page" />
</template>
