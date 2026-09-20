<script setup lang="ts">
// 返回顶部：页面滚动超过阈值后出现，点击回到页面顶部（滚动容器自动识别，整页滚动与内层容器滚动都可用）。
//
// 约定与页面保持一致：
// - 文案走 tx()（zh / en / pt-BR / hi），与 PortalPage 用同一份界面语言 ref；
// - 配色只用主题变量（--panel/--line/--ink/--shadow…），深浅色自动跟随，不写死颜色；
// - 无障碍：原生 button + aria-label；尊重「减少动态效果」（reduced-motion 下不做平滑滚动与淡入动画）；
//   点击后把焦点移到主标题（页面需给标题加 tabindex="-1"），避免焦点停留在马上就消失的按钮上。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getUiLocale } from "../ui-locale";

const props = withDefaults(
  defineProps<{
    /** 滚动超过多少像素后出现（默认 240，约 1/3 屏，避免小幅滚动就弹出）。 */
    threshold?: number;
    /** 点击后接收焦点的元素选择器（默认页面第一个 h1；页面未标 tabindex="-1" 时不抢焦点）。 */
    focusTarget?: string;
    /**
     * 「不要让按钮压住谁」的选择器（如对话页底部输入区 `.composer`）。
     * 传了就把按钮抬到该元素上方：高度实时测量（含移动端安全区），并用 ResizeObserver 跟随输入框变高。
     */
    avoidSelector?: string;
  }>(),
  { threshold: 240, focusTarget: "h1" },
);

const locale = getUiLocale();
const tx = (zh: string, en: string, pt = en, hi = en) =>
  locale.value === "zh" ? zh : locale.value === "pt-BR" ? pt : locale.value === "hi" ? hi : en;

const root = ref<HTMLElement | null>(null);
const visible = ref(false);
let ticking = false;

/**
 * 找页面真正的滚动容器：**不能直接读 window**。
 * 本仓全局样式是 `html, body, #app { height: 100% }` + `body { overflow-x: hidden }`——按规范，
 * 一个轴不是 visible 时另一轴会计算成 auto，于是 **body 成了滚动容器**，此时 `window.scrollY` 恒为 0、
 * `window.scrollTo()` 也没有效果（实测门户首页正是如此）。
 * 这里从按钮自身往上找最近的可滚动祖先，找不到再退化为「文档级滚动」——内层容器滚动与整页滚动两种布局都成立。
 */
function findScroller(): HTMLElement | null {
  let el: HTMLElement | null = root.value?.parentElement ?? null;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && el.scrollHeight > el.clientHeight + 1) {
      return el;
    }
    el = el.parentElement;
  }
  for (const candidate of [document.scrollingElement, document.body, document.documentElement]) {
    if (candidate instanceof HTMLElement && candidate.scrollHeight > candidate.clientHeight + 1) return candidate;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function scrolledY(): number {
  return Math.max(findScroller()?.scrollTop ?? 0, window.scrollY || 0);
}

/** 底部留白：默认 18px；传了 avoidSelector 就抬到那个元素上方（实时测量，含输入框变高）。 */
const bottomGap = ref("18px");
function syncBottomGap() {
  const selector = props.avoidSelector;
  if (!selector) {
    bottomGap.value = "18px";
    return;
  }
  let avoided: HTMLElement | null = null;
  try {
    avoided = document.querySelector<HTMLElement>(selector);
  } catch {
    avoided = null;
  }
  if (!avoided) {
    bottomGap.value = "18px";
    return;
  }
  // 视口底边到该元素顶边的距离 = 它实际占住的高度；再留 12px 间距，并夹在合理区间防异常值。
  const occupied = window.innerHeight - avoided.getBoundingClientRect().top;
  bottomGap.value = `${Math.max(12, Math.min(280, Math.round(occupied) + 12))}px`;
}

function sync() {
  ticking = false;
  visible.value = scrolledY() > props.threshold;
  syncBottomGap();
}

/** rAF 节流：滚动事件很密，保证每帧最多读一次布局。 */
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(sync);
}

