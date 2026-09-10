<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PORTAL_CARDS, PORTAL_KICKER, PORTAL_LEAD, PORTAL_TITLE } from "../agent-portal";
import { fetchMe, type Me } from "../api";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { hasPortalEntryAccess } from "../portal-permissions";
import { getUiLocale } from "../ui-locale";
import { pickLocalized } from "../localize";

const uiLocale = getUiLocale();
const route = useRoute();
const me = shallowRef<Me | null>(null);
const tx = (zh: string, en: string, pt = en, hi = en) =>
  pickLocalized(uiLocale.value, { zh, en, pt, hi });

onMounted(async () => {
  me.value = await fetchMe();
});

const cards = computed(() =>
  PORTAL_CARDS.map((card) => ({
    enabled: card.entry ? !me.value || hasPortalEntryAccess(me.value.permissions.entries, card.entry) : true,
    key: card.key,
    title: pickLocalized(uiLocale.value, card.title),
    desc: pickLocalized(uiLocale.value, card.desc),
    chip: pickLocalized(uiLocale.value, card.chip),
    cta:
      card.key === "admin" && me.value
        ? tx("进入工作台", "Open workspace", "Abrir espaco de trabalho", "वर्कस्पेस खोलें")
        : pickLocalized(uiLocale.value, card.cta),
    to:
      card.entry && me.value && !hasPortalEntryAccess(me.value.permissions.entries, card.entry)
        ? ""
        : me.value && card.authHref
          ? card.authHref
          : card.href || "",
    tone: card.tone,
    accent: card.accent,
    featured: Boolean(card.featured),
  })),
);

const traceDenied = computed(() => route.query.denied === "canViewTrace");
const deniedSource = computed(() => (typeof route.query.deniedSource === "string" ? route.query.deniedSource : ""));
const deniedFrom = computed(() => (typeof route.query.deniedFrom === "string" ? route.query.deniedFrom : ""));
const traceAccessHint = computed(() => {
  const source = me.value?.permissions.traceAccessSource;
  if (source === "owner-allowlist") {
    return tx("来源：Trace 白名单已命中", "Source: Trace allowlist matched", "Origem: allowlist de Trace correspondente", "स्रोत: Trace allowlist मेल खा गई");
  }
  if (source === "country-allowlist") {
    return tx("来源：当前国家线已开通 Trace", "Source: Trace is enabled for this country", "Origem: Trace liberado para este pais", "स्रोत: इस देश लाइन के लिए Trace सक्षम है");
  }
  if (source === "owner-denylist") {
    return tx("来源：当前账号命中 Trace 黑名单", "Source: this account is in the Trace denylist", "Origem: esta conta esta na denylist do Trace", "स्रोत: यह खाता Trace denylist में है");
  }
  if (source === "country-denylist") {
    return tx("来源：当前国家线未开通 Trace", "Source: Trace is not enabled for this country", "Origem: Trace nao esta liberado para este pais", "स्रोत: इस देश लाइन के लिए Trace सक्षम नहीं है");
  }
  if (source === "denied-allowlist") {
    return tx("来源：当前账号未命中 Trace 白名单", "Source: this account is not in the Trace allowlist", "Origem: esta conta nao esta na allowlist do Trace", "स्रोत: यह खाता Trace allowlist में नहीं है");
  }
  if (source === "default-login") {
    return tx("来源：当前未配置 Trace 白名单，默认按登录态开放", "Source: no Trace allowlist configured, access follows login state", "Origem: nenhuma allowlist de Trace configurada; acesso segue o login", "स्रोत: कोई Trace allowlist कॉन्फ़िगर नहीं है, पहुंच लॉगिन स्थिति पर आधारित है");
  }
  return "";
});
</script>

