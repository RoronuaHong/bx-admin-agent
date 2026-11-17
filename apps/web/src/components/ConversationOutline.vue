<script setup lang="ts">
// 对话大纲浮层（docs/conversation-outline-panel-plan.md §4-§7）：
// 右缘悬浮「FAB + 面板」，列出当前会话的用户指令节点；点击条目跳转（跳转逻辑在 ChatPage），
// 高亮随 .thread 滚动跟踪（缓存 + 二分，面板收起时零开销）；面板列表窗口化渲染（万条级冷开 ~557ms → 十毫秒级）。
// 纯展示组件：状态（open/activeId）由父级持有。
//
// 约定与 BackToTop 一致：
// - 文案走 tx()（zh / en / pt-BR / hi），模板内联调用保持 locale 响应式；
// - 配色只用主题变量（--panel/--line/--ink/--muted/--accent/--shadow…），深浅色自动跟随；
// - 无障碍：原生 button、aria-expanded / aria-current、Esc 关面板回焦点、尊重 reduced-motion。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getUiLocale } from "../ui-locale";

interface OutlineItem {
  id: number;
  label: string;
}

const props = defineProps<{
  /** 大纲条目（ChatPage.conversationOutline 派生）。 */
  items: OutlineItem[];
  /** 当前高亮条目（父级持有：切换会话时父级负责清空防残影）。 */
  activeId: number | null;
  /** 面板展开态（v-model:open）。 */
  open: boolean;
  /** 高亮带位置（视口顶部往下比例）；父级跳转落点用同一口径，避免点 A 亮 B。 */
  band: number;
  /** 点击跳转后锁定高亮，滚动跟踪在此期间不改写 activeId。 */
  pinnedId: number | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  /** 点击条目：父级负责跨渲染窗口扩容 + 滚动 + 落焦。 */
  (e: "jump", id: number): void;
  /** 滚动跟踪结果回传父级（父级只存不用，保持单一数据流）。 */
  (e: "active", id: number | null): void;
}>();

const locale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  locale.value === "zh" ? zh : locale.value === "pt-BR" ? pt : locale.value === "hi" ? hi : en;

const root = ref<HTMLElement | null>(null);
const fabEl = ref<HTMLButtonElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

/* —— 面板列表窗口化渲染：条目统一单行（nowrap + ellipsis），只挂可视区 ± 余量。
      万条级大纲（5,263 条）冷开实测 ~557ms 全量挂载 → 窗口化后首帧只挂 ~50 条，进入十毫秒级。
      行高不写死：首帧用 31px 预估，挂载后实测单条真实高度自校——所有条目同字体同行高且强制单行，
      单点测量即全量成立。 —— */
const ROW_EST = 31;
const OVERSCAN = 16;
const rowH = ref(ROW_EST);
const listScrollTop = ref(0);
const listClientH = ref(360);
const winStart = computed(() => {
  const count = props.items.length;
  const firstVisible = Math.floor(listScrollTop.value / rowH.value);
  const maxStart = Math.max(0, count - Math.ceil(listClientH.value / rowH.value));
  return Math.max(0, Math.min(firstVisible - OVERSCAN, maxStart));
});
const winEnd = computed(() =>
  Math.min(props.items.length, winStart.value + Math.ceil(listClientH.value / rowH.value) + OVERSCAN * 2),
);
const windowedItems = computed(() => {
  const out: Array<{ item: OutlineItem; index: number }> = [];
  for (let i = winStart.value; i < winEnd.value; i++) {
    const item = props.items[i];
    if (item) out.push({ item, index: i });
  }
  return out;
});

/** 读取列表真实滚动状态，驱动窗口 computed（scroll 事件 + 打开/校准时调用）。 */
function syncListMetrics() {
  const list = listEl.value;
  if (!list) return;
  listScrollTop.value = list.scrollTop;
  listClientH.value = list.clientHeight || listClientH.value;
}

/** 实测单条真实行高，自校窗口算术。 */
function measureRowH() {
  const first = listEl.value?.querySelector<HTMLElement>(".conv-outline__item");
  if (first && first.offsetHeight > 0) rowH.value = first.offsetHeight;
}

function onListScroll() {
  syncListMetrics();
}

/** 列表顶部内边距：绝对定位条目的内容坐标 = padding-top + index * rowH。 */
function listPadTop(): number {
  const list = listEl.value;
  return list ? parseFloat(getComputedStyle(list).paddingTop) || 0 : 0;
}

/** 窗口尺寸变化：面板高度、行高都可能变，窗口化度量要跟着重算。 */
function onWindowResize() {
  measureRowH();
  syncListMetrics();
  onScroll();
}

/** 组件约定挂在 .thread 内（ChatPage 的对话滚动容器），直接就近取宿主；
 *  不像 BackToTop 需要兼容整页滚动布局，无需向上遍历探测。 */
