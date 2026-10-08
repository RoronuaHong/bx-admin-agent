// 结果投递：把定时任务的收束结果推到企业 IM（钉钉 / 飞书 / 企业微信机器人）。
//
// 只做两件事：① 把 Agent 产出的 Markdown 排版成 IM 能可靠显示的文本；② 按平台协议发一条消息。
// 平台差异全部收在这里：载荷形状、加签算法、成功判定（钉钉/企业微信 errcode / 飞书 code）、关键词安全设置。
//
// ⚠️ 只在文档形状上实现，未对真实机器人做过端到端实测（本机没有有效 webhook）。
//    因此对外提供「测试发送」端点：配完通道先自己发一条，别等任务到点才发现配错。
import { createHmac } from "node:crypto";
import type { NotifyChannel } from "./channels.js";
import { garbledTextReason } from "../schedules.js";

/** 正文预算（字符）：钉钉 markdown 硬限约 20000 字节、飞书约 30KB，这里留足余量。 */
const MAX_BODY_CHARS = 3500;
/** 单次请求超时：投递是旁路，不能把调度 tick 拖住。 */
const REQUEST_TIMEOUT_MS = 8000;
/** 消息里最多几个按钮（平台按钮数量有限，且太多反而没人点）。 */
const MAX_LINKS = 3;
/** Markdown 表格在 IM 里最多折几行（钉钉/飞书都不渲染真表格，只能折成「列=值」）。 */
const MAX_TABLE_ROWS = 8;
/** 单块图表数据最多几行：推送正文有总预算，图多时按「每张几行」摊，不能让一张图吃掉整条消息。 */
const MAX_CHART_ROWS = 6;
/** 非表格形态的图表数据（层级 / 点边结构）原样预览的字符上限：不做猜测式排版，只给可核对的片段。 */
const MAX_CHART_PREVIEW_CHARS = 300;

export interface DeliveryLink {
  title: string;
  url: string;
}

/**
 * 投递时附带的图表数据（结构取自渲染契约 ChartSpec，这里只声明用到的字段，避免与渲染层耦合）。
 * IM 两端都只认文本：图推不过去，但图里的数字是这一期的结论依据，必须一并送到。
 */
export interface DeliveryChart {
  title?: string;
  chartType?: string;
  data: unknown;
}

export interface DeliveryMessage {
  title: string;
  body: string;
  links?: DeliveryLink[];
}

export interface DeliveryOutcome {
  channelId: string;
  label: string;
  ok: boolean;
  error?: string;
}

export interface DeliverySummary {
  at: number;
  /** 全部通道都成功才为 true（无通道时为 false，调用方按「未投递」处理）。 */
  ok: boolean;
  sent: number;
  error?: string;
  results: DeliveryOutcome[];
}

export type DeliveryLang = "zh" | "en" | "pt" | "hi";

interface LangPack {
  ok: string;
  fail: string;
  alert: string;
  recovered: string;
  task: string;
  /** 任务名本身已不可读时的标题，避免把「??????」再推出去。 */
  unnamed: string;
  status: string;
  /** 千问办公执行记录里的「触发方式」。 */
  trigger: string;
  triggerSchedule: string;
  triggerManual: string;
  triggerWake: string;
  /** 千问办公执行记录里的「执行耗时」。 */
  elapsed: string;
  at: string;
  open: string;
  empty: string;
  /** 无标题图表的小标题（通用显示词，与业务无关）。 */
  chart: string;
  /** 图表数据区的标题：IM 渲染不了图，这里明确告诉收件人下面是图里的数字。 */
  chartSection: (count: number) => string;
  rows: (total: number, shown: number) => string;
  truncated: string;
}

