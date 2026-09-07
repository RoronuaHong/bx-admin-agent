<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PORTAL_CARDS, PORTAL_KICKER, PORTAL_LEAD, PORTAL_TITLE } from "../agent-portal";
import { fetchMe, type Me } from "../api";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
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
    key: card.key,
    title: pickLocalized(uiLocale.value, card.title),
    desc: pickLocalized(uiLocale.value, card.desc),
    chip: pickLocalized(uiLocale.value, card.chip),
    cta:
      card.key === "admin" && me.value
        ? tx("进入工作台", "Open workspace", "Abrir workspace", "वर्कस्पेस खोलें")
        : pickLocalized(uiLocale.value, card.cta),
    to: me.value && card.authHref ? card.authHref : card.href || "",
    tone: card.tone,
  })),
);

const traceDenied = computed(() => route.query.denied === "canViewTrace");
const deniedSource = computed(() => (typeof route.query.deniedSource === "string" ? route.query.deniedSource : ""));
const deniedFrom = computed(() => (typeof route.query.deniedFrom === "string" ? route.query.deniedFrom : ""));
const traceAccessHint = computed(() => {
  const source = me.value?.permissions.traceAccessSource;
  if (source === "owner-allowlist") {
    return tx("来源：Trace 白名单已命中", "Source: Trace allowlist matched", "Origem: allowlist de Trace correspondente", "स्रोत: Trace allowlist matched");
  }
  if (source === "denied-allowlist") {
    return tx("来源：当前账号未命中 Trace 白名单", "Source: this account is not in the Trace allowlist", "Origem: esta conta nao esta na allowlist do Trace", "स्रोत: यह खाता Trace allowlist में नहीं है");
  }
  if (source === "default-login") {
    return tx("来源：当前未配置 Trace 白名单，默认按登录态开放", "Source: no Trace allowlist configured, access follows login state", "Origem: nenhuma allowlist de Trace configurada; acesso segue o login", "स्रोत: कोई Trace allowlist कॉन्फ़िगर नहीं है, access login state पर आधारित है");
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
        <RouterLink v-if="me?.permissions.canViewTrace" class="ghost-link" to="/trace">{{ tx("调用观察", "Trace", "Rastreamento", "ट्रेस") }}</RouterLink>
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </header>

    <p class="lead">
      {{ pickLocalized(uiLocale, PORTAL_LEAD) }}
    </p>

    <p v-if="traceDenied" class="notice warn">
      {{
        deniedSource === "denied-allowlist"
          ? tx("当前账号未命中 Trace 白名单，已从受控页面返回门户。请联系管理员开通。", "This account is not in the Trace allowlist and was returned from a protected page to the portal. Contact an administrator to enable access.", "Esta conta nao esta na allowlist do Trace e foi redirecionada de uma pagina protegida ao portal. Fale com um administrador para liberar o acesso.", "यह खाता Trace allowlist में नहीं है और सुरक्षित पेज से पोर्टल पर वापस भेज दिया गया है। एक्सेस सक्षम करने के लिए एडमिन से संपर्क करें।")
          : tx("当前账号没有 Trace 查看权限，请联系管理员开通。", "Your account does not have Trace access. Contact an administrator to enable it.", "Sua conta nao tem acesso ao Trace. Fale com um administrador para liberar.", "आपके खाते में Trace access नहीं है। इसे सक्षम करने के लिए एडमिन से संपर्क करें।")
      }}
      <span v-if="deniedFrom" class="notice-extra">
        {{ tx("来源页面：", "Requested page: ", "Pagina solicitada: ", "अनुरोधित पृष्ठ: ") }}{{ deniedFrom }}
      </span>
    </p>

    <p v-if="me" class="session-pill">
      {{ tx("当前登录：", "Current session: ", "Sessao atual: ", "वर्तमान सत्र: ") }}{{ me.country.label }} · {{ me.user.name || me.user.loginName }}
      <span class="session-sep">·</span>
      <span :class="['perm-chip', me.permissions.canViewTrace ? 'ok' : 'muted']">
        {{ me.permissions.canViewTrace ? tx("Trace 已开通", "Trace enabled", "Trace liberado", "Trace सक्षम") : tx("Trace 未开通", "Trace unavailable", "Trace indisponivel", "Trace उपलब्ध नहीं") }}
      </span>
    </p>
    <p v-if="me && traceAccessHint" class="notice subtle">{{ traceAccessHint }}</p>

    <p v-else class="notice">
      {{ tx("登录后会按账号权限显示 Trace 等受控入口。", "Sign in to reveal permission-based entries such as Trace.", "Faca login para ver entradas controladas por permissao, como Trace.", "Trace जैसे permission-based entries देखने के लिए साइन इन करें।") }}
    </p>

    <section class="grid" :aria-label="tx('Agent 列表', 'Agent list', 'Lista de agentes', 'एजेंट सूची')">
      <article
        v-for="card in cards"
        :key="card.title"
        class="card"
        :class="[`tone-${card.tone}`, { 'is-static': !card.to }]"
      >
        <div class="card-head">
          <h2 class="card-title">
            <RouterLink v-if="card.to" :to="card.to" class="card-link">{{ card.title }}</RouterLink>
            <span v-else>{{ card.title }}</span>
          </h2>
          <span class="chip">{{ card.chip }}</span>
        </div>
        <p>{{ card.desc }}</p>
        <span class="cta">{{ card.cta }}</span>
      </article>
    </section>
  </main>
</template>

<style scoped>
.stage {
  min-height: 100dvh;
  padding: calc(20px + var(--safe-top)) var(--pad) calc(28px + var(--safe-bottom));
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
  background: color-mix(in srgb, var(--panel) 88%, var(--fill));
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
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: clamp(34px, 6vw, 54px);
  line-height: 0.98;
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
  background: var(--fill-soft);
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
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 28px;
}

.card {
  position: relative;
  display: grid;
  gap: 14px;
  min-height: 220px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 4px);
  background: color-mix(in srgb, var(--panel) 86%, var(--fill));
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 6%, transparent);
  color: inherit;
  text-decoration: none;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}

.card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--ink) 16%, var(--line));
  box-shadow: 0 16px 36px color-mix(in srgb, var(--ink) 10%, transparent);
}

.card.is-static {
  cursor: default;
}

.card.is-static:hover {
  transform: none;
  border-color: var(--line);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 6%, transparent);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.card h2 {
  margin: 0;
  font-size: 20px;
}

.card-link {
  color: inherit;
  text-decoration: none;
}

.card-link::after {
  content: "";
  position: absolute;
  inset: 0;
}

.card-link:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 36%, transparent);
  outline-offset: 4px;
  border-radius: calc(var(--radius) + 4px);
}

.card p {
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.cta {
  margin-top: auto;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.tone-primary {
  border-color: color-mix(in srgb, var(--ink) 18%, var(--line));
}

.tone-muted {
  opacity: 0.84;
}

@media (max-width: 720px) {
  .top {
    flex-direction: column;
  }

  .top-actions {
    width: 100%;
    justify-content: space-between;
  }

  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
