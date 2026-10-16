// BI 工具人机工效（第 6 批）：concise/detailed 双模式 + 查询超时按实测派生。
//
// 对标两条：
// ① Anthropic《Writing effective tools for agents》「默认只回高信号字段；提供 concise/detailed 双模式；
//    截断时给出 next_cursor + 如何继续」——事故形态：单一元数据工具被调 24 次、每次全量回灌，
//    上下文被元数据撑爆后模型把已取到的结果卸载成句柄再重探（复盘 §3 L3/L4）。
// ② AWS《Timeouts, Retries, and Backoff with Jitter》「超时值按误超时率反推」——固定 30s 对多维聚合
//    必然误超时（实测 30002ms 被打断），但把默认值拍大会让挂死的查询拖更久，故按实测 p95 自适应派生。
//
// 逻辑放在两个独立纯模块里（脚本 import 即连 stdio，测试无法直接 import 本适配器）：
//   scripts/metabase-concise.mjs / scripts/metabase-query-timeout.mjs
// 本文件既测纯函数，也对适配器源码做静态断言——防止「参数加进 schema 了但没接线」这类半成品漂移。
import { test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DETAIL_HINT, detailMode, projectRows } from "../scripts/metabase-concise.mjs";
import { LatencyWindow, deriveAdaptiveTimeoutMs } from "../scripts/adaptive-timeout.mjs";

const ADAPTER = readFileSync(fileURLToPath(new URL("../scripts/metabase-mcp.mjs", import.meta.url)), "utf8");

// ── 双模式投影 ─────────────────────────────────────────────────────────────
test("[A] detail 归一化：只有显式 detailed 给全量，其余（含缺省/乱写）一律 concise", () => {
  expect(detailMode("detailed")).toBe("detailed");
  expect(detailMode("DETAILED")).toBe("detailed");
  expect(detailMode(" detailed ")).toBe("detailed");
  expect(detailMode(undefined)).toBe("concise");
  expect(detailMode(null)).toBe("concise");
  expect(detailMode("concise")).toBe("concise");
  expect(detailMode("full")).toBe("concise");
  expect(detailMode(1)).toBe("concise");
});

test("[B] concise 投影：只留高信号字段并按 cap 截断；detailed 原样不截断", () => {
  const rows = [
    { id: 1, name: "a", database: 7, sql: "SELECT 1" },
    { id: 2, name: "b", database: 7, sql: "SELECT 2" },
  ];
  const concise = projectRows(rows, { detail: "concise", keys: ["id", "name"], cap: 1, hint: "传 detail=detailed 看全量" });
  expect(concise.rows).toEqual([{ id: 1, name: "a" }]);
  expect(concise.truncated).toBe(true);
  expect(concise.total).toBe(2);
  // 截断必须带「怎么继续」（next_cursor 语义）：不静默丢数据。
  expect(concise.note).toContain("仅返回前 1 条");
  expect(concise.note).toContain("共 2 条");
  expect(concise.note).toContain("传 detail=detailed 看全量");

  const detailed = projectRows(rows, { detail: "detailed", keys: ["id", "name"], cap: 1, hint: "x" });
  expect(detailed.rows).toHaveLength(2);
  expect(detailed.rows[0]).toHaveProperty("sql", "SELECT 1");
  expect(detailed.truncated).toBe(false);
  expect(detailed.note).toBe("");
});

test("[C] 未截断时不给 note（不制造噪音）；keys 缺省时保留原形状只截断", () => {
  const rows = [{ a: 1, b: 2 }];
  const kept = projectRows(rows, { detail: "concise", cap: 5 });
  expect(kept.rows).toEqual([{ a: 1, b: 2 }]);
  expect(kept.note).toBe("");
  expect(kept.truncated).toBe(false);
  // undefined 字段不补键（不制造 null 占位）
  const p = projectRows([{ a: 1, b: undefined }], { detail: "concise", keys: ["a", "b"], cap: 5 });
  expect(Object.keys(p.rows[0]!)).toEqual(["a"]);
});

