// 结果投递通道注册表（钉钉 / 飞书自定义机器人）：全局一份列表，任务只存「用哪些通道 id」。
//
// 凭据策略与 mcp/config.ts 的 toPublic 一致：webhook（含 token）与加签密钥只落本机
// .data/notify-channels.json，对外接口一律只回**域名**与「是否已配密钥」，凭据不出服务端。
//
// 出站白名单：投递目标是用户可填的 URL，不加限制就是一个 SSRF 出口（拿服务端去打内网）。
// 只允许已知机器人域名；确需自建网关时用 NOTIFY_ALLOWED_HOSTS 显式追加（逗号分隔）。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, atomicWriteJson } from "../store-util.js";

export type NotifyKind = "dingtalk" | "feishu";

export interface NotifyChannel {
  id: string;
  kind: NotifyKind;
  /** 展示名（列表里认得出是哪个群 / 哪个机器人）。 */
  label: string;
  /** 机器人 webhook（含 token）——只落本机，绝不回显。 */
  webhook: string;
  /** 加签密钥：钉钉「加签」/ 飞书「签名校验」。不配则依赖关键词或平台侧 IP 白名单。 */
  secret?: string;
  /**
   * 平台侧「关键词」安全设置的内容：消息正文/标题必须包含该词，否则被**静默拒收**
   * （钉钉 HTTP 200 + errcode 310000）。配了这里就不用在群里关掉关键词校验。
   */
  keyword?: string;
  /**
   * 通道级启用开关：关闭后**全局停用**（所有引用它的任务到点都跳过投递）。
   * 缺省 = 启用（老数据无此字段视同启用，向后兼容）。
   */
  enabled?: boolean;
  createdAt: number;
}

/** 对外输出的通道信息：凭据只保留「有没有」，绝不回传值。 */
export interface NotifyChannelPublic {
  id: string;
  kind: NotifyKind;
  label: string;
  /** 只回域名，便于核对是不是填错了机器人；token 不外泄。 */
  host: string;
  hasSecret: boolean;
  keyword?: string;
  /** 通道级启用开关（缺省启用）。前端据此在任务表单里禁用不可勾选的项。 */
  enabled: boolean;
  createdAt: number;
}

export interface NotifyChannelInput {
  id?: string;
  kind?: NotifyKind;
  label?: string;
  webhook?: string;
  secret?: string;
  keyword?: string;
  /** 通道级启用开关（仅 upsert 时透传；缺省保持原值 / 新建启用）。 */
  enabled?: boolean;
}

const CONFIG_PATH = resolve(DATA_DIR, "notify-channels.json");
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KINDS: NotifyKind[] = ["dingtalk", "feishu"];
const MAX_LABEL_LEN = 40;
/** 不配 label 时的兜底展示名（通用协议词，与业务无关）。 */
const KIND_LABEL: Record<NotifyKind, string> = { dingtalk: "DingTalk", feishu: "Feishu" };
const DEFAULT_HOST_SUFFIXES = ["oapi.dingtalk.com", "open.feishu.cn", "open.larksuite.com"];

/** 允许出站的域名（默认机器人域名 + NOTIFY_ALLOWED_HOSTS 追加）。 */
export function allowedHostSuffixes(): string[] {
  const extra = (process.env.NOTIFY_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_HOST_SUFFIXES, ...extra];
}

/** 取出 webhook 的域名（解析失败返回空串）。 */
export function hostOf(webhook: string): string {
  try {
    return new URL(webhook).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostAllowed(host: string): boolean {
  return allowedHostSuffixes().some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** 入参校验：返回错误文案或 null。地址只做「形状 + 白名单」校验，连通性由测试端点验证。 */
export function validateChannelInput(input: NotifyChannelInput): string | null {
  if (input.id !== undefined && !ID_RE.test(String(input.id).trim())) {
    return "id 仅允许字母、数字、下划线、短横线（1-32 字符）";
  }
  if (input.kind !== undefined && !KINDS.includes(input.kind)) {
    return `通道类型非法（可选 ${KINDS.join(" / ")}）`;
  }
  const webhook = String(input.webhook || "").trim();
  if (!webhook) return "webhook 必填";
  const host = hostOf(webhook);
  if (!host) return "webhook 不是合法 URL";
  if (!/^https?:$/.test(new URL(webhook).protocol)) return "webhook 只支持 http/https";
  if (!hostAllowed(host)) {
    return `webhook 域名不在允许列表（可选 ${allowedHostSuffixes().join(" / ")}；自建网关用 NOTIFY_ALLOWED_HOSTS 追加）`;
  }
  if (input.label !== undefined && String(input.label).length > MAX_LABEL_LEN) {
    return `展示名不超过 ${MAX_LABEL_LEN} 字符`;
  }
  return null;
}

function readFileChannels(): NotifyChannel[] {
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NotifyChannel => Boolean(item && typeof item === "object" && (item as NotifyChannel).id));
  } catch (err) {
    console.warn(`[notify] 通道配置读取失败：${String((err as Error)?.message || err)}`);
    return [];
  }
}

export function loadChannels(): NotifyChannel[] {
  return readFileChannels().sort((a, b) => b.createdAt - a.createdAt);
}

export function getChannel(id: string): NotifyChannel | null {
  return readFileChannels().find((c) => c.id === id) || null;
}

export function toPublic(channel: NotifyChannel): NotifyChannelPublic {
  return {
    id: channel.id,
    kind: channel.kind,
    label: channel.label,
    host: hostOf(channel.webhook),
    hasSecret: Boolean(channel.secret),
    ...(channel.keyword ? { keyword: channel.keyword } : {}),
    enabled: channel.enabled !== false,
    createdAt: channel.createdAt,
  };
}

/**
 * 新增或更新通道（按 id 判定；无 id = 新建）。
 * 更新时未提供的凭据字段**保持原值**：前端拿到的是脱敏视图，回填不了 token，
 * 若按「未提供即清空」处理，改个展示名就会把 webhook 抹掉。
 */
export function upsertChannel(input: NotifyChannelInput): NotifyChannel {
  const list = readFileChannels();
  const id = String(input.id || "").trim() || `ch_${randomUUID().slice(0, 10)}`;
  const prev = list.find((c) => c.id === id);
  const kind = (input.kind || prev?.kind || "dingtalk") as NotifyKind;
  const next: NotifyChannel = {
    id,
    kind,
    label: (input.label !== undefined ? String(input.label).trim() : prev?.label) || KIND_LABEL[kind],
    webhook: (input.webhook !== undefined ? String(input.webhook).trim() : prev?.webhook) || "",
    createdAt: prev?.createdAt || Date.now(),
    // 启用开关：显式传则采用，否则沿用原值，再否则默认启用（新通道 / 老数据无字段）。
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : (prev?.enabled ?? true),
  };
  const secret = input.secret !== undefined ? String(input.secret).trim() : prev?.secret;
  if (secret) next.secret = secret;
  const keyword = input.keyword !== undefined ? String(input.keyword).trim() : prev?.keyword;
  if (keyword) next.keyword = keyword;

  const others = list.filter((c) => c.id !== id);
  atomicWriteJson(CONFIG_PATH, [next, ...others], { logLabel: "notify", pretty: true });
  return next;
}

export function deleteChannel(id: string): boolean {
  const list = readFileChannels();
  const kept = list.filter((c) => c.id !== id);
  if (kept.length === list.length) return false;
  atomicWriteJson(CONFIG_PATH, kept, { logLabel: "notify", pretty: true });
  return true;
}
