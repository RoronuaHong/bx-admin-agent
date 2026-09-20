// 角色（Agent 变体）注册表 —— 领域适配指南第 2 章「模式 B」的落地：
// 同一引擎按 role 选择人设 / 默认工具集 / 技能可见性；通用 Agent 与各领域 Agent 是同一引擎的不同配置实例。
// 角色只在此处（+ 各领域 skill 的 frontmatter）声明，前端/端侧不允许自行实现角色判断。
export interface AgentRole {
  id: string;
  label: string;
  /** 角色人设（系统提示稳定前缀第二段，紧跟全局 SAFETY_GUARDRAIL）。未配置 = 引擎默认人设。 */
  basePrompt?: string;
  /** 该角色**新建对话**默认勾选的 MCP 服务器 id（用户显式勾选时以请求为准）。 */
  defaultMcpServers?: string[];
  /** 该角色默认模型 id（请求未指定、对话未设置时回落到此；不填 = 全局默认模型）。 */
  defaultModel?: string;
  /** 该角色强制全量注入 MCP 工具 schema（不走「按需检索加载」deferred）。仅对依赖工具强、弱模型易在
   *  deferred 下不检索而编造的角色开启；不填 = 跟随全局 TOOL_SEARCH_MODE，不影响通用角色。 */
  forceEagerTools?: boolean;
  /** 该角色首轮强制走工具通道（tool_choice=required，对齐 Anthropic「防止模型凭记忆作答」最佳实践）：
   *  用户进入具体问题时模型必须先调一次工具、拿真实数据再答，杜绝凭训练记忆编造。
   *  仅对「答错=编造、且数据必须来自工具」的领域角色开启（如 movie）；不填 = auto，通用角色行为不变。
   *  注意：只在「当前尚无工具结果」的首轮强制，拿到结果后的后续轮次恢复 auto，模型才能正常收尾、问候也只多一次无害调用。 */
  forceToolCall?: boolean;
  /** 该角色的答案必须接地于工具数据（运行时护栏，详见 `src/grounding.ts`）：本轮「一条数据都没拿到」
   *  却要以正文结论收束时，作废该段文本 + 回灌纠正提示补取数据；重试后仍无数据则改用确定性拒答。
   *  仅对「答错等于编造、且事实必须来自数据源」的领域角色开启；不填 = 不参与本护栏，通用角色行为不变。 */
  enforceGrounding?: boolean;
}

/**
 * 通用人设由 system-prompt.ts 的 BASE_PERSONA 提供（roles.ts 不重复定义，避免双份漂移）；
 * generic 角色不在此声明 basePrompt，由 buildSystemPrompt 回落到 BASE_PERSONA。
 *
 * 分层原则：人设只写**该角色特有**的内容（身份、数据源与调用约定、范围边界）；
 * 跨角色通用纪律（违法/身份/专业建议/越狱抵抗等）只写在 `system-prompt.ts` 的 `SAFETY_GUARDRAIL`，
 * 工具使用纪律只写在同一文件的 `TOOLING_RULES` —— 由 `buildSystemPrompt` 对**所有角色**统一拼在其后。
 * 同一条纪律存在两份措辞会漂移，也会让模型收到重复信号（prompt 越长，单条指令的服从度越低）。
 * 因此：`role.basePrompt` 虽然是**替换**默认人设，也不必（不应）自带通用工具守则。
 */
const MOVIE_BASE_PROMPT = [
  "你是「观影助手」，只围绕电影与剧集的发现、了解与对比提供协助。被问到「你是谁」时只说你是观影助手。",
  "",
  "数据源与调用约定（工具使用的通用纪律不在此重复）：",
  "1. 影片数据来自 TMDb（工具前缀 mcp__movie__）。回答任何具体影片 / 剧集 / 影人的事实问题（片名、年份、导演、演员、评分、剧情、类型等）之前，" +
    "**必须先调用观影工具取真实数据**（如先用检索工具拿数字 id，再按 id 取详情），严禁凭记忆作答。" +
    "（运行时机制，不必惊讶：在「尚无工具结果」的首轮，系统会强制你先走一次工具通道；即便用户只是打招呼，也会先发起一次调用，照常调用后自然接话即可。）",
  "2. 调用观影工具时一律带上 language: \"zh-CN\"（默认 en-US，不传会返回英文标题与简介）；片名对不上时先用搜索工具拿数字 id，再按 id 取详情。",
  "",
  "范围与边界：",
  "1. 职责仅限影片/剧集相关（找片、介绍、对比、评分、上映信息、相似推荐、演职员与制作信息）。明显超出该范围的请求（写代码、算账、医疗/法律咨询、政治话题、一般闲聊问答等），礼貌说明你只擅长观影协助，并建议改用通用助手，不越界代答。",
  "2. 版权与盗版：绝不提供盗版资源、未授权在线播放/下载链接、破解或绕过付费/地域限制的方法，也不教人如何获取侵权内容。用户问「哪里能免费看」时，引导到合法渠道（影院、正版平台、图书馆等）。",
  "3. 剧透：默认不透露关键情节转折、结局或重大反转。涉及此类内容前先给出「剧透预警」，并优先用可跳过/折叠的方式呈现，除非用户明确说「无所谓剧透 / 直接剧透」。",
  "4. 成人内容：对含裸露、性、极端血腥或恐怖元素的影片，只在「帮助用户了解分级与内容预警」的语境下中性描述，不渲染细节、不生成色情或性暗示内容；按地区分级（如 G/PG/PG-13/R、国语分级）提示适龄信息。",
].join("\n");

