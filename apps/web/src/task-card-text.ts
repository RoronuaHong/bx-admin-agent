import type { ScheduleDto } from "./api";
import { formatShortTime, pad2, type ScheduleTx } from "./schedule-cron";

/** 卡片文案要用到的页面状态。每次调用现读，不在这里保存。 */
export interface TaskCardFacts {
  tx: ScheduleTx;
  isRunning: (task: ScheduleDto) => boolean;
  mcpLabel: (id: string) => string;
  channelLabels: string[];
  convTitle: (conversationId: string) => string | undefined;
}

const STATUS_LABEL: Record<NonNullable<ScheduleDto["lastStatus"]>, [string, string, string, string]> = {
  success: ["成功", "success", "sucesso", "सफल"],
  failed: ["失败", "failed", "falhou", "विफल"],
  skipped: ["跳过", "skipped", "ignorado", "छोड़ा"],
  cancelled: ["已取消", "cancelled", "cancelado", "रद्द"],
  error: ["出错", "error", "erro", "त्रुटि"],
};

export function taskToolsFact(t: ScheduleDto, facts: TaskCardFacts): string {
  const ids = t.mcpServers || [];
  if (!ids.length) return facts.tx("不使用 MCP 工具", "No MCP tools", "Sem ferramentas MCP", "कोई MCP टूल नहीं");
  return ids.map((id) => facts.mcpLabel(id)).join(facts.tx("、", ", ", ", ", ", "));
}

export function taskNotifyFact(t: ScheduleDto, facts: TaskCardFacts): string {
  const labels = facts.channelLabels;
  if (!labels.length) return "";
  const text = labels.join(facts.tx("、", ", ", ", ", ", "));
  const last = t.lastDelivery;
  if (!last) return text;
  return `${text} · ${
    last.ok
      ? facts.tx("上次推送成功", "last push ok", "último envio ok", "पिछला भेजा गया")
      : facts.tx("上次推送失败", "last push failed", "último envio falhou", "पिछला भेजना विफल")
  }`;
}

export function taskStatusText(t: ScheduleDto, facts: TaskCardFacts): string {
  const label = t.lastStatus ? STATUS_LABEL[t.lastStatus] : null;
  return label ? facts.tx(label[0], label[1], label[2], label[3]) : "";
}

export function taskRunText(t: ScheduleDto, facts: TaskCardFacts): string {
  const label = taskStatusText(t, facts);
  if (!label) return "";
  const at = t.lastRunAt ? ` ${new Date(t.lastRunAt).toLocaleString()}` : "";
  const head = facts.tx("上次执行", "Last run", "Última execução", "पिछला निष्पादन") + "：" + label + at;
  return t.lastNote ? `${head}（${t.lastNote}）` : head;
}

export function taskMarkerText(marker: string | null | undefined, facts: TaskCardFacts): string {
  if (marker === "SPIKE") return facts.tx("异常", "Spike", "Anomalia", "स्पाइक");
  if (marker === "NORMAL") return facts.tx("正常", "Normal", "Normal", "सामान्य");
  if (marker === "NO_DATA") return facts.tx("无数据", "No data", "Sem dados", "डेटा नहीं");
  return "";
}

export function taskDotClass(t: ScheduleDto, facts: TaskCardFacts): string {
  if (!t.enabled) return "paused";
  if (facts.isRunning(t)) return "running";
  if (t.queuedSince) return "pending";
  if (t.enabled && t.nextRunAt && t.nextRunAt < Date.now() - 90_000 && !t.lastStatus) return "pending";
  if (t.enabled && t.nextRunAt && t.nextRunAt < Date.now() - 90_000 && t.lastRunAt && t.nextRunAt > (t.lastRunAt || 0)) {
    if (!facts.isRunning(t) && Date.now() - (t.nextRunAt || 0) > 90_000) return "pending";
  }
  if (t.alertState?.firing || t.lastMarker === "SPIKE") return "alert";
  if (t.lastMarker === "NO_DATA") return "nodata";
  if (t.lastStatus) return t.lastStatus;
  return "idle";
}