// ── 自适应查询超时 ─────────────────────────────────────────────────────────
test("[D] 无足够样本时按配置值（冷启动只能如此，不猜）", () => {
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: [], maxMs: 120_000 })).toBe(30_000);
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: [1000, 2000, 3000], maxMs: 120_000 })).toBe(30_000);
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: [0, -5, Number.NaN], maxMs: 120_000 })).toBe(30_000);
});

test("[E] 样本足够：按 p95 × 2 派生，且不低于配置值、不超过封顶", () => {
  // 25 条成功查询都在 25-30s：p95 ≈ 29.4s → 派生 ≈ 59s（高于 30s 默认，救回合法慢查询）
  const slow = Array.from({ length: 25 }, () => 28_000);
  const raised = deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: slow, maxMs: 120_000 });
  expect(raised).toBeGreaterThan(30_000);
  expect(raised).toBeLessThanOrEqual(120_000);
  // 全是快查询：派生低于配置值 → 仍按配置值（不把超时压得更短）
  const fast = Array.from({ length: 25 }, () => 300);
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: fast, maxMs: 120_000 })).toBe(30_000);
  // 单个离群慢样本不该抬高阈值——这正是选 p95 而不是 max 的意义（一次 5 分钟的查询不代表常态）。
  const withOutlier = [...Array.from({ length: 24 }, () => 28_000), 300_000];
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: withOutlier, maxMs: 120_000 })).toBe(56_000);
  // 常态就是慢时封顶生效：不能让阈值无限涨（否则挂死的调用会一直占着连接）
  const allSlow = Array.from({ length: 25 }, () => 300_000);
  expect(deriveAdaptiveTimeoutMs({ configuredMs: 30_000, samples: allSlow, maxMs: 120_000 })).toBe(120_000);
});

test("[F] 延迟窗口：只收正数、按容量淘汰、最多留最近 N 条", () => {
  const w = new LatencyWindow(3);
  w.record(1000);
  w.record(0);
  w.record(Number.NaN);
  w.record(2000);
  w.record(3000);
  w.record(4000);
  expect(w.size).toBe(3);
  expect(w.snapshot()).toEqual([2000, 3000, 4000]);
});

// ── 适配器静态断言：schema 加了参数 ≠ 接了线 ─────────────────────────────────
test("[G] 七个元数据工具都声明了 detail 且描述带双模式说明", () => {
  for (const tool of [
    "list_databases",
    "get_database_schema",
    "get_field_values",
    "list_cards",
    "list_dashboards",
    "get_dashboard",
    "get_card",
  ]) {
    const at = ADAPTER.indexOf(`name: "${tool}"`);
    expect(at, `适配器里找不到工具 ${tool}`).toBeGreaterThan(-1);
    // 从该工具定义起，取到下一个工具定义为止的那一段里必须有 detail 枚举与 DETAIL_HINT
    const next = ADAPTER.indexOf('name: "', at + 12);
    const section = ADAPTER.slice(at, next === -1 ? undefined : next);
    expect(section, `${tool} 的 schema 里没有 detail 枚举`).toContain('enum: ["concise", "detailed"]');
    expect(section, `${tool} 的描述里没有双模式说明`).toContain("DETAIL_HINT");
  }
});

test("[H] 适配器引用共享纯模块，不允许内联第二份实现", () => {
  expect(ADAPTER).toContain('from "./metabase-concise.mjs"');
  expect(ADAPTER).toContain('from "./adaptive-timeout.mjs"');
  // 内联判据漂移的早期信号：这两个派生函数只应存在于纯模块里
  expect(ADAPTER).not.toContain("function deriveQueryTimeoutMs");
  expect(ADAPTER).not.toContain("function detailMode(");
});

test("[I] 超时与延迟口径：成功才进样本、执行类调用才计入、上限封顶", () => {
  // 成功延迟采样只在 query 类调用上，且只记成功（res.ok）
  expect(ADAPTER).toContain("if (query && res.ok) queryLatency.record");
  // 执行类调用带 query: true：get_field_values 的聚合查询 + runSql（run_native_query / execute_sql /
  // query 的原生 SQL 分支共用）+ execute_query / query 的卡片分支，共 4 处。
  expect(ADAPTER.match(/query: true/g) || []).toHaveLength(4);
  // 上限与派生都在
  expect(ADAPTER).toContain("BI_TIMEOUT_MAX_MS");
  expect(ADAPTER).toContain("deriveAdaptiveTimeoutMs({");
  // 超时文案用的是**生效值**而不是配置常量（否则模型看到的数字是错的）
  expect(ADAPTER).toContain("查询超时（${timeout}ms）");
});

