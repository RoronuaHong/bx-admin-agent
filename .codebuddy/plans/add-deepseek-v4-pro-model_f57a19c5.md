---
name: add-deepseek-v4-pro-model
overview: 在 agent-server 的 .env 模型注册表中新增 deepseek-v4-pro（dspro）条目，并加入 MODEL_PROVIDERS，使前端的"选择模型"下拉按钮自动出现该选项。无需修改前端代码（前端根据 /agent/models 自动渲染）。
todos:
  - id: add-dspro-env
    content: 在 .env 新增 dspro 配置块并追加进 MODEL_PROVIDERS 与注释
    status: completed
  - id: restart-server
    content: pm2 重启 agent-server-dev 使配置生效
    status: completed
    dependencies:
      - add-dspro-env
  - id: verify-model
    content: 验证 /agent/models 含 dspro 且前端下拉出现 DeepSeek-V4-Pro
    status: completed
    dependencies:
      - restart-server
---

## 用户需求
用户希望把 TokenHub 控制台中可用的 `deepseek-v4-pro` 模型，加入聊天页面的「选择模型」下拉按钮中。

## 产品概述
聊天页面（ChatPage）的模型切换下拉菜单由服务端 `/agent/models` 接口自动渲染，接口数据来源于 agent-server 的 `.env` 模型注册表。只需在服务端 `.env` 中注册 `deepseek-v4-pro` 模型，前端下拉按钮即可自动出现该选项，无需改动前端代码。

## 核心功能
- 在模型注册表中新增 `deepseek-v4-pro`（模型 ID：`dspro`）的配置项
- 将 `dspro` 追加进 `MODEL_PROVIDERS` 列表，使其出现在前端模型选择按钮中
- 保持现有默认模型（`nemotronultra`）首位不变，仅作为可选项加入
- 重启 agent-server 后，下拉菜单中出现 "DeepSeek-V4-Pro" 选项，选中后服务端以该模型应答

## 技术栈
- 后端：Node.js + TypeScript（agent-server），模型配置通过环境变量驱动（`apps/agent-server/src/config.ts` 的 `listModels()` 解析）
- 前端：Vue 3（ChatPage.vue），通过 `fetchModels()` 读取 `/agent/models` 自动渲染下拉，无需改动

## 实现方案
**策略**：沿用现有 `dsflash`（deepseek-v4-flash）的配置范式，新增一个同属 TokenHub 的 `dspro` 模型条目。模型下拉是数据驱动渲染，服务端注册即前端可见，零前端改动。

**关键技术决策**：
1. **复用 dsflash 模板**：`deepseek-v4-pro` 与 `deepseek-v4-flash` 同属 TokenHub OpenAI 兼容端点（`https://tokenhub.tencentmaas.com/v1`），共用同一 `API_KEY`，配置结构完全一致，仅 `NAME`/`LABEL`/`TIMEOUT_MS` 不同。
2. **VISION=none / TOOLS=true**：deepseek-v4-pro 为文本/推理模型，无视觉能力，故 `VISION=none`；支持 function calling，故 `TOOLS=true`。
3. **TIMEOUT_MS=180000**：pro 比 flash 推理更慢，超时给 180s 避免长推理被截断。
4. **不置为默认**：`MODEL_PROVIDERS` 首位仍为 `nemotronultra`（注释已说明其"最快最准"），`dspro` 追加在 `dsflash` 之后，仅作为可选模型。
5. **不改 auto 路由策略**：用户仅要求"加进按钮"，未要求设为自动路由优先模型，故 `superpower-router-policy.json` 不动。

## 实现备注
- **重启生效**：`.env` 为运行时惰性读取，但 pm2 进程加载后环境变量已固化，必须重启 `agent-server-dev` 进程才能加载新模型。按既有运维规范：`pm2 delete agent-server-dev` → 确认 8787 端口释放 → `pm2 start ecosystem.dev.config.cjs --only agent-server-dev`。
- **验证方式**：重启后 `curl http://localhost:8787/agent/models` 应返回含 `id:"dspro"` 的条目；或浏览器打开 `http://localhost:5173/chat` 点击模型按钮确认出现 "DeepSeek-V4-Pro"。
- **向后兼容**：仅追加配置，不删除/修改任何现有模型，无回归风险。

## 架构设计
本任务为纯配置扩展，不涉及架构变更。数据流保持：`.env` 模型环境变量 → `config.ts listModels()` → `/agent/models` 接口 → 前端 `fetchModels()` → 下拉菜单自动渲染。

## 目录结构
```
apps/agent-server/.env   # [MODIFY] 模型注册表配置文件。
                          # 1) 第16行 MODEL_PROVIDERS 末尾追加 ",dspro"；
                          # 2) 第11行注释 "TokenHub（2 代表）" 改为 "TokenHub（3 代表）：hyvision, dsflash, dspro"；
                          # 3) 在 dsflash 配置块（第41行后）新增 dspro 配置块（PROVIDER=openai, NAME=deepseek-v4-pro,
                          #    BASE_URL=https://tokenhub.tencentmaas.com/v1, API_KEY 复用同一 TokenHub key,
                          #    VISION=none, TIMEOUT_MS=180000, LABEL=DeepSeek-V4-Pro, TOOLS=true）。
```
