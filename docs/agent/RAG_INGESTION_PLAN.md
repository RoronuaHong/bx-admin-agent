# RAG 知识入库方案（200+ 文档 + PDF + 摹客RP 链接）

> 建立时间：2026-08-22
> 关联模块：`apps/agent-server/src/tools/knowledge-base.ts`、`knowledge-embedding.ts`、`scripts/build-knowledge-index.mjs`
> 状态：方案已定，待实施（P0 未开始）

## 1. 背景与目标

让用户在 bx-admin-agent 的 /chat 聊天框用自然语言查询企业内部文档。当前知识库（docs/knowledge/）仅有 6 篇 md 示例，需扩展为三类真实来源：

| 来源 | 规模 | 形态 |
|---|---|---|
| 企业内部文档 | 200+ 篇 | md/txt/docx/xlsx/csv/html 混合 |
| PDF | 若干 | 文本型为主，可能有扫描件 |
| 网页链接 | 若干 | 主要为摹客RP（Mockplus）原型分享链接 |

## 2. 现状盘点（已有能力）

| 能力 | 现状 |
|---|---|
| md/txt/html 扫描入库 | ✅ knowledge-base.ts 已支持（分段 + embedding + RRF 检索） |
| PDF 文本提取 | 🟡 unpdf 已装，未接进知识库扫描 |
| 网页链接抓取 | 🟡 sources.ts 有 http/https 正文提取，仅当次会话注入、不入库 |
| xlsx 解析 | ✅ exceljs 已装 |
| docx 解析 | ❌ 无 mammoth，需新增依赖 |
| 图片 OCR | ✅ vision.ts 有转录能力（远程视觉 + ollama 兜底） |

## 3. 来源与方案

### 3.1 200+ 文档（P0 主体）

核心动作：把 `walkDir` 从「只认 md/txt/html」升级为**按扩展名分发的解析器注册表**：

```
walkDir → 按扩展名路由
  ├─ .md/.txt/.html  → 现有逻辑直接读
  ├─ .docx           → mammoth 转文本（需新增依赖，纯 JS）
  ├─ .xlsx/.csv      → exceljs 转表格文本（已装）
  ├─ .pdf            → unpdf 提取文本（已装）
  └─ 其他            → 跳过并记录
```

要点：
- 文档统一落盘到 `docs/knowledge/`（或配置目录），批量入库零手工
- ⚠️ docx/xlsx 是二进制，现有 `readFileSync utf8` 直接读会乱码，必须走解析器
- 增量索引见 P1

### 3.2 PDF

- **文本型 PDF**：unpdf 提取 → 走同一套分段 + embedding，零成本
- **扫描件/图片型 PDF**：unpdf 提取不到文字，需 OCR。两条路：
  - 远程视觉模型转录（复用 vision.ts，但 200 篇成本不低）
  - 本地 tesseract.js（慢但免费）
- 建议：先支持文本型，扫描件标记「需 OCR」待定，不做首期

### 3.3 网页链接（摹客RP）——不实时抓取

摹客RP（Mockplus）分享链接是 **SPA 动态渲染 + 通常要登录态**，HTTP 抓 HTML 拿不到内容；且原型是**画布图形，文本密度极低**，RAG 价值有限。

决策：**不做实时抓取**，作为「文档 → 链接」元数据入库（检索结果返回链接引用）。可选路径：

| 路径 | 做法 | 评价 |
|---|---|---|
| A. 导出落盘（推荐） | Mockplus 内导出核心原型为 PDF/HTML → 走本地文件通道 | 质量最高，需人工，适合核心原型 |
| B. Headless 抓取 | Playwright / Chrome DevTools MCP 渲染 + 登录态 | 自动化但脆弱，文本质量差，仅按需 |
| C. 摹客开放 API | 需企业管理员凭证 | 短期走不通（同钉钉凭证阻塞） |

## 4. 向量数据库选型结论

**现阶段：不引入独立向量数据库。**

