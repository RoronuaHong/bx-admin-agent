import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

/**
 * 下拉选择面板的公共行为（开合 / 键盘上下移动 / 回车选择 / 点击外部关闭 / 失焦收回）。
 * 目前仅 ModelSelect 使用（专家切换走 ChatPage 的 toggleExpertPanel，未独立成组件）。
 *
 * 组件自身只负责「选项从哪来、选中后干什么」：
 * - `flatOptions`：扁平选项列表（含当前选中项），用于键盘边界与高亮定位。
 * - `currentId`：当前选中项 id，用于打开时定位高亮、回车选择回调。
 * - `onChoose`：选中某项的副作用（emit 或路由跳转）。
 */
export interface SelectPanelOptions {
  flatOptions: () => Array<{ id: string }>;
  currentId: () => string;
  onChoose: (id: string) => void;
}

export function useSelectPanel(opts: SelectPanelOptions) {
  const root = ref<HTMLElement | null>(null);
  const triggerEl = ref<HTMLButtonElement | null>(null);
  const listEl = ref<HTMLElement | null>(null);
  const open = ref(false);
  const activeIndex = ref(0);

  function indexOfId(id: string): number {
    return opts.flatOptions().findIndex((o) => o.id === id);
  }

  function scrollActiveIntoView() {
    void nextTick(() => {
      listEl.value?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  function moveActive(delta: number) {
    const total = opts.flatOptions().length;
    if (!total) return;
    activeIndex.value = (activeIndex.value + delta + total) % total;
    scrollActiveIntoView();
  }

  function openPanel() {
    if (open.value) return;
    open.value = true;
    activeIndex.value = Math.max(indexOfId(opts.currentId()), 0);
    void nextTick(() => {
      scrollActiveIntoView();
      // 把焦点移进面板，使方向键 / 回车可被列表（或 ModelSelect 的搜索框）承接。
      listEl.value?.focus();
    });
  }

  function closePanel(refocus = false) {
    if (!open.value) return;
    open.value = false;
    if (refocus) void nextTick(() => triggerEl.value?.focus());
  }

  function togglePanel() {
    if (open.value) closePanel();
    else openPanel();
  }

  function choose(id: string) {
    opts.onChoose(id);
    closePanel(true);
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPanel();
    } else if (event.key === "Escape") {
      closePanel();
    }
  }

  /** 列表自身（而非搜索框）承接键盘导航时用：上下移动 + 回车选择 + Esc/Tab 收回。 */
  function onListKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = opts.flatOptions()[activeIndex.value];
      if (option) choose(option.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePanel(true);
    } else if (event.key === "Tab") {
      closePanel();
    }
  }

  function onPointerDown(event: MouseEvent) {
    if (!root.value?.contains(event.target as Node)) closePanel();
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && open.value) closePanel(true);
  }

  watch(open, (v) => {
    if (!v) activeIndex.value = Math.max(indexOfId(opts.currentId()), 0);
  });

  onMounted(() => {
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onWindowKeydown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("mousedown", onPointerDown);
    window.removeEventListener("keydown", onWindowKeydown);
  });

  return {
    root,
    triggerEl,
    listEl,
    open,
    activeIndex,
    indexOfId,
    scrollActiveIntoView,
    moveActive,
    openPanel,
    closePanel,
    togglePanel,
    choose,
    onTriggerKeydown,
    onListKeydown,
  };
}
