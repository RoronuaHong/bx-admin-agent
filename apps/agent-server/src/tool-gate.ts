/**
 * workflow 层：轻量 tool 门控
 * - extractGrepPattern：提取 grep 关键词
 * 主路径：LLM 调 tools/skill/MCP → 规则门（call_api 前）→ 落地
 * 可选链式编排见 workflow-orchestrate.ts（非默认主路径）
 *
 * ⚠️ 意图判别（业务/闲聊、是否写操作）100% 交模型（对齐 Cursor「无独立意图路由层」）：
 * 原 isActionableBusinessQuery（写死中文业务动词白名单）已于 2026-08-24 删除——它既不属于
 * skill/tool/MCP，又写死了业务中文词，违反「禁止写死」红线；且中文动词白名单会漏词（「看最近30天」
 * 漏「看」）造成打地鼠。服务端兜底编排改为由「模型是否真调业务工具 / writeForce / 模型失败」等
 * 模型信号驱动，不再用服务端 bool 预判抢路由。
 */

/**
 * 从用户输入提取 grep 关键词。
 * ⚠️ 红线（2026-08-26）：服务端流程不得写死任何业务词/功能词/中文动词表做剥词——
 * 「口语词→核心词」的语义判断 100% 交模型（模型调 search_api_module 时自己决定 query 参数，
 * 对齐 Cursor「模型控制工具入参，服务端不做中文意图正则」）。
 * 本函数仅做两类**无业务语义**的归一化：
 *  1) 英文 module.operation 形态 → 取 module 部分（英文 CRUD 契约，合法）；
 *  2) 去除首尾空白与控制字符，截断超长（防整句喂 grep 但保留全部词，由 rg 自行匹配）。
 * 不再做中文动词/功能词剥离（原写死词表已删，避免「搜索/统计」等业务词根被误剥的历史事故）。
 */
export function extractGrepPattern(text: string): string {
  const t = text.trim().replace(/^[\s，。、！？；：,.!?;:]+|[\s，。、！？；：,.!?;:]+$/g, "");
  // module.operation 形式 → 取 module 部分（英文 CRUD 契约，非业务词）
  const opMatch = t.match(/\b([a-zA-Z][\w-]*)\.(getList|getById|create|update|delete|remove)\b/i);
  if (opMatch) return opMatch[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  // 直接返回用户输入（保留全部词，不剥中文）；超长截断避免整句喂 grep
  return t.slice(0, 32);
}