<template>
  <main class="stage">
    <header class="top">
      <div>
        <p class="kicker">{{ pickLocalized(uiLocale, PORTAL_KICKER) }}</p>
        <h1>{{ pickLocalized(uiLocale, PORTAL_TITLE) }}</h1>
      </div>
      <div class="top-actions">
        <RouterLink v-if="me?.permissions?.entries?.trace" class="ghost-link" to="/trace">{{ tx("调用观察", "Trace", "Rastreamento", "ट्रेस") }}</RouterLink>
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </header>

    <p class="lead">
      {{ pickLocalized(uiLocale, PORTAL_LEAD) }}
    </p>

    <p v-if="traceDenied" class="notice warn">
      {{
        deniedSource === "owner-denylist"
          ? tx("当前账号命中 Trace 黑名单，已从受控页面返回门户。请联系管理员处理。", "This account is in the Trace denylist and was returned from a protected page to the portal. Contact an administrator if this is unexpected.", "Esta conta esta na denylist do Trace e foi redirecionada de uma pagina protegida ao portal. Fale com um administrador se isso estiver incorreto.", "यह खाता Trace denylist में है और सुरक्षित पेज से पोर्टल पर वापस भेज दिया गया है। यदि यह गलत है तो एडमिन से संपर्क करें।")
          : deniedSource === "country-denylist"
            ? tx("当前国家线未开通 Trace，已从受控页面返回门户。", "Trace is not enabled for this country and you were returned from a protected page to the portal.", "Trace nao esta liberado para este pais e voce foi redirecionado de uma pagina protegida ao portal.", "इस देश लाइन के लिए Trace सक्षम नहीं है और आपको सुरक्षित पेज से पोर्टल पर वापस भेज दिया गया है।")
            : deniedSource === "denied-allowlist"
          ? tx("当前账号未命中 Trace 白名单，已从受控页面返回门户。请联系管理员开通。", "This account is not in the Trace allowlist and was returned from a protected page to the portal. Contact an administrator to enable access.", "Esta conta nao esta na allowlist do Trace e foi redirecionada de uma pagina protegida ao portal. Fale com um administrador para liberar o acesso.", "यह खाता Trace allowlist में नहीं है और सुरक्षित पेज से पोर्टल पर वापस भेज दिया गया है। एक्सेस सक्षम करने के लिए एडमिन से संपर्क करें।")
          : tx("当前账号没有 Trace 查看权限，请联系管理员开通。", "Your account does not have Trace access. Contact an administrator to enable it.", "Sua conta nao tem acesso ao Trace. Fale com um administrador para liberar.", "आपके खाते में Trace देखने की अनुमति नहीं है। इसे सक्षम करने के लिए एडमिन से संपर्क करें।")
      }}
      <span v-if="deniedFrom" class="notice-extra">
        {{ tx("来源页面：", "Requested page: ", "Pagina solicitada: ", "अनुरोधित पृष्ठ: ") }}{{ deniedFrom }}
      </span>
    </p>

    <p v-if="me" class="session-pill">
      {{ tx("当前登录：", "Current session: ", "Sessao atual: ", "वर्तमान सत्र: ") }}{{ me.country.label }} · {{ me.user.name || me.user.loginName }}
      <span class="session-sep">·</span>
      <span :class="['perm-chip', me.permissions.entries.trace ? 'ok' : 'muted']">
        {{ me.permissions.entries.trace ? tx("Trace 已开通", "Trace enabled", "Trace liberado", "Trace सक्षम") : tx("Trace 未开通", "Trace unavailable", "Trace indisponivel", "Trace उपलब्ध नहीं") }}
      </span>
    </p>
    <p v-if="me && traceAccessHint" class="notice subtle">{{ traceAccessHint }}</p>

    <p v-else class="notice">
      {{
        tx(
          "「调用观察 / Trace」跟随后台管理 Agent 的运营账号登录与权限；问数、知识库、观影各自独立鉴权，不混用此账号。",
          "Trace follows the Admin Agent ops-account session and permissions. Analytics, knowledge, and viewing each use their own auth — not this account.",
          "Trace segue a sessao e permissoes da conta operacional do Agent de Backoffice. Analise, conhecimento e visualizacao tem auth propria — nao misturam esta conta.",
          "Trace एडमिन एजेंट के ops खाता सत्र और अनुमतियों पर निर्भर है। एनालिटिक्स, नॉलेज और व्यूइंग अपने auth इस्तेमाल करते हैं — यह खाता साझा नहीं।",
        )
      }}
    </p>

    <section class="grid" :aria-label="tx('Agent 列表', 'Agent list', 'Lista de agentes', 'एजेंट सूची')">
      <template v-for="card in cards" :key="card.key">
        <RouterLink
          v-if="card.to"
          :to="card.to"
          class="card is-link"
          :class="[
            `tone-${card.tone}`,
            `accent-${card.accent}`,
            { 'is-disabled': !card.enabled, 'is-featured': card.featured },
          ]"
        >
          <div class="card-glow" aria-hidden="true" />
          <div class="card-head">
            <h2 class="card-title">{{ card.title }}</h2>
            <span class="chip">{{ card.chip }}</span>
          </div>
          <p>{{ card.desc }}</p>
          <span class="cta">{{ card.cta }} <span class="cta-arrow" aria-hidden="true">→</span></span>
        </RouterLink>
        <article
          v-else
          class="card is-static"
          :class="[
            `tone-${card.tone}`,
            `accent-${card.accent}`,
            { 'is-disabled': !card.enabled, 'is-featured': card.featured },
          ]"
        >
          <div class="card-glow" aria-hidden="true" />
          <div class="card-head">
            <h2 class="card-title">{{ card.title }}</h2>
            <span class="chip">{{ card.chip }}</span>
          </div>
          <p>{{ card.desc }}</p>
          <span class="cta">{{ card.cta }} <span class="cta-arrow" aria-hidden="true">→</span></span>
        </article>
      </template>
    </section>
  </main>
