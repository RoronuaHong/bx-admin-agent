# 产物交付与文件生成方案（Excel / CSV / PDF 等）

> 版本：v1（2026-09-22）
> 定位：解决「让 agent 生成 excel / pdf 等文件」的**交付断链**；给出「内置工具 vs 技能（Skill）」的形态判定准则与分档落地清单。
> 相关：`apps/agent-server/src/builtins.ts`、`fs-store.ts`、`app.ts`、`chat.ts`、`conversations.ts`、`packages/shared/src/index.ts`、`apps/web/src/pages/ChatPage.vue`、`apps/agent-server/skills/`、`docs/deep-agents-plan.md` §5 D5（代码执行沙箱）、`docs/chart-visualization-plan.md`（图表已落地的同族问题）。

**当前状态**

| 项 | 内容 | 状态 |
|---|---|---|
| 1 | 问题定性与断链核查（§1 / §2） | ✅ 已完成 |
| 2 | 形态判定准则（内置 / MCP / Skill / 定时任务） | ✅ 已完成（§4） |
| 3 | P0 产物交付闭环（导出工具 + 下载端点 + `file` 事件 + 下载卡片） | ✅ 已落地（`export_data`：xlsx/csv/json/md） |
| 4 | P1 工具面补齐（`fs_delete` / 上传入工作区 / 定时任务工具化） | ⬜ 待实施 |
| 5 | P2 `run_script`（受控代码执行）/ `image_gen` | 🟡 暂缓，见 §6 论证 |
| 6 | v2 格式扩展（PDF / Word / HTML / TXT，§10） | ✅ 已落地（2026-09-23，见 §10.7） |
| 7 | v2.1 报告式导出交付断链修复（零表格报告 + fs_write 下载卡片，§11） | ✅ 已落地（2026-09-24，见 §11.4） |

---

## 0. 一句话结论

服务端**能写文本文件，但没有任何产物出口**：工作区只支持 UTF-8 文本、没有二进制写、没有下载端点、前端只有纯文本预览。所以「生成 excel」这类需求必然退化为「写一个 `.csv` + 一句『可直接用 Excel 打开』」——**用户实际拿不到文件**。

落地结论：

1. **数据类产物（csv / xlsx / json / md）走内置工具**：新增一个通用导出工具（`export_data`），模型只给行数据，格式由服务端确定性生成（`exceljs` 仓库已装）；
2. **格式规范类知识走 Skill**：多 sheet 拆分、表头、列宽、数字/日期格式、单元格格式策略写进技能说明，按需加载，**不为每种文件格式各建一个工具**；
3. **交付通道必须补齐**：下载端点 + `file` 事件 + 前端下载卡片，三段缺一不可（对齐 CodeBuddy 里「文件即产物」的对等物）；
4. **通用 shell / 代码执行暂不给**（§6）：产物需求可枚举，而无沙箱的任意代码执行在服务端不成立。

---

## 1. 复现与断链

实测输入（web 端 `/chat`）：

```
user: 123
      上面那句话生成excel
```

模型行为（推理面板原文）：意识到「工作区只有文本工具、没有 Excel 生成工具」，于是写出 `123.csv` 并回复「已生成：123.csv，可直接用 Excel 打开」。

实际交付：**0**。CSV 落在服务端沙箱 `.data/fs/<conversationId>/` 内，前端只能点开看纯文本预览，无法下载；`.xlsx` 二进制根本无法生成。

结论：这不是模型不听话，而是工具面缺了「生成」与「交付」两段。

---

## 2. 现状核查（代码级）

