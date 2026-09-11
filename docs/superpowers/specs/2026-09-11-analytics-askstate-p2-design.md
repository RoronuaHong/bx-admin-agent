# Analytics AskState P2：服务端线性栈 · Undo · CI

> **状态**：已落地（线性栈 + undo API + 前端撤销 + CI 单测）  
> **日期**：2026-09-11  
> **决策**：方案 A（线性 Ask 栈，非分支树）  
> **关联**：[`2026-09-11-analytics-askstate-design.md`](./2026-09-11-analytics-askstate-design.md)

## 目标

- 跨刷新 / 跨设备续问仍带工作记忆（Mongo `analytics_conversations.askStateStack`）
- 线性 Undo：pop 栈顶，不删聊天气泡
- CI：栈单测进 `test:analytics`；live smoke 不进默认 PR CI

## 模型

```ts
type AskStateStack = {
  states: AskState[]; // max 20; top = current
  updatedAt: number;
};
```

## API

- `POST /analytics/conversations/:id/ask-state` body `{ askState }` → push（同 askId 替换）
- `POST /analytics/conversations/:id/ask-state/undo` → pop，返回 `{ stack, current }`
- GET/list conversations 带上 `askStateStack`
- messages upsert 可选附带 `askStateStack`

## Undo

- 只改栈；消息保留
- 栈空：ok + 提示
- clear / 新会话：清空栈

## 前端

- 恢复会话：远端栈顶 → `lastAskState`（优先于仅本地）
- 每次 ok/clarify：push 远端 + 本地
- 「撤销上一 Ask」：栈深 ≥ 2 可用

## 非目标

- fork / 分支树 UI、跨会话搜索