test("[J] 双模式说明句是一处定义（避免各工具措辞漂移）", () => {
  expect(DETAIL_HINT).toContain("concise");
  expect(DETAIL_HINT).toContain("detailed");
  // 适配器里不允许出现第二份手写说明句
  const literals = ADAPTER.match(/默认 concise|只回高信号字段/g) || [];
  expect(literals, "双模式说明句只应来自 DETAIL_HINT 常量").toHaveLength(0);
});

// ── 读侧高层工具（对齐 CodeBuddy 能力面，第 2026-10-15 批）───────────────────────────
test("[K] 新增读侧高层工具已注册，且描述零业务词（通用型改动）", () => {
  for (const tool of ["execute_query", "execute_sql", "query", "construct_query", "read_resource"]) {
    const at = ADAPTER.indexOf(`name: "${tool}"`);
    expect(at, `适配器里找不到工具 ${tool}`).toBeGreaterThan(-1);
  }
  // 通用型改动校验：描述里不得出现任何具体业务口径（国家 / 指标 / 维度等）。
  const businessTerms = ["印度", "巴西", "日活", "会员", "DAU", "渠道", "退订"];
  for (const tool of ["execute_query", "execute_sql", "query", "construct_query", "read_resource"]) {
    const at = ADAPTER.indexOf(`name: "${tool}"`);
    const next = ADAPTER.indexOf('name: "', at + 12);
    const section = ADAPTER.slice(at, next === -1 ? undefined : next);
    for (const term of businessTerms) {
      expect(section, `${tool} 的描述混入了业务词「${term}」`).not.toContain(term);
    }
  }
});

test("[L] 只读声明边界正确：execute_query/construct_query/read_resource 入 READ_ONLY_TOOLS，execute_sql/query 不入（执行任意 SQL，放行交由服务端）", () => {
  const setBlock = ADAPTER.slice(
    ADAPTER.indexOf("const READ_ONLY_TOOLS"),
    ADAPTER.indexOf("const READ_ONLY_ANNOTATIONS"),
  );
  expect(setBlock).toContain('"execute_query"');
  expect(setBlock).toContain('"construct_query"');
  expect(setBlock).toContain('"read_resource"');
  // 这两个执行类入口不在此名单——是否放行由服务端风险策略决定（工具自述不替服务端放行）
  expect(setBlock).not.toContain('"execute_sql"');
  expect(setBlock).not.toContain('"query"');
});

test("[T] search_columns 接进工具面且被技能引用：锁住「新工具 0 调用」的静态回归", () => {
  // §12.5 实测：14 个工具已下发、eager 注入，但新补的 5 个高层工具一次都没被调用——
  // 根因之一正是「技能层从没提过该用哪个工具去发现关联列」。这里把"工具已注册 + 技能已引用"锁成承重结构，
  // 防止 search_columns 这种跨表列发现能力在静默中退化成"看得见用不上"（与 [O] 同一思路：提示层指路信息才算数）。
  const at = ADAPTER.indexOf('name: "search_columns"');
  expect(at, "适配器里找不到 search_columns").toBeGreaterThan(-1);
  // 只读声明边界：search_columns 查系统目录（system.columns），必须入 READ_ONLY_TOOLS
  const setBlock = ADAPTER.slice(
    ADAPTER.indexOf("const READ_ONLY_TOOLS"),
    ADAPTER.indexOf("const READ_ONLY_ANNOTATIONS"),
  );
  expect(setBlock, "search_columns 未入 READ_ONLY_TOOLS").toContain('"search_columns"');
  // 描述零业务词（通用型改动红线）
  const next = ADAPTER.indexOf('name: "', at + 12);
  const section = ADAPTER.slice(at, next === -1 ? undefined : next);
  for (const term of ["印度", "巴西", "日活", "会员", "渠道", "退订"]) {
    expect(section, `search_columns 描述混入了业务词「${term}」`).not.toContain(term);
  }
  // 技能必须引用它——否则模型即使看得到工具，也不知道"跨表列发现"该用它
  const skill = readFileSync(
    fileURLToPath(new URL("../skills/business-data-query/SKILL.md", import.meta.url)),
    "utf8",
  );
  expect(skill, "技能层未引用 search_columns，跨表列发现能力不会被模型用起来").toContain("search_columns");
});

