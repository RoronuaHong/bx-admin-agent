/**
 * call_api 确定性校验护栏（对齐 Cursor/Claude Code 的 pre-tool 检查点）。
 *
 * 设计红线约束（2026-08-25 起「全部由大模型判断」最高红线）：
 *  - 本文件只做「协议层 / 结构层」硬校验，绝不写死任何业务词（模块名/接口名/字段名/枚举值/中文业务术语）。
 *  - 参数契约来自实时读接口源码（resolveApiOperation → 源码文件），不维护任何映射表。
 *  - 枚举值翻译（如 <中文枚举值> → <字段名>=<编码值>）由 execGetFieldMapping 从源码抽取后作为提示回喂模型，
 *    不在此文件写死任何业务映射。
 *  - 所有校验失败返回带前缀的错误串（PARAM_NOT_IN_CONTRACT / FILTER_NOT_APPLIED /
 *    POSSIBLE_FILTER_DROPPED / ENUM_VALUE_HINT），交由 chat.ts 回传模型自愈，不中断 tool-loop。
 */

import { resolveApiOperation } from "./api-operation-index.js";
import { execGetFieldMapping, extractPagingContract } from "./output-tools.js";
import { resolveCodebaseRoot } from "./project-context.js";
import { findConfigFiles } from "./output-tools.js";

/** 从接口源码文件抽取该接口函数的入参名列表（不含导出函数本身之外的其他函数）。 */
function extractParamNames(src: string, funcName: string): string[] {
  // 匹配 export const <funcName> = (params?: XxxParams) => 或 (params) =>
  const sigRe = new RegExp(
    `export\\s+const\\s+${funcName}\\s*=\\s*\\(([^)]*)\\)\\s*=>`,
  );
  const m = src.match(sigRe);
  if (!m) return [];
  const argStr = m[1].trim();
  if (!argStr) return [];
  // 参数可能是 (params?: Xxx) 或 (params) 或 (a, b)；只取第一个参数名（列表接口通常单对象参数）
  const first = argStr.split(",")[0].trim();
  const name = first.replace(/\?$/, "").replace(/:.*$/, "").trim();
  return name ? [name] : [];
}

/** 从源码抽取某个对象类型/接口的字段名集合（用于判断 params 的扁平 key 是否属于该接口契约）。 */
function extractTypeFieldNames(src: string, typeName: string): string[] {
  const re = new RegExp(
    `(interface|type)\\s+${typeName}\\s*(<[^>]*>)?\\s*=\\s*\\{`,
  );
  const m = src.match(re);
  if (!m) return [];
  const start = m.index! + m[0].length;
  let depth = 1;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = src.slice(start, i);
  const fields: string[] = [];
  const fieldRe = /^\s*([A-Za-z_$][\w$]*)\s*[\?:]/gm;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(block))) fields.push(fm[1]);
  return fields;
}

export interface CallApiGuardInput {
  operation?: string;
  path?: string;
  params?: Record<string, unknown>;
  userText: string;
  intent?: {
    target?: string;
    filters?: Array<{ field?: string; op?: string; value?: string }>;
    paging?: { wantPages?: number; wantRows?: number };
  };
}

export interface CallApiGuardResult {
  /** 阻断性错误（打回模型重填）：参数不在契约 / 声明的筛选未落地 */
  block?: string;
  /** 非阻断提示（附在结果后，供模型自查）：筛选词疑似被吞 / 枚举值疑似需翻译 */
  warn?: string;
}

/**
 * 确定性校验 call_api 调用。返回 block 则 chat.ts 把错误回传模型（MODULE_RETRY 同类机制），
 * 返回 warn 则附加提示但不阻断。
 */
