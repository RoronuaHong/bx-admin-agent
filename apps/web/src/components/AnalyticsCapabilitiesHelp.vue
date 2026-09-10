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

const examples = [
  {
    zh: "八月二十到二十一印度A按天观看人数",
    en: "viewers by day for India A from Aug 20–21",
    pt: "visualizadores por dia India A de 20–21 ago",
    hi: "भारत A 20–21 अगस्त दैनिक व्यूअर्स",
  },
  {
    zh: "最近7天各渠道观看人数",
    en: "viewers by channel for the last 7 days",
    pt: "visualizadores por canal nos ultimos 7 dias",
    hi: "पिछले 7 दिनों में चैनल अनुसार व्यूअर्स",
  },
  {
    zh: "昨天印度A和印度B对比观看人数",
    en: "compare India A vs India B viewers yesterday",
    pt: "compare visualizadores India A vs India B ontem",
    hi: "कल भारत A बनाम भारत B व्यूअर्स की तुलना",
  },
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
        aria-labelledby="analytics-cap-title"
      >
        <header class="cap-head">
          <h2 id="analytics-cap-title">{{ tx("问数能力与用法", "Ask capabilities", "Capacidades de analise", "पूछने की क्षमताएं") }}</h2>
          <button type="button" class="cap-x" :aria-label="tx('关闭', 'Close', 'Fechar', 'बंद करें')" @click="close">×</button>
        </header>

        <div class="cap-body">
          <p class="cap-intro">
            {{ tx("我是数据分析 Agent：用自然语言问观看人数等指标，结果来自 Metabase。尽量写明", "I am the Analytics Agent: ask metrics like viewers in natural language; results come from Metabase. Prefer an explicit ", "Sou o Agent de Analise: pergunte metricas como visualizadores em linguagem natural; resultados do Metabase. Prefira ", "मैं एनालिटिक्स एजेंट हूँ: प्राकृतिक भाषा में व्यूअर्स जैसे मेट्रिक पूछें — परिणाम Metabase से। स्पष्ट ") }}<strong>{{ tx("日期或时间范围", "date or range", "data ou intervalo", "तिथि या अवधि") }}</strong>{{ tx("；缺日期会反问，不编造口径。", "; missing dates trigger clarification — no invented metrics.", "; datas ausentes pedem esclarecimento — sem metricas inventadas.", "; तिथि न हो तो स्पष्टीकरण मांगा जाएगा — काल्पनिक मेट्रिक नहीं।") }}
          </p>

          <section>
            <h3>{{ tx("怎么问", "How to ask", "Como perguntar", "कैसे पूछें") }}</h3>
            <ul>
              <li>{{ tx("写清渠道 / 维度 + 指标 + 日期，如「八月二十到二十一印度A按天观看人数」", "Include channel/dimension + metric + dates, e.g. “viewers by day for India A from Aug 20–21”", "Inclua canal/dimensao + metrica + datas, ex.: visualizadores por dia India A de 20–21 ago", "चैनल/आयाम + मेट्रिक + तिथि बताएं, जैसे भारत A 20–21 अगस्त दैनिक व्यूअर्स") }}</li>
              <li>{{ tx("对比或多 grain 会拆成多张表返回", "Comparisons or mixed grains return multiple tables", "Comparacoes ou grains mistos retornam varias tabelas", "तुलना या मिश्रित grain पर कई तालिकाएं मिलेंगी") }}</li>
              <li>{{ tx("可展开「查看 SQL」核对生成语句", "Expand “View SQL” to inspect generated statements", "Expanda “Ver SQL” para inspecionar as queries", "जनरेटेड SQL देखने के लिए “SQL देखें” खोलें") }}</li>
            </ul>
          </section>

          <section>
            <h3>{{ tx("巡检", "Scan", "Varredura", "स्कैन") }}</h3>
            <ul>
              <li>{{ tx("顶栏「巡检」可手动跑 watch-users 规则集；dryRun 不发钉钉", "Header “Scan” enqueues the watch-users rule set; dryRun skips DingTalk", "O “Varredura” no topo enfileira watch-users; dryRun nao envia DingTalk", "हेडर “स्कैन” watch-users नियम चलाता है; dryRun में DingTalk नहीं जाता") }}</li>
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
                @click="pickExample(uiLocale === 'en' ? ex.en : uiLocale === 'pt-BR' ? ex.pt : uiLocale === 'hi' ? ex.hi : ex.zh)"
              >
                {{ uiLocale === "en" ? ex.en : uiLocale === "pt-BR" ? ex.pt : uiLocale === "hi" ? ex.hi : ex.zh }}
              </button>
            </div>
          </section>

          <p class="cap-note">
            {{ tx("问数会话与后台管理 Agent 隔离；不支持后台写操作。会话 Tab 先保存在本机。", "Analytics sessions are isolated from the Admin Agent and do not perform backend writes. Conversation tabs are stored locally for now.", "Sessoes de analise ficam isoladas do Agent de Backoffice e nao fazem escritas. Abas ficam no navegador por enquanto.", "एनालिटिक्स सत्र एडमिन एजेंट से अलग हैं और बैकएंड लिखते नहीं। टैब अभी लोकल सेव होते हैं।") }}
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