| 能力 | 落点 | 判定 |
|---|---|---|
| 工作区写 | `fs-store.ts:33` `fsWrite()` → `writeFileSync(content, "utf-8")`；`fs-store.ts:12` `MAX_FILE_BYTES` 默认 256KB | ❌ **仅文本**，无二进制路径 |
| 工作区读 | `fs_read` / `fs_edit` / `fs_ls` / `fs_glob` / `fs_grep`（文本语义） | ✅ |
| 工作区 HTTP 读侧 | `app.ts:1292` `GET .../files`（列表）、`app.ts:1298` `GET .../files/content`（文本预览，支持行分页） | ❌ 只有预览，**无下载** |
| 下载出口 | 全仓 `Content-Disposition` 仅两处：`app.ts:1250`（导出对话 JSON）、`app.ts:1262`（导出对话 MD） | ❌ 工作区文件无出口 |
| 前端工作区 UI | `apps/web/src/api.ts:597` `fetchWorkspaceFiles` / `:604` `readWorkspaceFile`；`ChatPage.vue:4914-4923` 点击 = 预览，`:4925` 用 `<pre>` 展示 | ❌ 无下载按钮 |
| 事件契约 | `packages/shared/src/index.ts:88-151` `ChatEventBody`：有 `chart`，无 `file`/附件类事件 | ❌ 无产物事件 |
| 落库快照 | `conversations.ts:17-41` `StoredMessage`：有 `charts`、`thinking`、`todos`，无 `files` | ❌ 产物无法持久化（刷新即消失） |
| 上传附件 | `uploads.ts:149-166` `getUploadFile()` 注释明确「仅供本轮解析为文本注入上下文用」，带 TTL，**不进工作区** | ❌ 「上传 → 加工 → 导出」闭环不成立 |
| 相关依赖 | `package.json:18-22`：`exceljs` / `unpdf` / `mammoth` **已装** | 🟡 仅用于入库解析（`rag/parsers.ts:120-141` `parseXlsx`），生成侧未使用 |
| 代码执行 | 全仓无 shell / 脚本执行工具 | ❌ 无（见 §6） |
| 图表产物 | 内置 `render_chart` + 前端 AntV 本地渲染 + `chart` 事件 + `StoredMessage.charts` | ✅ **可复用的正确范式**（本方案的 `file` 事件与卡片直接对齐它） |

---

## 3. 对齐 CodeBuddy / Cursor 的工具面差距

| 能力 | CodeBuddy | 本项目现状 |
|---|---|---|
| 读 / 写 / 改 / 列 / 搜文件 | `read_file` / `write_to_file` / `replace_in_file` / `list_dir` / `search_file` / `search_content` | `fs_read` / `fs_write` / `fs_edit` / `fs_ls` / `fs_glob` / `fs_grep`（齐） |
| 删文件 | `delete_file` | **缺** |
| 终端 / 脚本执行 | `execute_command` | **缺**（§6 论证暂不给） |
| 代码校验 | `read_lints` | **缺**（仅在 agent 需改业务项目代码时才有价值） |
| 生图 | `image_gen` | **缺**（建议走 MCP） |
| 联网检索 | `web_search` / `web_fetch` | `web_search` / `fetch_url`（齐，未配服务时不注入） |
| 任务规划 | `todo_write` | `write_todos`（齐） |
| 子代理 | `task`（含 team 模式） | `task`（并行批 + 独立取消，齐；无 team） |
| 技能 | `use_skill` | `read_skill` + 技能索引（齐） |
| 长期记忆 | `update_memory` | `save_memory` / `recall_memory`（齐） |
| 结构化反问 | `ask_followup_question` | `request_clarification`（齐，带一次性票据 + 超时 fail-closed） |
| 定时任务 | `automation_update`（模型可自建） | 仅 HTTP `/chat/schedules`（前端建，**模型不能自建**） |
| 知识库 | `RAG_search` | `search_knowledge` / `knowledge_sources`（齐） |
| **产物交付** | 文件即产物（写进 IDE 工作区，用户直接可见可打开） | **缺**：无导出工具 / 无下载端点 / 无文件卡片 ← **本次问题根因** |

> 注：CodeBuddy 的「产物交付」靠的是**它跑在用户本机 IDE 里**——写文件就是交付。对话式产品的等价物只有显式下载卡片，不能靠"文件确实存在"。

---

## 4. 形态判定准则（内置 / MCP / Skill / 定时任务）

| 特征 | 归属 | 理由 |
|---|---|---|
| 本机确定性计算 / 文件 / 渲染，无凭据、无外部副作用 | **内置工具** | 进程内可审计；`scope: workspace` 可免确认（见 `builtins.ts:29-56` 风险登记表）；弱模型也能稳定命中 |
| 需要第三方系统凭据 / 协议 / 网络 | **MCP 连接器** | 隔离外部面，勾选即注入，凭据脱敏（见 `docs/mcp-guide.md`） |
| 只有「怎么做」的流程与格式约定 | **Skill** | 按需 `read_skill` 加载，不占常驻 schema token |
| 长时 / 无人值守 / 周期执行 | **定时任务** | 复用对话任务底座 + 结果回投（见 `app.ts` 的 `startScheduleLoop`） |
| 产物交付（下载） | **内置工具 + HTTP 端点 + 前端卡片** | 三段一体，任何一段缺失都等于没交付 |