/** 投递文案的四种语言（通用显示词缀，与业务无关）。 */
const LANGS: Record<DeliveryLang, LangPack> = {
  zh: {
    ok: "成功",
    fail: "失败",
    alert: "异常",
    recovered: "已恢复",
    task: "任务",
    unnamed: "定时任务",
    status: "状态",
    trigger: "触发",
    triggerSchedule: "定时触发",
    triggerManual: "手动执行",
    triggerWake: "事件唤醒",
    elapsed: "耗时",
    at: "时间",
    open: "打开对话",
    empty: "（本次未产出内容）",
    chart: "图表",
    chartSection: (count) => `本次图表数据（${count} 张，图见对话）：`,
    rows: (total, shown) => `（表格共 ${total} 行，此处仅列前 ${shown} 行）`,
    truncated: "（内容过长已截断，完整结果见对话）",
  },
  en: {
    ok: "Success",
    fail: "Failed",
    alert: "Alert",
    recovered: "Recovered",
    task: "Task",
    unnamed: "Scheduled task",
    status: "Status",
    trigger: "Trigger",
    triggerSchedule: "Scheduled",
    triggerManual: "Run now",
    triggerWake: "Wake",
    elapsed: "Duration",
    at: "Time",
    open: "Open chat",
    empty: "(no output this run)",
    chart: "Chart",
    chartSection: (count) => `Chart data (${count}; charts live in the chat):`,
    rows: (total, shown) => `(table has ${total} rows; showing first ${shown})`,
    truncated: "(truncated; see the chat for the full result)",
  },
  pt: {
    ok: "Sucesso",
    fail: "Falhou",
    alert: "Alerta",
    recovered: "Recuperado",
    task: "Tarefa",
    unnamed: "Tarefa agendada",
    status: "Status",
    trigger: "Disparo",
    triggerSchedule: "Agendado",
    triggerManual: "Manual",
    triggerWake: "Evento",
    elapsed: "Duração",
    at: "Hora",
    open: "Abrir conversa",
    empty: "(sem saída nesta execução)",
    chart: "Gráfico",
    chartSection: (count) => `Dados dos gráficos (${count}; os gráficos ficam na conversa):`,
    rows: (total, shown) => `(tabela com ${total} linhas; mostrando as primeiras ${shown})`,
    truncated: "(truncado; veja a conversa para o resultado completo)",
  },
  hi: {
    ok: "सफल",
    fail: "विफल",
    alert: "अलर्ट",
    recovered: "बहाल",
    task: "कार्य",
    unnamed: "अनुसूचित कार्य",
    status: "स्थिति",
    trigger: "ट्रिगर",
    triggerSchedule: "निर्धारित",
    triggerManual: "मैनुअल",
    triggerWake: "वेक",
    elapsed: "अवधि",
    at: "समय",
    open: "चैट खोलें",
    empty: "(इस बार कोई आउटपुट नहीं)",
    chart: "चार्ट",
    chartSection: (count) => `चार्ट डेटा (${count}; चार्ट चैट में हैं):`,
    rows: (total, shown) => `(तालिका में ${total} पंक्तियाँ; पहली ${shown} दिखाई गईं)`,
    truncated: "(काट दिया गया; पूरा परिणाम चैट में देखें)",
  },
};

/** 语言标签只按前缀识别（zh / en / pt-BR / hi），认不出按中文。 */
export function deliveryLangOf(locale?: string): DeliveryLang {
  const key = String(locale || "").trim().toLowerCase();
  if (key.startsWith("en")) return "en";
  if (key.startsWith("pt")) return "pt";
  if (key.startsWith("hi")) return "hi";
  return "zh";
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * 把整块 Markdown 表格折成 IM 友好文本。
 * 钉钉 markdown 与飞书 lark_md **都不渲染真表格**——原样发过去是一堆竖线乱码，
 * 所以逐行折成「列=值」列表，超出的行数如实注明（不发假表格，也不假装全量）。
 */
function tableToLines(block: string[][], lang: LangPack): string[] {
  const header = block[0] || [];
  const rows = block.slice(1).filter((cells) => !isSeparatorRow(cells));
  const cols = header.map((h, i) => ({ title: h || `#${i + 1}`, index: i }));
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const lines = shown.map(
    (cells) =>
      `• ${cols
        .map((c) => `${c.title}=${cells[c.index] ?? ""}`)
        .filter((pair) => !pair.endsWith("="))
        .join("；")}`,
  );
  if (rows.length > shown.length) lines.push(lang.rows(rows.length, shown.length));
  return lines;
}

/** 行对象数组 → 「k=v」对（空值不落，避免 IM 里出现一串 `x=`）。 */
function rowToPairs(item: Record<string, unknown>): string {
  return Object.entries(item)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("；");
}

/** 图表数据是否为「行对象数组」（可逐行折成文本）；层级 / 点边结构返回 null，不做猜测式排版。 */
function tabularData(data: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(data) || !data.length) return null;
  return data.every((item) => item && typeof item === "object" && !Array.isArray(item))
    ? (data as Array<Record<string, unknown>>)
    : null;
}

