import type { Ref } from "vue";

export function composerMaxHeight() {
  return Math.min(Math.round(window.innerHeight * 0.7), 520);
}

export function resizeComposerBox(
  composerInput: Ref<HTMLTextAreaElement | null>,
  composerHeight: Ref<number | null>,
) {
  const el = composerInput.value;
  if (!el) return;
  el.style.height = "auto";
  const floor = Math.max(composerHeight.value ?? 0, 130);
  const target = Math.min(Math.max(el.scrollHeight, floor), composerMaxHeight());
  el.style.height = `${target}px`;
  document.documentElement.style.setProperty("--composer-max", `${target}px`);
  el.scrollTop = 0;
}

export function startComposerResizeDrag(args: {
  event: PointerEvent | MouseEvent | TouchEvent;
  composerInput: Ref<HTMLTextAreaElement | null>;
  composerHeight: Ref<number | null>;
  resizeComposer: () => void;
}) {
  const { event, composerInput, composerHeight, resizeComposer } = args;
  const isTouch = "touches" in event;
  if (!isTouch && event.button !== 0) return;
  if (isTouch) event.preventDefault();

  const startY = isTouch ? event.touches[0]!.clientY : event.clientY;
  const el = composerInput.value;
  const startH = composerHeight.value ?? el?.clientHeight ?? 0;
  const maxH = Math.min(Math.round(window.innerHeight * 0.85), 640);
  let dragActive = true;

  document.documentElement.style.setProperty("--composer-max", "none");

  const onMove = (ev: PointerEvent | MouseEvent | TouchEvent) => {
    const y = "touches" in ev ? ev.touches[0]!.clientY : ev.clientY;
    const h = startH + (startY - y);
    composerHeight.value = Math.min(Math.max(h, 130), maxH);
  };

  const end = () => {
    if (!dragActive) return;
    dragActive = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", end);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", end);
    window.removeEventListener("touchcancel", end);
    document.documentElement.style.setProperty(
      "--composer-max",
      composerHeight.value != null ? `${composerHeight.value}px` : "",
    );
    if (composerHeight.value != null) resizeComposer();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", end);
  window.addEventListener("touchmove", onMove);
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
}