</template>

<style scoped>
.stage {
  --portal-ink: var(--ink);
  --portal-muted: var(--muted);
  position: relative;
  isolation: isolate;
  min-height: 100dvh;
  padding: calc(20px + var(--safe-top)) var(--pad) calc(28px + var(--safe-bottom));
  overflow: hidden;
  background:
    radial-gradient(900px 480px at 8% -10%, color-mix(in srgb, #0d9488 22%, transparent), transparent 60%),
    radial-gradient(720px 420px at 92% 8%, color-mix(in srgb, #ea580c 16%, transparent), transparent 55%),
    radial-gradient(640px 380px at 70% 100%, color-mix(in srgb, #0284c7 14%, transparent), transparent 50%),
    linear-gradient(165deg, color-mix(in srgb, var(--bg) 92%, #ecfdf5) 0%, var(--bg) 48%, color-mix(in srgb, var(--bg) 90%, #fff7ed) 100%);
}

.stage::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: 0.35;
  background-image:
    linear-gradient(color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 20%, #000 20%, transparent 75%);
}

.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--line) 88%, var(--ink) 12%);
  border-radius: calc(var(--radius) + 2px);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(10px);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 18%, transparent),
    0 10px 24px color-mix(in srgb, var(--ink) 6%, transparent);
}

.ghost-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
  font-size: 12px;
  font-weight: 600;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.ghost-link:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--panel) 72%, var(--fill));
  border-color: color-mix(in srgb, var(--line) 76%, var(--ink) 24%);
}

.ghost-link:focus-visible {
  outline: none;
  color: var(--ink);
  border-color: color-mix(in srgb, var(--line) 72%, var(--ink) 28%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 12%, transparent);
}

.kicker {
  margin: 0 0 10px;
  color: color-mix(in srgb, #0f766e 70%, var(--muted));
  font-size: 11px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  font-weight: 700;
}

h1 {
  margin: 0;
  font-size: clamp(34px, 6vw, 54px);
  line-height: 0.98;
  letter-spacing: -0.03em;
}

.lead {
  max-width: 68ch;
  margin: 18px 0 0;
  color: var(--muted);
  line-height: 1.7;
}

.session-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 22px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: color-mix(in srgb, var(--panel) 80%, transparent);
  backdrop-filter: blur(8px);
  font-size: 12px;
}

.session-sep {
  color: color-mix(in srgb, var(--muted) 72%, transparent);
}

.perm-chip {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.perm-chip.ok {
  color: #0b8a5f;
  background: color-mix(in srgb, #12b981 14%, transparent);
}

.perm-chip.muted {
  color: var(--ink-2);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.notice {
  margin: 20px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.notice.warn {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #f59e0b 26%, var(--line));
  border-radius: 12px;
  color: #9a6700;
  background: color-mix(in srgb, #f59e0b 10%, var(--panel));
}

.notice-extra {
  display: block;
  margin-top: 6px;
  color: inherit;
  opacity: 0.8;
}

.notice.subtle {
  margin-top: 8px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 16px;
  margin-top: 28px;
}

.card {
  --card-accent: #0d9488;
  --card-accent-2: #0369a1;
  --card-surface: color-mix(in srgb, var(--panel) 88%, transparent);
  position: relative;
  display: grid;
  gap: 14px;
  grid-column: span 4;
  min-height: 228px;
  padding: 22px;
  border: 1px solid color-mix(in srgb, var(--card-accent) 22%, var(--line));
  border-radius: calc(var(--radius) + 6px);
  background:
    linear-gradient(
      155deg,
      color-mix(in srgb, var(--card-accent) 22%, transparent) 0%,
      transparent 48%
    ),
    var(--card-surface);
  box-shadow:
    0 12px 32px color-mix(in srgb, var(--ink) 7%, transparent),
    inset 0 1px 0 color-mix(in srgb, white 22%, transparent);
  color: inherit;
  text-decoration: none;
  overflow: hidden;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.card-glow {
  position: absolute;
  inset: auto -20% -40% auto;
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--card-accent) 28%, transparent), transparent 70%);
  pointer-events: none;
  opacity: 0.9;
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--card-accent) 48%, var(--line));
  box-shadow:
    0 18px 40px color-mix(in srgb, var(--card-accent) 16%, transparent),
    0 10px 24px color-mix(in srgb, var(--ink) 8%, transparent);
}

.card:hover .card-glow {
  opacity: 1;
  transform: scale(1.12);
}

.card.is-featured {
  grid-column: span 8;
  min-height: 260px;
  padding: 26px 28px;
}

.card.is-featured .card-title {
  font-size: clamp(24px, 3vw, 30px);
}

.card.is-link {
  cursor: pointer;
}

.card.is-link:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--card-accent) 55%, transparent);
  outline-offset: 3px;
}

