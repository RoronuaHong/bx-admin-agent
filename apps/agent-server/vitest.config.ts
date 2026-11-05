import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { defineConfig } from "vitest/config";

// 本地 .env 里的 MONGO_URI（可能带凭据）要与开发实例一致：
// Mongo 开启认证后，无凭据连接能握手成功、但每条命令都报 "requires authentication"，
// 依赖 Mongo 的用例会整片失败——看着像回归，其实只是没凭据。
// 只取 MONGO_URI：整份 .env 灌进测试环境会带进模型密钥与 MCP 配置，改变用例行为。
// 显式的环境变量优先（CI 里 workflow 传的就是无认证的本地实例）。
//
// 用 dotenv 的 parse（而不是 config）：config 会把整份 .env 写进 process.env，
// 于是模型密钥、JEV_API_KEY 之类会渗进测试环境、改变用例行为（jev 用例依赖「未配置 Jev」）。
const envPath = join(fileURLToPath(new URL(".", import.meta.url)), ".env");
let localEnv: Record<string, string> = {};
try {
  localEnv = parse(readFileSync(envPath));
} catch {
  // 没有 .env（如 CI）：就用默认连接串，不影响。
}
const mongoUri = process.env.MONGO_URI || localEnv.MONGO_URI;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 这些阈值被被测模块在 import 时读取，必须在导入前就位（等价于原脚本顶部的 process.env 赋值）。
    env: {
      // 测试专用库：绝不能与运行实例共用 bx_agent，否则测试写脏数据 / 失败留残、
      // 且与开发数据互相污染。与下面其它阈值同理，必须在模块 import 前就位。
      // （本地 Mongo 开了认证时，若账号只有 bx_agent 的权限，用 MONGO_TEST_DB_NAME 指到一个有权限的库。）
      MONGO_DB_NAME: process.env.MONGO_TEST_DB_NAME || "bx_agent_test",
      // 运行时数据目录同理：trace / 上传 / 记忆 / 工作区都写到每次运行新建的临时目录，不碰仓库里的 .data。
      AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "bx-agent-vitest-")),
      MCP_MAX_TOOLS: "3",
      MCP_TOOL_RESULT_KEEP: "3",
      MCP_TOOL_RESULT_BUDGET: "200",
      MCP_TOOL_RESULT_PROTECT: "keepme",
      FS_MAX_FILE_BYTES: "1048576",
      // 连接串可能来自 .env（本地 Mongo 开了认证）；都没有就不设，走 db.ts 的默认地址。
      ...(mongoUri ? { MONGO_URI: mongoUri } : {}),
    },
  },
});