理由：
1. 规模小（几十到 1 万 chunk），暴力余弦扫描毫秒级，现有 `.vectors.json` 文件索引 + RRF 融合足够
2. EC2 + PM2 单进程，新增常驻服务 = 新增运维负担，与「轻量、可回退、零依赖」设计哲学冲突
3. 现有链路（chunking → embedding → 检索 → 引用回填）已闭环，缺的不是存储

**未来上向量数据库的触发阈值**：

| 触发信号 | 说明 |
|---|---|
| chunk 量 > 5~10 万 | 暴力扫描变慢，需 ANN（HNSW） |
| 多进程/多实例并发写 | 文件索引有写冲突 |
| 需要权限过滤/多租户 | 文件方案难做细粒度过滤 |
| 增量同步常态化（如钉钉拉取） | 全量重建成本高 |

**届时选型排序**：
1. **Qdrant**（首选）：单 Docker 容器，资源占用小，社区版无阉割，1024 维 HNSW 支持，LangChain 有集成
2. **MongoDB Atlas Vector Search**：已有 mongodb 依赖；⚠️ 自托管社区版**无 $vectorSearch**（Atlas 专有）
3. **腾讯云向量数据库**：embedding 已走腾讯云 TokenHub，生态顺延
4. **pgvector**：仅当已有 PostgreSQL

不建议：Milvus / Weaviate / Elasticsearch（对当前规模过度设计）。

**真正提升 RAG 质量的优先项**（替代换存储）：增量索引、rerank（大模型重排 Top-K）、chunk 大小调优。

## 5. 实施计划

| 优先级 | 内容 | 涉及 |
|---|---|---|
| P0 | 解析器注册表：md/txt/html + pdf + xlsx + docx 接入扫描 | knowledge-base.ts walkDir + 新增解析模块；package.json 加 mammoth |
| P1 | 增量索引：md5/ctime 指纹，只重建变更文档的 chunk 与向量 | buildIndex / buildVectors |
| P2 | 网页链接入库工具（普通网页正文抓取；摹客RP 按需方案 B） | 新增 link-ingest |
| 挂账 | 钉钉文档拉取（等管理员凭证）、权限过滤 | 同 memory 73540172 |

## 6. 风险与待定

- docx 批量转换耗时与内存（200+ 篇），需分批
- 扫描件 PDF 的 OCR 方案待定（成本 vs 覆盖）
- 摹客RP 是否需要人工导出核心原型，待业务确认
- 200+ 文档的实际格式分布未盘点，P0 实施前先做一次文件类型清点

## 7. Qdrant 练手记录（2026-08-22，已跑通）

目的：为「未来可能上向量数据库」预演，选型即生产首选 Qdrant。

**环境**：
- Docker 容器 `qdrant-practice`（镜像 `qdrant/qdrant:latest`，REST 6333 / gRPC 6334，数据卷 `qdrant_practice_data`）
- 练手脚本 `apps/agent-server/scripts/qdrant-practice.mjs`（零新依赖，原生 fetch 调 REST，顺带练 REST API）
- 运行：`cd apps/agent-server && .\node_modules\.bin\tsx.cmd scripts/qdrant-practice.mjs [query]`
  （⚠️ PowerShell 传中文参数会乱码，用默认 query 或改 `process.argv`）

**演示内容**（对应脚本步骤）：
1. 建 collection `kb-practice`（1024 维 / Cosine / HNSW m=16 ef_construct=100）
2. 把 docs/knowledge 的 18 个 chunk + 向量 upsert（复用 `.index.json` + `.vectors.json`）
3. 语义检索：query 向量化 → search
4. payload filter：按 `tags=人事` 过滤后检索
5. 与现方案（RRF 融合）结果对比
6. collection 状态 / HNSW 索引信息

**实测结果**：query「上班迟到了会扣钱吗」Qdrant top1=考勤制度（score 0.4981），与现方案 RRF top1 一致——验证了「数据量小时换库不换结果」，当前规模无需引入向量库。

**清理**：`docker rm -f qdrant-practice`；重建 collection：`DELETE /collections/kb-practice` 后重跑脚本。
