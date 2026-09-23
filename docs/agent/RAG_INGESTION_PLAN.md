# RAG 知识入库方案（200+ 文档 + PDF + 网页链接）

> 建立时间：2026-08-22（原计划）；2026-09-17 落地解析器注册表；本版（2026-09-23）按实际代码 `src/rag/*` 重写对齐。
> 关联代码：`apps/agent-server/src/rag/parsers.ts` / `store.ts` / `embedding.ts`、`apps/agent-server/scripts/build-rag-index.mjs`
> 状态：P0 解析器注册表已落地；分阶段方案见 §6。

## 0. 一句话结论

企业内部文档（md/txt/html/pdf/docx/xlsx）**本地目录批量入库**已跑通：扫描 `docs/knowledge/**` → 按扩展名分发解析 → 切片 → 词法 TF-IDF + 可选向量（RRF 融合）→ 模型经 `search_knowledge` / `knowledge_sources` 工具自主调用，答案带 `source`/`title`/`score`。现阶段**不引入独立向量库**（见 §4）。

## 1. 现状（已落地能力）

| 能力 | 现状 | 位置 |
|---|---|---|
| md/txt/html 扫描入库 | ✅ 零依赖内置解析 | `parsers.ts` |
| pdf 文本提取 | ✅ `unpdf`（可选依赖） | `parsers.ts:parsePdf` |
| docx 解析 | ✅ `mammoth`（可选依赖） | `parsers.ts:parseDocx` |
| xlsx/xlsm 解析 | ✅ `exceljs`（可选依赖） | `parsers.ts:parseXlsx` |
| 增量索引 | ✅ md5 内容指纹 | `build-rag-index.mjs` / `store.ts` |
| 语义向量检索 | ✅ `KB_EMBEDDING=on` 复用 TokenHub embedding，off 自动降级词法 | `embedding.ts` |
| 网页链接抓取 | 🟡 仅当次会话注入、不入库 | 旧 `sources.ts` |
| 钉钉文档拉取 | ❌ 等管理员凭证 | 挂账 |

## 2. 解析器注册表（P0 核心，`src/rag/parsers.ts`）

设计要点：**加格式只装依赖、不改代码**。

### 2.1 按扩展名分发

```
parseFile(absPath)
  ├─ 不支持扩展名            → { error: "不支持的格式：<ext>" }   （不抛异常）
  ├─ 读取失败                → { error: "读取失败：<msg>" }
  ├─ 二进制嗅探命中          → { error: "疑似二进制文件，已跳过" }  （禁止 utf8 直读）
  └─ 按扩展名路由解析：
       .md/.markdown/.txt/.csv/.log/.json/.yaml/.yml/.ini/.conf  → 直接 readFileSync utf8
       .html/.htm/.xhtml      → stripHtml（去 script/style/标签）
       .pdf                  → parsePdf（unpdf，可选依赖）
       .docx                 → parseDocx（mammoth，可选依赖）
       .xlsx/.xlsm           → parseXlsx（exceljs，可选依赖，按 sheet/行转「值 | 值」带表头）
```

### 2.2 可选依赖：装了就用，没装如实报错

`unpdf` / `mammoth` / `exceljs` 通过 `loadOptional(pkg)` 动态 `import()` 加载（specifier 用变量，避免 TS 对未装模块静态解析失败）。未安装时返回**可展示的错误**（如「未安装 pdf 解析器（pnpm add unpdf 后即可入库）」），**绝不静默跳过或假装解析成功**。

导出函数：
- `isSupportedExt(ext)` —— 是否支持该扩展名（pdf/docx/xlsx 仍要再查依赖是否装）。
- `optionalDepInstalled(pkg)` —— 同步探测包能否解析到。
- `looksBinary(buf)` —— 前 4KB 嗅探 NUL 字节 / 控制字符比例 > 0.3 即判二进制（pdf/docx/xlsx 本身压缩形态不走此嗅探，交给各自解析器）。
- `stripHtml(html)` / `titleOf(text, fallback)` —— HTML 清洗、标题提取（首个 md/HTML 标题优先，回退文件名）。
- `parseFile(absPath)` —— 统一入口，返回 `ParsedDoc { title, text }` 或 `{ error }`，**解析器抛异常也被捕获转为 error，不穿透中断批处理**。