/**
 * 图表折成 IM 文本。
 * 图本身推不过去（两端都不渲染图），但图里那几行数字经常就是这一期的全部结论——
 * 只推一句「以上为完整监测结果」等于没推，所以把数据逐行附上，超出部分如实注明。
 */
export function chartToLines(chart: DeliveryChart, lang: LangPack | DeliveryLang = "zh"): string[] {
  const pack = typeof lang === "string" ? LANGS[lang] : lang;
  const title = String(chart.title || "").trim() || pack.chart;
  const rows = tabularData(chart.data);
  const lines = [`### ${title}`];
  if (!rows) {
    // 非表格形态：原样给一段紧凑预览（宁可难看，也不编造排版）
    const preview = JSON.stringify(chart.data ?? null);
    lines.push(
      `• ${preview.slice(0, MAX_CHART_PREVIEW_CHARS)}${preview.length > MAX_CHART_PREVIEW_CHARS ? "…" : ""}`,
    );
    return lines;
  }
  const shown = rows.slice(0, MAX_CHART_ROWS);
  for (const row of shown) lines.push(`• ${rowToPairs(row)}`);
  if (rows.length > shown.length) lines.push(pack.rows(rows.length, shown.length));
  return lines;
}

/** 正文总预算收敛：表格 + 图表都折完后再裁一次，避免叠加后超出平台上限被拒收。 */
function clampBody(body: string, pack: LangPack): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n${pack.truncated}`;
}

/** 对话落库会在正文后追加「本轮已执行的工具」供模型回忆；IM 不需要这段，JSON 参数在钉钉里会被当成乱码。 */
function stripToolTrace(text: string): string {
  const idx = text.search(/\n*\[本轮已执行的工具\]/);
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

/**
 * 对话里的协议标记只给引擎认。群消息用收件人语言的标识：
 * 异常 = 破线，正常 = 未破线，警告 = 没取到完整计数。
 */
const ALERT_MARK_ZH: Record<string, string> = {
  SPIKE: "异常",
  NORMAL: "正常",
  NO_DATA: "警告",
};

/** 钉钉 markdown 认 `<font color=#RRGGBB>`。圆点是图标，字色跟图标走。 */
const ALERT_BADGE_ZH: Record<string, string> = {
  异常: `<font color=#E5484D>🔴 异常</font>`,
  正常: `<font color=#2F9E44>🟢 正常</font>`,
  警告: `<font color=#F5C518>🟡 警告</font>`,
  已恢复: `<font color=#2F9E44>🟢 已恢复</font>`,
};

export function alertBadgeZh(label: string): string {
  return ALERT_BADGE_ZH[label] || label;
}

function presentAlertMarks(text: string, lang: DeliveryLang): string {
  return text.replace(/\[(SPIKE|NORMAL|NO_DATA)\]/gi, (_, raw: string) => {
    const key = String(raw).toUpperCase();
    if (lang === "zh") return alertBadgeZh(ALERT_MARK_ZH[key] || key);
    return `【${key}】`;
  });
}

/**
 * 群消息不复述工具字段。模型若把 complete / raw_rows 写进结论，这里改成中文；
 * 关于「能不能发钉钉」的自述整行丢掉——推不推由引擎决定，不是结论的一部分。
 */
