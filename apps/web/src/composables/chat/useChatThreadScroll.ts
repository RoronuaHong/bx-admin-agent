import { nextTick, type Ref } from "vue";

export interface ChatThreadScrollOptions {
  currentId: Ref<string>;
  /** 滚动容器（模板 ref，由协调层持有）。 */
  threadEl: Ref<HTMLElement | null>;
  /** 大纲高亮 pin（跨层：大纲组尚未拆分，按引用/祖先 getter 注入，不提前拆进来）。 */
  pinnedOutlineId: Ref<number | null>;
  isOutlineJumpActive: () => boolean;
  getOutlineIgnoreScrollUntil: () => number;
  releaseOutlinePin: () => void;
}

/**
 * 对话线程滚动 / 跟底（SCC C 之一）。
 * 机械搬迁自 useChatPageCore；跨层的大纲 pin 状态只通过 options 注入 getter/回调。
 */
export function useChatThreadScroll(options: ChatThreadScrollOptions) {
  const {
    currentId,
    threadEl,
    pinnedOutlineId,
    isOutlineJumpActive,
    getOutlineIgnoreScrollUntil,
    releaseOutlinePin,
  } = options;

  let scrollQueued = false;
  /** 同一帧里后到的「强制回底」不能被已经排上的普通跟随丢掉。 */
  let scrollForce = false;

  /** 气泡更新时是否要跟随滚动：只有"正在看的这个对话"才滚，后台流不抢滚动条。 */
  function queueScrollIfCurrent(convId: string) {
    if (currentId.value === convId) queueScroll();
  }

  /**
   * 跟底开关（stick-to-bottom）：流式增量只在「当前已贴近底部」（48px 容差）时才自动跟随。
   * 没有它，用户在生成中上滚阅读历史会被下一片增量拉回底部——「回到顶部」也就形同虚设。
   * 判定挂在滚动容器的 scroll 事件上（程序滚动同样触发），滚回底部附近即自动恢复跟随。
   */
  let followBottom = true;
  function nearBottom(el: HTMLElement, gap = 48): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < gap;
  }
  /**
   * 「此刻用户是否贴着底部」——**必须在内容变高之前量**。
   * 新回复/新增量会把容器撑高，之后再量到的已经不是用户原来的位置：自己长出来的那截高度
   * 会被当成「用户已上滚」，新回复于是不滚动（页面停在原地，压根看不见刚来的回复）。
   */
  function atBottomNow(): boolean {
    const el = threadEl.value;
    return followBottom && (!el || nearBottom(el));
  }
  function onThreadScroll() {
    const el = threadEl.value;
    if (el) followBottom = nearBottom(el);
    // 非本轮程序滚动的 scroll 一律视为用户滚动（拖滚动条也走这条路），立即解锁高亮跟踪。
    if (pinnedOutlineId.value !== null && !isOutlineJumpActive() && Date.now() > getOutlineIgnoreScrollUntil())
      releaseOutlinePin();
  }

  function queueScroll(force = false) {
    if (force) {
      scrollForce = true;
      followBottom = true;
    } else if (!followBottom) {
      return;
    }
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      const forced = scrollForce;
      scrollQueued = false;
      scrollForce = false;
      void nextTick(() => {
        const el = threadEl.value;
        if (!el) return;
        // 执行时再按实时几何复核（阈值放宽到 240px：单片增量一般长不了这么多，超出只可能是用户上滚）。
        // 只靠标记有个窗口：rAF+nextTick 双重延迟下，密集增量可能先于 scroll 事件把用户刚上滚的位置盖掉。
        // 用户主动发送走 forced：人已经滚到很上面时也要回到最底，不能被这道阈值拦下。
        if (!forced && !nearBottom(el, 240)) return;
        if (forced) followBottom = true;
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  /** 用户主动发送时无条件恢复跟底（原 core 里 send() 直接写 followBottom = true）。 */
  function setFollowBottom(value: boolean) {
    followBottom = value;
  }

  return {
    scrollQueued,
    scrollForce,
    queueScrollIfCurrent,
    followBottom,
    nearBottom,
    atBottomNow,
    onThreadScroll,
    queueScroll,
    setFollowBottom,
  };
}
