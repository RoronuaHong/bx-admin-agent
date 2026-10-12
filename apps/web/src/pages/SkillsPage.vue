<script setup lang="ts">
// 技能管理：系统自带只读，本地技能可增删改。全局开关不改 SKILL.md。
// 对话里勾选全文是另一层，仍在输入框的技能面板。
import { computed, onMounted, ref } from "vue";
import {
  createSkill,
  deleteSkill,
  fetchSkillCatalog,
  fetchSkillDocument,
  importSkillFile,
  setSkillEnabled,
  updateSkill,
  type SkillCatalogItem,
} from "../api";
import { loadPinyin, matchesFuzzyScoped, pinyinReady } from "../pinyin";
import { getUiLocale } from "../ui-locale";

const locale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  locale.value === "zh" ? zh : locale.value === "pt-BR" ? pt : locale.value === "hi" ? hi : en;

const ROLE_OPTIONS = [
  { id: "generic", label: "通用助手" },
  { id: "movie", label: "观影助手" },
  { id: "support", label: "客服助手" },
];

const loading = ref(false);
const busy = ref(false);
const errorText = ref("");
const notice = ref("");
const warning = ref("");
const query = ref("");
const skills = ref<SkillCatalogItem[]>([]);
const mode = ref<"view" | "create" | "edit" | "upload" | "">("");
const activeDir = ref("");
const preview = ref("");
const form = ref({ dir: "", name: "", description: "", roles: [] as string[], body: "" });
const uploadDir = ref("");
const uploadFile = ref<File | null>(null);

const filtered = computed(() => {
  void pinyinReady.value;
  const q = query.value.trim().toLowerCase();
  if (!q) return skills.value;
  return skills.value.filter((skill) =>
    matchesFuzzyScoped([skill.name], [skill.dir, skill.description], q),
  );
});
const builtin = computed(() => filtered.value.filter((skill) => skill.source === "builtin"));
const local = computed(() => filtered.value.filter((skill) => skill.source === "local"));

function onSearchInput() {
  loadPinyin();
}

async function load() {
  loading.value = true;
  errorText.value = "";
  try {
    skills.value = await fetchSkillCatalog();
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  form.value = { dir: "", name: "", description: "", roles: [], body: "" };
  preview.value = "";
  warning.value = "";
}

function openCreate() {
  mode.value = "create";
  activeDir.value = "";
  notice.value = "";
  resetForm();
}

function openUpload() {
  mode.value = "upload";
  activeDir.value = "";
  notice.value = "";
  warning.value = "";
  uploadDir.value = "";
  uploadFile.value = null;
}

async function openSkill(skill: SkillCatalogItem, edit: boolean) {
  errorText.value = "";
  activeDir.value = skill.dir;
  try {
    const doc = await fetchSkillDocument(skill.dir);
    preview.value = doc.content;
    form.value = {
      dir: doc.skill.dir,
      name: doc.skill.name,
      description: doc.skill.description,
      roles: [...(doc.skill.roles || [])],
      body: doc.body,
    };
    mode.value = edit && skill.source === "local" ? "edit" : "view";
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  }
}

function toggleRole(id: string) {
  const roles = form.value.roles;
  form.value.roles = roles.includes(id) ? roles.filter((role) => role !== id) : [...roles, id];
}

async function save() {
  busy.value = true;
  errorText.value = "";
  warning.value = "";
  notice.value = "";
  try {
    const payload = {
      dir: form.value.dir.trim(),
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      roles: form.value.roles,
      body: form.value.body,
    };
    const creating = mode.value === "create";
    const result = creating ? await createSkill(payload) : await updateSkill(payload.dir, payload);
    warning.value = result.warning || "";
    notice.value = creating
      ? "已新建。对话里可以勾选它，不勾选时模型仍会按需加载。"
      : "已保存。";
    if (result.warning) notice.value = `${notice.value} ${result.warning}`;
    mode.value = "view";
    activeDir.value = result.skill.dir;
    await load();
    await openSkill(result.skill, false);
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    busy.value = false;
  }
}

async function onToggle(skill: SkillCatalogItem) {
  busy.value = true;
  errorText.value = "";
  try {
    await setSkillEnabled(skill.dir, !skill.enabled);
    await load();
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    busy.value = false;
  }
}

async function onDelete(skill: SkillCatalogItem) {
  if (!window.confirm(`删除本地技能「${skill.name}」？文件会从这台机器去掉。`)) return;
  busy.value = true;
  errorText.value = "";
  try {
    const result = await deleteSkill(skill.dir);
    notice.value = result.notice || "已从各对话勾选中消失";
    if (activeDir.value === skill.dir) {
      mode.value = "";
      activeDir.value = "";
    }
    await load();
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    busy.value = false;
  }
}

function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  uploadFile.value = input.files?.[0] || null;
}

