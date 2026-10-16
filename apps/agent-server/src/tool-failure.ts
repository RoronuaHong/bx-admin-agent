/**
 * 工具失败分类 + 窗口健康度（第 2 批 P2-1 地基 / P1-1 判据）。
 *
 * **为什么必须先分类再熔断**（对标 Fowler《Circuit Breaker》「按异常类型设置不同策略」）：
 * 熔断只在依赖本身出问题时才该动作。下面几类不是同一件事：
 *   · 上游不可用、超时 —— 依赖挂了，继续打没有意义，该熔断；
 *   · 我们的安全闸门主动拒绝 —— 策略正在正常工作，工具本身是好的，熔断它等于自伤；
 *   · 参数/语义错误（字段不存在、语法不合法）—— Fowler 明确「客户端参数错误通常不应触发熔断」；
 *   · 被取消 —— 是本轮自己中止的，与工具健康无关。
 * 2026-10-14 事故里那 6 次失败的性质正是「查询语义被拒」：若不分类就熔断，一个健康的
 * 查询工具会被摘除，比修复前更糟（详见 docs/agent-stall-incident-20261014.md §5 P1-1）。
 *
 * 分类值刻意做成**低基数枚举**（对标 OTel 语义约定：`error.type` 必须是稳定的分类值，
 * 不能放消息文本——那会造成高基数、泄露敏感内容、且无法跨系统聚合）。
 */

export type ToolErrorKind =
  /** 上游/连接不可用或响应异常（依赖侧问题，计入熔断）。 */
  | "upstream"
  /** 超时（有界等待被打破，计入熔断）。 */
  | "timeout"
  /** 被闸门拦下，根本没进上游（不计入熔断）。 */
  | "denied"
  /** 参数/语义错误：字段不存在、语法不合法、无法解析（不计入熔断）。 */
  | "schema"
  /** 本轮被外部中止（不计入熔断）。 */
  | "aborted"
  /** 归不出已知类别（保守：不计入熔断，只落 span 供排查）。 */
  | "other";

/** 会触发熔断的类别：只有「依赖侧真的出了问题」才算。 */
export const FUSING_KINDS: ReadonlySet<ToolErrorKind> = new Set<ToolErrorKind>(["upstream", "timeout"]);

/** 分类 → 人话说明（回灌提示与指标复用）。零业务词。 */
export const KIND_LABEL: Record<ToolErrorKind, string> = {
  upstream: "上游不可用",
  timeout: "超时",
  denied: "被闸门拒绝",
  schema: "参数或语义不合法",
  aborted: "被中止",
  other: "其他错误",
};

// 通用错误标记：只匹配协议层/系统层措辞，不含任何业务对象名。
const TIMEOUT_RE = /超时|timeout|timed\s*out|deadline|aborted due to timeout/i;
const UPSTREAM_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network error|upstream|bad gateway|gateway|服务(?:器)?暂时不可用|\b50[0234]\b|internal server error/i;
const SCHEMA_RE =
  /unknown column|unknown table|unknown field|no such|不存在|未找到|无法解析|无法识别|不支持|语法|syntax|invalid|参数|字段|表名|column/i;
const DENIED_RE = /已拒绝|被拒绝|拒绝执行|不允许|未授权|没有权限|权限不足|只接受|只读策略|需确认|需要确认/i;

export interface ClassifyInput {
  /** 是否真正执行了（false = 被闸门拦下或被冻住）。 */
  executed: boolean;
  /** 是否成功。 */
  ok: boolean;
  /** 结果或错误原文：只用于匹配通用标记，**绝不写进分类值**。 */
  text?: string;
  /** 本轮是否已被外部中止。 */
  aborted?: boolean;
}

/**
 * 纯函数：把一次工具执行归类；成功返回 null。
 *
 * 判定顺序固定：**结构优先于文本**（是否执行 / 是否中止），文本只是最后辅助判据——
 * 上游文案随时会变，拿它当主判据迟早误判。
 */
export function classifyToolFailure(input: ClassifyInput): ToolErrorKind | null {
  if (input.ok) return null;
  // 结构判据：没进上游，就不是上游的问题。
  if (!input.executed) return "denied";
  if (input.aborted) return "aborted";
  const text = String(input.text || "");
  if (TIMEOUT_RE.test(text)) return "timeout";
  if (UPSTREAM_RE.test(text)) return "upstream";
  if (SCHEMA_RE.test(text)) return "schema";
  if (DENIED_RE.test(text)) return "denied";
  return "other";
}

// ---- 窗口健康度（P1-1 判据）----