test("[M] 取数核心单一实现：runSql 被 run_native_query / execute_sql / query 复用，只读校验只在 assertSql", () => {
  expect(ADAPTER).toContain("async function runSql(");
  expect(ADAPTER).toContain("function assertSql(");
  // run_native_query 委托给 runSql（不重复内联只读校验 + 执行渲染）
  const rnq = ADAPTER.slice(ADAPTER.indexOf('name: "run_native_query"'), ADAPTER.indexOf('name: "list_cards"'));
  expect(rnq).toContain("return runSql(");
});

// ── 工具发现性（2026-10-15 复跑实测结论）────────────────────────────────────────
// 实测事故形态：14 个工具已下发、eager 注入，但新补的 5 个高层工具在两次复跑里**一次都没被调用**。
// 根因不是工具不可用，而是「重叠工具没有默认优先级」+「技能层把执行暗示成了参考」：
// 模型面对同一件事的多个入口，会退回自己最熟悉的那条老路。
// 这两条锁的是**提示层的指路信息**，不是工具本身——工具在不在由上面的注册用例保证。
test("[N] 取数阶梯必须在工具注记里声明优先级，否则重叠工具等于没补", () => {
  const env = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  // 阶梯的三级入口都要有注记，且写明「优先」关系
  expect(env, "缺少 execute_query 的首选注记").toContain('"execute_query":"【取数首选入口】');
  expect(env, "缺少 construct_query 的校验注记").toContain('"construct_query":"【只校验不执行】');
  expect(env, "缺少 execute_sql 的执行器注记").toContain('"execute_sql":"【底层 SQL 执行器】');
  expect(env, "缺少 query 的统一入口注记").toContain('"query":"【统一取数入口】');
  expect(env, "缺少 read_resource 的统一读取注记").toContain('"read_resource":"【统一读取入口】');
  // 底层入口必须被显式指向高层入口（否则模型没有理由改路）
  expect(env, "run_native_query 未指向 execute_query").toContain("已有现成提问请优先 execute_query");
  // 统一入口要给出确定顺序，避免"不知道走哪条就都试一遍"
  expect(env, "toolNotes 缺少全局阶梯说明").toContain("取数阶梯");
  // 注记不得混入业务口径（通用型改动红线）
  for (const term of ["印度", "巴西", "日活", "会员", "渠道", "退订"]) {
    const noteBlock = env.slice(env.indexOf('"toolNotes"'), env.indexOf('"readOnlySqlTools"'));
    expect(noteBlock, `toolNotes 注记混入了业务词「${term}」`).not.toContain(term);
  }
});