export function guardCallApi(input: CallApiGuardInput): CallApiGuardResult {
  const op = String(input.operation || "").trim();
  const params = (input.params && typeof input.params === "object" ? input.params : {}) as Record<string, unknown>;
  const paramKeys = Object.keys(params);
  console.log(`[guard:call_api] op=${op} params=${JSON.stringify(params)} userText=${input.userText.slice(0, 40)}`);

  // 无 operation 无法定位接口契约 → 跳过（path 兜底场景由 chat.ts 处理）
  if (!op) return {};

  const resolved = resolveApiOperation(op);
  if (!resolved) {
    // 2026-08-26 修复：operation 无法定位到真实接口时不再静默放行。
    // 事故：模型幻觉出不存在的接口 id（如 <模块>.<子模块>.<臆造列表名>），guard 直接 return {}
    // 模型收不到任何反馈 → 反复用同一错误 operation 空转十几轮后才兜底收束。
    // 现返回 warn（非阻断提示），chat.ts 放行但把提示回传模型自查：确认真实接口 id 后重试。
    // 纯协议反馈（只谈「operation 无法定位接口」，不含任何业务词）。
    console.log(`[guard:call_api] resolved=null op=${op} → warn`);
    return {
      warn:
        `检测到 operation「${op}」无法定位到项目内任何真实接口（可能名称拼写有误或混入了不存在的模块名）。` +
        `请用 read_api_module 读取候选模块的接口源码，按函数名精确选择真实可用的接口 id（如 <模块>.<函数名>），` +
        `再重新调用 call_api；不要臆造接口名。`,
    };
  }
  console.log(`[guard:call_api] resolved=${resolved.id} file=${resolved.file} func=${resolved.func}`);

  // —— C1: 参数名是否在接口契约内（仅比 key 名，不认识语义） ——
  const src = readModuleSources(resolved.module);
  if (src) {
    const paramNames = extractParamNames(src, resolved.func);
    const contractFields = new Set<string>();
    for (const p of paramNames) {
      // 参数类型可能是 XxxParams / XxxQuery，抽该类型字段
      const typeFields = extractTypeFieldNames(src, p.charAt(0).toUpperCase() + p.slice(1) + "s");
      if (typeFields.length) typeFields.forEach((f) => contractFields.add(f));
      const bare = extractTypeFieldNames(src, p);
      if (bare.length) bare.forEach((f) => contractFields.add(f));
    }
    if (contractFields.size) {
      const unknown = paramKeys.filter((k) => !contractFields.has(k) && !isGenericParam(k));
      if (unknown.length) {
        console.log(`[guard:call_api] BLOCK PARAM_NOT_IN_CONTRACT unknown=${unknown.join(",")}`);
        return {
          block:
            `PARAM_NOT_IN_CONTRACT\n` +
            `接口 ${resolved.id} 的入参契约来自源码类型定义，未包含以下参数名：${unknown.join(", ")}。\n` +
            `请仅传入该接口接受的参数（可先 read_api_module 读取源码确认参数名），不要臆造参数。`,
        };
      }
      // —— C2: 枚举值格式校验（值疑似中文业务词但契约字段是数字/英文编码） ——
      const enumHint = buildEnumHint(resolved.module, paramKeys, params);
      if (enumHint) {
        console.log(`[guard:call_api] BLOCK ENUM_VALUE_HINT`);
        return { block: enumHint };
      }
    }

    // —— C1.5: 分页参数契约一致性校验（2026-08-26，对齐 Cursor 工具 schema 层） ——
    // 从模块对应页面表格配置提取真实分页参数名（useStandardTable fetchSetting / 默认 page+size）。
    // 当契约已知（如 page+size）而模型 params 用了非契约的分页参数名（如 pageNum/pageSize）时，
    // 返回 warn 提示改用契约名——防止弱模型猜错参数名导致接口返回全量/不分页。
    // 契约提取不到（页面未用标准表格 hook）→ 不校验不注入（宁缺毋滥）。
    try {
      const paging = extractPagingContract(resolved.module);
      if (paging) {
        const { pageField, sizeField } = paging;
        const hasAnyPagingKey = paramKeys.some((k) =>
          /^(page|pageNum|pageSize|size|current|limit|offset|pageIndex|start|end)$/i.test(k),
        );
        if (hasAnyPagingKey) {
          const hasContractKeys = paramKeys.some(
            (k) => k === pageField || k === sizeField || k.toLowerCase() === pageField.toLowerCase() || k.toLowerCase() === sizeField.toLowerCase(),
          );
          if (!hasContractKeys) {
            const srcLabel = paging.source === "explicit" ? "页面表格显式配置" : "标准表格 hook 默认";
            console.log(
              `[guard:call_api] WARN PAGING_CONTRACT_MISMATCH contract=${pageField},${sizeField} got=${paramKeys.join(",")}`,
            );
            return {
              warn:
                `PAGING_CONTRACT_MISMATCH\n` +
                `该接口对应页面表格（${srcLabel}）的真实分页参数名是 页码=${pageField}、每页条数=${sizeField}，` +
                `但你本次 params 使用了 ${paramKeys.filter((k) => /^(page|pageNum|pageSize|size|current|limit|offset|pageIndex|start|end)$/i.test(k)).join(", ")}，` +
                `与该接口契约不一致，接口可能不按这些参数名分页而返回全量数据。\n` +
                `请改用 ${pageField}+${sizeField} 作为分页参数名重新调用 call_api（如 ${JSON.stringify({
                  [pageField]: 1,
                  [sizeField]: 20,
                })}）。`,
            };
          }
        }
      }
    } catch {
      /* 契约提取异常不阻断（宁缺毋滥） */
    }
  }

  // —— A: intent.filters 声明的筛选值是否落地到 params（结构自检，不判语义） ——
  const intentFilters = input.intent?.filters;
  if (Array.isArray(intentFilters) && intentFilters.length) {
    const serialized = JSON.stringify(params);
    const missing = intentFilters.filter(
      (f) => f.value != null && f.value !== "" && !serialized.includes(String(f.value)),
    );
    if (missing.length) {
      console.log(`[guard:call_api] BLOCK FILTER_NOT_APPLIED missing=${missing.map((f) => f.value).join(",")}`);
      return {
        block:
          `FILTER_NOT_APPLIED\n` +
          `你在 intent.filters 声明了筛选条件，但其 value 未出现在 call_api 的 params 中：` +
          missing.map((f) => `${f.field || "?"} = ${f.value}`).join("；") +
          `。\n请把筛选条件作为 params 参数传入（如该字段是编码枚举，先用 get_field_mapping 查源码映射后传编码值），不要把它当作独立业务对象去另查一个模块。`,
      };
    }
  }

  // —— D: userText 筛选词轻量抽取 vs params 比对（仅警告，不阻断） ——
  const dropped = detectDroppedFilter(input.userText, params);
  if (dropped.length) {
    console.log(`[guard:call_api] WARN POSSIBLE_FILTER_DROPPED dropped=${dropped.join(";")}`);
    return {
      warn:
        `POSSIBLE_FILTER_DROPPED\n` +
        `用户原话疑似包含筛选条件，但其值未出现在 call_api 的 params 中：${dropped.join("；")}。` +
        `若确为筛选条件，请作为 params 传入后再取数；若非筛选（如属于其他语义）可忽略本提示。`,
    };
  }

  console.log(`[guard:call_api] PASS op=${op}`);
  return {};
}