### 2.3 契约边界

- 单个文件解析失败只计入 `failures`，**不影响整次入库**（已踩坑：损坏 pdf 曾让整批崩）。
- 返回 `error` 的条目由 `build-rag-index.mjs` 打印 `[rag] 跳过 <rel>：<error>`。

## 3. 入库脚本（`scripts/build-rag-index.mjs`）

```
node --import tsx scripts/build-rag-index.mjs [目录] [--full] [--namespace movie]
```

默认目录仓库根 `docs/knowledge`；`--full` 忽略指纹全量重建；`--namespace` 按角色隔离语料（默认 `generic`）。

行为：
- 递归 `walk`（跳过隐藏目录/文件、`node_modules`），只收 `isSupportedExt` 命中的文件。
- 未变更（md5 相同）→ 跳过；变更 → 先 `removeSource` 清旧切片再 `ingest` 重建（防残留污染）。
- 磁盘已删除的来源 → `listSources` 比对后清理索引残留。
- 末尾打印新增/更新、未变更、失败、清理条数与索引规模（切片/来源/向量）。

## 4. 向量库选型结论（不变）

**现阶段不引入独立向量库**：规模小（几十~1 万 chunk），`.vectors.json` 文件索引 + RRF 融合毫秒级；单进程免运维。触发阈值（chunk > 5~10 万 / 多实例并发写 / 权限过滤 / 增量常态化）后首选 Qdrant。

## 5. 仍缺 / 待定

| 项 | 说明 |
|---|---|
| 权限过滤 | 检索不看用户权限，M4 多租户时补 |
| Top-K 模型重排 | 当前仅 RRF 融合，无 cross-encoder 重排 |
| 引用渲染 | 来源目前是文本，非可点击链接 |
| MCP resources 入库 | 旧版有，当前只做本地目录 |
| 扫描件 PDF OCR | 文本型已支持；图片型 unpdf 提取为空 → 如实报「可能是扫描件」并跳过 |
| 网页链接入库 | 普通网页正文抓取 + 摹客RP 走「导出 PDF/HTML → 本地通道」（不实时抓取） |
| 回归测试 | `parsers.ts` 当前**无单元测试**（`tests/` 未含）；建议补 `rag-parser.test.ts` 覆盖各扩展名 + 降级路径 |

## 6. 分阶段实施（细化，2026-09-01 全网调研）

| 阶段 | 内容 | 优先级 | 状态 |
|---|---|---|---|
| 1 | 解析器注册表：md/txt/html + pdf/docx/xlsx 接入扫描 | P0 | ✅ 已落地 |
| 2 | 分块策略升级：结构感知递归切分（标题→段落→句子）+ 重叠；表格整块带表头 | P0.5 | 🟡 待做 |
| 3 | 检索增强：大模型 Rerank（Top-20 → 精排 5）；元数据过滤 | P1 | 🟡 待做 |
| 4 | 评估体系：50-100 题评测集 + verify 脚本跑分基线 | P1 必做 | 🟡 待做 |
| 5 | 增量索引：md5 指纹（已实现基础版） | P1 | ✅ 基础版 |
| 6 | 网页链接入库 | P2 | ❌ |
| 挂账 | 钉钉文档拉取（等管理员凭证）；权限过滤 | - | ❌ |

执行顺序：阶段 1 → 2 → 4（建基线）→ 3 → 5 → 6。

## 7. 依赖清单（已装）

`apps/agent-server/package.json`：`exceljs` / `unpdf` / `mammoth` 均已在 dependencies（解析侧使用）；生成侧（docx 页面生成，见 `artifact-delivery-plan.md`）不依赖它们。

## 8. 运行 / 回归

- 入库：`node --import tsx scripts/build-rag-index.mjs docs/knowledge`
- 检索：经 `search_knowledge` 工具（只读、工具模式注入）。
- 注意：入库脚本是**独立进程**，新文档入库后服务无需重启即可被检索（索引按 mtime 失效重载）。
