// 批量探测：对同一远程 MCP 发起多个不同 query，看每个 query 各自返回哪些片名。
// 目的：复现「不同查询都返回闪灵/午夜凶铃」的异常，判断是服务端问题还是模型误报。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = "https://orca-mcp.mmdju.workers.dev/mcp";
const QUERIES = [
  "The Shining", "Ringu", "A Quiet Place", "Train to Busan",
  "Psycho", "Get Out", "The Wailing", "Saw", "Suspiria", "A Tale of Two Sisters",
];

const client = new Client({ name: "movie-batch", version: "0" }, { capabilities: {} });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)), { timeout: 30000 });
  for (const q of QUERIES) {
    const res = await client.callTool({ name: "movies_search", arguments: { query: q, language: "zh-CN" } }, undefined, { timeout: 60000 });
    const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let titles = [];
    try {
      const json = JSON.parse(text);
      titles = (json.items || []).map((it) => `${it.title}(${it.year})`);
    } catch {
      titles = [text.slice(0, 80)];
    }
    console.log(`\n[query=${q}] isError=${Boolean(res.isError)} -> ${titles.slice(0, 5).join(" | ") || "(empty)"}`);
  }
} catch (err) {
  console.log(`[FAIL] ${String(err?.message || err)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
