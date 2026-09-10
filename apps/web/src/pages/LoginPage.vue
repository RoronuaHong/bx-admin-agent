<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fetchCountries, getApiErrorToken, login, type Country } from "../api";
import AgentChromeNav from "../components/AgentChromeNav.vue";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
import { localizeToken } from "../localize";
import { getUiLocale } from "../ui-locale";

const router = useRouter();
const route = useRoute();
const uiLocale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  uiLocale.value === "zh" ? zh : uiLocale.value === "pt-BR" ? pt : uiLocale.value === "hi" ? hi : en;
const countries = ref<Country[]>([]);
const country = ref("");
const username = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);

/** Trace 观察者入口：鉴权身份仍用运营账号，但产品上不叫「进后台工作台」。 */
const isTraceLogin = computed(
  () => route.path === "/trace/login" || route.meta.purpose === "trace" || route.query.purpose === "trace",
);

onMounted(async () => {
  countries.value = await fetchCountries();
  country.value = countries.value[0]?.id || "";
});

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    await login({ country: country.value, username: username.value, password: password.value });
    const defaultNext = isTraceLogin.value ? "/trace" : "/agents/admin/chat";
    const nextPath =
      typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : defaultNext;
    await router.replace(nextPath);
  } catch (err) {
    error.value = localizeToken(uiLocale.value, getApiErrorToken(err), "AUTH_LOGIN_FAILED");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="stage" :class="{ 'purpose-trace': isTraceLogin }">
    <header class="top">
      <p class="kicker">
        {{
          isTraceLogin
            ? tx("调用观察 · 登录", "Trace · Sign in", "Trace · Entrar", "ट्रेस · साइन इन")
            : tx("后台管理 Agent · 登录", "Admin Agent · Sign in", "Agent de Backoffice · Entrar", "एडमिन एजेंट · साइन इन")
        }}
      </p>
      <div class="top-actions">
        <AgentChromeNav :current-key="isTraceLogin ? undefined : 'admin'" />
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </header>

    <section class="sheet">
      <h1 class="brand-mark">
        {{
          isTraceLogin
            ? tx("调用观察", "Trace", "Rastreamento", "ट्रेस")
            : tx("后台管理 Agent", "Admin Agent", "Agent de Backoffice", "एडमिन एजेंट")
        }}
      </h1>
      <p class="lead">
        {{
          isTraceLogin
            ? tx(
                "门户级观测登录：用运营账号验证 Trace 查看权限。各对话 Agent 仍独立鉴权；此处只开观察面，不进后台工作台。",
                "Portal Trace observer login: use an ops account to verify Trace view permission. Chat agents keep separate auth — this only opens the observer, not the admin workspace.",
                "Login de observacao Trace: use conta operacional para permissao de Trace. Agentes de chat tem auth propria — aqui so abre a observacao, nao o workspace admin.",
                "पोर्टल Trace ऑब्ज़र्वर लॉगिन: Trace देखने की अनुमति के लिए ops खाता। चैट एजेंट अलग auth रखते हैं — यहाँ केवल ऑब्ज़र्वर खुलता है, एडमिन वर्कस्पेस नहीं।",
              )
            : tx(
                "仅用于后台管理 Agent。其它 Agent 使用各自独立鉴权，不与此账号混用。",
                "For the Admin Agent only. Other agents use their own auth and do not share this account.",
                "Apenas para o Agent de Backoffice. Os demais agentes usam auth propria e nao compartilham esta conta.",
                "केवल एडमिन एजेंट के लिए। अन्य एजेंट अपना auth इस्तेमाल करते हैं, यह खाता साझा नहीं।",
              )
        }}
      </p>
      <form class="form" @submit.prevent="submit">
        <label>
          {{ tx("国家 / 环境", "Country / Environment", "Pais / Ambiente", "देश / वातावरण") }}
          <select v-model="country" required>
            <option v-for="item in countries" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </label>
        <label>
          {{ tx("账号", "Username", "Usuario", "उपयोगकर्ता नाम") }}
          <input v-model="username" autocomplete="username" inputmode="text" required />
        </label>
        <label>
          {{ tx("密码", "Password", "Senha", "पासवर्ड") }}
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" :disabled="loading">
          {{
            loading
              ? tx("登录中…", "Signing in…", "Entrando…", "साइन इन हो रहा है…")
              : isTraceLogin
                ? tx("进入观察", "Open Trace", "Abrir Trace", "ट्रेस खोलें")
                : tx("进入", "Enter", "Entrar", "प्रवेश करें")
          }}
        </button>
      </form>
      <p class="hint">
        {{
          isTraceLogin
            ? tx(
                "观察权限由 Trace 白/黑名单与国家线策略控制；问数写入的 run 也会出现在 Trace 列表。",
                "View access follows Trace allow/deny and country policy. Analytics runs also appear in the Trace list.",
                "Acesso segue allow/deny e pais do Trace. Runs de analise tambem aparecem na lista.",
                "देखने की अनुमति Trace allow/deny और देश नीति से। एनालिटिक्स रन भी सूची में दिखेंगे।",
              )
            : tx(
                "使用原运营账号进入对应国家线。问数 / 知识库 / 观影不走此登录。",
                "Use your ops account for the selected country. Analytics / knowledge / viewing do not use this sign-in.",
                "Use a conta operacional do pais. Analise / conhecimento / visualizacao nao usam este login.",
                "चुने देश के ops खाते से प्रवेश करें। एनालिटिक्स / नॉलेज / व्यूइंग इस लॉगिन से नहीं।",
              )
        }}
      </p>
    </section>
  </main>
</template>

<style scoped>
.stage {
  --agent-accent: #c2410c;
  --agent-accent-2: #b45309;
  position: relative;
  isolation: isolate;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: calc(18px + var(--safe-top)) var(--pad) calc(24px + var(--safe-bottom));
  overflow: hidden;
  background:
    radial-gradient(820px 420px at 8% -10%, color-mix(in srgb, #c2410c 22%, transparent), transparent 58%),
    radial-gradient(640px 380px at 92% 8%, color-mix(in srgb, #b45309 14%, transparent), transparent 55%),
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--bg) 90%, #ffedd5) 0%,
      var(--bg) 48%,
      color-mix(in srgb, var(--bg) 92%, #fff7ed) 100%
    );
}

.stage.purpose-trace {
  --agent-accent: #4338ca;
  --agent-accent-2: #0e7490;
  background:
    radial-gradient(820px 420px at 8% -10%, color-mix(in srgb, #4338ca 22%, transparent), transparent 58%),
    radial-gradient(640px 380px at 92% 8%, color-mix(in srgb, #0e7490 14%, transparent), transparent 55%),
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--bg) 90%, #e0e7ff) 0%,
      var(--bg) 48%,
      color-mix(in srgb, var(--bg) 92%, #ecfeff) 100%
    );
}

.stage::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.28;
  background-image:
    linear-gradient(color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 78% 68% at 50% 18%, #000 18%, transparent 72%);
}

.top,
.sheet {
  position: relative;
  z-index: 1;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 18%, var(--line));
  border-radius: calc(var(--radius) + 2px);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(10px);
  /* Keep chrome controls (nav / locale / theme) on one baseline. */
  line-height: 1;
}

.ghost-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 16%, var(--line));
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
  font-size: 12px;
}

.ghost-link:hover {
  color: color-mix(in srgb, var(--agent-accent) 50%, var(--ink));
  background: color-mix(in srgb, var(--agent-accent) 10%, var(--fill-soft));
}

.kicker {
  margin: 0;
  color: color-mix(in srgb, var(--agent-accent) 70%, var(--muted));
  font-size: 11px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  font-weight: 700;
}

.sheet {
  width: min(440px, 100%);
  margin: auto 0;
  padding: 24px;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 22%, var(--line));
  border-radius: calc(var(--radius) + 8px);
  background: color-mix(in srgb, var(--panel) 88%, var(--agent-accent));
  box-shadow: 0 18px 48px color-mix(in srgb, var(--agent-accent) 12%, transparent);
  animation: rise 0.55s ease both;
}

h1 {
  margin: 0;
  font-size: clamp(36px, 9vw, 56px);
  line-height: 0.95;
  font-weight: 600;
  color: color-mix(in srgb, var(--agent-accent) 28%, var(--ink));
}

.lead,
.hint {
  color: var(--muted);
  line-height: 1.65;
}

.lead {
  margin: 16px 0 28px;
  max-width: 28em;
}

.form {
  display: grid;
  gap: 14px;
}

label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.form input,
.form select,
.form button[type="submit"] {
  height: 48px;
  border: 1px solid color-mix(in srgb, var(--agent-accent) 14%, var(--line));
  background: var(--fill);
  color: var(--ink);
  padding: 0 14px;
  font-size: 16px;
  border-radius: var(--radius);
  appearance: none;
}

.form input:focus,
.form select:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--agent-accent) 45%, var(--line));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--agent-accent) 14%, transparent);
}

.form select {
  border-radius: var(--radius);
  background-image: linear-gradient(45deg, transparent 50%, var(--ink) 50%),
    linear-gradient(135deg, var(--ink) 50%, transparent 50%);
  background-position:
    calc(100% - 18px) 22px,
    calc(100% - 12px) 22px;
  background-size: 6px 6px;
  background-repeat: no-repeat;
}

.form button[type="submit"] {
  margin-top: 6px;
  background: var(--agent-accent);
  color: #fff;
  border-color: var(--agent-accent);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  border-radius: 999px;
  transition: opacity 0.16s ease, transform 0.12s ease, background 0.16s ease;
}

.form button[type="submit"]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--agent-accent) 82%, #000);
}

.form button[type="submit"]:active:not(:disabled) {
  transform: translateY(1px);
}

.form button[type="submit"]:disabled {
  opacity: 0.5;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.hint {
  margin: 22px 0 0;
  font-size: 12px;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (min-width: 900px) {
  .stage {
    padding: 32px 48px 40px;
  }

  .sheet {
    margin: auto 8vw;
  }
}
</style>
