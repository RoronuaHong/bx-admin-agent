<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { getUiLocale } from "../ui-locale";

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  "use-example": [text: string];
}>();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;

const dialogRef = ref<HTMLElement | null>(null);

function close() {
  open.value = false;
}

function pickExample(text: string) {
  emit("use-example", text);
  close();
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !open.value) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

watch(open, (v) => {
  document.body.style.overflow = v ? "hidden" : "";
  if (v) {
    window.addEventListener("keydown", onKey, true);
    nextTick(() => dialogRef.value?.querySelector<HTMLElement>(".cap-x")?.focus());
  } else {
    window.removeEventListener("keydown", onKey, true);
  }
});

onUnmounted(() => {
  document.body.style.overflow = "";
  window.removeEventListener("keydown", onKey, true);
});

/** 覆盖全场景：列表 / 详情 / 报表 / 导出 / 写操作 / 知识库（与 CAPABILITY_MATCH 验收话术对齐） */
const examples = [
  { zh: "需要看白名单管理的列表", en: "Show me the whitelist management list", pt: "Mostre a lista de gerenciamento da whitelist", hi: "मुझे व्हाइटलिस्ट प्रबंधन सूची दिखाओ" },
  { zh: "用户列表，10038557464768004，看详情", en: "User list, ID 10038557464768004, show details", pt: "Lista de usuarios, ID 10038557464768004, mostrar detalhes", hi: "यूज़र सूची, ID 10038557464768004, विवरण दिखाओ" },
  { zh: "登录数据统计，近7天，google登录方式和图表", en: "Login stats for the last 7 days, Google login method, with chart", pt: "Estatisticas de login dos ultimos 7 dias, metodo Google, com grafico", hi: "पिछले 7 दिनों के लॉगिन आँकड़े, Google लॉगिन विधि, चार्ट सहित" },
  { zh: "看平台收入趋势", en: "Show platform revenue trend", pt: "Mostre a tendencia de receita da plataforma", hi: "प्लेटफ़ॉर्म की राजस्व प्रवृत्ति दिखाओ" },
  { zh: "把白名单列表导出成 Excel", en: "Export the whitelist list to Excel", pt: "Exporte a lista da whitelist para Excel", hi: "व्हाइटलिस्ट सूची को Excel में निर्यात करो" },
  { zh: "帮我下架某部影片", en: "Help me unpublish a movie", pt: "Ajude-me a remover um filme do ar", hi: "किसी फ़िल्म को अनपब्लिश करने में मेरी मदद करो" },
  { zh: "查一下报销流程", en: "Check the reimbursement process", pt: "Verifique o processo de reembolso", hi: "रिइम्बर्समेंट प्रक्रिया जांचो" },
];
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cap-mask" @click.self="close">
      <div
        ref="dialogRef"
        class="cap-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cap-title"
      >
        <header class="cap-head">
          <h2 id="cap-title">{{ tx("助手能力与用法", "Capabilities and Usage", "Capacidades e uso", "क्षमताएं और उपयोग") }}</h2>
          <button type="button" class="cap-x" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="close">×</button>
        </header>

        <div class="cap-body">
          <!-- 总：一句话定位 -->
          <p class="cap-intro">
            {{ tx("我是后台业务助手：把你的自然语言，变成对后台数据的", "I am a backend operations assistant that turns your natural language into", "Sou um assistente de operacoes de backoffice que transforma sua linguagem natural em", "मैं एक बैकऑफिस ऑपरेशंस असिस्टेंट हूं जो आपकी प्राकृतिक भाषा को बदलता है") }}<strong>{{ tx("查询、报表、导出和写操作", "queries, reports, exports, and write actions", "consultas, relatorios, exportacoes e acoes de escrita", "क्वेरी, रिपोर्ट, एक्सपोर्ट और लिखने वाली कार्रवाइयों में") }}</strong>{{ tx("，字段与口径均对齐 PC 后台。用「模块 + 动作」说清要什么即可，缺信息我会反问，写操作会先跟你确认。", ". Field labels and result semantics stay aligned with the PC admin. Just describe the module and action. If information is missing, I will ask. Write actions always require confirmation first.", ". Os campos e a semantica dos resultados permanecem alinhados com o admin web. Basta descrever o modulo e a acao. Se faltar informacao, eu vou perguntar. Acoes de escrita sempre exigem confirmacao antes.", ". फ़ील्ड नाम और परिणाम का अर्थ PC एडमिन के साथ संरेखित रहते हैं। बस मॉड्यूल और कार्रवाई बताइए। जानकारी कम होगी तो मैं पूछूंगा। लिखने वाली कार्रवाइयों से पहले हमेशा पुष्टि ली जाएगी।") }}
          </p>

          <!-- 分：查数据 -->
          <section>
            <h3>{{ tx("查数据（列表 / 详情）", "Query Data (List / Detail)", "Consultar dados (lista / detalhes)", "डेटा क्वेरी करें (सूची / विवरण)") }}</h3>
            <ul>
              <li>{{ tx("列表：说清模块 + 动作，如「白名单列表」→ 中文表格，字段对齐 PC 后台", "List: specify module + action, for example 'whitelist list' → aligned table output", "Lista: especifique modulo + acao, por exemplo 'lista da whitelist' -> saida em tabela alinhada", "सूची: मॉड्यूल + कार्रवाई बताइए, जैसे 'व्हाइटलिस्ट सूची' -> संरेखित तालिका आउटपुट") }}</li>
              <li>{{ tx("详情：尽量带 ID，如「用户 10038557464768004 详情」→ 分块展示", "Detail: include an ID when possible, for example 'user 10038557464768004 details'", "Detalhes: inclua um ID quando possivel, por exemplo 'detalhes do usuario 10038557464768004'", "विवरण: संभव हो तो ID शामिल करें, जैसे 'यूज़र 10038557464768004 विवरण'") }}</li>
              <li>{{ tx("树表 / 表尾：有层级或汇总需求时自动缩进、出合计/均值行", "Tree / footer: hierarchical and summary-style outputs get indentation and total/average rows automatically", "Arvore / rodape: saidas hierarquicas e resumos ganham indentacao e linhas de total/media automaticamente", "ट्री / फुटर: पदानुक्रमित और सारांश आउटपुट में अपने आप इंडेंटेशन और कुल/औसत पंक्तियां जुड़ती हैं") }}</li>
            </ul>
          </section>

          <!-- 分：报表与图表 -->
          <section>
            <h3>{{ tx("报表 / 趋势 / 图表", "Reports / Trends / Charts", "Relatorios / tendencias / graficos", "रिपोर्ट / ट्रेंड / चार्ट") }}</h3>
            <ul>
              <li>{{ tx("登录统计、收入趋势等：给周期与维度（如「近7天」「Google 登录」）→ 折线图 + 数据表", "For login stats or revenue trends, provide a time range and dimensions (for example, 'last 7 days' or 'Google login') → chart plus data table", "Para estatisticas de login ou tendencia de receita, informe periodo e dimensoes (por exemplo, 'ultimos 7 dias' ou 'login Google') -> grafico + tabela", "लॉगिन आँकड़े या राजस्व ट्रेंड के लिए समय सीमा और आयाम दें (जैसे 'पिछले 7 दिन' या 'Google लॉगिन') -> चार्ट + डेटा तालिका") }}</li>
              <li>{{ tx("通用报表按 PC 口径自动对齐表头并出图，不再手拼序列", "Generic reports align headers with the PC admin and generate charts automatically", "Relatorios genericos alinham cabecalhos com o admin web e geram graficos automaticamente", "सामान्य रिपोर्ट PC एडमिन के अनुरूप हेडर संरेखित करती हैं और अपने आप चार्ट बनाती हैं") }}</li>
            </ul>
          </section>

          <!-- 分：导出 -->
          <section>
            <h3>{{ tx("导出 Excel / PDF", "Export Excel / PDF", "Exportar Excel / PDF", "Excel / PDF निर्यात करें") }}</h3>
            <ul>
              <li>{{ tx("说「导出 Excel / PDF」→ 聊天内预览，可下载，支持树表与表尾汇总", "Say 'export Excel / PDF' → preview in chat, downloadable, supports tree tables and footer summaries", "Diga 'exportar Excel / PDF' -> pre-visualizacao no chat, download disponivel, com suporte a arvore e rodape de resumo", "कहें 'Excel / PDF निर्यात करें' -> चैट में पूर्वावलोकन, डाउनलोड योग्य, ट्री टेबल और फुटर सारांश समर्थित") }}</li>
            </ul>
          </section>

          <!-- 分：写操作 -->
          <section>
            <h3>{{ tx("写操作（新增 / 修改 / 删除 / 审核）", "Write Actions (Create / Update / Delete / Review)", "Acoes de escrita (criar / atualizar / excluir / revisar)", "लिखने वाली कार्रवाइयां (बनाएं / अपडेट करें / हटाएं / समीक्षा करें)") }}</h3>
            <ul>
              <li>{{ tx("如「下架影片」「新增配置」「更新状态」→ 先弹确认再执行，执行后回读结果", "For actions like unpublishing a movie, adding config, or updating status, confirmation is required before execution and results are read back afterwards", "Para acoes como retirar um filme do ar, adicionar configuracao ou atualizar status, a confirmacao e obrigatoria antes da execucao e o resultado e relido depois", "फ़िल्म अनपब्लिश करना, कॉन्फ़िग जोड़ना या स्टेटस अपडेट करना जैसी कार्रवाइयों में पहले पुष्टि ली जाती है और बाद में परिणाम फिर से पढ़ा जाता है") }}</li>
            </ul>
          </section>

          <!-- 分：知识库 -->
          <section>
            <h3>{{ tx("公司知识库（规范 / 流程 / 制度）", "Company Knowledge Base (Guidelines / Process / Policy)", "Base de conhecimento da empresa (diretrizes / processo / politica)", "कंपनी ज्ञान आधार (दिशानिर्देश / प्रक्रिया / नीति)") }}</h3>
            <ul>
              <li>{{ tx("问报销、部署、制度等 → 检索本地知识库并标注来源回答，不凭空编造", "Questions about reimbursement, deployment, policy, and similar topics are answered from the local knowledge base with cited sources", "Perguntas sobre reembolso, deploy, politica e temas semelhantes sao respondidas a partir da base local com fontes citadas", "रिइम्बर्समेंट, डिप्लॉय, नीति जैसी बातों के जवाब स्थानीय नॉलेज बेस से स्रोत सहित दिए जाते हैं") }}</li>
            </ul>
          </section>

          <!-- 分：示例 -->
          <section>
            <h3>{{ tx("示例（点一下填入输入框）", "Examples (click to fill the composer)", "Exemplos (clique para preencher o campo)", "उदाहरण (क्लिक करके कंपोजर में भरें)") }}</h3>
            <div class="cap-chips">
              <button
                v-for="ex in examples"
                :key="ex.zh"
                type="button"
                class="cap-chip"
                @click="pickExample(uiLocale === 'en' ? ex.en : uiLocale === 'pt-BR' ? ex.pt : uiLocale === 'hi' ? ex.hi : ex.zh)"
              >
                {{ uiLocale === "en" ? ex.en : uiLocale === "pt-BR" ? ex.pt : uiLocale === "hi" ? ex.hi : ex.zh }}
              </button>
            </div>
          </section>

          <!-- 总：边界与约定 -->
          <p class="cap-note">
            {{ tx("真数据需有效登录；一次一件事，缺信息会反问，写操作必须确认。视频 / BI / 富文本只给摘要或链接，不内嵌播放器或完整 HTML；图片会自动切换视觉模型识别。", "Real data requires a valid login. Please ask for one thing at a time. Missing information will trigger clarification, and write actions must be confirmed. Video / BI / rich text content is returned as summaries or links rather than embedded full content. Images can trigger an automatic switch to a vision-capable model.", "Dados reais exigem login valido. Faca um pedido por vez. Se faltar informacao, vou pedir esclarecimento, e acoes de escrita precisam de confirmacao. Conteudo de video / BI / rich text e retornado como resumo ou link, sem incorporar player ou HTML completo. Imagens podem acionar troca automatica para um modelo com visao.", "वास्तविक डेटा के लिए वैध लॉगिन चाहिए। एक बार में एक ही अनुरोध करें। जानकारी कम होगी तो स्पष्टीकरण मांगा जाएगा, और लिखने वाली कार्रवाइयों के लिए पुष्टि जरूरी है। वीडियो / BI / rich text सामग्री पूर्ण एम्बेड के बजाय सारांश या लिंक के रूप में लौटती है। चित्र होने पर विज़न मॉडल पर स्वचालित स्विच हो सकता है।") }}
          </p>
        </div>

        <footer class="cap-foot">
          <button type="button" class="cap-ok" @click="close">{{ tx("知道了", "Got it", "Entendi", "समझ गया") }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cap-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--ink) 45%, transparent);
  backdrop-filter: blur(6px);
}

.cap-dialog {
  width: min(520px, 100%);
  max-height: min(84vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink) 18%, transparent);
  overflow: hidden;
}

.cap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.cap-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.cap-x {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 8px;
}

.cap-x:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 35%, transparent);
  outline-offset: 2px;
}

.cap-body {
  padding: 14px 16px 8px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.55;
}

.cap-body .cap-intro {
  margin: 0 0 14px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  border-left: 3px solid color-mix(in srgb, var(--ink) 40%, transparent);
  border-radius: 8px;
  color: color-mix(in srgb, var(--ink) 92%, transparent);
}

.cap-body section {
  margin-bottom: 14px;
}

.cap-body h3 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.cap-body ul,
.cap-body ol {
  margin: 0;
  padding-left: 1.2em;
}

.cap-body li {
  margin: 4px 0;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.cap-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cap-chip {
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.cap-chip:hover {
  border-color: color-mix(in srgb, var(--ink) 35%, var(--line));
}

.cap-note {
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.cap-foot {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: flex-end;
}

.cap-ok {
  border: none;
  border-radius: 10px;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--ink) 90%, transparent);
  color: var(--panel);
  font-size: 13px;
  cursor: pointer;
}

.cap-ok:hover {
  filter: brightness(1.05);
}
</style>
