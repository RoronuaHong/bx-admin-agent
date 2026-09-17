import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 这些阈值被被测模块在 import 时读取，必须在导入前就位（等价于原脚本顶部的 process.env 赋值）。
    env: {
      MCP_MAX_TOOLS: "3",
      MCP_TOOL_RESULT_KEEP: "3",
      MCP_TOOL_RESULT_BUDGET: "200",
      MCP_TOOL_RESULT_PROTECT: "keepme",
      FS_MAX_FILE_BYTES: "1048576",
    },
  },
});
