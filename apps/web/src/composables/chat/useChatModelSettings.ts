import { computed, nextTick, ref, type ComputedRef, type Ref } from "vue";
import {
  MODEL_AUTO_ID,
  getApiErrorToken,
  patchConversation,
  type ConversationDto,
  type ModelInfo,
} from "../../api";
import { isUiLocale, setUiLocale, type UiLocale } from "../../ui-locale";
import { localizeToken } from "../../localize";
import type { ConvState } from "./chat-page-types";

type Tx = (zh: string, en: string, pt?: string, hi?: string) => string;

export interface ChatModelSettingsOptions {
  current: ComputedRef<ConvState>;
  currentId: Ref<string>;
  settingsError: Ref<string>;
  conversations: Ref<ConversationDto[]>;
  deviceLocale: Ref<UiLocale>;
  uiLocale: Ref<UiLocale>;
  tx: Tx;
  /** 与全局气泡计数器共用；只在用户操作时调用，setup 同步阶段不触发。 */
  nextSeq: () => number;
  /** 强制回底薄代理（来自 threadScroll；注入回调以消解初始化顺序）。 */
  queueScroll: (force?: boolean) => void;
}

/**
 * 模型设置 / 对话语言（SCC C 之一）。
 * 从 useChatPageCore 机械搬迁，行为零变化；跨组状态（conversations / settingsError / 计数器 / 回底）
 * 只通过 options 注入引用或回调，不在本文件内新建实例级状态。
 */
