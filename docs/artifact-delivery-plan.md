# 产物交付与文件生成方案（Excel / CSV / PDF 等）

> 版本：v1（2026-09-22）
> 定位：解决「让 agent 生成 excel / pdf 等文件」的**交付断链**；给出「内置工具 vs 技能（Skill）」的形态判定准则与分档落地清单。
> 相关：`apps/agent-server/src/builtins.ts`、`fs-store.ts`、`app.ts`、`chat.ts`、`conversations.ts`、`packages/shared/src/index.ts`、`apps/web/src/pages/ChatPage.vue`、`apps/agent-server/skills/`、`docs/deep-agents-plan.md` §5 D5（代码执行沙箱）、`docs/chart-visualization-plan.md`（图表已落地的同族问题）。

**当前状态**

| 项 | 内容 | 状态 |
|---|---|---|
| 1 | 问题定性与断链核查（§1 / §2） | ✅ 已完成 |
| 2 | 形态判定准则（内置 / MCP / Skill / 定时任务） | ✅ 已完成（§4） |
| 3 | P0 产物交付闭环（导出工具 + 下载端点 + `file` 事件 + 下载卡片） | ⬜ 待实施 |
| 4 | P1 工具面补齐（`fs_delete` / 上传入工作区 / 定时任务工具化） | ⬜ 待实施 |
| 5 | P2 `run_script`（受控代码执行）/ `image_gen` | 🟡 暂缓，见 §6 论证 |

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
| PDF | P1：**内置渲染工具** | 计划 `export_document`（md/html → pdf） | 排版引擎选型待定：无头浏览器体积大、`pdfkit` 需自写排版；**兜底方案**是先交付 md + 浏览器打印，不阻塞 P0 |
| DOCX | 暂不做 | —— | 生成需求低频（解析侧 `mammoth` 已有） |
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
- PDF 渲染引擎选型（体积 vs 排版能力）未定。