/** 通用参数名白名单：分页/排序/通用契约参数不校验（跨接口通用，非业务词） */
function isGenericParam(k: string): boolean {
  return /^(page|pageNum|pageSize|size|current|limit|sort|order|orderBy|asc|desc|token|lang|country|pageIndex|pageSize_?)$/i.test(k);
}

/**
 * 从模块名定位真实源码（configs.data.tsx 列定义 + 同目录 api 文件），拼 CODEBASE_ROOT 绝对路径。
 * 返回拼接后的多文件内容（列枚举来自 configs，DTO 参数来自 api 文件）。
 * 复用 project-context 的 resolveCodebaseRoot 与 output-tools 的 findConfigFiles 路径逻辑。
 */
function readModuleSources(moduleKey: string): string | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = resolveCodebaseRoot();
    const files = findConfigFiles(moduleKey);
    const contents: string[] = [];
    for (const f of files) {
      if (fs.existsSync(f)) contents.push(fs.readFileSync(f, "utf8"));
      // 同目录下的 api 文件（含 getList 的 request DTO）
      const apiFile = path.join(path.dirname(f), "..", "api", `${moduleKey}.ts`);
      if (fs.existsSync(apiFile)) contents.push(fs.readFileSync(apiFile, "utf8"));
    }
    return contents.length ? contents.join("\n// --- file boundary ---\n") : null;
  } catch {
    return null;
  }
}