**两条反模式（本项目明确避免）**

1. **为每种文件格式各建一个工具**（`export_xlsx` / `export_pdf` / `export_docx`…）：工具数量与 schema token 线性上涨（`chat.ts:180-183` 的按需加载阈值会提前触发），且弱模型在多选一里更容易选错。
2. **把格式知识写进工具描述**：工具描述是常驻 schema，逐轮计费；格式约定又需要频繁迭代，两者节奏不匹配。

**业界证据**

| 参考对象 | 形态 | 启示 |
|---|---|---|
| CodeBuddy / Cursor | 通用文件工具（读/写/改/列/搜）+ **终端执行**；Excel / PDF 靠脚本（openpyxl / reportlab 等），**不为格式建工具** | 它们是「一个通用执行口 + 用户本机可信环境」；我们的差异是**没有可信执行环境** |
| Anthropic 官方 Agent Skills | 把 xlsx / docx / pptx / pdf 做成**文档技能（Skill）**（含格式规范、校验脚本），配一个代码执行能力——而不是 20 个生成工具 | 格式知识属于技能层；工具层只提供原子能力 |
| 本项目既有范式 | `render_chart`（原子工具）+ `chart` 事件 + 前端 `ChartCard` + `StoredMessage.charts` | **产物类的正确范式已存在**，`file` 直接照搬即可 |

**本项目的最优形态**（受「无沙箱」约束）：

> 用一个**确定性导出工具**（数据 → 文件，模型零排版自由度）替代「代码执行 + 文档技能」组合；
> 格式规范（多 sheet、表头、列宽、数字格式）交给**技能**承载，不进工具 schema。

---

## 5. 方案

### P0 — 产物交付闭环（修复本次问题，推荐全做）

| # | 改动 | 文件 | 要点 |
|---|---|---|---|
| 1 | 工作区支持二进制写 | `fs-store.ts` | 新增 `fsWriteBinary()`：扩展名白名单（xlsx / pdf / zip…）+ 独立体积上限（默认 20MB，文本路径与 256KB 上限不变）；沿用 `safePath` 的越界拦截 |
| 2 | 内置工具 `export_data` | `builtins.ts` | 入参 `{ filename, format: csv\|xlsx\|json\|md, rows?, sheets?, columns? }`；用 `exceljs` 产出**真实 xlsx**（多 sheet、表头、列宽、数字/日期类型保留）；返回 `{ path, bytes, downloadUrl }`；登记 `BUILTIN_RISK`（`write` / `workspace`，与 `fs_write` 同待遇） |
| 3 | 产物事件 | `packages/shared/src/index.ts` | `ChatEventBody` 新增 `file` 变体：`{ type: "file"; path; name; bytes; mime; url }`（形状对齐 `chart`） |
| 4 | 落库 | `conversations.ts` + `chat.ts` | `StoredMessage` 增 `files?: StoredFile[]`；chat 循环下发 `file` 事件并写快照（否则刷新即消失，与 `charts` 同理）；`app.ts` 的 `persistTaskOutcome`（断线回投）同步带上 |
| 5 | 下载端点 | `app.ts` | `GET /chat/conversations/:id/files/download?path=`：归属校验（他人对话 404）+ `safePath` 白名单 + 正确 MIME + `Content-Disposition` |
| 6 | 前端下载卡片 | `ChatPage.vue` + `api.ts` | 气泡内文件卡（名称 / 大小 / 下载按钮，样式对齐 `ChartCard`）；资源面板文件行补下载按钮（现在只有预览） |
| 7 | 引导与技能 | `system-prompt.ts`（或既有引导块）+ `skills/office-export/SKILL.md` | 明确「需要交付文件时用 `export_data`；**禁止用 `fs_write` 写文本冒充 Excel**」；技能承载多 sheet 拆分规则、表头与列宽约定、数字/百分比/日期格式、超长表处理 |

- 依赖：**零新增**（`exceljs` 已在 `package.json`）。
- 回归面：`fs_write` 预览、对话导出 JSON/MD、`render_chart` 均不受影响。

### P1 — 工具面补齐