const SUPPORT_BASE_PROMPT = [
  "你是「客服助手」，面向用户的客户服务 AI：处理咨询、售后问题与常见问答（FAQ），帮助用户查订单、跟进工单、给出标准解答话术。被问到「你是谁」时只说你是客服助手。",
  "",
  "服务守则（工具使用的通用纪律不在此重复）：",
  "1. 礼貌、共情、简洁：先回应诉求再给方案；涉及敏感事项（退款、投诉、隐私）时按标准流程引导，不擅自承诺超出权限的内容。",
  "2. 超出客服职责的范围（写代码、医疗/法律建议、政治话题等），礼貌说明边界并建议改用通用助手，不越界代答。",
].join("\n");

const ROLES: Record<string, AgentRole> = {
  generic: { id: "generic", label: "通用助手" },
  movie: {
    id: "movie",
    label: "观影助手",
    basePrompt: MOVIE_BASE_PROMPT,
    // 数据源：TMDb（公共托管 MCP，Streamable HTTP；配置见 .env 的 MCP_BUILTIN_SERVERS，
    // 白名单放行该服务器的全部 21 个只读工具：电影检索/详情/相似/趋势、榜单与多源评分、
    // 系列顺序、影人、关键词/制片厂、剧集分季分集、预告/海报、上映日历等）。
    // 工具都收 language 参数（默认 en-US）→ 人设里要求调用时一律传 zh-CN。
    defaultMcpServers: ["movie"],
    // 强制全量注入电影工具 schema：通用角色的 TOOL_SEARCH_MODE=auto 在工具定义超窗口 10% 时切 deferred（只留 search_tools 入口），
    // 弱模型（如 hy-vision）不会主动检索就直接用记忆作答 → 编造。movie 角色依赖工具强、工具数（21）< 上限，故强制 eager，
    // 让 21 个电影工具对模型始终可见、可被调用；此开关只影响 movie 角色，不改通用角色行为。
    forceEagerTools: true,
    // 首轮强制工具调用（对齐 Anthropic「防止模型凭记忆作答」最佳实践）：movie 角色数据必须来自 TMDb 工具，
    // 任何具体影片/影人事实问题首轮 tool_choice=required 逼模型先调工具、杜绝凭记忆编造；仅作用「尚无工具结果」的首轮，
    // 拿到结果后恢复 auto（模型正常收尾、问候也只多一次无害调用）。通用角色不开启 → 仍是 auto，行为不变。
    forceToolCall: true,
    // 接地护栏（运行时）：forceToolCall 依赖端点尊重 tool_choice=required，若网关/弱模型忽略该字段，
    // 首轮就可能凭记忆直接作答而无人拦截。开启后：本轮「零工具数据」不得收束——先作废文本回灌纠正提示
    // 补取数据（默认重试 1 次），仍无数据则改用确定性拒答，绝不展示可能编造的内容。通用角色不开启。
    enforceGrounding: true,
    // 观影助手默认模型 = kimi-k2.7-code（TokenHub）：minimax-m2.7 于 2026-09-20 因网关 402 未开通下掉后改钉这个。
    // 选它的理由不变：严格遵循「必须先调观影工具」指令（首轮强制 required + 强提示下必走工具）、
    // 返回 TMDb 真实数据、查不到如实说「不存在于数据库中」，不凭记忆编造。用户仍可在 UI 手动切其它模型；
    // 切到弱模型时 unavailable 护栏与伪调用检测仍是兜底。
    // 注意：id 必须存在于 MODEL_PROVIDERS（.env）——钉住的模型被下线/改名后会静默回落到全局默认模型，
    // 服务端会用 [chat:model] 日志如实告警，排查「页面用的模型和这里写的不一致」先看那条日志。
    defaultModel: "kimi27",
  },
  support: {
    id: "support",
    label: "客服助手",
    basePrompt: SUPPORT_BASE_PROMPT,
    // 暂无专属 MCP/技能：复用通用工具能力；需要订单/工单系统时再加 defaultMcpServers + forceEagerTools/forceToolCall。
  },
};

/** 取角色；未知 id 一律回落通用（fail-open 到安全默认，而不是报错）。 */
export function getRole(id?: string | null): AgentRole {
  return ROLES[String(id || "").trim()] || ROLES.generic!;
}

export function hasRole(id?: string | null): boolean {
  return Boolean(id && ROLES[String(id).trim()]);
}

/** 列出全部已注册角色（门户 / 测试枚举用）。 */
export function listRoles(): AgentRole[] {
  return Object.values(ROLES);
}
