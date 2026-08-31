---
name: multi-key-rotation
overview: 为 agent-server 的 NVIDIA 模型实现「共享 key 池 + 轮换」：所有 NVIDIA 模型共用一套多 key（旧+新），请求时 round-robin 轮换并遇 429/5xx 自动切 key 重试；加回 nvlagunaxs 模型，前端动态下拉无需改。
todos:
  - id: extend-config-keypool
    content: 修改 config.ts：ModelEntry 增加 apiKeys key 池字段，listModels() 对 NVIDIA 模型注入共享池（NVIDIA_API_KEYS）、非 NVIDIA 退化单 key
    status: completed
  - id: impl-rotation-retry
    content: 修改 models.ts：callOpenAiAgent/callAnthropicAgent 发请求前轮询选 key，429/5xx 时切下一 key 重试（有限次）
    status: completed
    dependencies:
      - extend-config-keypool
  - id: add-nvidia-pool-env
    content: 编辑 .env：新增 NVIDIA_API_KEYS=旧key,新key；MODEL_PROVIDERS 加入 nvlagunaxs
    status: completed
  - id: update-router-policy
    content: 更新 superpower-router-policy.json：fallbackModels 加入 nvlagunaxs
    status: completed
  - id: restart-verify
    content: pm2 delete+start 重启 agent-server-dev，跑脚本确认 apiKeys 解析与 nvlagunaxs 注册，用 [mcp:chrome-devtools] 验证前端下拉，验证后删脚本
    status: completed
    dependencies:
      - impl-rotation-retry
      - add-nvidia-pool-env
      - update-router-policy
---


## 产品概述
为 agent-server 实现 NVIDIA NIM 模型的「多 API key 共享池与轮换」能力：引入全局 NVIDIA key 池，所有 NVIDIA 模型共享该池，实际调用时在多个 key 间轮换、遇限流（429/5xx）自动切换下一个 key 重试，从而绕开 NVIDIA 免费层单 key 约 40 RPM 的限额；同时将 NVIDIA Laguna-XS-2.1（nvlagunaxs）加回模型注册表，使 http://192.168.50.129:5173/chat 前端的模型下拉可选用它。

## 核心功能
- NVIDIA 共享 key 池：新增全局配置 NVIDIA_API_KEYS（逗号分隔多个 nvapi-* key），所有指向 NVIDIA 端点的模型共享此池
- 轮换使用：请求时按 round-robin 从共享池选取一个 key 发起调用
- 自动重试：当前 key 触发 429/5xx 时，自动切换池中下一个 key 重试（最多 key 数轮）
- 加回 NVIDIA Laguna-XS-2.1（nvlagunaxs）：加入 MODEL_PROVIDERS，前端下拉可选用
- 兼容既有单 key 配置：非 NVIDIA 模型（zen 免费链 / TokenHub）仍用各自 MODEL_<ID>_API_KEY，不受影响
- 前端模型下拉动态拉取（/models），无需改前端代码

## 技术栈
- 运行时：Node.js + TypeScript（pm2 托管 agent-server-dev，端口 8787）
- 模型加载：src/config.ts 的 listModels() 惰性读取 MODEL_PROVIDERS 与 MODEL_<ID>_* 环境变量
- 模型调用：src/models.ts 的 callOpenAiAgent / callAnthropicAgent 发请求
- 配置：.env、data/superpower-router-policy.json
- 前端：apps/web vite proxy → http://localhost:8787（192.168.50.129 为本地局域网 IP）



## 技术栈
- 运行时：Node.js + TypeScript（pm2 托管 agent-server-dev，端口 8787）
- 模型加载：src/config.ts 的 listModels() 惰性读取 MODEL_PROVIDERS 与 MODEL_<ID>_* 环境变量
- 模型调用：src/models.ts 的 callOpenAiAgent / callAnthropicAgent 发请求
- 配置：.env、data/superpower-router-policy.json

## 实现方案
### 策略
在 config.ts 中为 ModelEntry 增加 apiKeys key 池字段（对 NVIDIA 端点模型注入共享池，非 NVIDIA 模型退化为单 key），在 models.ts 发请求处新增「轮询选 key + 限流切 key 重试」逻辑；随后在 .env 新增 NVIDIA_API_KEYS 全局共享池、加回 nvlagunaxs，更新 router-policy 并重启验证。