| # | 项 | 说明 |
|---|---|---|
| 8 | `fs_delete` | 工作区删文件；与 `fs_write` 同待遇（`write`/`workspace` 免确认 + `allowed` 审计），补齐 CodeBuddy 的 `delete_file` |
| 9 | 上传附件落进工作区 | 消除 `FILE_TTL_MS` 断层，形成「上传 → 加工 → 导出」闭环；需统一附件 TTL 与工作区生命周期 |
| 10 | 定时任务工具化 | 让模型自己建/改任务（现在只有前端 HTTP 能做）；属跨会话副作用，**必须走确认卡闸门** |
| 11 | `read_lints` 类校验工具 | 仅当 agent 要改业务项目代码时才具备价值（配合 `CODEBASE_ROOT`） |

### P2 — 暂缓（需专门评估）

| # | 项 | 结论 |
|---|---|---|
| 12 | `run_script` / 通用 `execute_command` | **暂不给**，论证见 §6 |
| 13 | `image_gen` | 建议走 MCP 外部生图服务接入，不必内置 |

---

## 6. 为什么暂不给 `execute_command`（对齐差异的显式取舍）

| 维度 | CodeBuddy（本机 IDE） | 本项目（服务端） |
|---|---|---|
| 执行环境 | 用户自己的机器，用户可见、可中断、可审 | 服务端进程，与全部用户会话、`.data`、`.env` 凭据同机 |
| 风险边界 | 越权影响 = 用户自己的事 | 任意代码执行 = 任意文件 / 网络 / 凭据访问，**无沙箱** |
| 模型能力 | 强模型 + 用户随时纠偏 | 弱模型随机退化（空转、参数猜错），脚本失败率与资源消耗不可控 |
| 需求覆盖 | 通用 | **产物需求可枚举**：csv / xlsx / json / md（P0）、pdf / zip（P1） |

结论：用「专用确定性生成器」覆盖 95% 场景，性价比与安全性均优于开一个通用执行口。

**若将来确需**，前置条件（缺一不可）：

1. 容器化隔离（独立进程/容器、非宿主直跑）；
2. 网络默认关闭（或域名白名单）；
3. 工作区只读挂载 + 独立可写临时目录；
4. 超时 / 内存 / 输出体积硬上限；
5. 解释器与依赖白名单（不引入 `npm install` 之类）；
6. 全量审计（命令、退出码、耗时、产物路径）。

---

## 7. Excel / PDF 等产物的最终形态建议

| 产物 | 形态 | 工具 / 载体 | 理由 |
|---|---|---|---|
| CSV | **内置工具** | `export_data`（`format: "csv"`） | 纯文本序列化，零依赖、零自由度 |
| XLSX | **内置工具**（+ Skill 承载格式约定） | `export_data`（`exceljs`）+ `skills/office-export` | 「数据 → 表格文件」是确定性转换，模型不该自己拼字节；格式策略（多 sheet / 列宽 / 数字格式）属技能层 |
| JSON / MD | 内置工具（同一工具） | `export_data` | 同属数据序列化，不额外建工具 |
| PDF | ~~P1：内置渲染工具~~ → **v2 内置扩展** | `export_data`（`format: "pdf"`），选型与实现见 §10 | 原定「待选型后并入同一工具族」，现选型完成（pdfmake + CJK 字体内嵌） |
| DOCX | ~~暂不做~~ → **v2 内置扩展** | `export_data`（`format: "docx"`），见 §10 | 用户明确要求补齐 Office 双件套（Word/PDF），推翻 v1「暂不做」决策 |
| 图表 | 已落地 | 内置 `render_chart` | 前端本地渲染，零外链 |
| 图片生成 | 走 MCP | 外部生图服务 | 需外部凭据，不属本机确定性能力 |

**一句话**：Excel / CSV / JSON / MD 用「**1 个内置导出工具 + 1 个格式规范技能**」，PDF 待渲染引擎选型后并入同一工具族；**不出现「一格式一工具」**。

---

## 8. 验收标准

1. 输入「123 / 上面那句话生成excel」→ 气泡内出现 `123.xlsx` 下载卡片；下载文件为**真实 xlsx**（可被 Excel/WPS 打开，内容为 `123`）。
2. 多人/多对话隔离：他人对话的文件下载端点返回 404；路径含 `..` / 绝对路径一律拒绝。
3. 刷新页面后文件卡仍在（落库生效）；断线回投路径（`persistTaskOutcome`）同样带上文件卡。
4. 回归：`fs_write` 文本预览、对话导出 JSON/MD、`render_chart` 图表渲染无变化。
5. 零新增依赖；工具名、描述、事件字段全为协议级英文，**不含任何业务词**。

