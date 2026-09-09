# 多语言运行时契约

> 更新时间：2026-09-08  
> 目的：把当前多语言治理从“零散修补”收口为统一实现契约，覆盖 Web UI、agent-server 非 LLM 文本、工具结果展示与 LLM 回复语言策略。

---

## 1. 目标边界

本项目当前的多语言治理分为三层：

1. **非 LLM 文本必须受 UI locale 严格约束**
   - 页面按钮、标签、占位符、提示语
   - HTTP / SSE 错误
   - 工具结果中的固定系统文案
   - 服务端 fallback / cancel / export 等兜底提示

2. **LLM 正文单独受 reply-language 策略约束**
   - 不与 UI locale 简单绑定
   - 按用户意图、偏好、当前输入语言、会话历史综合决策

3. **原始内容展示受 target-content-language 策略约束**
   - 历史用户消息
   - 历史助手消息
   - 历史 reasoning 文本
   - 知识库/文档摘要
   - 源码片段、文件正文、自由文本诊断字段

这三层不能混用。

---

## 2. 术语

- **UI locale**：前端界面语言，如 `zh` / `en` / `pt-BR` / `hi`
- **reply language**：LLM 正文回复语言
- **target content language**：原始内容是否允许直接展示的判定语种；当前复用用户显式 `replyLanguage` 偏好
- **token/code 契约**：后端返回结构化语言码，由前端映射为当前 UI locale 文案
- **固定系统文案**：系统自己生成的说明、错误、状态、包装语，不是业务数据本体
- **内容本体**：业务字段值、源码原文、知识库命中片段、外部文档 snippet 等源内容

---

## 3. 当前主流程

1. 前端保存并切换 `uiLocale`
2. `ChatPage` 发起 `streamChat()` 时透传 `uiLocale`
3. `chatStream()`：
   - 用 `resolveReplyLanguage()` 决定 LLM 正文语言
   - 用 `uiLocale` 控制服务端固定 fallback 文本
4. `/auth/me` 返回用户 `preferences.replyLanguage`，前端将其归一化为 `target content language`
5. 后端优先返回结构化 token/code，而不是原始 message-first 字符串
6. 前端通过以下入口做最终显示：
   - `localizeToken()`：HTTP/SSE/token 文本本地化
   - `displayConversationTitleForLocale()` / `displayMessageTextForLocale()` / `displayReasoningTextForLocale()`：历史标题、消息正文与 reasoning 按内容策略裁决
   - `presentToolResult()`：工具结果结构化展示、递归 code 解析、固定文案本地化、对无 `_i18n` 的旧结构结果继续执行源内容 fail-closed
   - `presentToolLabel()`：工具名展示本地化

---

## 4. 非 LLM 文本规则

### 4.1 必须 token/code 化的内容

以下内容禁止直接返回原始中文/英文固定文案：

- API 错误
- SSE 错误事件
- 工具报错
- 工具成功结果中的固定说明字段
- 服务端 fallback 提示
- 取消、导出、权限、能力边界等系统提示

推荐格式：

```json
{
  "ok": false,
  "_i18n": {
    "code": "TOOL_CALL_FAILED",
    "params": {
      "name": "call_api"
    }
  }
}
```

### 4.2 工具结果中的说明字段

工具结果内允许出现结构化扩展字段，前端应递归解析：

- `hintCode` + `hintParams`
- `guideCode`
- `outputHintCode`
- 任意 `*Code` + 同名 `*Params`

禁止新增新的裸说明字段而不提供 code 版本。

### 4.3 UI transport 包装

`UI_TABLE` / `UI_FILE` / `UI_CHART` 属于传输协议，不应依赖其后附带的自然语言包装文案作为最终展示来源。

规则：

- 聊天气泡中的结构化表格/文件以上屏 payload 为准
- 工具卡中如命中 `UI_TABLE` / `UI_FILE`，应优先展示结构化内容
- 包装层的原始中文说明应省略或替换为当前 locale 的通用提示