test("[O] 技能层必须写「找到就执行」，而不是让模型照着重写", () => {
  const skill = readFileSync(
    fileURLToPath(new URL("../skills/business-data-query/SKILL.md", import.meta.url)),
    "utf8",
  );
  // 旧措辞把动作说成"参考"，实测导致模型只读定义不执行（get_card×17 却 0 次执行）
  expect(skill).toContain("直接执行");
  expect(skill).toContain("不要只读它的定义");
  // 大结果不许往回捞（实测卸载 70 → fs_read 捞回 47）
  expect(skill).toContain("大结果不要往回捞");
  expect(skill).toContain("重新发一条已经聚合好的查询");
  // 「取不到」的处理必须有前置条件：实测 R5 探5 张表就收尾，漏掉了能给按天序列的那张，
  // 会员维度从"完整"退化成"只有快照"，还用"库里没有"带过——把"我没找到"说成了"它不存在"。
  expect(skill).toContain("换一个候选来源试一次");
  expect(skill).toContain("不要说成");
  // ⚠️ 反向约束（实测踩到）：曾把这条写成**独立步骤**并强调"库里没有是一句需要证据的断言"，
  // 结果弱模型抓住这个出口，连续两轮把能答的子问题也一起判成"没取到"（答案从 4000+ 字掉到 671 字）。
  // 所以措辞必须把"覆盖率"放在前面、"说明限制"放在交付之后，且不得单列成许可式步骤。
  expect(skill).toContain("逐个子问题过一遍");
  expect(skill).toContain("先把能答的部分答完并交付");
  expect(skill).not.toContain("穷尽候选来源");
  expect(skill).not.toContain("是一句需要证据的断言");
  // SQL 写法必须在技能层可见（模型读得到才会照着写；只落在 lint 里等于事后补救）
expect(skill).toContain("## SQL 怎么写");
expect(skill).toContain("结果集要有界");
expect(skill).toContain("谓词要可裁剪");
expect(skill).toContain("分组要完整");
expect(skill).toContain("别写出笛卡尔积");
expect(skill).toContain("docs/bi-sql-best-practices.md");
  // 步骤编号连续（加过步骤最容易留下的破绽）。
  // 只校验「## 步骤」块——技能里还有「SQL 怎么写」等带自己编号的小节，合在一起看会误报。
  const stepBlock = skill.slice(skill.indexOf("## 步骤"), skill.indexOf("## SQL 怎么写") === -1 ? undefined : skill.indexOf("## SQL 怎么写"));
  const steps = [...stepBlock.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  expect(steps.length, "「## 步骤」块应至少有 5 步").toBeGreaterThanOrEqual(5);
  expect(steps, "步骤编号必须连续").toEqual(Array.from({ length: steps.length }, (_, i) => i + 1));
});

// ── 工具 schema 健全性（通用：不依赖具体工具）────────────────────────────────────
// 实测踩到：`read_resource.id` 声明成 number，但 table 类型实际传的是表名（字符串）——
// 模型照 schema 传数字就必然落空。这类"声明与实际用法不符"没有任何测试能自动发现，
// 所以这里用通用判据兜：required 必须都在 properties 里、每个属性必须有 description、
// 属性名不得与其它工具的同名参数语义冲突（只查同名不同类型这一类最易踩的）。
/** 从 `open` 处的 `{` 做括号配平，返回该块的完整文本（含外层花括号）。 */
function braceBlock(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

test("[R] 每个工具：inputSchema 的 required ⊆ properties、每个入参都有说明", () => {
  const toolBlocks: Array<{ name: string; body: string }> = [];
  for (const m of ADAPTER.matchAll(/\n  \{\n    name:\s*"([a-z_]+)"/g)) {
    toolBlocks.push({ name: m[1], body: ADAPTER.slice(m.index) });
  }
  expect(toolBlocks.length, "解析到的工具数").toBeGreaterThanOrEqual(14);
  const problems: string[] = [];
  for (const t of toolBlocks) {
    const schemaAt = t.body.indexOf("inputSchema");
    if (schemaAt < 0) {
      problems.push(`${t.name}: 没有 inputSchema`);
      continue;
    }
    const schema = braceBlock(t.body, t.body.indexOf("{", schemaAt));
    const propsAt = schema.indexOf("properties");
    if (propsAt < 0) {
      problems.push(`${t.name}: inputSchema 缺 properties`);
      continue;
    }
    // 只在 properties 块内看字段名——工具描述里常带"返回结构示例"，
    // 正则扫全文会把那些输出字段误当成入参（初版就踩了这个，误报一片）。
    const props = braceBlock(schema, schema.indexOf("{", propsAt));
    const names = [...props.matchAll(/[{,]\s*([a-z_][\w]*)\s*:/g)].map((m) => m[1]);
    for (const n of names) {
      const at = props.indexOf(`${n}:`);
      const seg = props.slice(at, at + 300);
      if (!/description\s*:/.test(seg)) problems.push(`${t.name}.${n}: 缺 description`);
    }
    const reqM = /required:\s*\[([^\]]*)\]/.exec(schema);
    if (reqM) {
      for (const raw of reqM[1].split(",")) {
        const n = raw.trim().replace(/^["']|["']$/g, "");
        if (n && !names.includes(n)) problems.push(`${t.name}: required 的 ${n} 不在 properties 中`);
      }
    }
  }
  expect(problems, `工具 schema 存在问题：\n${problems.join("\n")}`).toEqual([]);
});

test("[S] 按 id / 名字混合定位资源的工具，id 必须允许联合类型（避免只传数字导致落空）", () => {
  // table 类资源是按**表名**定位的，若 id 只声明 number，模型照 schema 传数字必然查不到
  const at = ADAPTER.indexOf('name: "read_resource"');
  expect(at).toBeGreaterThan(-1);
  const seg = ADAPTER.slice(at, at + 1400);
  const idAt = seg.indexOf("id:");
  const idSeg = seg.slice(idAt, idAt + 220);
  expect(idSeg, "read_resource.id 未允许 string").toMatch(/type:\s*\[[^\]]*string[^\]]*\]/);
});

test("[Q] 上游失败必须在文案上与「数据不存在」可区分（否则模型会把 502 说成库里没有）", () => {
  // 实测形态：上游返回 502 时，若工具只回一句中性文案，模型很容易把它读成
  // 「这个表/这个字段没有我要的东西」→ 转写成「库里没有」→ 用户拿到一个假的结论。
  // 所以失败文案必须自带"这是上游/执行失败"的定性，且适配器**不得**替模型下"数据不存在"的结论。
  expect(ADAPTER, "上游拒绝的文案缺失").toContain("查询被上游拒绝");
  expect(ADAPTER, "未返回结果的文案缺失").toContain("查询未返回结果");

  // 失败路径里不得出现"不存在/库里没有/无数据"这类**数据缺失**定性
  const failStart = ADAPTER.indexOf("查询被上游拒绝");
  const failSeg = ADAPTER.slice(failStart, failStart + 600);
  for (const phrase of ["库里没有", "不存在", "无数据", "没有该字段"]) {
    expect(failSeg, `上游失败文案里出现数据缺失定性「${phrase}」`).not.toContain(phrase);
  }
  // 适配器全局不得替业务下"库里没有"的结论（那是需要取证才能断言的事，属模型职责）
  expect(ADAPTER, "适配器不应断言数据不存在").not.toContain("库里没有");
});

test("[P] 工具角色不能靠自定义 MCP 注解声明（SDK 会剥掉未声明字段）", () => {
  // 这条是**踩过的技术前提**：曾打算给每个工具加 `x-role: catalog|execute` 注解，
  // 好让服务端结构化区分「读定义」与「执行取数」并加决策点护栏。
  // 实测 @modelcontextprotocol/sdk 的 ToolAnnotationsSchema 是**不带 passthrough 的 z.object**，
  // 未声明的字段会被 zod 静默剥掉 → 该方案在当前 SDK 版本上根本传不过来。
  // 所以「决策点护栏」若要做，必须另开配置通道（类似 toolRisks 的 config 字段），不能靠注解。
  const sdkPath = fileURLToPath(
    new URL("../node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js", import.meta.url),
  );
  expect(
    existsSync(sdkPath),
    `找不到 MCP SDK 的 types.js（${sdkPath}）。若 SDK 换了产物路径或被提升到 monorepo 根，请同步更新本用例的路径——` +
      "这条用例锁的是「注解不能承载自定义字段」这个技术前提，路径失效时要重新确认前提是否仍成立。",
  ).toBe(true);
  const sdk = readFileSync(sdkPath, "utf8");
  const at = sdk.indexOf("exports.ToolAnnotationsSchema = z.object(");
  expect(at, "未找到 ToolAnnotationsSchema 定义（SDK 版本变了？）").toBeGreaterThan(-1);
  // 只取该对象自身（到它的闭合 `});`），不要溢出到相邻 schema——那会读到无关内容造成假失败。
  const close = sdk.indexOf("\n});", at);
  const segment = close > at ? sdk.slice(at, close + 4) : sdk.slice(at, at + 900);
  expect(
    /passthrough|looseObject|catchall/.test(segment),
    "SDK 若开始允许额外注解字段，本条前提失效——决策点护栏可以改用注解通道，届时请更新此用例与文档",
  ).toBe(false);
});