---

## 9. 挂账

- 上传附件不进工作区（P1 #9）。
- 定时任务仅前端可建（P1 #10）。
- 工作区为单机单用户假设（并发写与配额未做）。
- ~~PDF 渲染引擎选型（体积 vs 排版能力）未定~~ → 已在 §10 v2 定案。

---

## 10. v2 格式扩展：PDF / Word / HTML / TXT（2026-09-23 评审稿）

> 触发：用户在 `/chat` 实测「123 / 上述导出pdf」→ 模型只能如实回答「不支持 PDF」。
> 结论先行：**基础设施早已预埋好（`.pdf`/`.docx` 早在二进制白名单与 MIME 表里），缺的只是「生成器」一段代码与两个依赖**。

### 10.1 为什么导不了 PDF（代码级根因）

| 环节 | 落点 | 现状 |
|---|---|---|
| 格式白名单 | `builtins.ts` `EXPORT_FORMATS = new Set(["xlsx","csv","json","md"])` | ❌ pdf/docx 不在集合，`resolveExportTarget` 直接报「不支持的导出格式」 |
| 工具 schema | `builtins.ts` `export_data` spec 的 `format` 描述 | ❌ 只声明 `csv \| xlsx \| json \| md`，模型无从得知可请求 PDF |
| 生成器 | `builtins.ts` `execExportData` 分支：xlsx → `buildXlsx`；其余 → 文本序列化 | ❌ 无 PDF/DOCX 生成函数 |
| 二进制落盘 | `fs-store.ts` `BINARY_EXTS`（含 `.xlsx .xls .pdf .docx .zip`） | ✅ **已预埋** |
| MIME | `fs-store.ts` `MIME_BY_EXT`（`.pdf`/`.docx` 齐全） | ✅ **已预埋** |
| 下载卡片 / 下载端点 | artifact 事件 + `GET .../files/download`（`mimeOf` 通用） | ✅ 通用，新格式零前端改动 |
| 依赖 | `package.json`：`exceljs`（生成 xlsx）/ `unpdf`+`mammoth`（解析侧） | ❌ 缺 PDF 生成库与 DOCX 生成库 |
| 顺手的小坑 | 文件名 `x.xls` → 扩展名推断 `xls` → 报「不支持」 | 🟡 应友好映射为 `xlsx`（白名单里 `.xls` 本就指向同一产物） |

### 10.2 目标格式矩阵（对齐 ChatGPT Code Interpreter / CodeBuddy 文件产物口径）

| 格式 | 优先级 | 生成方式 | 新增依赖 | 说明 |
|---|---|---|---|---|
| xlsx | ✅ 已有 | `exceljs`（多 sheet/冻结表头/列宽） | — | 不动 |
| csv / json / md | ✅ 已有 | 文本序列化 | — | 不动 |
| **docx（Word）** | P0 本批 | `docx` npm 包（声明式：标题+表格+样式） | `docx`（纯 JS，零原生依赖） | 中文无需内嵌字体（Word 按名称取系统字体）；P0 最高性价比 |
| **pdf** | P0 本批 | `pdfmake`（声明式表格布局，字体经 vfs 注入） | `pdfmake` + NotoSansSC TTF 字体资产 | **唯一硬点：PDF 必须内嵌 CJK 字体**，否则中文全变空白；详见 10.3 |
| **html** | P0 本批 | 自包含单文件（内联 CSS 的样式表格），走 `fsWrite` 文本路径 | **零依赖** | 双重价值：①本身可预览/二次加工；②浏览器打开 Ctrl+P 即存 PDF——是 PDF 的**零成本兜底通道**（v1 §7 的兜底方案正式落地） |
| **txt** | P0 本批 | 等宽对齐纯文本（CJK 记 2 计算列宽），走 `fsWrite` | 零依赖 | 补齐 Code Interpreter 基线格式 |
| **pptx（PowerPoint）** | P0 本批 | `pptxgenjs`（标题页 + 每表一页幻灯表格） | `pptxgenjs`（纯 JS，零原生依赖） | 用户拍板全量补齐；表格数据 → 每表一页幻灯，中文走系统字体无需内嵌；密集表格建议仍用 xlsx |
| **png（图表图片）** | P0 本批 | 前端 ChartCard 增加「存 PNG」按钮：G2 canvas `toDataURL` 白底合成后下载 | **零依赖、零服务端改动** | 对齐 Cursor/CodeBuddy 图表卡标配；图表本就前端本地渲染（v1 §7 判定维持），服务端重复渲染无意义 |