function findScroller(): HTMLElement | null {
  return root.value?.closest<HTMLElement>(".thread") ?? null;
}

/** 贴底判定容差：与页面跟底逻辑（nearBottom）同口径。 */
const BOTTOM_GAP = 48;
let ticking = false;

/**
 * 已渲染条目缓存：行在 DOM 里自上而下有序（rect.top 单调不减），滚动跟踪对 top 做二分，
 * 布局读取从 O(N) 降到 O(log N)——万条级任务会话实测全量扫描 ~46ms/帧，二分后 <1ms/帧。
 * 缓存签名 = 条目数 + 首末条目 id + 内容高度（512px 分桶）：扩窗跳转、切换会话、增删气泡都会失效重建；
 * 失效间隔内的新行不影响正确性：贴底走快速路径（见 syncActive），而非贴底时新用户消息必然改变条目数/首末 id 触发重建。
 * 注：面板列表自身用窗口化渲染（上方 computed）；content-visibility 曾试过——数千均匀单行条目下
 * 逐帧相关性检查是净开销（33.9ms/帧 vs 关掉 16.6ms/帧），故弃用，窗口化才是海量小块的正解。
 */
let renderedCache: Array<{ id: number; el: Element }> = [];
let cacheSig = "";

function buildRenderedCache(scroller: HTMLElement, items: OutlineItem[]) {
  const anchors = new Map<string, Element>();
  scroller.querySelectorAll("[data-bubble-id]").forEach((el) => {
    anchors.set(el.getAttribute("data-bubble-id") || "", el);
  });
  renderedCache = [];
  for (const item of items) {
    const el = anchors.get(String(item.id));
    if (el) renderedCache.push({ id: item.id, el });
  }
}

function syncActive() {
  ticking = false;
  // 点击跳转后的锁定窗口：父级已把 activeId 设为被点项，滚动跟踪先别改写。
  if (props.pinnedId !== null) return;
  const scroller = findScroller();
  if (!scroller || !props.items.length) return;
  // 面板收起时高亮值不可见，不做逐帧扫描（打开瞬间 open watcher 会强制全量同步一次）。
  if (!props.open) return;
  const lastItem = props.items[props.items.length - 1];
  // 快速路径：内容不满一屏（全部可见）或贴底（正在读最新一轮）——当前项=最后一条。
  // 无需锚点缓存，面板冷开因此免去万条级的锚点收集（~40ms）。
  if (
    scroller.scrollHeight <= scroller.clientHeight + 1 ||
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BOTTOM_GAP
  ) {
    if (lastItem && lastItem.id !== props.activeId) emit("active", lastItem.id);
    return;
  }
  const sig = `${props.items.length}:${props.items[0]?.id}:${props.items[props.items.length - 1]?.id}:${Math.floor(scroller.scrollHeight / 512)}`;
  if (sig !== cacheSig) {
    buildRenderedCache(scroller, props.items);
    cacheSig = sig;
  }
  const rendered = renderedCache;
  if (!rendered.length) return;
  const band = scroller.getBoundingClientRect().top + scroller.clientHeight * props.band;
  // 二分找「top 已越过带」的最后一条（单调不减）。
  let lo = 0;
  let hi = rendered.length - 1;
  let crossed = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const probe = rendered[mid];
    if (probe && probe.el.getBoundingClientRect().top <= band) {
      crossed = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 全部在带下方（视口停在最早消息附近）→ 取第一条已渲染的；全部在上方 → 已取最后一条。
  const active: number | null = crossed >= 0 ? (rendered[crossed]?.id ?? null) : (rendered[0]?.id ?? null);
  if (active !== props.activeId) emit("active", active);
}

/** rAF 节流：滚动事件很密，保证每帧最多量一次布局。 */
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(syncActive);
}

/** 面板内层滚到当前条目：窗口化 + 均匀行高 → 纯算术定位（O(1)，不量 DOM、不依赖补丁时序）。 */
function revealActive() {
  const list = listEl.value;
  if (!list || props.activeId === null) return;
  const index = props.items.findIndex((i) => i.id === props.activeId);
  if (index < 0) return;
  const top = listPadTop() + index * rowH.value;
  const bottom = top + rowH.value;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  syncListMetrics();
}

function closeFromPanel() {
  emit("update:open", false);
  // 焦点回 FAB：面板是 v-if 卸载，不接管焦点会掉到 body（键盘用户丢失位置）。
  fabEl.value?.focus({ preventScroll: true });
}

let scroller: HTMLElement | null = null;

onMounted(() => {
  scroller = findScroller();
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onWindowResize, { passive: true });
  // 刷新后可能已处于某个滚动位置（浏览器滚动恢复）。
  syncActive();
});