async function submitUpload() {
  if (!uploadFile.value) {
    errorText.value = "请选择 SKILL.md 或 zip";
    return;
  }
  busy.value = true;
  errorText.value = "";
  warning.value = "";
  try {
    const result = await importSkillFile(uploadDir.value.trim(), uploadFile.value);
    notice.value = "已上传。对话里可以勾选它。";
    if (result.warning) notice.value = `${notice.value} ${result.warning}`;
    mode.value = "";
    await load();
  } catch (err) {
    errorText.value = String((err as Error)?.message || err);
  } finally {
    busy.value = false;
  }
}

function badge(skill: SkillCatalogItem): string {
  if (!skill.enabled) return "已全局关闭";
  if (skill.default) return "按需加载，不用勾选";
  return "可在对话里勾选";
}

onMounted(load);
</script>

<template>
  <div class="skills">
    <header class="skills__head">
      <div>
        <h1 class="skills__title">{{ tx("技能", "Skills", "Habilidades", "स्किल") }}</h1>
        <p class="skills__sub">
          系统自带的技能随版本更新。本地技能只存在这台机器上。关掉后文件还在，但索引、按需读取和对话勾选都不再提供它。
        </p>
      </div>
      <div class="skills__actions">
        <button class="skills__btn" type="button" :disabled="busy" @click="openCreate">新建</button>
        <button class="skills__btn" type="button" :disabled="busy" @click="openUpload">上传</button>
        <button class="skills__btn" type="button" :disabled="loading" @click="load">{{ loading ? "加载中…" : "刷新" }}</button>
        <RouterLink class="skills__btn skills__btn--ghost" to="/">返回门户</RouterLink>
      </div>
    </header>

    <input
      v-model="query"
      class="skills__search"
      type="search"
      placeholder="搜索技能"
      @input="onSearchInput"
    />

    <p v-if="errorText" class="skills__error">{{ errorText }}</p>
    <p v-if="notice" class="skills__notice">{{ notice }}</p>

    <div class="skills__layout">
      <div>
        <section>
          <h2 class="skills__section">系统自带</h2>
          <p v-if="!loading && !builtin.length" class="skills__empty">没有匹配的系统技能。</p>
          <ul class="skills__list">
            <li v-for="skill in builtin" :key="skill.dir" class="skills__item" :class="{ off: !skill.enabled }">
              <button type="button" class="skills__main" @click="openSkill(skill, false)">
                <span class="skills__name">{{ skill.name }}</span>
                <span class="skills__dir">{{ skill.dir }}</span>
                <span class="skills__desc">{{ skill.description || "（无描述）" }}</span>
                <span class="skills__badge">{{ badge(skill) }}</span>
              </button>
              <button class="skills__btn" type="button" :disabled="busy" @click="onToggle(skill)">
                {{ skill.enabled ? "关闭" : "打开" }}
              </button>
            </li>
          </ul>
        </section>

        <section>
          <h2 class="skills__section">本地技能</h2>
          <p v-if="!loading && !local.length" class="skills__empty">还没有本地技能。新建或上传一份 SKILL.md。</p>
          <ul class="skills__list">
            <li v-for="skill in local" :key="skill.dir" class="skills__item" :class="{ off: !skill.enabled }">
              <button type="button" class="skills__main" @click="openSkill(skill, false)">
                <span class="skills__name">{{ skill.name }}</span>
                <span class="skills__dir">{{ skill.dir }}</span>
                <span class="skills__desc">{{ skill.description || "（无描述）" }}</span>
                <span class="skills__badge">{{ badge(skill) }}</span>
              </button>
              <div class="skills__row-actions">
                <button class="skills__btn" type="button" :disabled="busy" @click="openSkill(skill, true)">编辑</button>
                <button class="skills__btn" type="button" :disabled="busy" @click="onToggle(skill)">
                  {{ skill.enabled ? "关闭" : "打开" }}
                </button>
                <button class="skills__btn" type="button" :disabled="busy" @click="onDelete(skill)">删除</button>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <aside v-if="mode" class="skills__panel">
        <h2 class="skills__section">
          {{ mode === "create" ? "新建本地技能" : mode === "upload" ? "上传" : mode === "edit" ? "编辑" : "查看" }}
        </h2>

        <form v-if="mode === 'upload'" class="skills__form" @submit.prevent="submitUpload">
          <label>目录名<input v-model="uploadDir" required placeholder="weekly-report" /></label>
          <label>文件<input type="file" accept=".md,.zip,text/markdown,application/zip" @change="onFile" /></label>
          <p class="skills__hint">只接受单个 SKILL.md，或根目录只有这一个文件的 zip。不能附带脚本。</p>
          <button class="skills__btn skills__btn--primary" type="submit" :disabled="busy">上传</button>
        </form>

        <form v-else-if="mode === 'create' || mode === 'edit'" class="skills__form" @submit.prevent="save">
          <label>目录名<input v-model="form.dir" :readonly="mode === 'edit'" required placeholder="weekly-report" /></label>
          <label>显示名<input v-model="form.name" required maxlength="80" /></label>
          <label>描述<textarea v-model="form.description" required maxlength="1024" rows="3" placeholder="做什么，以及什么时候该用它" /></label>
          <fieldset>
            <legend>适用助手（不选 = 全部可见）</legend>
            <label v-for="role in ROLE_OPTIONS" :key="role.id" class="skills__check">
              <input type="checkbox" :checked="form.roles.includes(role.id)" @change="toggleRole(role.id)" />
              {{ role.label }}
            </label>
          </fieldset>
          <label>正文<textarea v-model="form.body" required rows="12" /></label>
          <button class="skills__btn skills__btn--primary" type="submit" :disabled="busy">保存</button>
        </form>

        <pre v-else class="skills__preview">{{ preview }}</pre>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.skills {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 20px 64px;
  color: var(--text, #1f2328);
}
.skills__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  align-items: flex-start;
}
.skills__title {
  margin: 0;
  font-size: 20px;
}
.skills__sub {
  margin: 6px 0 0;
  font-size: 13px;
  opacity: 0.75;
  max-width: 62ch;
}
.skills__actions,
.skills__row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.skills__btn {
  border: 1px solid var(--border, #d8dee4);
  background: var(--surface, #fff);
  color: inherit;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
}
.skills__btn--ghost {
  text-decoration: none;
  display: inline-block;
}
.skills__btn--primary {
  background: #1f2328;
  color: #fff;
  border-color: #1f2328;
}
.skills__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.skills__search {
  margin-top: 16px;
  width: min(420px, 100%);
  border: 1px solid var(--border, #d8dee4);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
}
.skills__error {
  color: #c0392b;
  font-size: 13px;
}
.skills__notice {
  font-size: 13px;
  color: #1a7f37;
}
.skills__layout {
  margin-top: 16px;
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
  gap: 20px;
  align-items: start;
}
.skills__section {
  margin: 18px 0 8px;
  font-size: 14px;
}
.skills__empty {
  font-size: 13px;
  opacity: 0.7;
}
.skills__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skills__item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
  border: 1px solid var(--border, #d8dee4);
  border-radius: 10px;
  padding: 10px;
}
.skills__item.off {
  opacity: 0.6;
}
.skills__main {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skills__name {
  font-weight: 600;
  font-size: 14px;
}
.skills__dir,
.skills__desc,
.skills__hint,
.skills__badge {
  font-size: 12px;
  opacity: 0.7;
}
.skills__desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skills__badge {
  opacity: 1;
  color: #9a6700;
}
.skills__panel {
  border: 1px solid var(--border, #d8dee4);
  border-radius: 10px;
  padding: 12px;
  position: sticky;
  top: 12px;
}
.skills__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}
.skills__form label,
.skills__form fieldset {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.skills__form input,
.skills__form textarea {
  font: inherit;
  border: 1px solid var(--border, #d8dee4);
  border-radius: 8px;
  padding: 6px 8px;
}
.skills__check {
  flex-direction: row !important;
  align-items: center;
  gap: 6px;
}
.skills__preview {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  max-height: 70vh;
  overflow: auto;
  margin: 0;
}
@media (max-width: 800px) {
  .skills__layout {
    grid-template-columns: 1fr;
  }
  .skills__panel {
    position: static;
  }
}
</style>