**不新增第二个工具**：全部并入 `export_data`（v1 §4 准则「不为每种格式各建一个工具」不变）。工具名/描述/schema 全协议级英文，不含业务词（红线）。

### 10.3 PDF 引擎选型（v1 挂账项定案）

| 方案 | 结论 | 理由 |
|---|---|---|
| **pdfmake（选定）** | ✅ | 声明式 content 定义（table/文本/分页），API 与 `docx` 包同风格；字体经 vfs 注入；纯 JS 无原生编译 |
| pdfkit | 备选 | 命令式坐标排版，表格需自写循环；与 docx 的声明式风格不统一 |
| puppeteer / 无头浏览器 | ❌ | Chromium 体积数百 MB、启动秒级，服务端不可接受（v1 §7 已否，维持） |
| pdf-lib | ❌ | 过低层（逐字符定位），表格排版全部自写，得不偿失 |

**CJK 字体内嵌（PDF 唯一硬点）**：
- 资产：`apps/agent-server/assets/fonts/NotoSansSC-Regular.ttf`（思源黑体子集，体积预计 2~8MB；完整版 ~10MB 过大，做子集裁剪）。
- 构建：pdfmake 的 `vfs_fonts.js` 由脚本从 TTF 生成，不进 npm。
- 兜底：字体资产缺失时 `format:"pdf"` 如实报错并提示改用 `docx`/`html`，**绝不输出中文空白/乱码的 PDF**（诚实失败优于坏产物）。
- `.gitignore`/LFS 取舍：字体入库（一次性资产），若嫌大改走部署时下载脚本，评审时定。

### 10.4 服务端实现落点（全部在 `apps/agent-server`）

1. **`builtins.ts`**
   - `EXPORT_FORMATS` 扩为 `xlsx / csv / json / md / docx / pdf / html / txt`；
   - `export_data` 工具描述与 `format` schema 同步（「生成 pdf / word 文档」话术进触发条件）；错误提示同步支持集合；
   - `resolveExportTarget`：扩展名 `xls` → 归一为 `xlsx`（小坑修复）；
   - 新增 `buildDocx(sheets)` / `buildPdf(sheets, title)` / `buildHtml(...)` / `buildTxt(...)`，全部**动态 `import`**（对齐 `buildXlsx` 现有模式：真用到才付加载成本）。
2. **多表（sheets）策略**：xlsx = 多工作表（现状）；docx / pdf = 按序「小标题 + 表格」分节（同一循环，几乎零额外成本）；html / txt = 沿用「多表仅限 xlsx/docx/pdf」拒绝路径（提示语同步）。
3. **行数上限分级**（PDF 页数会爆炸，不能沿用 5 万行一刀切）：`xlsx` 5 万（现状）/ `docx` 2 万 / `pdf` 2000 / `html` 5 万 / `txt` 5 万；超限报错并给分流建议（如「数据量较大请改用 xlsx」）。
4. **`fs-store.ts`**：零改动（白名单/MIME 已备好；html/txt 走既有文本路径）。
5. **`app.ts` / 前端 `api.ts` / `ChatPage.vue`**：零改动（下载卡片与端点按 mime/文件名通用渲染）。
6. **依赖**：`pnpm add docx pdfmake`（都在 `apps/agent-server`）；字体资产一处新增。

### 10.5 验收标准（v2）

1. 「导出pdf / 导出word」→ 气泡出现 `.pdf` / `.docx` 下载卡片；文件可被 Adobe/WPS/Word 打开，**中文正常显示**（PDF 字体内嵌验证）。
2. 多表导出：`sheets` 给 pdf/docx → 分节呈现；给 html/txt → 明确报错拒绝。
3. 超行数上限 → 明确报错 + 分流建议，不产出残缺文档。
4. 字体资产缺失时 PDF 如实报错引导替代格式（兜底路径）。
5. 回归：xlsx/csv/json/md 四种既有格式产物逐字节语义不变；`fs_write` 文本、对话导出、`render_chart` 无变化。
6. 工具 schema / 描述 / 错误提示零业务词（红线审计）。

### 10.6 评审待定项（需要用户拍板）

