<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fetchCountries, login, type Country } from "../api";
import ThemeToggle from "../components/ThemeToggle.vue";
import UiLocaleSelect from "../components/UiLocaleSelect.vue";
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

onMounted(async () => {
  countries.value = await fetchCountries();
  country.value = countries.value[0]?.id || "";
});

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    await login({ country: country.value, username: username.value, password: password.value });
    const nextPath = typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/agents/admin/chat";
    await router.replace(nextPath);
  } catch (err) {
    error.value = err instanceof Error ? err.message : tx("登录失败", "Login failed", "Falha no login", "लॉगिन विफल");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="stage">
    <header class="top">
      <p class="kicker">{{ tx("后台管理 Agent", "Admin Agent", "Agent de Backoffice", "एडमिन एजेंट") }}</p>
      <div class="top-actions">
        <RouterLink class="ghost-link" to="/">{{ tx("返回门户", "Back to portal", "Voltar ao portal", "पोर्टल पर वापस") }}</RouterLink>
        <UiLocaleSelect />
        <ThemeToggle />
      </div>
    </header>

    <section class="sheet">
      <h1 class="brand-mark">{{ tx("后台管理 Agent", "Admin Agent", "Agent de Backoffice", "एडमिन एजेंट") }}</h1>
      <p class="lead">{{ tx("登录后进入后台管理 Agent 工作台，用自然语言查询与管理运营后台各业务模块。", "Sign in to enter the admin agent workspace and manage backend operations in natural language.", "Faca login para entrar no workspace do agente de backoffice e operar o painel com linguagem natural.", "लॉगिन करके एडमिन एजेंट वर्कस्पेस में प्रवेश करें और प्राकृतिक भाषा में बैकएंड ऑपरेशंस संभालें।") }}</p>
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
        <button type="submit" :disabled="loading">{{ loading ? tx("登录中…", "Signing in…", "Entrando…", "साइन इन हो रहा है…") : tx("进入", "Enter", "Entrar", "प्रवेश करें") }}</button>
      </form>
      <p class="hint">{{ tx("该登录仅用于后台管理 Agent，使用原运营账号进入对应国家线。Trace 等受控入口会按账号权限显示。", "This sign-in is for the admin agent only. Use your existing operations account for the selected country. Controlled entries such as Trace are shown by account permission.", "Este login e apenas para o agente de backoffice. Use sua conta operacional existente para o pais selecionado. Entradas controladas, como Trace, aparecem conforme a permissao da conta.", "यह लॉगिन केवल एडमिन एजेंट के लिए है। चुने गए देश के लिए अपना मौजूदा ऑपरेशंस खाता उपयोग करें। Trace जैसे नियंत्रित प्रवेश खाते की अनुमति के अनुसार दिखेंगे।") }}</p>
    </section>
  </main>
</template>

<style scoped>
.stage {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: calc(18px + var(--safe-top)) var(--pad) calc(24px + var(--safe-bottom));
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
}

.ghost-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
  font-size: 12px;
}

.ghost-link:hover {
  color: var(--ink);
  background: var(--fill-soft);
}

.kicker {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
}


.sheet {
  width: min(420px, 100%);
  margin: auto 0;
  animation: rise 0.55s ease both;
}

h1 {
  margin: 0;
  font-size: clamp(40px, 11vw, 64px);
  line-height: 0.92;
  font-weight: 600;
}

.lead,
.hint {
  color: var(--muted);
  line-height: 1.65;
}

.lead {
  margin: 16px 0 32px;
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

input,
select,
button {
  height: 48px;
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink);
  padding: 0 14px;
  font-size: 16px;
  border-radius: var(--radius);
  appearance: none;
}

select {
  border-radius: var(--radius);
  background-image: linear-gradient(45deg, transparent 50%, var(--ink) 50%),
    linear-gradient(135deg, var(--ink) 50%, transparent 50%);
  background-position:
    calc(100% - 18px) 22px,
    calc(100% - 12px) 22px;
  background-size: 6px 6px;
  background-repeat: no-repeat;
}

button {
  margin-top: 6px;
  background: var(--ink);
  color: var(--bg);
  border-color: var(--ink);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  transition: opacity 0.16s ease, transform 0.12s ease;
}

button:hover:not(:disabled) {
  opacity: 0.88;
}

button:active:not(:disabled) {
  transform: translateY(1px);
}

button:disabled {
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

@media (min-width: 900px) {
  .stage {
    padding: 32px 48px 40px;
  }

  .sheet {
    margin: auto 8vw;
  }
}
</style>
