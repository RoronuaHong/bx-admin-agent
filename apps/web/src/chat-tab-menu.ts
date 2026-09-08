export interface TabMenuState {
  convId: string;
  idx: number;
  x: number;
  y: number;
}

export function createTabMenuPosition(ev: MouseEvent): Pick<TabMenuState, "x" | "y"> {
  const pad = 8;
  const menuW = 168;
  const menuH = 220;
  const x = Math.min(ev.clientX, window.innerWidth - menuW - pad);
  const y = Math.min(ev.clientY, window.innerHeight - menuH - pad);
  return { x: Math.max(pad, x), y: Math.max(pad, y) };
}