1. **字体方案**：NotoSansSC 子集直接入库（简单）vs 部署脚本按需下载（仓库瘦）——推荐前者（一次性 ~5MB）。
2. **pdf 2000 行上限**是否合适（可放宽到 5000，代价是百页文档）。
3. `txt` 是否要（Code Interpreter 有；本项目场景偏少，砍掉也行）。

---

## 10.7 落地记录（2026-09-23）

`export_data` 已从 4 种格式扩到 **8 种**（`xlsx / csv / json / md / docx / pdf / html / txt`），全部走同一个工具、前端与下载端点**零改动**。

**新增依赖与资产**

| 项 | 内容 |
|---|---|
| `docx@^9.7.1` | 生成 Word（纯 JS，中文由 Word 按字体名解析，**无需内嵌字体**） |
| `pdfmake@^0.3.11` | 生成 PDF（声明式表格布局） |
| `assets/fonts/NotoSansSC-Regular.otf` | PDF 中文字体（Noto Sans SC，**SIL OFL 1.1**，8.3MB，同目录带 `LICENSE-NotoSansSC.txt`） |

**实现要点**

1. `EXPORT_FORMATS` 8 种；新增 `MULTI_SHEET_FORMATS = {xlsx, docx, pdf}`（其余格式多表明确拒绝）、`TEXT_EXPORT_FORMATS = {csv, json, md, html, txt}`（走 `fsWrite` 文本路径，其余走 `fsWriteBinary`）。
2. 生成器：`buildDocx` / `buildPdf` / `buildHtml` / `buildTxt`，全部**动态 `import`**（真用到才付加载成本，对齐既有 `buildXlsx`）。
3. 分格式行数上限：`pdf` 2000 行、`docx` 2 万行（PDF 页数会随行数线性膨胀），其余沿用 5 万；超限报错并**引导改用 xlsx**。
4. `pdfmake 0.3` 是**新 API**（不再是 `new PdfPrinter(fonts)`）：`setFonts()` + `setLocalAccessPolicy()` + `setUrlAccessPolicy()` + `createPdf().getBuffer()`；实例为模块单例，**只初始化一次**。安全上按最小权限：本地访问只放行字体目录，外部 URL 一律拒绝。
5. 字体缺失时 `pdf` **如实报错并引导改用 docx/html**，绝不产出中文空白/乱码的坏 PDF（诚实失败优于坏产物）。
6. 别名归一：`.xls → xlsx`、`.htm → html`（修掉 10.1 的「小坑」）。
7. **`fs-store.ts` 实际需一处改动**（§10.4 原判「零改动」不准确）：`MIME_BY_EXT` 缺 `.html/.htm`，会回落 `application/octet-stream`，已补 `text/html; charset=utf-8`。

**验证**：`tests/export-formats.test.ts` 7/7（八格式落盘非空、pdf `%PDF-` / docx `PK` 魔数、html 表格与标题、多表策略、别名归一、不支持格式拒绝、pdf 行数上限）；全量 `pnpm test` **20 文件 / 126 测试全绿**。真实产物抽检：PDF 与 docx 的中文均可被 `unpdf` / `mammoth` 正确提取，PDF 因 **pdfkit 自动 subset** 仅约 48KB（源字体 8.3MB）。

**尚未做**：`pptx`（§10.2 列出但未纳入本批 `EXPORT_FORMATS`）、`png`（图表存图属前端 ChartCard 改动）。

---

## 11. v2.1 修复：报告式导出交付断链（2026-09-24）

> 触发：实测会话（「分组统计 + 表格 + 折线图 + 饼图 + 预测与建议，全部生成到 html 里」）——
> 模型取数、核实字段、画图（`render_chart` × 2）全部成功，最终交付却失败：用户既没看到下载卡片，
> 模型收束文本还停在「参数未正常传入导致写入失败，重新写入：」。
> 事后核查：HTML 文件**其实已写到工作区**（16KB），但用户拿不到——典型的「交付断链」复发。

### 11.1 断链核查（代码级，逐层）