### 关键技术决策
1. **共享池数据来源**：新增全局环境变量 NVIDIA_API_KEYS（逗号分隔）。listModels() 读取后，对 baseUrl 命中 NVIDIA 端点（integrate.api.nvidia.com 前缀）的模型注入 apiKeys 池；非 NVIDIA 模型 apiKeys 退化为各自 MODEL_<ID>_API_KEY 单值。NVIDIA_API_KEYS 为空时 NVIDIA 模型同样退化用各自 API_KEY，保证兼容。
2. **NVIDIA 端点判定**：用 baseUrl 前缀匹配 integrate.api.nvidia.com（通用端点判断，非业务词，符合红线）。
3. **轮询算法**：模块级计数器 keyRotationCounter（进程内共享），按 (counter++) % pool.length 取 key，round-robin 均匀分布。纯鉴权机制，无业务词。
4. **限流切 key 重试**：在 fetch 返回非 2xx 且 pool.length > 1 时，对 429/5xx 自动切换下一个 key 重试，最多 pool.length 轮；重试耗尽或非可重试错误（4xx 如 401/403）则抛出原错误。重试仅包装 fetch 调用层，不重复构造 messages/body。
5. **保留 apiKey 字段**：ModelEntry 保留 apiKey（取 apiKeys[0]）作兼容出口，避免 models.ts 之外引用点出错（已确认仅 L142/L243 使用）。
6. **前端零改动**：模型下拉动态拉 /models，新增模型自动出现。

### 性能与可靠性
- round-robin 选 key O(1)，无额外请求开销
- 重试次数严格受限于 key 数（≤ 3 轮），避免无限重试拖慢响应
- 模块级计数器无并发问题（Node 单线程事件循环）

## 实现注意事项
- 重启必须 pm2 delete agent-server-dev → 确认 8787 释放（注意排查孤儿 node 进程占用端口）→ pm2 start ecosystem.dev.config.cjs --only agent-server-dev
- 验证：重启日志确认 models 列表含 nvlagunaxs；跑临时脚本确认 apiKeys 池解析正确（NVIDIA 模型共享池、非 NVIDIA 单 key）；grep 确认无残留
- load-env.ts 已在上一轮修复 require 误用，重启后应无 ReferenceError

## 架构设计
无架构变更，仅扩展模型鉴权层与配置。数据流向：
MODEL_PROVIDERS + NVIDIA_API_KEYS → config.listModels()（apiKeys key 池）→ /models 接口 → 前端下拉
models.ts callAgent → 轮询选 key → fetch → 429/5xx 切 key 重试 → 返回

## 目录结构
```
apps/agent-server/
├── .env                                  # [MODIFY] 新增 NVIDIA_API_KEYS=旧key,新key；MODEL_PROVIDERS 加入 nvlagunaxs
├── data/
│   └── superpower-router-policy.json     # [MODIFY] fallbackModels 加入 nvlagunaxs
├── src/
│   ├── config.ts                         # [MODIFY] ModelEntry 增加 apiKeys: string[]；listModels() 对 NVIDIA 模型注入共享池，非 NVIDIA 退化单 key
│   └── models.ts                         # [MODIFY] callOpenAiAgent/callAnthropicAgent 发请求前从 apiKeys 轮询选 key；429/5xx 切 key 重试
└── scripts/
    └── verify-multikey.mjs               # [NEW] 临时验证脚本：确认 apiKeys 解析与 nvlagunaxs 注册（验证后删除）
```

## 关键代码结构
```ts
// config.ts — ModelEntry 扩展
interface ModelEntry {
  // ...既有字段
  apiKey: string;      // 兼容保留，取 apiKeys[0]
  apiKeys: string[];   // 新增：key 池（NVIDIA 共享 / 非 NVIDIA 单 key）
}

// listModels() 内解析（L82 附近）：
const baseUrl = process.env[`${prefix}BASE_URL`] || defaultBase;
const isNvidia = baseUrl.includes("integrate.api.nvidia.com");
const sharedPool = (process.env.NVIDIA_API_KEYS || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const singleKey = (process.env[`${prefix}API_KEY`] || "").trim();
const keys = isNvidia && sharedPool.length ? sharedPool
  : singleKey ? [singleKey] : [];
// push: { ... , baseUrl, apiKey: keys[0] || "", apiKeys: keys }

// models.ts — 发请求前选 key（模块级计数器）：
let keyRotationCounter = 0;
function pickRotationKey(model: ModelEntry): string {
  const pool = model.apiKeys.length ? model.apiKeys : model.apiKey ? [model.apiKey] : [""];
  return pool[(keyRotationCounter++) % pool.length];
}
```


## Agent Extensions
- **chrome-devtools（MCP）**
  - 用途：在 http://192.168.50.129:5173/chat 打开前端模型下拉，验证 nvlagunaxs 模型是否出现且可选、模型列表动态拉取正常
  - 预期结果：前端下拉能选到 NVIDIA 模型，验证「加回 nvlagunaxs」对用户可见生效