onBeforeUnmount(() => {
  scroller?.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onWindowResize);
});

// 大纲内容整体替换（换会话，即便条目数相同）/新增删除气泡：布局变了就重算当前项，
// 否则同条目数的会话切换会留着空高亮直到下一次滚动。
watch(
  () => props.items,
  () => {
    cacheSig = "";
    void nextTick(syncActive);
  },
);

// 展开面板（pre-flush：先于 v-if 首渲染）：
// 1) 预置滚动种子到 active 附近——首帧直接渲染正确窗口，免去「先渲染顶部 → 再跳深处」的二次渲染；
// 2) 扫描缓存失效；挂载后实测行高 + 校准滚动度量 + 全量同步一次当前项。
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    if (props.activeId !== null) {
      const idx = props.items.findIndex((i) => i.id === props.activeId);
      listScrollTop.value = idx >= 0 ? Math.max(0, idx * rowH.value - listClientH.value / 2) : 0;
    } else {
      listScrollTop.value = 0;
    }
    cacheSig = "";
    void nextTick(() => {
      measureRowH();
      syncListMetrics();
      syncActive();
    });
  },
);

// 滚动跟踪刷新当前项时，把该条目滚进面板可视区（纯算术定位，无需等 DOM 补丁；
// instant，避免与用户手动滚列表打架）。
watch(
  () => props.activeId,
  () => revealActive(),
);

// 用户滚动解锁后立刻重算一次，不依赖同帧 scroll 监听器的先后顺序。
watch(
  () => props.pinnedId,
  (pinned, prev) => {
    if (prev !== null && pinned === null) void nextTick(syncActive);
  },
);
</script>

<template>
  <div ref="root" class="conv-outline">
    <!-- 折叠 FAB：胶囊按钮 + 条目数徽标；面板展开时徽标隐藏（面板头部已有计数）。
         无条目（新会话 / 无用户消息）时整组不渲染。 -->
    <button
      v-if="items.length"
      ref="fabEl"
      class="conv-outline__fab"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open && items.length ? 'conv-outline-panel' : undefined"
      :aria-label="tx('对话大纲', 'Conversation outline', 'Estrutura da conversa', 'बातचीत की रूपरेखा')"
      :title="tx('对话大纲', 'Conversation outline', 'Estrutura da conversa', 'बातचीत की रूपरेखा')"
      @click="emit('update:open', !open)"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h10" />
        <circle cx="4" cy="6" r="0.5" fill="currentColor" />
      </svg>
      <span v-if="!open" class="conv-outline__badge" aria-hidden="true">{{ items.length }}</span>
    </button>

    <Transition name="conv-outline">
      <nav
        v-if="open && items.length"
        id="conv-outline-panel"
        class="conv-outline__panel"
        :aria-label="tx('对话大纲', 'Conversation outline', 'Estrutura da conversa', 'बातचीत की रूपरेखा')"
        @keydown.esc.prevent="closeFromPanel"
      >
        <div class="conv-outline__head">
          <span class="conv-outline__title">{{ tx("对话大纲", "Conversation outline", "Estrutura da conversa", "बातचीत की रूपरेखा") }}</span>
          <span class="conv-outline__count">{{ items.length }}</span>
          <button
            class="conv-outline__close"
            type="button"
            :aria-label="tx('收起', 'Collapse', 'Recolher', 'समेटें')"
            :title="tx('收起', 'Collapse', 'Recolher', 'समेटें')"
            @click="closeFromPanel"
          >
            ×
          </button>
        </div>
        <div ref="listEl" class="conv-outline__list" @scroll="onListScroll">
          <!-- 窗口化画布：总高 = 条目数 × 行高（均匀单行），只挂可视窗口内的条目（绝对定位）。
               屏外条目不在 DOM——给条目带上 setsize/posinset，让读屏器知道完整规模与位置。 -->
          <div class="conv-outline__canvas" :style="{ height: `${items.length * rowH}px` }">
            <button
              v-for="{ item, index } in windowedItems"
              :key="item.id"
              type="button"
              class="conv-outline__item"
              :class="{ active: item.id === activeId }"
              :aria-current="item.id === activeId ? 'true' : undefined"
              :aria-setsize="items.length"
              :aria-posinset="index + 1"
              :title="item.label"
              :style="{ top: `${index * rowH}px` }"
              @click="emit('jump', item.id)"
            >
              <span class="conv-outline__text">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </nav>
    </Transition>
  </div>
</template>

<style scoped>
.conv-outline {
  position: fixed;
  right: calc(10px + env(safe-area-inset-right, 0px));
  top: 50%;
  transform: translateY(-50%);
  /* 内容层顶档（与 BackToTop / .done-toast 同层），低于抽屉/弹窗家族（1000+）。 */
  z-index: 60;
}