| # | 环节 | 落点 | 现象 / 根因 |
|---|---|---|---|
| 1 | `export_data` 报告格式表格必填 | `builtins.ts` `export_data` → `exportMatrix` | 报告式格式（html/pdf/docx）即使给了 `sections`+`charts`，只要没给 `rows`/`sheets`，`rawSheets` 无条件兜底 `{rows: args.rows}` → 「缺少数据行」直接报错。模型想交付「叙述+图表、无明细表」的报告被拒——它口中的「参数未正常传入」即此 |
| 2 | `fs_write` 不下发 artifact | `builtins.ts` `case "fs_write"` | 返回只有 text；`artifact` 事件是 `export_data` 专属。模型被 #1 拒后退而用 `fs_write` 手写 HTML → 文件写进工作区、**前端没有任何下载入口**（下载卡片三段一体缺一段，v1 §4 结论复现） |
| 3 | 手写 HTML 带外链 CDN | 模型行为（fs_write 的 content） | `<script src="https://cdn.jsdelivr.net/.../echarts.min.js">`——违反本仓导出物「**自包含、零外链**」设计原则（`report.ts` 头注）：断网 / CDN 不可达时打开就是图表空白 |
| 4 | 首次 `fs_write` 非法路径 | `fs-store.ts` `safePath` | 模型第一次传了工作区外路径 → 「非法路径」报错。`safePath` 拦截正确；但工具描述未强调「只接受相对路径」，加剧了试错轮次 |
| 5 | （附带）预测 SQL 报错 | ClickHouse `ILLEGAL_AGGREGATION` | 聚合函数套聚合，属模型写错 SQL，与交付断链无关，不计入本修复 |

### 11.2 最佳实践对齐（修复原则）

1. **导出物自包含、零外链**：HTML 报告一律由服务端合成（`report.ts` 的 `buildHtmlReport`：内联样式 + 图表烘焙成内联 SVG），绝不接受模型手写引用 CDN 的网页。
2. **交付走 `export_data` 单一通道**：下载卡片 = `artifact` 事件 + 下载端点 + 前端卡片，三段一体；`fs_write` 是工作区**草稿**语义（对齐 §5 P0 #7 的引导原则）。
3. **报告与数据分离**：报告式格式（html/pdf/docx）的载体是「叙述 + 图表 + 表格（可选）」；数据格式（xlsx/csv/json/md/txt）的载体是表格（必填）。「缺表格就报错」只应约束后者——v2 只实现了「报告格式可带 sections/charts」，漏了「可**只**带 sections/charts」。
4. **诚实失败**：表格 / 叙述 / 图表三种内容全空时明确报错，不产出空文件。

### 11.3 修复设计（三条，全部服务端，前端零改动）

| # | 改动 | 落点 | 要点 |
|---|---|---|---|
| A | 报告格式允许零表格 | `builtins.ts` `export_data` | 新增 `REPORT_EXPORT_FORMATS = {html, pdf, docx}`：无 `rows`/`sheets` 时跳过建表（`built=[]`），只渲染 `sections`+`charts`；数据格式维持必填并提前明确报错；三者全空报「缺少内容」；总结文案适配零表格形态（原 `${built[0]!.matrix...}` 在空表时会崩） |
| B | `fs_write` 写 `.html` 下发下载卡片 | `builtins.ts` `case "fs_write"` | 命中 `.html/.htm` 扩展名（协议级判定，无业务词）时返回 `artifact`——前端既有 `isHtmlArtifact` 自动带「预览 + 下载」双按钮；其余扩展名维持草稿语义不下发卡片 |
| C | 工具描述引导 | `builtins.ts` `export_data` / `fs_write` spec | `export_data`：「报告式格式可只给 sections+charts」「导出物必须自包含，禁止用 fs_write 手写带外链 CDN 的网页代替本工具」；`fs_write`：「草稿通道，不出下载卡片（.html 除外）；交付用户的文件用 export_data；只接受工作区内相对路径」 |

### 11.4 验收标准（v2.1）

1. `export_data` html 仅 `sections`+`charts`（无 rows）→ 成功产出含 `<figure>`/内联 `<svg>` 的自包含 HTML（无 `<script` 外链），下载卡片出现。
2. html/pdf/docx 零表格可用；xlsx/csv/json/md/txt 无 rows 仍明确报「缺少数据行」。
3. 三者全空（无 rows/sections/charts）→ 明确报「缺少内容」，不产出空文件。
4. `fs_write` 写 `.html` → 对话出现下载卡片（可预览/下载）；写 `.md`/`.txt` → 无卡片（草稿语义不变）。
5. 回归：`tests/export-formats.test.ts` 既有 7 组用例全绿 + 新增零表格 / 全空拒绝 / fs_write 卡片用例；xlsx 等既有格式产物语义不变。
