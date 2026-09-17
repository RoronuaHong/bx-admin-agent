// 从实例 OpenAPI（/api/docs/openapi.json）打印我们用到/待加端点的权威签名，用于对齐文档。
import "dotenv/config";

const BASE = (process.env.BI_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.BI_API_KEY || "";

const res = await fetch(`${BASE}/api/docs/openapi.json`, { headers: { "X-API-Key": KEY } });
if (!res.ok) {
  console.log(`openapi 获取失败：${res.status}`);
  process.exit(1);
}
const spec = await res.json();
const paths = spec.paths || {};
console.log(`openapi=${spec.openapi} title=${spec.info?.title} version=${spec.info?.version} paths=${Object.keys(paths).length}`);

const WANTED = [
  "/api/database",
  "/api/database/{id}/metadata",
  "/api/dataset",
  "/api/dataset/native",
  "/api/card/{id}/query",
  "/api/table",
  "/api/table/{id}/query_metadata",
  "/api/card",
  "/api/card/{id}",
  "/api/dashboard",
  "/api/dashboard/{id}",
  "/api/search",
];

function typeOf(schema) {
  if (!schema) return "-";
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (schema.type === "array") return `array<${typeOf(schema.items)}>`;
  if (schema.type) return schema.type;
  if (schema.oneOf) return `oneOf<${schema.oneOf.map(typeOf).join("|")}>`;
  if (schema.anyOf) return `anyOf<${schema.anyOf.map(typeOf).join("|")}>`;
  if (schema.allOf) return `allOf<${schema.allOf.map(typeOf).join("+")}>`;
  return "object";
}

for (const p of WANTED) {
  const item = paths[p];
  if (!item) {
    console.log(`\n=== ${p}  ❌ OpenAPI 中不存在此路径`);
    continue;
  }
  for (const [method, op] of Object.entries(item)) {
    if (!["get", "post", "put", "delete"].includes(method)) continue;
    console.log(`\n=== ${method.toUpperCase()} ${p}  (${op["x-metabase-visibility"] || ""})`);
    console.log(`  summary: ${op.summary || "-"}`);
    const params = (op.parameters || []).map((x) => `${x.name}${x.required ? "*" : ""}:${typeOf(x.schema)}`);
    if (params.length) console.log(`  params: ${params.join(", ")}`);
    const rb = op.requestBody?.content?.["application/json"]?.schema;
    if (rb) {
      console.log(`  body: ${typeOf(rb)}${rb.required ? ` required=[${rb.required.join(",")}]` : ""}`);
      if (rb.properties) {
        console.log(`  bodyProps: ${Object.keys(rb.properties).join(", ")}`);
        for (const [k, v] of Object.entries(rb.properties)) {
          const inner = v?.properties ? ` → {${Object.keys(v.properties).join(",")}}` : "";
          console.log(`    - ${k}: ${typeOf(v)}${inner}${v?.required ? ` required=[${v.required.join(",")}]` : ""}`);
        }
      }
    }
    const codes = Object.keys(op.responses || {}).join(",");
    console.log(`  responses: ${codes}`);
    if (op.deprecated) console.log("  ⚠ deprecated");
  }
}