export function useChatModelSettings(options: ChatModelSettingsOptions) {
  const {
    current,
    currentId,
    settingsError,
    conversations,
    deviceLocale,
    uiLocale,
    tx,
    nextSeq,
    queueScroll,
  } = options;

  const models = ref<ModelInfo[]>([]);
  const modelsLoaded = ref(false);

  /** 当前对话的模型选择；空 = 自动模式（运行时挑可用模型），UI 兜底展示「自动」。
   *  对话里存的 id 已被挪出模型配置（失效 id）时同样回落「自动」：
   *  失效 id 在任何列表里都查不到，UI 会退化成没有标签的「选择模型」空壳——
   *  而它本身不承载任何信息，回落自动既有标签、发送时也会解析到可用模型。 */
  const modelId = computed({
    get: () => {
      const stored = current.value.settings.modelId;
      if (!stored) return MODEL_AUTO_ID;
      if (modelsLoaded.value && !models.value.some((model) => model.id === stored)) return MODEL_AUTO_ID;
      return stored;
    },
    set: (value: string) => {
      void saveModelChoice(value);
    },
  });

  /**
   * 「自动」模式解析：把 auto（或空/失效值）落到具体模型。
   * 优先用「上次成功用过的模型」，否则按列表顺序挑第一个「近期未失败」的——
   * 实现「哪个能用用哪个」：失败过的模型会被跳过，直到全部失败才重置黑名单重新探测。
   */
  const lastGoodModelId = ref<string>("");
  const failedModelIds = ref<Set<string>>(new Set());
  function resolveModel(value: string): string {
    const ids = models.value.map((m) => m.id);
    const usable = (id: string | undefined) => !!id && ids.includes(id) && !failedModelIds.value.has(id);
    if (value && value !== MODEL_AUTO_ID && usable(value)) return value;
    if (usable(lastGoodModelId.value)) return lastGoodModelId.value;
    const next = ids.find((id) => !failedModelIds.value.has(id));
    if (next) return next;
    // 全部失败过：清空黑名单，给一次重新探测的机会。
    failedModelIds.value.clear();
    return ids[0] ?? "";
  }

  let settingsErrorTimer: ReturnType<typeof setTimeout> | null = null;
  /** 乐观更新失败后的提示；4s 自动消失，不打扰。 */
  function showSettingsError(message: string) {
    settingsError.value = message;
    if (settingsErrorTimer) clearTimeout(settingsErrorTimer);
    settingsErrorTimer = setTimeout(() => {
      settingsError.value = "";
    }, 4000);
  }
  /** 卸载时清掉短时提示定时器（唯一由协调层转调的清理入口）。 */
  function disposeSettingsErrorTimer() {
    if (settingsErrorTimer) {
      clearTimeout(settingsErrorTimer);
      settingsErrorTimer = null;
    }
  }

  /** 把改动同步回本地列表条目，避免下次切回时被过期 DTO 覆盖（服务端仍是唯一真相）。 */
  function syncConvLocal(convId: string, patch: Partial<ConversationDto>) {
    conversations.value = conversations.value.map((c) => (c.id === convId ? { ...c, ...patch } : c));
  }

  /** 应用某对话的语言（未显式设置时用设备默认）。tx() / localizeToken 都读这个内存态。 */
  function applyConversationLocale(locale: string | undefined) {
    setUiLocale(isUiLocale(locale) ? locale : deviceLocale.value);
  }

  /**
   * 模型切换：乐观更新 → PATCH 落库 → 失败回滚（对齐 TanStack 的 onMutate/onError/onSettled 三段式）。
   * 尚未创建对话时（首屏）只改内存，创建对话后随设置一起落库。
   */
  function modelChoiceLabel(id: string): string {
    if (!id || id === MODEL_AUTO_ID) return tx("自动", "Auto", "Automático", "स्वतः");
    return models.value.find((model) => model.id === id)?.label || id;
  }

  const modelSwitchHint = ref("");

  async function saveModelChoice(value: string) {
    const convId = currentId.value;
    const state = current.value;
    const prev = state.settings.modelId;
    const prevShown = prev || MODEL_AUTO_ID;
    if (prevShown === value) return;
    state.settings.modelId = value;
    const fromLabel = modelChoiceLabel(prevShown);
    const toLabel = modelChoiceLabel(value);
    const hadThread = state.bubbles.some((bubble) => bubble.role !== "notice");
    const noticeId = hadThread && fromLabel !== toLabel ? nextSeq() : 0;
    if (noticeId) {
      state.bubbles.push({
        id: noticeId,
        role: "notice",
        at: Date.now(),
        text: tx(
          `模型已从 ${fromLabel} 更改为 ${toLabel}`,
          `Model changed from ${fromLabel} to ${toLabel}`,
          `Modelo alterado de ${fromLabel} para ${toLabel}`,
          `मॉडल ${fromLabel} से ${toLabel} में बदला गया`,
        ),
      });
      modelSwitchHint.value = tx(
        "在对话中途更换模型可能降低效果，上下文的分词方式也会变化。",
        "Switching models mid-chat can hurt quality, and the context is tokenized differently.",
        "Trocar o modelo no meio da conversa pode piorar a resposta, e o contexto é tokenizado de outro jeito.",
        "बीच बातचीत में मॉडल बदलने से गुणवत्ता घट सकती है, और संदर्भ अलग तरह से टोकनाइज़ होता है।",
      );
      void nextTick(() => queueScroll(true));
    }
    if (!convId) return;
    try {
      await patchConversation(convId, { model: value });
      syncConvLocal(convId, { model: value });
    } catch (err) {
      state.settings.modelId = prev;
      if (noticeId) state.bubbles = state.bubbles.filter((bubble) => bubble.id !== noticeId);
      modelSwitchHint.value = "";
      showSettingsError(
        localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("模型保存失败", "Failed to save model", "Falha ao salvar o modelo", "मॉडल सहेजने में विफल")),
      );
    }
  }

  /** 语言切换：组件已先改内存（立即生效），这里负责落当前对话 + 失败回滚。 */
  async function onLocaleChange(locale: UiLocale) {
    const convId = currentId.value;
    const state = current.value;
    const prev = state.settings.locale;
    state.settings.locale = locale;
    if (!convId) return;
    try {
      await patchConversation(convId, { locale });
      syncConvLocal(convId, { locale });
    } catch (err) {
      state.settings.locale = prev;
      applyConversationLocale(prev);
      showSettingsError(
        localizeToken(uiLocale.value, getApiErrorToken(err), (err as Error)?.message || tx("语言保存失败", "Failed to save language", "Falha ao salvar o idioma", "भाषा सहेजने में विफल")),
      );
    }
  }

  /** 实际生效的模型（auto 已解析为具体模型），用于图片能力等预判。 */
  const resolvedModelId = computed(() => resolveModel(modelId.value));

  /** 当前模型是否支持直读图片（由服务端 /models 的 vision 字段给出）。 */
  const modelSupportsImages = computed(
    () => models.value.find((m) => m.id === resolvedModelId.value)?.vision === "direct",
  );
  /** 已选图片但当前模型不支持：明确提示，避免"传了但模型看不到"的静默失效。 */
  const imagesUnsupported = computed(
    () => current.value.pendingImages.length > 0 && !modelSupportsImages.value,
  );

  return {
    models,
    modelsLoaded,
    modelId,
    lastGoodModelId,
    failedModelIds,
    resolveModel,
    settingsErrorTimer,
    showSettingsError,
    disposeSettingsErrorTimer,
    syncConvLocal,
    applyConversationLocale,
    modelChoiceLabel,
    modelSwitchHint,
    saveModelChoice,
    onLocaleChange,
    resolvedModelId,
    modelSupportsImages,
    imagesUnsupported,
  };
}
