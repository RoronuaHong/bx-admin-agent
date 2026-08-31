---
name: export-preview
description: 用户要导出/下载文件或在聊天内预览表格（Excel/PDF、树表、汇总、表尾）时使用。
version: 1.0.0
---

# 导出与聊天预览

用户要「导出 / 下载 Excel/PDF / 树表 / 汇总」时：

1. 先有数据（`call_api` → `normalize_output`）
2. `render_table`：聊天内预览表；树传 `tree:true` 或 `children`；汇总传 `footer:{sum:['amount']}`
3. `export_dataset`：`format=xlsx|pdf`，同参生成文件；聊天会出现预览 + 下载按钮

不要编造文件链接；必须走上述工具。
