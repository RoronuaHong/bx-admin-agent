# 交付物生成规范（Deliverable Guardrails）

> 版本：v1（2026-09-28）
> 定位：**所有"产出可下载/可查看文件"的内置工具**的统一护栏基线。从 `docs/artifact-delivery-plan.md` §11 提炼，供新增/改动交付类工具时复用，避免每加一个工具重踩一遍坑。
> 关联：`apps/agent-server/src/report.ts`、`builtins.ts`、`fs-store.ts`；测试 `tests/export-formats.test.ts`、`tests/html-self-contained.test.ts`、`tests/governance-guardrails.test.ts`。

## 0. 适用范围

下列工具都"生成用户拿得到的产物"，**一律适用本规范**：

| 工具 | 产物形态 | 关键护栏落点 |
|---|---|---|
| `export_data`（html / pdf / docx） | 报告式文件 | `report.ts` 内联 `REPORT_CSS` + 内联 SVG；`buildPdf`/`buildDocx` 以 `if (title)` 守卫 |
| `export_data`（xlsx / csv / json / md / txt） | 数据式文件 | 表格必填，确定性序列化 |
| `fs_write`（`.html`） | 手写 HTML 下载卡片 | `externalRefHint` 软护栏（§3） |
| `image_gen` | 图片（本地 PNG） | 远端 `url` 本地化落盘，不泄漏外部链接 |
| `run_script` | 执行结果回传 | 只透传原始输出，不包裹编造文案 |
| `render_chart` | 对话内图表卡 | 前端本地渲染，零外链 |

## 1. 五条硬原则

1. **自包含、零外链**
   - HTML 报告：内联 CSS 变量设计系统（`REPORT_CSS`）+ 图表烘焙成内联 SVG；**不引任何 CDN / web font**，断网可开、Ctrl+P 干净存 PDF。
   - PDF：仅引本地字体资产（如 `assets/fonts/NotoSansSC-*.tt`），不出现 `https://`。
   - DOCX：由 Word 按字体名解析，不嵌入网络资源。
   - `image_gen`：把远端 `url` 取到本地再落盘，交付物不含外部链接。

2. **禁止工具侧确定性编造**
   - 导出物的**每一段文案**都必须来自用户的真实输入或工具的真实返回；工具层**绝不注入**用户未提供的默认值（如默认 HTML 大标题「数据分析报告」、默认「导出数据」）。
   - 缺字段 → **如实报错**，而非补占位文案。
   - 可选 KPI 概要卡：仅模型**显式传入**才渲染，工具**不自动从表格推算**指标（避免编造）。

3. **交付走单一通道**
   - 下载卡片 = `artifact` 事件 + 下载端点 + 前端卡片，三段一体。
   - `fs_write` 是工作区**草稿**语义；`.html` 例外（下发卡片 + 软护栏）。交付用户的正式文件用 `export_data`。

4. **诚实失败**
   - 报告式格式：叙述 / 图表 / 表格**三者全空** → 明确报「缺少内容」，不产出空文件。
   - 数据式格式：表格必填，缺则提前报错。
   - PDF 字体资产缺失 → 如实报错并引导改用 `docx`/`html`，绝不产出中文空白/乱码坏文件。

5. **报告与数据分离**
   - 报告式（html / pdf / docx）：载体是「叙述 + 图表 + 表格（可选）」，**允许零表格**。
   - 数据式（xlsx / csv / json / md / txt）：载体是表格，**必填**。
   - 「缺表格就报错」只约束后者。

## 2. 观感基线（仅 HTML 报告，零外链前提下）

- 系统字体栈 + `:root` CSS 变量配色（品牌蓝 `#3370FF` + 中性灰阶）。
- Hero 头：**仅当真有 `title` 时**渲染，绝不编造默认标题。
- 可选 KPI 概要卡（显式传入才渲染）+ 叙述/图表/表格**卡片化**（圆角 + 轻阴影）。
- `@media print` 去阴影、保色，`print-color-adjust: exact`，Ctrl+P 干净存 PDF。

## 3. 手写 HTML 软护栏（只提示不硬拦）

`fs_write` 写 `.html` 成功时，用 `externalRefHint(content)` 检测 `<script/link/img/iframe/embed/source>` 指向绝对 `http(s)://` 或协议相对 `//` 的引用，回灌一句服务端观察提示（含引用处数 + 前 3 个样例域名），引导改用 `export_data(format=html)` 或改成内联 `<style>/<svg>`。
口径同「跨轮重复调用」软提示：**只提示不硬拦**，对齐 Goldilocks（模型确有「内嵌第三方库做自检页」的合法场景）。内联 `<style>` / 内联 `<svg>` / 相对路径一律放行。

## 4. CI 级硬卡点

`tests/governance-guardrails.test.ts` 在套件内随 CI 运行，源码级钉死：
- **[G1]** `report.ts` 不出现 `http(s)://` 字面量（除 SVG 命名空间 `http://www.w3.org/2000/svg`）。
- **[G2]** `report.ts` / `builtins.ts` 无默认标题兜底 `|| "数据分析报告"` / `|| "导出数据"`。
- **[G3]** `externalRefHint` 与 `.html` 下载卡片逻辑存在。
- **[G4]** `image_gen` 本地化落盘（`fsWriteBinary` + `b64_json`）、`run_script` 透传原始输出（`runShell`）。

行为级回归由 `tests/export-formats.test.ts`（[C2]–[C8]：无标题不编造、零表格可用、零外链、pdf/docx 全家族一致）与 `tests/html-self-contained.test.ts`（[A]–[D]：软护栏命中/不误报/卡片回灌）锁死。

## 5. 新增交付类工具的自检清单

- [ ] 产物是否自包含、零外链？（HTML 内联、PDF 本地字体、图片本地化）
- [ ] 是否注入了任何用户没给过的默认标题/文案？（缺字段应报错）
- [ ] 是否走 `artifact` 下载通道（或明确标注为草稿）？
- [ ] 全空/缺字段时是否诚实失败而非产出坏文件？
- [ ] 是否补了行为级测试 + 在 `governance-guardrails.test.ts` 加了对应源码级卡点？