/**
 * C2: 枚举值格式校验。若某参数是中文业务词（如某个未翻译的标签），但 get_field_mapping 抽出的该字段
 * 枚举值全是数字/英文编码，则返回阻断错误并附源码映射提示（映射来自 execGetFieldMapping，不写死）。
 */
function buildEnumHint(
  moduleKey: string,
  paramKeys: string[],
  params: Record<string, unknown>,
): string | null {
  for (const k of paramKeys) {
    const v = params[k];
    if (typeof v !== "string") continue;
    // 值本身是中文或含中文业务词（非数字/非纯英文编码）→ 疑似未翻译
    if (!/^[\x00-\x7F]+$/.test(v) || /[一-龥]/.test(v)) {
      try {
        const mapping = execGetFieldMapping({ module: moduleKey });
        const parsed = JSON.parse(mapping) as { enumMap?: Record<string, Record<string, string>> };
        const em = parsed.enumMap?.[k];
        if (em && Object.keys(em).length) {
          const match = Object.entries(em).find(([, label]) => label === v || label.includes(v));
          if (match) {
            return (
              `ENUM_VALUE_HINT\n` +
              `参数 ${k} 的值「${v}」疑似未翻译为接口契约的编码值。源码枚举映射（${k}）为：` +
              JSON.stringify(em) +
              `。\n请传入编码值「${match[0]}」（如 ${k}=${match[0]}），不要直接传中文业务词。`
            );
          }
          // 值不在枚举 label 中，但字段确实是枚举 → 提示可用值
          return (
            `ENUM_VALUE_HINT\n` +
            `参数 ${k} 的值「${v}」不在接口契约枚举范围内。源码枚举（${k}）可选值为：` +
            JSON.stringify(em) +
            `。\n请传入上述编码值之一，不要直接传中文业务词。`
          );
        }
      } catch {
        /* 抽取失败不阻断，交模型自行处理 */
      }
    }
  }
  return null;
}

/**
 * D: 从 userText 轻量抽取「名词=值 / 名词(包含)值」结构（通用正则，不写死任何业务词或功能词）。
 * 仅用通用结构符号（标点/系词）做连接，不把具体中文连接词写死进正则；
 * 排除项用纯结构判定（字段提示过短/纯标点），不维护写死功能词表。返回疑似被吞的「字段提示=值」描述。
 */
function detectDroppedFilter(userText: string, params: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  // 通用连接结构：<名词><通用标点/系词:=：为是><值>；连接符仅用跨语言通用的标点与系词，不写死业务连接词
  const re = /([A-Za-z一-龥]{2,8})[:：=为是]+\s*([A-Za-z0-9一-龥]{1,12})/g;
  let m: RegExpExecArray | null;
  const serialized = JSON.stringify(params);
  while ((m = re.exec(userText))) {
    const fieldHint = m[1];
    const value = m[2];
    // 排除纯结构噪声（字段提示全为标点/空白，或长度不具语义），不写死任何功能词表
    if (!/[A-Za-z一-龥]/.test(fieldHint)) continue;
    if (value && !serialized.includes(value)) {
      dropped.push(`${fieldHint}=${value}`);
    }
  }
  // 去重
  return [...new Set(dropped)];
}
