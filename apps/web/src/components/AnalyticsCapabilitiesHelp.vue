<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { ANALYTICS_HELP_EXAMPLES, type AnalyticsAskExample } from "../analytics-ask-examples";
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

const examples = ANALYTICS_HELP_EXAMPLES;

function exampleText(ex: AnalyticsAskExample) {
  const loc = uiLocale.value;
  if (loc === "en") return ex.en;
  if (loc === "pt-BR") return ex.pt;
  if (loc === "hi") return ex.hi;
  return ex.zh;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cap-mask" @click.self="close">
      <div
        ref="dialogRef"
        class="cap-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="analytics-cap-title"
      >
        <header class="cap-head">
          <h2 id="analytics-cap-title">{{ tx("问数能力与用法", "Ask capabilities", "Capacidades de analise", "पूछने की क्षमताएं") }}</h2>
          <button type="button" class="cap-x" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="close">×</button>
        </header>

        <div class="cap-body">
          <p class="cap-intro">
            {{ tx("我是数据分析 Agent：用自然语言问观看人数等指标，结果来自 Metabase。尽量写明", "I am the Analytics Agent. Ask metrics like viewers in natural language; results come from Metabase. Prefer an explicit ", "Sou o Agent de Analise. Pergunte metricas como visualizadores em linguagem natural; resultados do Metabase. Prefira ", "मैं एनालिटिक्स एजेंट हूँ। प्राकृतिक भाषा में व्यूअर्स जैसे मेट्रिक पूछें — परिणाम Metabase से। स्पष्ट ") }}<strong>{{ tx("日期或时间范围", "date or range", "data ou intervalo", "तिथि या अवधि") }}</strong>{{ tx("；缺日期会反问，不编造口径。", "; if it is missing I will ask — I will not invent definitions.", "; se faltar, eu pergunto — sem inventar definicoes.", "; तिथि न हो तो मैं पूछूंगा — काल्पनिक परिभाषा नहीं।") }}
          </p>

          <section>
            <h3>{{ tx("怎么问", "How to ask", "Como perguntar", "कैसे पूछें") }}</h3>
            <ul>
              <li>{{ tx("一次说清：渠道 / 维度 + 指标 + 日期（「昨天」「最近 7 天」也可以）", "Spell out channel/dimension + metric + dates (“yesterday” or “last 7 days” also works)", "Diga canal/dimensao + metrica + datas (“ontem” ou “ultimos 7 dias” tambem vale)", "एक साथ बताएं: चैनल/आयाम + मेट्रिक + तिथि (“कल” या “पिछले 7 दिन” भी चलता है)") }}</li>
              <li>{{ tx("对比、或「按天」和「按渠道」混在一句里时，会拆成多张表", "Comparisons, or mixing daily and by-channel in one ask, return multiple tables", "Comparacoes, ou misturar por dia e por canal na mesma pergunta, retornam varias tabelas", "तुलना, या एक ही सवाल में दैनिक और चैनल अनुसार मिलाने पर कई तालिकाएं मिलेंगी") }}</li>
            </ul>
          </section>

          <section>
            <h3>{{ tx("看结果", "Results", "Resultados", "परिणाम") }}</h3>
            <ul>
              <li>{{ tx("表格可下载 CSV", "Download tables as CSV", "Baixe as tabelas em CSV", "तालिकाएं CSV में डाउनलोड करें") }}</li>
              <li>{{ tx("展开 SQL 可核对生成语句", "Expand SQL to check the generated query", "Expanda SQL para conferir a query gerada", "जनरेटेड क्वेरी देखने के लिए SQL खोलें") }}</li>
            </ul>
          </section>

          <section>
            <h3>{{ tx("附件与语音", "Files and voice", "Arquivos e voz", "फ़ाइलें और वॉइस") }}</h3>
            <ul>
              <li>{{ tx("可粘贴或上传图片、txt / md / json / csv；图片会先转成文字再问数", "Paste or upload images and txt / md / json / csv; images are turned into text first", "Cole ou envie imagens e txt / md / json / csv; imagens viram texto antes", "चित्र और txt / md / json / csv पेस्ट या अपलोड करें; चित्र पहले टेक्स्ट बनते हैं") }}</li>
              <li>{{ tx("可用语音填入输入框", "Voice can fill the input box", "A voz pode preencher o campo", "वॉइस से इनपुट बॉक्स भर सकते हैं") }}</li>
            </ul>
          </section>

          <section>
            <h3>{{ tx("巡检", "Scan", "Varredura", "स्कैन") }}</h3>
            <ul>
              <li>{{ tx("顶栏「巡检」可手动跑渠道日活", "Header “Scan” runs channel daily-active checks", "O “Varredura” no topo roda a checagem de ativos diarios por canal", "हेडर “स्कैन” चैनल दैनिक एक्टिव जांच चलाता है") }}</li>
              <li>{{ tx("勾选 dryRun 只试跑、不发钉钉", "Check dryRun to trial the job without sending DingTalk", "Marque dryRun para testar sem enviar DingTalk", "dryRun चुनें तो सिर्फ ट्रायल होगा, DingTalk नहीं जाएगा") }}</li>
              <li>{{ tx("自动巡检开启后，每天汇总昨日日活（不是投放 ROI）", "When auto-scan is on, yesterday’s daily actives are summarized each day (not ad ROI)", "Com a varredura automatica, os ativos de ontem sao resumidos todo dia (nao e ROI de ads)", "ऑटो-स्कैन चालू हो तो हर दिन कल के दैनिक एक्टिव का सार आता है (विज्ञापन ROI नहीं)") }}</li>
            </ul>
          </section>

          <section>
            <h3>{{ tx("示例（点一下填入输入框）", "Examples (click to fill)", "Exemplos (clique para preencher)", "उदाहरण (क्लिक करके भरें)") }}</h3>
            <div class="cap-chips">
              <button
                v-for="ex in examples"
                :key="ex.zh"
                type="button"
                class="cap-chip"
                @click="pickExample(exampleText(ex))"
              >
                {{ exampleText(ex) }}
              </button>
            </div>
          </section>

          <p class="cap-note">
            {{ tx("问数会话与后台管理 Agent 隔离，不能改后台数据。会话 Tab 先保存在本机。", "Analytics chats are separate from the Admin Agent and cannot change backend data. Conversation tabs stay on this device for now.", "As conversas de analise ficam isoladas do Agent de Backoffice e nao alteram dados. As abas ficam neste dispositivo por enquanto.", "एनालिटिक्स चैट एडमिन एजेंट से अलग हैं और बैकएंड डेटा नहीं बदलतीं। टैब अभी इसी डिवाइस पर रहते हैं।") }}
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
  width: min(560px, 100%);
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
  border-left: 3px solid color-mix(in srgb, #0f766e 55%, transparent);
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

.cap-body ul {
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
  border-color: color-mix(in srgb, #0f766e 40%, var(--line));
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
  background: color-mix(in srgb, #0f766e 88%, var(--ink));
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.cap-ok:hover {
  filter: brightness(1.05);
}
</style>