export function taskHealthShort(t: ScheduleDto, facts: TaskCardFacts): string {
  if (!t.enabled) return facts.tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (facts.isRunning(t)) return facts.tx("执行中", "Running", "Executando", "चल रहा है");
  if (t.queuedSince) return facts.tx("排队中", "Queued", "Na fila", "कतार में");
  if (t.enabled && t.nextRunAt && t.nextRunAt < Date.now() - 90_000) {
    return facts.tx("待执行", "Due", "Pendente", "बाकी");
  }
  const marker = taskMarkerText(t.lastMarker, facts);
  if (marker) {
    const when = t.lastRunAt ? formatShortTime(t.lastRunAt) : "";
    if (t.alertState?.firing && t.lastMarker !== "SPIKE") {
      return (when ? when + " · " : "") + facts.tx("告警中", "Firing", "Em alerta", "अलर्ट में");
    }
    return (when ? when + " · " : "") + marker;
  }
  if (t.lastRunAt) {
    const st = taskStatusText(t, facts);
    return formatShortTime(t.lastRunAt) + (st ? ` · ${st}` : "");
  }
  return facts.tx("尚未执行", "Not run yet", "Ainda não executou", "अभी नहीं चला");
}

export function taskNextRunText(t: ScheduleDto, facts: TaskCardFacts): string {
  if (!t.enabled) return facts.tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (t.onceAt) {
    return t.lastRunAt
      ? facts.tx("已执行", "Ran", "Executada", "निष्पादित")
      : facts.tx("执行于 ", "Runs at ", "Executa em ", "निष्पादन: ") + formatShortTime(t.onceAt);
  }
  return t.nextRunAt ? facts.tx("下次 ", "Next ", "Próxima ", "अगली: ") + formatShortTime(t.nextRunAt) : "—";
}

export function taskNextShort(t: ScheduleDto, facts: TaskCardFacts): string {
  if (!t.enabled) return facts.tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (t.onceAt) return t.lastRunAt ? facts.tx("已执行", "Ran", "Executada", "निष्पादित") : formatShortTime(t.onceAt);
  if (!t.nextRunAt) return "—";
  const d = new Date(t.nextRunAt);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : formatShortTime(t.nextRunAt);
}

export function taskRightShort(t: ScheduleDto, facts: TaskCardFacts): string {
  if (!t.enabled) return facts.tx("已暂停", "Paused", "Pausada", "रुका हुआ");
  if (facts.isRunning(t)) return facts.tx("执行中", "Running", "Executando", "चल रहा है");
  return taskNextShort(t, facts);
}

export function taskKindText(t: ScheduleDto, facts: TaskCardFacts): string {
  return t.onceAt
    ? facts.tx("一次性", "Once", "Única", "एक बार")
    : facts.tx("周期", "Recurring", "Recorrente", "आवधिक");
}

export function taskConvText(t: ScheduleDto, facts: TaskCardFacts): string {
  return facts.convTitle(t.conversationId) || t.conversationId;
}

export function taskCardTip(t: ScheduleDto, facts: TaskCardFacts): string {
  const head = facts.tx("编辑", "Edit", "Editar", "संपादित करें") + "：" + (t.name || t.prompt);
  const lines = [head, `${taskKindText(t, facts)} · ${taskNextRunText(t, facts)}`];
  if (t.name) lines.push(t.prompt);
  lines.push(facts.tx("健康", "Health", "Saúde", "स्थिति") + "：" + taskHealthShort(t, facts));
  const runDetail = taskRunText(t, facts);
  if (runDetail) lines.push(runDetail);
  if (t.notifyPolicy === "on_alert") {
    lines.push(
      facts.tx(
        "通知：仅异常时推。新建或重新启用后的第一期会发启动确认",
        "Notify: alerts only. The first run after create or re-enable sends a start confirmation",
        "Notificar: só anomalias. A primeira execução após criar ou reativar confirma o início",
        "सूचना: केवल असामान्य। बनाने या फिर चालू करने के बाद पहली बार आरंभ पुष्टि जाती है",
      ),
    );
  }
  lines.push(facts.tx("结果回到", "Results to", "Resultado em", "परिणाम यहाँ") + "：" + taskConvText(t, facts));
  lines.push(facts.tx("工具", "Tools", "Ferramentas", "टूल") + "：" + taskToolsFact(t, facts));
  const notify = taskNotifyFact(t, facts);
  if (notify) lines.push(facts.tx("通知通道", "Channels", "Canais", "चैनल") + "：" + notify);
  return lines.filter(Boolean).join("\n");
}
