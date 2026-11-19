import { reactive, type Ref } from "vue";
import { visibleThinking } from "../../trace-labels";
import type { ToolStep } from "../../chat-types";
import type { UiLocale } from "../../ui-locale";
import type { Bubble } from "./chat-page-types";

export interface ChatReasoningUIOptions {
  threadEl: Ref<HTMLElement | null>;
  uiLocale: Ref<UiLocale>;
  tx: (zh: string, en: string, pt?: string, hi?: string) => string;
}

/**
 * 推理过程 UI（任务计划 + 工具步骤 + 思考流）折叠与展示（SCC C 之一）。
 * 机械搬迁自 useChatPageCore；threadEl / uiLocale / tx 通过 options 注入，行为零变化。
 */
export function useChatReasoningUI(options: ChatReasoningUIOptions) {
  const { threadEl, uiLocale, tx } = options;

  // ---- 推理过程（任务计划 + 工具步骤）折叠：生成中默认展开，收束后自动折叠，避免长过程刷屏 ----
  const openReasoning = reactive(new Set<number>());
  /**
   * 用户在生成中手动收起的气泡。思考增量很密，每一片都会请求「展开」；
   * 不记住这次收起的话，点一下立刻又被下一片思考撑开，看起来就是无法折叠。
   */
  const reasoningCollapsedByUser = new Set<number>();

  function toggleReasoning(id: number) {
    if (openReasoning.has(id)) {
      openReasoning.delete(id);
      reasoningCollapsedByUser.add(id);
    } else {
      reasoningCollapsedByUser.delete(id);
      openReasoning.add(id);
      stickThinkingToBottom();
    }
  }

  /** 流式事件请求展开：尊重用户刚刚的收起，直到他们再点开或本轮收束。 */
  function openReasoningPanel(id: number) {
    if (reasoningCollapsedByUser.has(id)) return;
    openReasoning.add(id);
  }

  function closeReasoningPanel(id: number) {
    openReasoning.delete(id);
    reasoningCollapsedByUser.delete(id);
  }

  /**
   * 单步结果的展开态（键 = 气泡 id + 步骤 id）。
   * 结果默认收起：一次工具循环常有 3-8 步，全部铺开会把气泡撑得很长；收起时用一行摘要交代
   * 「这步拿到了什么」，要看全文再点开（对齐 antd Collapse 的「默认收起 + 摘要」）。
   */
  const openSteps = reactive(new Set<string>());

  function stepKey(b: Bubble, step: ToolStep): string {
    return `${b.id}::${step.id}`;
  }

  function toggleStep(b: Bubble, step: ToolStep) {
    if (!step.result) return;
    const key = stepKey(b, step);
    if (openSteps.has(key)) openSteps.delete(key);
    else openSteps.add(key);
  }

  /** 收起时的摘要：取结果首个非空行并截断（只作提示，全文点开看）。 */
  function stepSummary(step: ToolStep): string {
    const line = (step.result || "")
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0);
    if (!line) return "";
    // 抓正文的步骤结果首行是 markdown 标题（`# 标题`）：摘要里去掉标记，省得像乱码。
    return line.replace(/^#{1,6}\s*/, "").slice(0, 90);
  }

  function hasRunningStep(b: Bubble): boolean {
    return !!b.steps?.some((s) => s.status === "running");
  }

  /**
   * 是否真的有思考内容。流式片段常常只推来空白（换行/空格），
   * 直接判 `b.thinking` 会把「空白的推理面板」渲染出来，所以统一按去空白后判断。
   */
  function hasThinking(b: Bubble): boolean {
    return !!b.thinking && b.thinking.trim().length > 0;
  }

  // 意图识别：只认模型显式写的「意图：/Intent:」前缀。
  // 不做「取首句」兜底——推理流首行经常是半截话（如「用户只输入了"123"，没有明确的请求或问题。这可能是：」），
  // 截断后放进高亮卡里像坏数据，也是推理面板观感差的主要来源之一（ChatGPT/Claude 都不做这种二次高亮）。
  const INTENT_RE = /^(意图|Intent)\s*[:：]\s*(.+)$/i;

  function intentOf(b: Bubble): string | undefined {
    const firstLine = (b.thinking || "").split("\n", 1)[0].trim();
    const m = firstLine.match(INTENT_RE);
    return m ? m[2].trim() : undefined;
  }

  // 去掉首行意图（作为意图行展示）后的思考流，避免重复；无意图时不剥离。
  function thinkingDisplay(b: Bubble): string {
    const t = b.thinking || "";
    const nl = t.indexOf("\n");
    const body = intentOf(b) ? (nl >= 0 ? t.slice(nl + 1).replace(/^\s*\n/, "") : "") : t;
    return visibleThinking(body, uiLocale.value);
  }

  // ---- 思考耗时（对齐 ChatGPT「Thought for Ns」的口径）----
  // 各思考段分别计时后累加：工具执行 / 结果回灌的间隙不算思考；
  // 计时起点放模块级 Map（气泡 id → 该段首个思考增量时刻），不进响应式状态。
  const thinkStarts = new Map<number, number>();

  function thinkPhaseStart(id: number) {
    if (!thinkStarts.has(id)) thinkStarts.set(id, Date.now());
  }

  /** 结束当前思考段并累加进气泡：正文到达 / 收束 / 出错时都要调，否则该段时长丢失。 */
  function thinkPhaseEnd(reply: Bubble) {
    const start = thinkStarts.get(reply.id);
    if (!start) return;
    thinkStarts.delete(reply.id);
    reply.thinkMs = (reply.thinkMs || 0) + (Date.now() - start);
  }

  /** 展示用耗时（如「8 秒」）；累计不足 0.8s 不显示，避免短轮次凑热闹。 */
  function thinkLabel(b: Bubble): string {
    if (!b.thinkMs || b.thinkMs < 800) return "";
    const s = Math.round(b.thinkMs / 1000);
    return tx(`${s} 秒`, `${s}s`, `${s}s`, `${s} सेकंड`);
  }

  // 思考流跟底：面板限高内滚，不跟底就只能盯着开头（推理增量很密，rAF 合并避免每片都触发布局）。
  let thinkStickQueued = false;
  function stickThinkingToBottom() {
    if (thinkStickQueued) return;
    thinkStickQueued = true;
    requestAnimationFrame(() => {
      thinkStickQueued = false;
      // 取最后一个思考区：正在流式的通常就是最新一条助手气泡。
      const bodies = threadEl.value?.querySelectorAll<HTMLElement>(".reasoning__thinking");
      const last = bodies?.length ? bodies[bodies.length - 1] : null;
      if (last) last.scrollTop = last.scrollHeight;
    });
  }

  function reasoningTitle(b: Bubble): string {
    const n = b.steps?.length || 0;
    const sn = b.subagents?.length || 0;
    // 思考期（流式、已收到 thinking 但还没具体步骤）：有意图识别则标「理解意图」，否则「思考中」。
    if (b.streaming && hasThinking(b) && !b.steps?.length && !b.todos?.length && !b.subagents?.length)
      return intentOf(b)
        ? tx("理解意图…", "Understanding intent…", "Entendendo a intenção…", "इरादा समझ रहा है…")
        : tx("思考中…", "Thinking…", "Pensando…", "सोच रहा है…");
    // 已在出正文但尚无步骤/子代理（模型未显式规划，直接作答）：标「回答中」，避免还挂着「正在规划」像卡死。
    if (b.streaming && b.text && !b.steps?.length && !b.todos?.length && !b.subagents?.length)
      return tx("回答中…", "Answering…", "Respondendo…", "उत्तर दे रहा है…");
    // 静默规划期（流式但还没有任何步骤/子代理，也没有思考流、也没出正文）：显式标「正在规划」。
    if (b.streaming && !b.steps?.length && !b.todos?.length && !b.subagents?.length)
      return tx("正在规划…", "Planning…", "Planejando…", "योजना बना रहा है…");
    if (b.streaming && hasRunningStep(b)) return tx("推理中…", "Reasoning…", "Pensando…", "तर्क कर रहा है…");
    if (b.streaming && sn) {
      return tx(`子代理运行中 · ${sn} 个`, `Subagents running · ${sn}`, `Subagentes rodando · ${sn}`, `उप-एजेंट चल रहे · ${sn}`);
    }
    if (n) return tx(`推理过程 · ${n} 步`, `Reasoning · ${n} step${n > 1 ? "s" : ""}`, `Raciocínio · ${n} passos`, `तर्क · ${n} चरण`);
    if (b.todos?.length) return tx("任务计划", "Plan", "Plano", "कार्य योजना");
    if (sn) return tx(`子代理 · ${sn} 个`, `Subagents · ${sn}`, `Subagentes · ${sn}`, `उप-एजेंट · ${sn}`);
    return tx("推理过程", "Reasoning", "Raciocínio", "तर्क प्रक्रिया");
  }

  return {
    openReasoning,
    reasoningCollapsedByUser,
    toggleReasoning,
    openReasoningPanel,
    closeReasoningPanel,
    openSteps,
    stepKey,
    toggleStep,
    stepSummary,
    hasRunningStep,
    hasThinking,
    INTENT_RE,
    intentOf,
    thinkingDisplay,
    thinkStarts,
    thinkPhaseStart,
    thinkPhaseEnd,
    thinkLabel,
    thinkStickQueued,
    stickThinkingToBottom,
    reasoningTitle,
  };
}