.card.is-static {
  cursor: default;
}

.card.is-disabled {
  opacity: 0.72;
  filter: grayscale(0.2);
  pointer-events: none;
}

.card.is-static:hover {
  transform: none;
  border-color: color-mix(in srgb, var(--card-accent) 22%, var(--line));
  box-shadow:
    0 12px 32px color-mix(in srgb, var(--ink) 7%, transparent),
    inset 0 1px 0 color-mix(in srgb, white 22%, transparent);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  z-index: 1;
}

.card h2,
.card-title {
  margin: 0;
  font-size: 20px;
  letter-spacing: -0.02em;
}

.card p {
  margin: 0;
  z-index: 1;
  max-width: 52ch;
  color: var(--muted);
  line-height: 1.7;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--card-accent) 28%, transparent);
  background: color-mix(in srgb, var(--card-accent) 16%, var(--panel));
  color: color-mix(in srgb, var(--card-accent) 72%, var(--ink));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

.cta {
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  width: fit-content;
  padding: 8px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--card-accent) 14%, transparent);
  color: color-mix(in srgb, var(--card-accent) 78%, var(--ink));
  font-size: 13px;
  font-weight: 700;
}

.cta-arrow {
  transition: transform 0.16s ease;
}

.card:hover .cta-arrow {
  transform: translateX(3px);
}

.accent-analytics {
  --card-accent: #0f766e;
  --card-accent-2: #0369a1;
  --card-surface: linear-gradient(160deg, #ccfbf1 0%, #ecfeff 42%, color-mix(in srgb, var(--panel) 70%, #fff) 100%);
}

.accent-admin {
  --card-accent: #c2410c;
  --card-accent-2: #b45309;
  --card-surface: linear-gradient(160deg, #ffedd5 0%, #fff7ed 45%, color-mix(in srgb, var(--panel) 70%, #fff) 100%);
}

.accent-knowledge {
  --card-accent: #4d7c0f;
  --card-accent-2: #a16207;
  --card-surface: linear-gradient(160deg, #ecfccb 0%, #fef9c3 48%, color-mix(in srgb, var(--panel) 70%, #fff) 100%);
}

.accent-viewing {
  --card-accent: #0369a1;
  --card-accent-2: #0e7490;
  --card-surface: linear-gradient(160deg, #bae6fd 0%, #e0f2fe 45%, color-mix(in srgb, var(--panel) 70%, #fff) 100%);
}

.accent-more {
  --card-accent: #64748b;
  --card-accent-2: #475569;
  --card-surface: linear-gradient(160deg, #e2e8f0 0%, #f1f5f9 50%, color-mix(in srgb, var(--panel) 80%, #fff) 100%);
}

.tone-muted {
  opacity: 0.9;
}

@media (max-width: 960px) {
  .card,
  .card.is-featured {
    grid-column: span 6;
  }
}

@media (max-width: 720px) {
  .top {
    flex-direction: column;
  }

  .top-actions {
    width: 100%;
    justify-content: space-between;
  }

  .card,
  .card.is-featured {
    grid-column: span 12;
    min-height: 200px;
  }
}

:global(html.dark) .stage {
  background:
    radial-gradient(900px 480px at 8% -10%, color-mix(in srgb, #14b8a6 18%, transparent), transparent 60%),
    radial-gradient(720px 420px at 92% 8%, color-mix(in srgb, #f97316 12%, transparent), transparent 55%),
    radial-gradient(640px 380px at 70% 100%, color-mix(in srgb, #38bdf8 10%, transparent), transparent 50%),
    linear-gradient(165deg, color-mix(in srgb, var(--bg) 88%, #042f2e) 0%, var(--bg) 50%, color-mix(in srgb, var(--bg) 90%, #1c1917) 100%);
}

:global(html.dark) .accent-analytics {
  --card-surface: linear-gradient(160deg, #115e59 0%, color-mix(in srgb, #134e4a 70%, var(--panel)) 55%, var(--panel) 100%);
}

:global(html.dark) .accent-admin {
  --card-surface: linear-gradient(160deg, #9a3412 0%, color-mix(in srgb, #7c2d12 65%, var(--panel)) 55%, var(--panel) 100%);
}

:global(html.dark) .accent-knowledge {
  --card-surface: linear-gradient(160deg, #3f6212 0%, color-mix(in srgb, #365314 65%, var(--panel)) 55%, var(--panel) 100%);
}

:global(html.dark) .accent-viewing {
  --card-surface: linear-gradient(160deg, #075985 0%, color-mix(in srgb, #0c4a6e 65%, var(--panel)) 55%, var(--panel) 100%);
}

:global(html.dark) .kicker {
  color: color-mix(in srgb, #5eead4 55%, var(--muted));
}
</style>
