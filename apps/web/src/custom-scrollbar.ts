export function bindCustomScrollbar(
  getScroller: () => HTMLElement | null,
  getTrack: () => HTMLElement | null,
  getThumb: () => HTMLElement | null,
): () => void {
  const scroller = getScroller();
  const track = getTrack();
  const thumb = getThumb();
  if (!scroller || !track || !thumb) return () => {};

  const update = () => {
    const canScroll = scroller.scrollHeight > scroller.clientHeight + 1;
    track.classList.toggle("is-off", !canScroll);
    const trackH = track.clientHeight;
    const thumbH = Math.max(28, Math.min(trackH, (scroller.clientHeight / scroller.scrollHeight) * trackH));
    thumb.style.height = `${thumbH}px`;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const maxTop = trackH - thumbH;
    thumb.style.top = `${maxScroll > 0 ? (scroller.scrollTop / maxScroll) * maxTop : 0}px`;
  };

  let dragging = false;
  let startY = 0;
  let startScroll = 0;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const maxTop = track.clientHeight - thumb.offsetHeight;
    if (maxTop <= 0) return;
    scroller.scrollTop = startScroll + ((e.clientY - startY) / maxTop) * maxScroll;
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    scroller.style.removeProperty("scroll-behavior");
    track.classList.remove("is-dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  const onThumbDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startY = e.clientY;
    startScroll = scroller.scrollTop;
    scroller.style.scrollBehavior = "auto";
    track.classList.add("is-dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onTrackClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".model-scrollbar-thumb, .thread-scrollbar-thumb")) return;
    const rect = track.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
  };

  thumb.addEventListener("mousedown", onThumbDown);
  track.addEventListener("click", onTrackClick);
  scroller.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);

  const ro = new ResizeObserver(update);
  ro.observe(scroller);
  const mo = new MutationObserver(update);
  mo.observe(scroller, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });

  update();

  return () => {
    onUp();
    thumb.removeEventListener("mousedown", onThumbDown);
    track.removeEventListener("click", onTrackClick);
    scroller.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    ro.disconnect();
    mo.disconnect();
  };
}