function polishZhAlert(text: string): string {
  const replaced = text
    .replace(/（工具返回）/g, "")
    .replace(/（工具标注时区\s*Asia\/Shanghai）/g, "（上海）")
    .replace(/Asia\/Shanghai/g, "上海")
    .replace(/\bcomplete\s*:\s*true\b/gi, "计数完整")
    .replace(/\bcomplete\s*:\s*false\b/gi, "计数不完整")
    .replace(/\braw_rows\b/gi, "原始条数")
    .replace(/\bunique\b/gi, "去重条数")
    .replace(/\babove\b/gi, "超过")
    .replace(/\bover_count\b/gi, "破线桶数")
    .replace(/\*\/(\d+)/g, "每 $1 分钟");
  return replaced
    .split(/\r?\n/)
    .filter((line) => !/钉钉群|推送能力|无法确认能否直接|群消息发送/.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 钉钉 / 飞书 markdown 会把 `_` 当斜体、把 `[词]` 当链接起点。
 * 全角替换只影响 IM 文本，不改对话里的原文。
 */
function neutralizeImMarkdown(text: string, lang: DeliveryLang): string {
  const marked = lang === "zh" ? polishZhAlert(presentAlertMarks(text, lang)) : presentAlertMarks(text, lang);
  return marked.replace(/_/g, "＿");
}

/** Markdown → IM 文本：去掉工具轨迹、躲开平台 markdown 误解析、表格折行、超长截断。 */
export function formatForIm(text: string, lang: LangPack | DeliveryLang = "zh"): string {
  const pack = typeof lang === "string" ? LANGS[lang] : lang;
  const deliveryLang: DeliveryLang =
    typeof lang === "string"
      ? lang
      : ((Object.keys(LANGS) as DeliveryLang[]).find((key) => LANGS[key] === pack) ?? "zh");
  const lines = stripToolTrace(text).split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableRow(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const block: string[][] = [];
    while (i < lines.length && isTableRow(lines[i])) {
      block.push(splitRow(lines[i]));
      i += 1;
    }
    i -= 1;
    out.push(...tableToLines(block, pack));
  }
  const merged = neutralizeImMarkdown(out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), deliveryLang);
  if (merged.length <= MAX_BODY_CHARS) return merged;
  return `${merged.slice(0, MAX_BODY_CHARS)}\n\n${pack.truncated}`;
}

/** 钉钉加签：`base64(HMAC-SHA256(secret, timestamp + "\n" + secret))`，结果需 URL 编码。 */
export function dingtalkSign(secret: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}\n${secret}`, "utf-8").digest("base64");
  return encodeURIComponent(digest);
}

/** 飞书加签：拼接串本身当密钥、待签数据为空字符串（与钉钉不是同一个算法）。 */
export function feishuSign(secret: string, timestamp: number): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

/** 关键词安全设置：正文/标题必须含该词，否则平台静默拒收（HTTP 200 + errcode 310000）。 */
function applyKeyword(text: string, keyword?: string, _singleLine = false): string {
  const kw = (keyword || "").trim();
  if (!kw || text.includes(kw)) return text;
  // 贴在最后一行末尾，不要单独成段。单独一行会被当成结论（实测钉钉卡片末尾多出一个关键词）。
  const trimmed = text.replace(/\s+$/, "");
  return trimmed ? `${trimmed} ${kw}` : kw;
}

function dingtalkRequest(
  channel: NotifyChannel,
  title: string,
  body: string,
  links: DeliveryLink[],
  timestamp: number,
): { url: string; payload: unknown } {
  const url = new URL(channel.webhook);
  if (channel.secret) {
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", dingtalkSign(channel.secret, timestamp));
  }
  // 有链接走整体跳转 actionCard：底部一个「打开对话」按钮，点击经 dingtalk:// 在钉钉内嵌 webview 打开
  // （pc_slide=true = PC 侧边栏，移动端是应用内浏览器），不跳系统浏览器。正文仍是 markdown。
  // 无链接才退回纯 markdown。历史上 actionCard 在部分客户端会把中文按错误编码显示成乱码，但本服务发送时
  // 已显式 charset=utf-8 + 字节级 Content-Length（见 sendToChannel），乱码前提已堵，按钮卡片可放心用。
  if (links.length) {
    const payload = {
      msgtype: "actionCard",
      actionCard: {
        title: title.slice(0, 100),
        text: body.slice(0, 18000),
        singleTitle: links[0].title.slice(0, 20),
        singleURL: `dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(links[0].url.slice(0, 500))}&pc_slide=true`,
      },
    };
    return { url: url.toString(), payload };
  }
  const payload = {
    msgtype: "markdown",
    markdown: {
      title: title.slice(0, 100),
      text: body.slice(0, 18000),
    },
  };
  return { url: url.toString(), payload };
}

function feishuRequest(
  channel: NotifyChannel,
  title: string,
  body: string,
  links: DeliveryLink[],
  timestamp: number,
): { url: string; payload: unknown } {
  // 统一走交互卡片：飞书纯文本消息不解析 Markdown，卡片才能保留标题/加粗/列表，也能挂按钮。
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title.slice(0, 100) } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: body.slice(0, 18000) } }],
  };
  if (links.length) {
    card.elements = [
      ...(card.elements as unknown[]),
      {
        tag: "action",
        actions: links.map((link) => ({
          tag: "button",
          text: { tag: "plain_text", content: link.title.slice(0, 20) },
          url: link.url.slice(0, 500),
          type: "primary",
        })),
      },
    ];
  }
  const payload: Record<string, unknown> = { msg_type: "interactive", card };
  if (channel.secret) {
    payload.timestamp = String(timestamp);
    payload.sign = feishuSign(channel.secret, timestamp);
  }
  return { url: channel.webhook, payload };
}

/**
 * 企业微信群机器人：只认 markdown / text 两种消息（没有卡片、没有按钮），
 * 按钮（打开对话）折成文内 markdown 链接；不支持加签（安全设置只有 webhook 里的 key），secret 忽略。
 * markdown content 上限 4096 字节（中文约 1300 字）：通用正文预算之后这里再按平台收紧，超长截断不整条拒收。
 */
function wecomRequest(
  channel: NotifyChannel,
  title: string,
  body: string,
  links: DeliveryLink[],
): { url: string; payload: unknown } {
  const budget = 1200;
  let content = `## ${title.slice(0, 100)}\n\n${body}`;
  if (content.length > budget) {
    content = `${content.slice(0, budget)}…`;
  } else if (links.length) {
    const tail = `\n\n${links
      .map((link) => `[${link.title.slice(0, 20)}](${link.url.slice(0, 500)})`)
      .join("  ")}`;
    if (content.length + tail.length <= budget) content += tail;
  }
  return { url: channel.webhook, payload: { msgtype: "markdown", markdown: { content } } };
}

