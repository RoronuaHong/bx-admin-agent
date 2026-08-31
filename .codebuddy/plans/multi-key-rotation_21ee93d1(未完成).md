---
name: multi-key-rotation
overview: 为 agent-server 的 NVIDIA 模型实现多 API key 共存与轮换：config 支持 key 池，models 发请求时轮询选择 + 429/5xx 自动切 key 重试，新增 nvlagunaxs 模型，前端动态下拉无需改。
todos:
  - id: extend-config-keypool
    content: 修改 config.ts：ModelEntry 增加 apiKeys key 池字段，listModels() 解析 MODEL_<ID>_API_KEYS 兼容 MODEL_<ID>_API_KEY
    status: pending
  - id: impl-rotation-retry
    content: 修改 models.ts：callOpenAiAgent/callAnthropicAgent 发请求前轮询选 key，429/5xx 时切下一 key 重试（有限次）
    status: pending
    dependencies:
      - extend-config-keypool
  - id: add-nvlagunaxs-env
    content: 编辑 .env：新增 MODEL_NVLANUNAXS_* 块（新 key）并加入 MODEL_PROVIDERS；给 nvnemotronultra/nvnemotronsuper 配置 API_KEYS 多 key 共存
    status: pending
  - id: update-router-policy
    content: 更新 superpower-router-policy.json：fallbackModels 加入 nvlagunaxs
    status: pending
  - id: restart-verify
    content: pm2 delete+start 重启 agent-server-dev，跑脚本确认 apiKeys 解析与 nvlagunaxs 注册，grep 无残留，验证后删脚本
    status: pending
    dependencies:
      - impl-rotation-retry
      - add-nvlagunaxs-env
      - update-router-policy
---

## 产品概述
为 agent-server 实现 NVIDIA NIM 模型的「多 API key 共存与轮换」能力，并将 NVIDIA Laguna-XS-2.1 模型加回注册表，使 http://192.168.50.129:5173/chat 前端的模型下拉可选用多个 NVIDIA 模型，且实际调用时在多个 key 间轮换、遇限流（429/5xx）自动切换下一个 key 重试，从而绕开 NVIDIA 免费层单 key 约 40 RPM 的限额。

## 核心功能
- 多 key 共存：每个模型可配置多个 API key（逗号分隔），服务端按 key 池管理
- 轮换使用：请求时按 round-robin 从 key 池选取一个 key 发起调用
- 自动重试：当前 key 触发 429/5xx 时，自动切换到下一个 key 重试（最多 key 数轮）
- 加回 NVIDIA Laguna-XS-2.1（nvlagunaxs），使用用户提供的新 key
- 将旧 key 与新 key 共存配置到 NVIDIA 模型上
- 兼容既有单 key 配置，不影响 zen 免费链与 TokenHub 模型
- 前端模型下拉动态拉取，无需改前端代码


## 技术栈
- 运行时：Node.js + TypeScript（pm2 托管 agent-server-dev，端口 8787）
- 模型加载：src/config.ts 的 listModels() 惰性读取 MODEL_PROVIDERS 与 MODEL_<ID>_* 环境变量
- 模型调用：src/models.ts 的 callOpenAiAgent / callAnthropicAgent 发请求
- 配置：.env、data/superpower-router-policy.json
- 前端：apps/web vite proxy → http://localhost:8787（129 即本地局域网 IP）

## 实现方案
### 策略
在 config.ts 将 ModelEntry 的 apiKey 单值扩展为 apiKeys key 池（保留 apiKey 单值兼容），在 models.ts 发请求处新增「轮询选 key + 限流切 key 重试」逻辑；随后在 .env 新增 nvlagunaxs 块并为 NVIDIA 模型配置多 key，最后更新 router-policy 并重启验证。

