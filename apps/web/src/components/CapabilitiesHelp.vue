<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  "use-example": [text: string];
}>();

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
  "需要看白名单管理的列表",
  "用户列表，10038557464768004，看详情",
  "登录数据统计，近7天，google登录方式和图表",
  "看平台收入趋势",
  "把白名单列表导出成 Excel",
  "帮我下架某部影片",
  "查一下报销流程",
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
          <h2 id="cap-title">助手能力与用法</h2>
          <button type="button" class="cap-x" aria-label="关闭" @click="close">×</button>
        </header>

        <div class="cap-body">
          <!-- 总：一句话定位 -->
          <p class="cap-intro">
            我是后台业务助手：把你的自然语言，变成对后台数据的<strong>查询、报表、导出和写操作</strong>，
            字段与口径均对齐 PC 后台。用「模块 + 动作」说清要什么即可，缺信息我会反问，写操作会先跟你确认。
          </p>

          <!-- 分：查数据 -->
          <section>
            <h3>查数据（列表 / 详情）</h3>
            <ul>
              <li><b>列表</b>：说清模块 + 动作，如「白名单列表」→ 中文表格，字段对齐 PC 后台</li>
              <li><b>详情</b>：尽量带 ID，如「用户 10038557464768004 详情」→ 分块展示</li>
              <li><b>树表 / 表尾</b>：有层级或汇总需求时自动缩进、出合计/均值行</li>
            </ul>
          </section>

          <!-- 分：报表与图表 -->
          <section>
            <h3>报表 / 趋势 / 图表</h3>
            <ul>
              <li>登录统计、收入趋势等：给周期与维度（如「近7天」「Google 登录」）→ 折线图 + 数据表</li>
              <li>通用报表按 PC 口径自动对齐表头并出图，不再手拼序列</li>
            </ul>
          </section>

          <!-- 分：导出 -->
          <section>
            <h3>导出 Excel / PDF</h3>
            <ul>
              <li>说「导出 Excel / PDF」→ 聊天内预览，可下载，支持树表与表尾汇总</li>
            </ul>
          </section>

          <!-- 分：写操作 -->
          <section>
            <h3>写操作（新增 / 修改 / 删除 / 审核）</h3>
            <ul>
              <li>如「下架影片」「新增配置」「更新状态」→ 先弹确认再执行，执行后回读结果</li>
            </ul>
          </section>

          <!-- 分：知识库 -->
          <section>
            <h3>公司知识库（规范 / 流程 / 制度）</h3>
            <ul>
              <li>问报销、部署、制度等 → 检索本地知识库并标注来源回答，不凭空编造</li>
            </ul>
          </section>

          <!-- 分：示例 -->
          <section>
            <h3>示例（点一下填入输入框）</h3>
            <div class="cap-chips">
              <button
                v-for="ex in examples"
                :key="ex"
                type="button"
                class="cap-chip"
                @click="pickExample(ex)"
              >
                {{ ex }}
              </button>
            </div>
          </section>

          <!-- 总：边界与约定 -->
          <p class="cap-note">
            真数据需有效登录；一次一件事，缺信息会反问，写操作必须确认。
            视频 / BI / 富文本只给摘要或链接，不内嵌播放器或完整 HTML；图片会自动切换视觉模型识别。
          </p>
        </div>

        <footer class="cap-foot">
          <button type="button" class="cap-ok" @click="close">知道了</button>
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