/** 发一条消息到单个通道；失败抛错（由 deliverToChannels 收敛成结果，不让投递失败影响任务状态）。 */
export async function sendToChannel(
  channel: NotifyChannel,
  message: DeliveryMessage,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<void> {
  const doFetch = opts.fetchImpl || fetch;
  const timestamp = opts.now ?? Date.now();
  const links = (message.links || []).slice(0, MAX_LINKS);
  const title = applyKeyword(message.title, channel.keyword, true);
  const body = applyKeyword(message.body, channel.keyword);
  const request =
    channel.kind === "feishu"
      ? feishuRequest(channel, title, body, links, timestamp)
      : channel.kind === "wecom"
        ? wecomRequest(channel, title, body, links)
        : dingtalkRequest(channel, title, body, links, timestamp);

  const rawBody = Buffer.from(JSON.stringify(request.payload), "utf8");
  const res = await doFetch(request.url, {
    method: "POST",
    // 显式 UTF-8 字节 + Content-Length：缺省 charset 时部分网关按 GBK/latin1 解，中文变成乱码。
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(rawBody.length),
    },
    body: rawBody,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${channel.kind} http ${res.status}: ${raw.slice(0, 200)}`);
  let data: { errcode?: number; errmsg?: string; code?: number; msg?: string } = {};
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    /* 自建网关可能回非 JSON */
  }
  // 平台判定：钉钉/企业微信 errcode / 飞书 code，非 0 即拒收（HTTP 200 也会带错误码）。
  const code = channel.kind === "feishu" ? data.code : data.errcode;
  if (code !== undefined && Number(code) !== 0) {
    const reason = channel.kind === "feishu" ? data.msg : data.errmsg;
    throw new Error(`${channel.kind} 拒收 code=${code} ${reason || ""}`.trim());
  }
}

/** 并行投递到多个通道，逐个记录成败（一条通道挂掉不影响其它通道）。 */
export async function deliverToChannels(
  channels: NotifyChannel[],
  message: DeliveryMessage,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<DeliverySummary> {
  const at = opts.now ?? Date.now();
  const results = await Promise.all(
    channels.map(async (channel): Promise<DeliveryOutcome> => {
      try {
        await sendToChannel(channel, message, opts);
        return { channelId: channel.id, label: channel.label, ok: true };
      } catch (err) {
        const error = String((err as Error)?.message || err).slice(0, 200);
        console.warn(`[notify] 投递失败 ${channel.kind}/${channel.id}：${error}`);
        return { channelId: channel.id, label: channel.label, ok: false, error };
      }
    }),
  );
  const sent = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  return {
    at,
    ok: results.length > 0 && failures.length === 0,
    sent,
    ...(failures.length ? { error: failures.map((f) => `${f.label}: ${f.error}`).join("; ") } : {}),
    results,
  };
}

export type ScheduleDeliveryTrigger = "schedule" | "manual" | "wake";

export interface ScheduleDeliveryInput {
  name?: string;
  prompt: string;
  status: "success" | "failed" | "alert" | "recovered";
  text: string;
  conversationId: string;
  webOrigin?: string;
  locale?: string;
  /** 结果所在对话的路由（缺省 /chat）；由前端路由决定，服务端不猜。 */
  chatPath?: string;
  /** 设备 owner 标识：IM webview 通常不共享浏览器 cookie，链接里带上它才能让「打开对话」正确归属。 */
  ownerKey?: string;
  /** 本轮产出的图表数据：IM 渲染不了图，折成文本一并推送（图本身只在对话里看）。 */
  charts?: DeliveryChart[];
  /** 千问办公执行记录：定时触发 / 手动执行 / 事件唤醒。 */
  trigger?: ScheduleDeliveryTrigger;
  /** 从开跑到收尾的毫秒数。 */
  durationMs?: number;
  /** 展示用时间；缺省为组装时刻。测试可传入固定值。 */
  at?: number;
}

/** 耗时写成收件人读得懂的短句。不足 1 秒按 1 秒计，避免推成「0 秒」。 */
function formatElapsed(ms: number, lang: DeliveryLang): string {
  const sec = Math.max(1, Math.round(Math.max(0, ms) / 1000));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (lang === "zh") {
    if (sec < 60) return `${sec} 秒`;
    if (min < 60) return rem ? `${min} 分 ${rem} 秒` : `${min} 分`;
    return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
  }
  if (lang === "pt") {
    if (sec < 60) return `${sec} s`;
    if (min < 60) return rem ? `${min} min ${rem} s` : `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }
  if (sec < 60) return `${sec}s`;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/**
 * 组装定时任务的结果通知。
 * 结论在前（CodeBuddy 的 summary / 千问的任务会话结果），记录在后。
 * 记录项之间用空行隔开：钉钉 markdown 会把单个换行折成同一行，
 * 「任务 / 状态 / 时间」会粘成一长串。
 */
export function buildScheduleDelivery(input: ScheduleDeliveryInput): DeliveryMessage {
  const lang = deliveryLangOf(input.locale);
  const pack = LANGS[lang];
  const readableLabel = (text: string | undefined): string => {
    const t = String(text || "").trim();
    if (!t || garbledTextReason(t)) return "";
    return t;
  };
  const name = (readableLabel(input.name) || readableLabel(input.prompt) || pack.unnamed).slice(0, 40);
  const statusText =
    input.status === "failed"
      ? pack.fail
      : input.status === "alert"
        ? pack.alert
        : input.status === "recovered"
          ? pack.recovered
          : pack.ok;
  const triggerText =
    input.trigger === "manual"
      ? pack.triggerManual
      : input.trigger === "wake"
        ? pack.triggerWake
        : input.trigger === "schedule"
          ? pack.triggerSchedule
          : "";
  const charts = (input.charts || []).filter((chart) => chart && chart.data !== undefined);
  const chartBlock = charts.length
    ? [pack.chartSection(charts.length), ...charts.flatMap((chart) => chartToLines(chart, pack))].join("\n\n")
    : "";
  const conclusion = input.text.trim() ? formatForIm(input.text, pack) : pack.empty;
  // 任务名放最前，并用一级标题加大（钉钉 markdown 不认 font size，# 是能变大的写法）。
  const taskHeading = `# **${pack.task}：${name}**`;
  const record = [
    `${pack.status}：${lang === "zh" ? alertBadgeZh(statusText) : statusText}`,
    ...(triggerText ? [`${pack.trigger}：${triggerText}`] : []),
    `${pack.at}：${new Date(input.at ?? Date.now()).toLocaleString()}`,
    ...(input.durationMs !== undefined && input.durationMs >= 0
      ? [`${pack.elapsed}：${formatElapsed(input.durationMs, lang)}`]
      : []),
  ];
  const body = clampBody([taskHeading, conclusion, ...(chartBlock ? [chartBlock] : []), ...record].join("\n\n"), pack);
  const origin = (input.webOrigin || "").trim().replace(/\/+$/, "");
  // 没配 WEB_ORIGIN 就不给按钮：宁可少一个按钮，也不要拼一个点不开的地址。
  const links: DeliveryLink[] = origin
    ? [
        {
          title: pack.open,
          url: `${origin}${input.chatPath || "/chat"}?conv=${encodeURIComponent(input.conversationId)}${
            input.ownerKey ? `&owner=${encodeURIComponent(input.ownerKey)}` : ""
          }`,
        },
      ]
    : [];
  return { title: `${name} · ${statusText}`, body, ...(links.length ? { links } : {}) };
}
