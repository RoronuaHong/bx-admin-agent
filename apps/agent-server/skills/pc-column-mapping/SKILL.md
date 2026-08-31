---
name: pc-column-mapping
description: PC 字段对齐：渲染出现英文字段/表头或枚举值未翻译（数字/英文）时，按本技能到当前项目源码找中文映射后重新输出。
version: 1.0.0
---

# PC 后台字段中文化（源码找映射）

PC 后台管理系统（影视后台等）的字段名/表头是英文 dataIndex（`clientType`、`userGroupId`、`terminalFlag` 等），中文映射在**项目源码**里，**不要**凭经验猜测、**不要**自造中文名，必须从源码/字典中找到真实映射。

## 适用场景

- 表头/字段名是英文（不是字段值）→ 找「字段 → 中文名」映射
- 枚举值未翻译（数字、英文短值如 `1/0/2`、`ANDROID`）→ 找「值 → 中文 label」映射
- 位掩码字段（`terminalFlag`、`level` 等）→ 找「bit/位 → 中文 label」映射

## 方法（读当前项目源码）

你的工具（`read_file` / `grep_codebase`）已自动指向**当前项目**代码库，无需写项目路径前缀。

按顺序查（找到即止）：

1. **列定义**：`src/views/<模块目录>/configs.data.tsx`（或 `.ts`）的 `columns` 数组
   - `title` 字段即中文列名：`title: getTran('KEY','[中文]')` 的**第二个参数**是中文（去掉 `[` `]`）；`title: '中文'` 直接取
   - `dataIndex` 是英文字段名，与 `title` 一一对应
   - 模块目录不确定时：`grep_codebase` 搜 `dataIndex: 'clientType'` 或 `import ... from '/@/api/<模块>'` 定位
2. **枚举/下拉（含值翻译）**：同目录 `useFormSchema.ts` 的 `options: [{ value, label }]`；`options.ts`/`constant.ts` 的常量表
   - `customRender: (t) => MAP[t]` / `customRender: ({record}) => MAP[record.x]` → 跟随 `MAP`/`OPTIONS` 定义（`{ '1': '中文', '2': '中文' }`），MAP 可能 import 自其他文件（`import { ProviderType } from '/@/utils/...'`）→ 跟随 import 路径读定义
   - 简单三目 `t === 1 ? '是' : '否'` → 布尔/双值枚举
   - **数据里的枚举值（如 clientType=1、provider=3）也要翻译**：找出该值的 label 后，把渲染数据里的数字换成中文 label 再 `render_table`（如 provider: 3 → provider: 'Google'）；不要在最终答复里展示原始数字
3. **位掩码**：`options.ts` 里 `get*ByOperatorOptions` / `TERMINAL_FLAG` 等 `{ label, value: 2 的幂 }` → 按位展开为多值中文
4. **i18n**：列 title 是 `t('tran10.xxx')` 时 → `grep_codebase` 在 `src/locales/lang/zh-CN/` 找该 key 的中文

## 输出要求

- 用 `render_table` 推送到聊天预览：`columns` 传你从源码找到的中文表头
  （`[{ key: 'clientType', title: '客户端类型' }]`——key 必须与数据字段一致，title 填中文）
- `normalize_output` 只做格式规范（字段过滤/排序/条数修正），**不再提供字段中文化**；中文化一律经 `render_table` 的 `columns.title` 传入
- 表头必须是**中文**，与 PC 列定义一致；列顺序/裁剪以 PC 列为准
- 枚举值（如 enabled 的 true/false → 是/否）在渲染前把数据里的值转成中文，或保持通用布尔推断（服务端对 boolean 值已自动显示是/否，无需处理）
- **找不到映射的字段**：保留英文并明确说明「该字段源码中无中文映射」，不要编造
- 禁止：把 `terminalFlag` 简写成 `all`、把枚举猜成 `1=是 0=否`（必须源码里有）、输出原始英文 dataIndex 表头

## 多项目

工具已按当前会话项目读取源码；切项目后自动读对应项目的映射，不要跨项目套用字段含义。
