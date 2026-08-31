---
name: prune-models-env
overview: 按用户规则精简 .env 的 MODEL_PROVIDERS：保留 Zen 免费链 5 个 + NVIDIA 2 个 + TokenHub 2 个（hyvision/dsflash），其余全删，关 KB，同步更新 router-policy 并重启验证。
todos:
  - id: trim-env-models
    content: 编辑 .env：MODEL_PROVIDERS 仅留 9 个（nemotronultra 置首），删除 TokenHub 52 块与 NVIDIA 4 块及 KB_EMBEDDING_* 行，KB_EMBEDDING=off
    status: completed
  - id: update-router-policy
    content: 更新 superpower-router-policy.json：fallbackModels 移除 glm5/glm52
    status: completed
    dependencies:
      - trim-env-models
  - id: restart-server
    content: pm2 delete agent-server-dev 并确认 8787 释放后重启 agent-server-dev
    status: completed
    dependencies:
      - trim-env-models
      - update-router-policy
  - id: verify-models
    content: 用 tsx 跑临时脚本打印 listModels() 确认仅 9 个模型且正确，grep .env 确认无残留被删 id，验证后删脚本
    status: completed
    dependencies:
      - restart-server
---

## 用户需求
精简 agent-server 的大模型注册表：按「不同来源留 1-2 个最强代表 + 免费链全留」的规则，删除其余所有模型配置。

## 产品概述
修改 `.env` 的 `MODEL_PROVIDERS` 注册表与对应模型配置块，并同步更新路由策略与知识库开关，使服务端仅加载 9 个模型（Zen 免费链 5 个全留、NVIDIA NIM 留 2 个最强、TokenHub 留 2 个最强代表 hyvision/dsflash），移除冗余模型并关闭已不可用的知识库语义检索，降低配置噪音与误用风险。

## 核心功能
- 保留 9 个模型：Zen 免费链 5 个（zenhy3、nemotronfree、nemotronultra、xpreviewfree、lagunas）+ NVIDIA NIM 2 个（nvnemotronultra、nvnemotronsuper）+ TokenHub 2 个（hyvision、dsflash）
- 删除 TokenHub 其余 52 个模型配置块（含文本/视觉/视频/图像/3D/语音/Embedding）及 NVIDIA 多余 4 个（nvnemotronlightning、nvlagunaxs、nvnanoomni、nvstepflash）
- 关闭知识库语义检索（KB_EMBEDDING=off），因依赖的 TokenHub embedding（kinfrate06）已删除
- 同步更新 superpower-router-policy.json 的 fallbackModels，移除已删的 glm5/glm52
- 将最强模型 nemotronultra 置于 MODEL_PROVIDERS 首位作为默认模型
- 重启 agent-server-dev 使配置生效并验证


## 技术栈
- 配置层：`.env`（dotenv 风格键值对）、`data/superpower-router-policy.json`（路由策略）
- 运行时：Node.js + tsx（pm2 托管 agent-server-dev，端口 8787）
- 模型加载：`src/config.ts` 的 `listModels()` 惰性读取 `MODEL_PROVIDERS` 与 `MODEL_<ID>_*` 环境变量

## 实现方案
### 策略
直接编辑 `.env` 与路由 JSON，删除无用模型配置块、精简 `MODEL_PROVIDERS` 列表、关闭 KB，最后重启服务并用 tsx 脚本验证 `listModels()` 结果。

### 关键技术决策
1. **保留模型顺序**：`nemotronultra` 放首位（原首位 zenhy3），因 `config.ts` 的 `defaultModel()` 取列表首个作默认，最强模型作默认体验最佳。完整顺序：`nemotronultra,zenhy3,nemotronfree,xpreviewfree,lagunas,nvnemotronultra,nvnemotronsuper,hyvision,dsflash`。
2. **TokenHub 留 hyvision + dsflash**：用户明确要求 TokenHub 来源留 1-2 个最强代表，故保留 `hyvision`（唯一真正的多模态视觉对话模型 VISION=direct）与 `dsflash`（deepseek-v4-flash，文本对话定位最强）。其余 TokenHub 模型（含 kinfrate06 embedding）全部删除。
3. **路由 JSON 同步**：`superpower-router-policy.json` 的 `fallbackModels` 含已删的 `glm5/glm52`，必须移除，否则 router 引用不存在的模型；`strongModels/fastModels` 已仅含保留模型，无需改。
4. **KB_EMBEDDING 处理**：`KB_EMBEDDING=on` 改为 `off`，依赖的 `kinfrate06` 块随 TokenHub 删除一并移除；`knowledge-embedding.ts` 在 off 时自动降级纯词法检索，不报错。

### 性能与可靠性
- 无运行时性能影响；模型列表从 62 缩减到 9，前端下拉与选项更清晰。
- `router-policy.ts` 纯动态读 JSON 无硬编码模型名，安全。
- 前端 web 动态拉 `/models` 接口（已确认 0 硬编码匹配），无需改动。

## 实现注意事项
- 删除 `.env` 模型块时需整段删除（每个模型约 7-9 行含空行），避免残留孤立 `MODEL_<id>_*` 键导致 config 解析告警。
- 重启必须 `pm2 delete agent-server-dev` → 确认 8787 释放 → `pm2 start ecosystem.dev.config.cjs --only agent-server-dev`（进程名 agent-server-dev，非 ecosystem 里的 agent-server）。
- 验证脚本用 tsx 跑（非 node，因 config 为 .ts），打印 `listModels().map(m=>m.id)` 确认仅 9 个。

## 架构设计
无架构变更，仅配置裁剪。数据流向不变：`MODEL_PROVIDERS` → `config.listModels()` → `/models` 接口 → 前端下拉；`router-policy` 读 JSON 决定 auto 路由。

## 目录结构
```
apps/agent-server/
├── .env                                  # [MODIFY] 精简 MODEL_PROVIDERS 为 9 个（nemotronultra 置首）；删除 TokenHub 52 块（含 kinfrate06/KB_*）+ NVIDIA 4 块；KB_EMBEDDING=off；更新头部注释
├── data/
│   └── superpower-router-policy.json     # [MODIFY] fallbackModels 移除 glm5/glm52，仅保留 9 个保留模型
└── scripts/
    └── verify-models.mjs                 # [NEW] 临时验证脚本：打印 listModels() 确认仅 9 个且含保留项、无删除项（验证后删除）
```

## 关键代码结构
无新增代码接口；仅配置与 JSON 内容变更。

