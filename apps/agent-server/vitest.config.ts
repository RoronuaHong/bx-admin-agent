import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 这些阈值被被测模块在 import 时读取，必须在导入前就位（等价于原脚本顶部的 process.env 赋值）。
    env: {
      // 测试专用库：绝不能与运行实例共用 bx_agent，否则测试写脏数据 / 失败留残、
      // 且与开发数据互相污染。与下面其它阈值同理，必须在模块 import 前就位。
      MONGO_DB_NAME: "bx_agent_test",
      // 运行时数据目录同理：trace / 上传 / 记忆 / 工作区都写到每次运行新建的临时目录，不碰仓库里的 .data。
      AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "bx-agent-vitest-")),
      MCP_MAX_TOOLS: "3",
      MCP_TOOL_RESULT_KEEP: "3",
      MCP_TOOL_RESULT_BUDGET: "200",
      MCP_TOOL_RESULT_PROTECT: "keepme",
      FS_MAX_FILE_BYTES: "1048576",
    },
  },
});