function toTop() {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // 远距离瞬移、近距离平滑：实测 Chrome 对长距离（约 >2 屏）的平滑滚动有 0.3–0.6s 起步空窗、
  // 全程 1s+，点「回到顶部」要的是立刻到位的反馈；短距离保留平滑以免突兀。
  const scroller = findScroller();
  const distance = scroller?.scrollTop ?? window.scrollY ?? 0;
  const viewport = scroller?.clientHeight || window.innerHeight;
  const behavior: ScrollBehavior = reduceMotion || distance > viewport * 2 ? "auto" : "smooth";
  scroller?.scrollTo({ top: 0, behavior });
  window.scrollTo({ top: 0, behavior }); // 文档级滚动布局下的兜底（body 滚动时是无害的空操作）
  // 焦点管理：页面用 tabindex="-1" 显式标了可聚焦的元素（标题 / 滚动区）时，把焦点交给它，
  // 避免焦点留在一个马上就 display:none 的按钮上（那会掉到 body，键盘用户丢失位置）。
  let target: HTMLElement | null = null;
  try {
    target = props.focusTarget ? document.querySelector<HTMLElement>(props.focusTarget) : null;
  } catch {
    target = null; // 选择器写错时不抛错，退化为 blur
  }
  if (target?.hasAttribute("tabindex")) target.focus({ preventScroll: true });
  else (document.activeElement as HTMLElement | null)?.blur();
}

/** 跟随「要避开的元素」高度变化（对话页输入框会被拖高 / 换行变高）。 */
let avoidObserver: ResizeObserver | null = null;

function watchAvoided() {
  const selector = props.avoidSelector;
  if (!selector || typeof ResizeObserver === "undefined") return;
  let avoided: HTMLElement | null = null;
  try {
    avoided = document.querySelector<HTMLElement>(selector);
  } catch {
    avoided = null;
  }
  if (!avoided) return;
  avoidObserver = new ResizeObserver(() => syncBottomGap());
  avoidObserver.observe(avoided);
}

onMounted(() => {
  sync(); // 刷新后可能已经处于滚动位置（浏览器滚动恢复）
  watchAvoided();
  // 捕获阶段监听：scroll 不冒泡，但文档级捕获能收到任意元素（含 body / 内层容器）的滚动事件。
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
});
onBeforeUnmount(() => {
  avoidObserver?.disconnect();
  document.removeEventListener("scroll", onScroll, { capture: true });
  window.removeEventListener("resize", onScroll);
});
</script>

<template>
  <Transition name="back-to-top">
    <button
      ref="root"
      v-show="visible"
      class="back-to-top"
      type="button"
      :style="{ bottom: bottomGap }"
      :aria-label="tx('返回顶部', 'Back to top', 'Voltar ao topo', 'ऊपर जाएं')"
      :title="tx('返回顶部', 'Back to top', 'Voltar ao topo', 'ऊपर जाएं')"
      @click="toTop"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 19V5"></path>
        <path d="m5.5 11.5 6.5-6.5 6.5 6.5"></path>
      </svg>
    </button>
  </Transition>
</template>

<style scoped>
.back-to-top {
  position: fixed;
  right: calc(18px + env(safe-area-inset-right, 0px));
  bottom: calc(18px + var(--safe-bottom, 0px));
  /* 内容层（30–70）之上、抽屉/弹窗（1000+）之下：抽屉打开时不该压在它上面。 */
  z-index: 60;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--line, #dfe3ee);
  border-radius: var(--radius-pill, 999px);
  background: var(--panel, #fff);
  color: var(--ink, #1c2333);
  box-shadow: var(--shadow, 0 10px 28px rgb(16 24 40 / 10%));
  cursor: pointer;
  transition: transform 0.16s var(--ease, ease), box-shadow 0.16s var(--ease, ease), background 0.16s var(--ease, ease);
}

.back-to-top:hover {
  transform: translateY(-2px);
  background: var(--fill, #fff);
}

.back-to-top:focus-visible {
  outline: none;
  box-shadow: var(--ring, 0 0 0 3px rgb(20 20 19 / 13%)), var(--shadow, 0 10px 28px rgb(16 24 40 / 10%));
}

.back-to-top-enter-active,
.back-to-top-leave-active {
  /* 明显的上滑进入：从下方 24px 滑入并轻微放大回正，用带回弹感的缓动让「滑动」更顺滑。 */
  transition: opacity 0.28s var(--ease, ease), transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.back-to-top-enter-from,
.back-to-top-leave-to {
  opacity: 0;
  transform: translateY(24px) scale(0.92);
}

@media (prefers-reduced-motion: reduce) {
  .back-to-top,
  .back-to-top-enter-active,
  .back-to-top-leave-active {
    transition: none;
  }

  .back-to-top:hover {
    transform: none;
  }
}
</style>
