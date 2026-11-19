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

function closePanel() {
  mode.value = "";
  activeDir.value = "";
  errorText.value = "";
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
        <button class="skills__btn skills__btn--primary" type="button" :disabled="busy" @click="openCreate">新建</button>
        <button class="skills__btn" type="button" :disabled="busy" @click="openUpload">上传</button>
        <button class="skills__btn" type="button" :disabled="loading" @click="load">{{ loading ? "加载中…" : "刷新" }}</button>
        <RouterLink class="skills__btn" to="/">返回门户</RouterLink>
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

    <div class="skills__layout" :class="{ 'skills__layout--split': mode }">
      <div>
        <section>
          <h2 class="skills__section">系统自带 <span class="skills__count">{{ builtin.length }}</span></h2>
          <p v-if="!loading && !builtin.length" class="skills__empty">没有匹配的系统技能。</p>
          <ul class="skills__list">
            <li v-for="skill in builtin" :key="skill.dir" class="skills__item" :class="{ off: !skill.enabled }">
              <button type="button" class="skills__main" @click="openSkill(skill, false)">
                <span class="skills__name">{{ skill.name }}</span>
                <span class="skills__dir">{{ skill.dir }}</span>
                <span class="skills__desc">{{ skill.description || "（无描述）" }}</span>
                <span
                  class="skills__badge"
                  :class="{ 'skills__badge--off': !skill.enabled, 'skills__badge--auto': skill.default }"
                >{{ badge(skill) }}</span>
              </button>
              <div class="skills__row-actions">
                <button class="skills__mini" type="button" :disabled="busy" @click="onToggle(skill)">
                  {{ skill.enabled ? "关闭" : "打开" }}
                </button>
              </div>
            </li>
          </ul>
        </section>

        <section>
          <h2 class="skills__section">本地技能 <span class="skills__count">{{ local.length }}</span></h2>
          <p v-if="!loading && !local.length" class="skills__empty">还没有本地技能。新建或上传一份 SKILL.md。</p>
          <ul class="skills__list">
            <li v-for="skill in local" :key="skill.dir" class="skills__item" :class="{ off: !skill.enabled }">
              <button type="button" class="skills__main" @click="openSkill(skill, false)">
                <span class="skills__name">{{ skill.name }}</span>
                <span class="skills__dir">{{ skill.dir }}</span>
                <span class="skills__desc">{{ skill.description || "（无描述）" }}</span>
                <span
                  class="skills__badge"
                  :class="{ 'skills__badge--off': !skill.enabled, 'skills__badge--auto': skill.default }"
                >{{ badge(skill) }}</span>
              </button>
              <div class="skills__row-actions">
                <button class="skills__mini" type="button" :disabled="busy" @click="openSkill(skill, true)">编辑</button>
                <button class="skills__mini" type="button" :disabled="busy" @click="onToggle(skill)">
                  {{ skill.enabled ? "关闭" : "打开" }}
                </button>
                <button class="skills__mini skills__mini--danger" type="button" :disabled="busy" @click="onDelete(skill)">删除</button>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <aside v-if="mode" class="skills__panel">
        <div class="skills__panel-head">
          <h2 class="skills__section">
            {{ mode === "create" ? "新建本地技能" : mode === "upload" ? "上传" : mode === "edit" ? "编辑" : "查看" }}
          </h2>
          <button class="skills__close" type="button" :aria-label="tx('关闭面板', 'Close panel')" @click="closePanel">×</button>
        </div>

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
  max-width: 1180px;
  margin: 0 auto;
  padding: clamp(24px, 4vw, 44px) clamp(18px, 4vw, 36px) 80px;
  color: var(--text, #1f2328);
}

/* 页头：标题用衬线展示字体呼应纸感主题，底部发丝线分隔内容区 */
.skills__head {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  justify-content: space-between;
  align-items: flex-end;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line, #dbdbd4);
}
.skills__title {
  margin: 0;
  font-family: var(--font-display, Georgia, serif);
  font-size: clamp(28px, 4vw, 38px);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.skills__sub {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2, var(--muted, #686868));
  max-width: 60ch;
}
.skills__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

/* 按钮：统一圆角胶囊、控件高度与悬停反馈；主操作用深色实底拉开层级 */
.skills__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--ctrl-h, 34px);
  padding: 0 16px;
  border: 1px solid var(--line, #d8dee4);
  border-radius: var(--radius-pill, 999px);
  background: var(--fill, #fff);
  color: var(--ink, inherit);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.16s var(--ease, ease), border-color 0.16s var(--ease, ease), color 0.16s var(--ease, ease);
}
.skills__btn:hover:not(:disabled) {
  border-color: var(--accent, #b9882f);
  background: var(--accent-soft, transparent);
}
.skills__btn:focus-visible {
  box-shadow: var(--ring, 0 0 0 3px rgba(0, 0, 0, 0.12));
}
.skills__btn--primary {
  background: var(--ink, #1f2328);
  border-color: var(--ink, #1f2328);
  color: var(--bg, #fff);
}
.skills__btn--primary:hover:not(:disabled) {
  background: var(--accent, #b9882f);
  border-color: var(--accent, #b9882f);
  color: var(--bg, #fff);
}
.skills__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 搜索框 */
.skills__search {
  display: block;
  margin: 22px 0 0;
  width: min(420px, 100%);
  height: var(--ctrl-h, 34px);
  border: 1px solid var(--line, #d8dee4);
  border-radius: var(--radius-pill, 999px);
  padding: 0 16px;
  background: var(--fill, #fff);
  font: inherit;
  font-size: 13px;
  transition: border-color 0.16s var(--ease, ease), box-shadow 0.16s var(--ease, ease);
}
.skills__search:focus {
  outline: none;
  border-color: var(--accent, #b9882f);
  box-shadow: var(--ring, 0 0 0 3px rgba(0, 0, 0, 0.12));
}

/* 反馈条 */
.skills__error,
.skills__notice {
  margin: 16px 0 0;
  padding: 10px 14px;
  border-radius: var(--radius-sm, 8px);
  font-size: 13px;
}
.skills__error {
  color: var(--danger, #8f2b22);
  background: var(--danger-soft, transparent);
}
.skills__notice {
  color: var(--success, #2f9e63);
  background: var(--success-soft, transparent);
}

/* 主布局：无面板时单列，列表铺满并自动分栏；打开面板才切两列 */
.skills__layout {
  margin-top: 30px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 32px;
  align-items: start;
}
.skills__layout--split {
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
}

/* 小节标题：衬线字 + 计数药丸 + 延伸分隔线 */
.skills__section {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 16px;
  font-family: var(--font-display, Georgia, serif);
  font-size: 20px;
  font-weight: 600;
}
.skills__section::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line, #dbdbd4);
}
.skills__count {
  font-family: var(--font-body, inherit);
  font-size: 12px;
  font-weight: 500;
  color: var(--muted, #686868);
  background: var(--fill-soft, #eeece8);
  border-radius: var(--radius-pill, 999px);
  padding: 2px 9px;
}
.skills__layout > div > section + section {
  margin-top: 36px;
}
.skills__empty {
  margin: 0;
  padding: 28px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--muted, #686868);
  background: var(--fill-soft, #eeece8);
  border: 1px dashed var(--line, #dbdbd4);
  border-radius: var(--radius, 12px);
}

/* 技能卡片网格：自适应列宽，宽屏一行多张，避免长列表 */
.skills__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.skills__layout--split .skills__list {
  grid-template-columns: minmax(0, 1fr);
}
.skills__item {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--panel, #fcfcf9);
  border: 1px solid var(--line, #dbdbd4);
  border-radius: var(--radius, 12px);
  transition: border-color 0.18s var(--ease, ease), box-shadow 0.18s var(--ease, ease), transform 0.18s var(--ease, ease);
}
.skills__item:hover {
  border-color: var(--accent, #b9882f);
  box-shadow: var(--shadow, 0 20px 50px rgba(20, 20, 19, 0.07));
  transform: translateY(-2px);
}
.skills__item.off {
  opacity: 0.55;
}
.skills__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  padding: 0;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.skills__name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink, inherit);
}
.skills__dir {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--muted, #686868);
  background: var(--fill-soft, #eeece8);
  border-radius: var(--radius-sm, 8px);
  padding: 2px 7px;
}
.skills__desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2, var(--muted, #686868));
}
.skills__badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--success, #2f9e63);
  background: var(--success-soft, transparent);
  border-radius: var(--radius-pill, 999px);
}
.skills__badge::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.skills__badge--auto {
  color: var(--accent, #b9882f);
  background: var(--accent-soft, transparent);
}
.skills__badge--off {
  color: var(--danger, #8f2b22);
  background: var(--danger-soft, transparent);
}

/* 卡片底部操作：状态徽标之外的次要动作，弱化为小号胶囊 */
.skills__row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding-top: 10px;
  border-top: 1px solid var(--line, #dbdbd4);
}
.skills__mini {
  padding: 4px 10px;
  border: 1px solid var(--line, #d8dee4);
  border-radius: var(--radius-pill, 999px);
  background: var(--fill, #fff);
  color: var(--ink-2, inherit);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.16s var(--ease, ease), border-color 0.16s var(--ease, ease), color 0.16s var(--ease, ease);
}
.skills__mini:hover:not(:disabled) {
  border-color: var(--accent, #b9882f);
  color: var(--accent, #b9882f);
  background: var(--accent-soft, transparent);
}
.skills__mini--danger:hover:not(:disabled) {
  border-color: var(--danger, #8f2b22);
  color: var(--danger, #8f2b22);
  background: var(--danger-soft, transparent);
}
.skills__mini:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 详情/编辑面板：仅在有操作时出现，粘顶便于长列表对照 */
.skills__panel {
  position: sticky;
  top: 20px;
  padding: 20px;
  background: var(--panel, #fcfcf9);
  border: 1px solid var(--line, #dbdbd4);
  border-radius: var(--radius-lg, 18px);
  box-shadow: var(--shadow, 0 20px 50px rgba(20, 20, 19, 0.07));
}
.skills__panel .skills__section::after {
  display: none;
}
.skills__panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.skills__panel-head .skills__section {
  margin: 0;
}
.skills__close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--line, #d8dee4);
  border-radius: var(--radius-pill, 999px);
  background: var(--fill, #fff);
  color: var(--muted, #686868);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s var(--ease, ease), border-color 0.16s var(--ease, ease), color 0.16s var(--ease, ease);
}
.skills__close:hover {
  border-color: var(--accent, #b9882f);
  color: var(--accent, #b9882f);
  background: var(--accent-soft, transparent);
}
.skills__close:focus-visible {
  box-shadow: var(--ring, 0 0 0 3px rgba(0, 0, 0, 0.12));
}
.skills__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}
.skills__form label,
.skills__form fieldset {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--ink-2, inherit);
  font-weight: 500;
}
.skills__form legend {
  margin-bottom: 4px;
}
.skills__form input,
.skills__form textarea {
  font: inherit;
  font-weight: 400;
  border: 1px solid var(--line, #d8dee4);
  border-radius: var(--radius-sm, 8px);
  padding: 8px 10px;
  background: var(--fill, #fff);
  color: var(--ink, inherit);
  transition: border-color 0.16s var(--ease, ease), box-shadow 0.16s var(--ease, ease);
}
.skills__form input:focus,
.skills__form textarea:focus {
  outline: none;
  border-color: var(--accent, #b9882f);
  box-shadow: var(--ring, 0 0 0 3px rgba(0, 0, 0, 0.12));
}
.skills__check {
  flex-direction: row !important;
  align-items: center;
  gap: 8px;
}
.skills__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted, #686868);
  line-height: 1.5;
}
.skills__preview {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  max-height: 70vh;
  overflow: auto;
  margin: 0;
  padding: 14px;
  background: var(--fill-soft, #eeece8);
  border-radius: var(--radius-sm, 8px);
}

@media (max-width: 900px) {
  .skills__layout--split {
    grid-template-columns: 1fr;
  }
  .skills__panel {
    position: static;
  }
}
@media (max-width: 560px) {
  .skills__head {
    align-items: flex-start;
  }
  .skills__actions {
    width: 100%;
  }
}
</style>