/* FAB：36px 胶囊，垂直居中锚点；面板绝对定位向上展开，锚点不动。 */
.conv-outline__fab {
  position: relative;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--line, #dbdbd4);
  border-radius: var(--radius-pill, 999px);
  background: var(--panel, #fcfcf9);
  color: var(--ink, #141413);
  box-shadow: var(--shadow, 0 20px 50px rgb(16 24 40 / 10%));
  cursor: pointer;
  /* 触屏消除双击缩放延迟。 */
  touch-action: manipulation;
  transition: transform 0.16s var(--ease, ease), box-shadow 0.16s var(--ease, ease), background 0.16s var(--ease, ease);
}

.conv-outline__fab:hover {
  transform: translateY(-2px);
  background: var(--fill, #fff);
}

.conv-outline__fab:focus-visible {
  outline: none;
  box-shadow: var(--ring, 0 0 0 3px rgb(20 20 19 / 13%)), var(--shadow, 0 20px 50px rgb(16 24 40 / 10%));
}

.conv-outline__badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-pill, 999px);
  /* 墨底纸字：浅/深主题对比均 >15:1（金底白字浅色下仅 ~3:1，不达 WCAG AA）。 */
  background: var(--ink, #141413);
  color: var(--panel, #fcfcf9);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* 面板：半透明 + backdrop 毛玻璃（不支持时退化为实色，不写死颜色）。 */
.conv-outline__panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  width: min(240px, 40vw);
  max-height: calc(50vh - 60px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line, #dbdbd4);
  border-radius: 14px;
  background: var(--panel, #fcfcf9);
  box-shadow: var(--shadow, 0 20px 50px rgb(16 24 40 / 10%));
  overflow: hidden;
}

@supports (backdrop-filter: blur(1px)) {
  .conv-outline__panel {
    background: color-mix(in srgb, var(--panel, #fcfcf9) 88%, transparent);
    backdrop-filter: blur(10px);
  }
}

.conv-outline__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 8px 12px;
  border-bottom: 1px solid var(--line, #dbdbd4);
}

.conv-outline__title {
  font-size: 12px;
  color: var(--muted, #686868);
}

.conv-outline__count {
  font-size: 11px;
  color: var(--muted, #686868);
  font-variant-numeric: tabular-nums;
}

.conv-outline__close {
  margin-left: auto;
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #686868);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.conv-outline__close:hover {
  background: var(--fill-soft, #eeece8);
  color: var(--ink, #141413);
}

.conv-outline__close:focus-visible {
  outline: none;
  box-shadow: var(--ring, 0 0 0 3px rgb(20 20 19 / 13%));
}

/* 列表：内滚；position:relative 让条目 offsetParent 指向列表（revealActive 依赖）。
   flex 子项默认 min-height:auto 会顶着内容撑破面板（被 overflow:hidden 裁掉而非滚动），
   必须显式 min-height:0 让它在 max-height 内收缩出滚动区。 */
.conv-outline__list {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
}

/* 窗口化画布：高度由内联样式给出（条目数 × 行高），条目绝对定位铺排。 */
.conv-outline__canvas {
  position: relative;
}

.conv-outline__item {
  position: absolute;
  left: 0;
  right: 0;
  display: block;
  padding: 6px 8px 6px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--ink, #141413);
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
}

.conv-outline__item:hover {
  background: var(--fill-soft, #eeece8);
}

.conv-outline__item:focus-visible {
  outline: none;
  box-shadow: var(--ring, 0 0 0 3px rgb(20 20 19 / 13%));
}

.conv-outline__text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-outline__item.active {
  color: var(--accent, #b9882f);
}

/* 当前项左侧高亮竖条（对齐原型）。 */
.conv-outline__item.active::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent, #b9882f);
}

/* 进出场：从右侧轻滑入。 */
.conv-outline-enter-active,
.conv-outline-leave-active {
  transition: opacity 0.16s var(--ease, ease), transform 0.16s var(--ease, ease);
}

.conv-outline-enter-from,
.conv-outline-leave-to {
  opacity: 0;
  transform: translateX(10px);
}

@media (max-width: 860px) {
  /* 40px：对齐页面 .hamburger 的触屏点击目标下限（WCAG 2.5.8 ≥24px，触屏惯例 40px+）。 */
  .conv-outline__fab {
    width: 40px;
    height: 40px;
  }

  .conv-outline__panel {
    width: min(240px, 58vw);
    max-height: calc(44vh - 48px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .conv-outline__fab,
  .conv-outline-enter-active,
  .conv-outline-leave-active {
    transition: none;
  }

  .conv-outline__fab:hover {
    transform: none;
  }

  .conv-outline-enter-from,
  .conv-outline-leave-to {
    transform: none;
  }
}
</style>
