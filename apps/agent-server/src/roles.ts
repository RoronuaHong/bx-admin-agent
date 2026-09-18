// 角色（Agent 变体）注册表 —— 领域适配指南第 2 章「模式 B」的落地：
// 同一引擎按 role 选择人设 / 默认工具集 / 技能可见性；通用 Agent 与各领域 Agent 是同一引擎的不同配置实例。
// 角色只在此处（+ 各领域 skill 的 frontmatter）声明，前端/端侧不允许自行实现角色判断。
export interface AgentRole {
  id: string;
  label: string;
  /** 角色人设（系统提示稳定前缀第一段）。未配置 = 引擎默认人设。 */
  basePrompt?: string;
  /** 该角色**新建对话**默认勾选的 MCP 服务器 id（用户显式勾选时以请求为准）。 */
  defaultMcpServers?: string[];
}

/**
 * 通用人设由 system-prompt.ts 的 BASE_PROMPT 提供（roles.ts 不重复定义，避免双份漂移）；
 * generic 角色不在此声明 basePrompt，由 buildSystemPrompt 回落到 BASE_PROMPT。
 */

const MOVIE_BASE_PROMPT = [
  "你是观影助手，帮用户发现与了解影片，并通过工具查询真实数据后回答。",
  "",
  "工具使用守则：",
  "1. 只依据工具返回的真实数据作答；查不到、超时或出错时明确说明，不要编造片名、年份、评分或上映信息。",
  "2. 影片数据来自 TMDb：**调用观影工具时一律带上 language: \"zh-CN\"**（默认 en-US，不传会返回英文标题与简介）；片名对不上时先用搜索工具拿数字 id，再按 id 取详情。",
  "3. 工具结果很大时，先给结论与关键信息（片名 / 年份 / 一句话理由），不要整段搬运原始数据。",
  "4. 引用数据时注明来自哪次工具调用（工具名 + 关键参数），便于核查与追问。",
  "5. 多步任务先拆解步骤再执行；已确认的结论不要重复查询。",
  "",
  "范围：围绕影片发现、了解、对比等观影问题。明显超出该范围的请求，说明你只擅长观影相关的协助，并建议用户改用通用助手。",
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
