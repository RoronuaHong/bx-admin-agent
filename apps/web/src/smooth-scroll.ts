// 自定义缓动平滑滚动：不依赖原生 `behavior: 'smooth'`——实测本项目对话滚动容器
// `.mc-scroll` 上 `Element.scrollTo({ behavior: 'smooth' })` 被静默忽略（options 形式 smooth 无效，
// 仅 `scrollTop = x` 即时赋值生效），故用 rAF 在指定时长内把 scrollTop 从当前值缓动到目标值，
// 给出可控、稳定的「滑动」过渡。reduced-motion 下直接瞬移。
export function smoothScrollTo(
  el: HTMLElement,
  targetTop: number,
  opts: { duration?: number } = {},
): void {
  if (!el) return;
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const start = el.scrollTop;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const end = Math.max(0, Math.min(targetTop, max));
  if (reduce || Math.abs(end - start) < 2) {
    el.scrollTop = end; // 尊重减少动态效果，或距离极小直接到位
    return;
  }
  const duration = opts.duration ?? 460;
  const t0 = performance.now();
  // easeInOutCubic：起步缓、中段快、收尾缓，滑动手感自然。
  const ease = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  let raf = 0;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    el.scrollTop = start + (end - start) * ease(p);
    if (p < 1) raf = requestAnimationFrame(step);
  };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(step);
}