### 关键技术决策
1. **key 池数据结构**：ModelEntry 增加 `apiKeys: string[]`，listModels() 读 `MODEL_<ID>_API_KEYS`（逗号分隔），为空则退化读 `MODEL_<ID>_API_KEY` 单值。保留 `apiKey` 字段（取 apiKeys[0]）作为默认/兼容出口，避免 model.apiKey 在 models.ts 之外的其他引用点（已确认仅 L142/L243）出错，也避免波及 knowledge-embedding.ts / symbol-index.ts 的独立 cfg.apiKey（那是 KB 与索引用的独立配置，不受影响）。
2. **轮询算法**：模块级计数器 `keyRotationCounter`（进程内共享），每模型按 `(counter++) % apiKeys.length` 取 key，实现 round-robin 均匀分布。纯鉴权机制，不含业务词，符合红线。
3. **限流切 key 重试**：在 fetch 返回非 2xx 且 `apiKeys.length > 1` 时，对 429（限流）/5xx（服务端错误）自动切换下一个 key 重试，最多 `apiKeys.length` 轮；重试耗尽或非可重试错误（4xx 如 401/403）则抛出原错误。重试仅包装 fetch 调用层，不重复构造 messages/body，避免副作用。
4. **nginx/网关错误处理**：保留现有 401006/402 等错误原样抛出逻辑（L248 起），多 key 重试只在错误分类为可重试时介入。
5. **前端零改动**：模型下拉动态拉 /models，新增模型自动出现。

### 性能与可靠性
- round-robin 选 key 为 O(1)，无额外请求开销
- 重试次数严格受限于 key 数（≤ 3 轮），避免无限重试拖慢响应
- 模块级计数器无并发安全问题（Node 单线程事件循环）

## 实现注意事项
- 删除/新增 .env 模型块时整段操作，避免残留孤立 MODEL_<id>_* 键
- 重启必须 pm2 delete agent-server-dev → 确认 8787 释放（注意排查孤儿 node 进程占用端口，本次曾遇 PID 46672 占用）→ pm2 start ecosystem.dev.config.cjs --only agent-server-dev
- 验证：重启日志确认 models 列表含 nvlagunaxs；跑临时脚本确认多 key 配置解析正确；grep 确认无残留

## 架构设计
无架构变更，仅扩展模型鉴权层与配置。数据流向：
MODEL_PROVIDERS → config.listModels()（apiKeys key 池）→ /models 接口 → 前端下拉
models.ts callAgent → 轮询选 key → fetch → 429/5xx 切 key 重试 → 返回

## 目录结构
```
apps/agent-server/
├── .env                                  # [MODIFY] 新增 MODEL_NVLANUNAXS_* 块（新 key）；给 nvnemotronultra/nvnemotronsuper 配置 MODEL_<ID>_API_KEYS 多 key（旧+新）；MODEL_PROVIDERS 加入 nvlagunaxs
├── data/
│   └── superpower-router-policy.json     # [MODIFY] fallbackModels 加入 nvlagunaxs
├── src/
│   ├── config.ts                         # [MODIFY] ModelEntry 增加 apiKeys: string[]；listModels() 读 MODEL_<ID>_API_KEYS 兼容 API_KEY
│   └── models.ts                         # [MODIFY] callOpenAiAgent/callAnthropicAgent 发请求前从 apiKeys 轮询选 key；429/5xx 切 key 重试（新增辅助函数 pickRotationKey + retryWithNextKey）
└── scripts/
    └── verify-multikey.mjs               # [NEW] 临时验证脚本：确认 listModels() 各模型 apiKeys 解析正确、nvlagunaxs 已注册（验证后删除）
```

## 关键代码结构
```ts
// config.ts — ModelEntry 扩展
interface ModelEntry {
  // ...既有字段
  apiKey: string;      // 兼容保留，取 apiKeys[0]
  apiKeys: string[];   // 新增：多 key 池（MODEL_<ID>_API_KEYS 逗号分隔，空则退化为 [API_KEY]）
}

// listModels() 内解析（L82 附近）：
const apiKeys = (process.env[`${prefix}API_KEYS`] || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const keys = apiKeys.length ? apiKeys
  : (process.env[`${prefix}API_KEY`] || "").trim() ? [process.env[`${prefix}API_KEY`].trim()] : [];
// push: { ... , apiKey: keys[0] || "", apiKeys: keys }

// models.ts — 发请求前选 key：
function pickRotationKey(model: ModelEntry): string {
  const pool = model.apiKeys.length ? model.apiKeys : model.apiKey ? [model.apiKey] : [""];
  return pool[(rotationCounter++) % pool.length];
}
```


# Agent Extensions
无额外扩展需要；本次为本地配置与代码改造，未使用任何外部 Agent 扩展。
