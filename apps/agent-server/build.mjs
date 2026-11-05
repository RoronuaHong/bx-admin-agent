// 生产构建：用 esbuild 把 agent-server 及其对 @bx/shared 的引用打包成单文件 ESM。
//
// 设计取舍（为什么不直接 tsc / 不跑 tsx）：
//  - @bx/shared 是 workspace 源码包（exports 直接指向 .ts），Node 运行时无法解析，
//    故在此显式把它解析到其 TS 源码并打进 bundle，运行时不再依赖该包。
//  - 第三方依赖（mongodb / hono / @modelcontextprotocol/sdk / exceljs ...）保持 external，
//    由运行时 node_modules 加载：避免打包原生 / CJS 依赖的不可预期问题，也便于依赖锁定与安全扫描。
//  - 产物是纯 JS，生产镜像里不需要 tsx / typescript / 源码，启动快、攻击面小。
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sharedEntry = resolve(here, "../../packages/shared/src/index.ts");

const plugins = [
  // 把对 @bx/shared 的裸导入重定向到其 TS 源码，使其被打包进 bundle。
  {
    name: "bx-shared-resolve",
    setup(b) {
      b.onResolve({ filter: /^@bx\/shared$/ }, () => ({ path: sharedEntry }));
    },
  },
  // 其余裸导入（node_modules 里的包）一律 external，运行时由 Node 加载。
  {
    name: "externalize-node-modules",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        // 相对路径（./ ../）、绝对路径（/ 或 Windows 盘符 X:\）交回 esbuild 默认解析；
        // 其余裸导入（node_modules 里的包）一律 external，运行时由 Node 加载。
        if (args.path.startsWith(".") || args.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.path)) {
          return undefined;
        }
        return { external: true };
      });
    },
  },
];

await build({
  entryPoints: [resolve(here, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(here, "dist/server.mjs"),
  sourcemap: true,
  plugins,
  logLevel: "info",
});

console.log("[build] agent-server -> apps/agent-server/dist/server.mjs");
