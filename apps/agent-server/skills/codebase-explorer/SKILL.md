---
name: codebase-explorer
description: 高效浏览本地代码库：引导工具调用顺序、避免无效翻目录。用户要求看代码、找实现、了解结构与构建方式时使用。
version: 1.0.0
---

# 浏览本地代码库指南

用户要求查看本地代码项目时，按以下方式使用工具。目标是：**最少轮次拿到最关键信息**，不要逐层展开整棵树。

## 流程

1. 先 `list_dir` 项目根目录，**跳过** node_modules、dist、build、pre-dist、.git、.husky、.vscode、.cursor 等非源码目录，不要进入。
2. 定位用户在意的领域（接口/页面/构建/测试等），直接 `list_dir` 对应子目录：
   - 接口定义 → 常见 `src/api`、`src/api/modules`
   - 页面/组件 → `src/views`、`src/components`
   - 构建配置 → 根目录 `package.json`、`vite.config.*`、`*.config.js/ts`
3. 需要细节时用 `read_file` 读单个文件，**一次并行读多个**（同一轮内发起多个 read_file 调用）。
4. 有疑问的路径可以直接 `read_file` 试探，失败信息会给提示，不要因一次失败就放弃线索。

## 输出

- 直接给出结论（接口路径、实现位置、关键代码片段），不输出"我按步骤翻了一遍目录"的过程记录。
- 若目标未找到，说明已检查过的位置和下一步建议路径。

## 例子

问了"兑换码详情接口在哪"：

1. `list_dir(root)` → 看到 `src/api/vipExchangeCode.ts`
2. `read_file(src/api/vipExchangeCode.ts)` + `read_file(src/api/base.ts)`（同轮并行）
3. 直接回答：接口 URL、参数、拼接规则。