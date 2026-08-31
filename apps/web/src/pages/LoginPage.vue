<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { fetchCountries, login, type Country } from "../api";
import ThemeToggle from "../components/ThemeToggle.vue";

const router = useRouter();
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
    await router.replace("/chat");
  } catch (err) {
    error.value = err instanceof Error ? err.message : "登录失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="stage">
    <header class="top">
      <p class="kicker">运营助手</p>
      <ThemeToggle />
    </header>

    <section class="sheet">
      <h1 class="brand-mark">小助手</h1>
      <p class="lead">登录后用自然语言查询与管理运营后台各业务模块，可用的页面与操作以登录后为准。</p>
      <form class="form" @submit.prevent="submit">
        <label>
          国家 / 环境
          <select v-model="country" required>
            <option v-for="item in countries" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </label>
        <label>
          账号
          <input v-model="username" autocomplete="username" inputmode="text" required />
        </label>
        <label>
          密码
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
        <p v-if="error" class="error">{{ error }}</p>
        <button type="submit" :disabled="loading">{{ loading ? "登录中…" : "进入" }}</button>
      </form>
      <p class="hint">使用原运营账号登录对应国家线。</p>
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
