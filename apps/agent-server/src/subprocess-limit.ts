/**
 * 子进程并发上限（防 fork-bomb / 资源耗尽）。
 *
 * run_tool_code（spawn 解释器）、run_command / run_script（exec shell）最终都会起一个子进程。
 * 这些入口受模型驱动、且可被 prompt 注入操纵——一段「疯狂 spawn」的代码若不加约束，
 * 能在毫秒内把服务端进程数 / 内存 / 句柄打爆。这里用一个进程内信号量，把「同时在跑的子进程数」
 * 收敛到 TOOL_SUBPROCESS_MAX_CONCURRENT（默认 4），多出来的排队等待，而非无限并发。
 *
 * 注意：这只是**数量**维度的资源护栏，不是沙箱——它不限制子进程能读哪些文件、能不能出网、
 * 也不隔离文件系统。真正的隔离需要 OS 级容器 / AppContainer（见 docs/SECURITY.md 的「已知局限」）。
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.TOOL_SUBPROCESS_MAX_CONCURRENT || 4));
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/** 在拿到的并发槽里执行 fn；fn 无论成功/抛错都会释放槽位。 */
export async function withSubprocessSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 暴露当前占用/排队数，便于健康检查或运维排查（可选）。 */
export function subprocessSlotStats(): { active: number; waiting: number; max: number } {
  return { active, waiting: waiters.length, max: MAX_CONCURRENT };
}