---

## 5. LLM 正文语言策略

`resolveReplyLanguage()` 当前优先级：

1. 用户已保存偏好
2. 当前输入语言
3. 会话上一次回复语言
4. 当前 UI locale

说明：

- UI locale 只作为最后兜底，不主导 LLM 正文
- 用户若显式连续用另一种语言提问，应允许正文跟随切换
- 已持久化偏好优先于当前输入检测

---

## 6. Fail-Closed 原则

当系统无法确认某段文本应以哪种方式安全展示时，优先选择“隐藏不安全原文”，而不是直接透传。

当前策略：

- 原始 `错误：...` 文本在非中文 UI 下显示为通用错误提示
- 原始诊断字段（如 `hint` / `_hint` / `guide` / `detail`）若与 `target content language` 不一致，则显示为隐藏占位
- `UI_TABLE` / `UI_FILE` 工具结果的包装文本不再直接显示
- 历史标题、历史用户消息、历史助手消息若与 `target content language` 不一致，则显示为隐藏占位
- 历史 reasoning 文本若与 `target content language` 不一致，则显示为隐藏占位
- 历史错误优先持久化 `errorToken`，重放时按当前 `uiLocale` 重新本地化；缺 token 的旧数据仅作为兼容兜底
- 知识摘要、源码片段、文件正文等源内容若与 `target content language` 不一致，则显示为隐藏占位

---

## 7. 内容本体展示策略

以下内容默认视为“内容本体”，当前不自动翻译：

- 业务数据字段值
- 知识库检索命中正文
- DingTalk 文档 snippet
- 源码片段、文件内容
- 用户上传文档原文

当前严格模式下：

- 结构化标识值（如 URL、文件名、path、id、状态枚举、数字）保持可见
- 自然语言源内容若与 `target content language` 不一致，则默认隐藏
- UI locale 仅决定“隐藏占位文案”用什么界面语言显示，不决定是否隐藏内容本体

---

## 8. 新增功能时的检查清单

新增页面、接口、工具或 fallback 时，必须逐项检查：

1. 是否新增了固定系统文案？
2. 若有，是否使用 token/code 或 locale 分流？
3. 工具结果是否混入了裸 `hint` / `guide` / `message`？
4. 前端展示路径是否会把原始 payload 直接渲染出来？
5. 固定系统文案是否只受 `uiLocale` 控制，而没有误绑到内容语种策略？
6. 原始内容是否按 `target content language` 做了准入判断？
7. 葡语/印地语是否只回退到对应翻译，而不是英文工具 id？

---

## 9. 当前已落地的关键实现点

- `apps/web/src/localize.ts`
- `apps/web/src/content-language.ts`
- `apps/web/src/tool-result-presenter.ts`
- `apps/web/src/chat-stream-events.ts`
- `apps/web/src/chat-storage.ts`
- `apps/web/src/pages/ChatPage.vue`
- `apps/agent-server/src/chat.ts`
- `apps/agent-server/src/chat-task-persistence.ts`
- `apps/agent-server/src/tool-result-contract.ts`
- `apps/agent-server/src/report-pc-parity.ts`
- `apps/agent-server/src/output-tools.ts`
- `apps/agent-server/src/app.ts`
- `apps/agent-server/src/tools/knowledge-base.ts`

---

## 10. 当前策略边界

当前已落地的是：

- 系统固定文案由 `uiLocale` 严格本地化
- LLM 正文由 `replyLanguage` 策略决定
- 历史消息、历史 reasoning、知识摘要、源码/文件摘录、诊断自由文本由 `target content language` 决定是否允许展示
- 后台任务在断线后落库时，需尽量保留与前台会话一致的助手消息结构（如 `reasoning` / `toolResults` / `errorToken`）

当前仍未做的是：

- 对被隐藏内容自动翻译
- 原文与翻译双显
- 用户在前端手动展开被隐藏原文

这些能力若要加入，属于下一阶段产品策略扩展，而不是当前基础契约的默认行为。