export interface WindowOptions {
  /** 窗口容量：记住最近多少次**有效探测**。 */
  window?: number;
  /** 最小样本数：样本不足不算比率（Fowler：比率必须配最小样本数）。 */
  minSamples?: number;
  /** 依赖侧失败占比阈值，达到即熔断。 */
  failRate?: number;
  /** 连续依赖侧失败次数阈值，达到即熔断（快路径：完全挂掉）。 */
  consecutive?: number;
}

export interface ToolStats {
  /** 窗口内有效探测次数（成功 + 依赖侧失败）。 */
  samples: number;
  /** 其中依赖侧失败次数。 */
  fusing: number;
  /** 当前连续依赖侧失败次数（成功或非依赖侧失败都会把它断开）。 */
  consecutive: number;
  /** 依赖侧失败占比（样本为 0 时为 0）。 */
  rate: number;
}

interface Entry {
  /** 环形记录：null = 成功，其余为失败类别。 */
  kinds: (ToolErrorKind | null)[];
  streak: number;
}

const DEFAULTS: Required<WindowOptions> = {
  window: 6,
  minSamples: 3,
  failRate: 0.5,
  consecutive: 3,
};

/**
 * 单轮对话内的工具健康窗口。
 *
 * 与旧实现的关键差异（这三点都是本次事故暴露的）：
 * 1. **成功不再清零失败统计**。旧实现「成功即 delete」，于是 err,ok,ok,err,ok,ok,err… 这种
 *    交替失败永远到不了阈值——本次事故正是这个形态（10 次调用 6 次失败，熔断一次没触发）。
 * 2. **比率 + 最小样本数**而非裸计数（Fowler：比率更能表达健康度，但必须配最小样本数，
 *    否则「只有 1 次调用且恰好失败」会得到 100% 失败率）。
 * 3. **只让依赖侧失败进统计**。闸门拒绝 / 参数错误 / 被中止都不计入分母：它们不是对依赖的
 *    有效探测，计进去会把真实故障率稀释掉。
 *
 * 阈值全部可注入，便于单测与按部署调整；不含任何业务词。
 */
export class ToolHealthWindow {
  private readonly opts: Required<WindowOptions>;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: WindowOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** 记一次执行结果：kind 为 null 表示成功。 */
  record(name: string, kind: ToolErrorKind | null): void {
    const entry = this.entries.get(name) || { kinds: [], streak: 0 };
    const counting = kind === null || FUSING_KINDS.has(kind);
    if (counting) {
      entry.kinds.push(kind);
      if (entry.kinds.length > this.opts.window) entry.kinds.shift();
      entry.streak = kind === null ? 0 : entry.streak + 1;
    } else {
      // 非依赖侧事件：断开连续计数，但不进窗口（它不构成对依赖的有效探测）。
      entry.streak = 0;
    }
    this.entries.set(name, entry);
  }

  stats(name: string): ToolStats {
    const entry = this.entries.get(name);
    const samples = entry ? entry.kinds.length : 0;
    const fusing = entry ? entry.kinds.filter((k): k is ToolErrorKind => k !== null).length : 0;
    return {
      samples,
      fusing,
      consecutive: entry ? entry.streak : 0,
      rate: samples ? fusing / samples : 0,
    };
  }

  /** 是否该熔断；返回原因（可直接回灌给模型）。 */
  fuseVerdict(name: string): { fuse: boolean; reason: string } {
    const s = this.stats(name);
    if (s.consecutive >= this.opts.consecutive) {
      return {
        fuse: true,
        reason:
          `工具 ${name} 已连续 ${s.consecutive} 次出现依赖侧问题（超时或上游不可用），本轮不再调用它。` +
          "请改用其他工具，或换一条取证路径；不要用同样的参数原样重试。",
      };
    }
    if (s.samples >= this.opts.minSamples && s.rate >= this.opts.failRate) {
      return {
        fuse: true,
        reason:
          `工具 ${name} 最近 ${s.samples} 次调用里有 ${s.fusing} 次是依赖侧问题（超时或上游不可用），` +
          "继续调它大概率还是失败，本轮不再调用它。请改用其他工具或换一条取证路径；" +
          "如果这些数据确实拿不到，就在回答里如实说明这一项没有取到，不要用推测补齐。",
      };
    }
    return { fuse: false, reason: "" };
  }

  /** 最近一次**失败**的类别（用于给熔断提示写人话说明）；没有失败过则 null。 */
  lastKind(name: string): ToolErrorKind | null {
    const kinds = this.entries.get(name)?.kinds;
    if (!kinds) return null;
    for (let i = kinds.length - 1; i >= 0; i -= 1) {
      const kind = kinds[i];
      if (kind !== null && kind !== undefined) return kind;
    }
    return null;
  }

  /** 显式解除（供将来做 half-open 探测或人工干预；当前主流程不自动调用）。 */
  clear(name: string): void {
    this.entries.delete(name);
  }
}

