/**
 * 澄清闸门评测：验证歧义输入是否触发 CLARIFICATION_REQUIRED。
 */
import { execCallApi } from "../src/tools.ts";

const cases = [
  {
    name: "missing operation",
    input: { method: "GET" },
    expectClarification: true,
  },
  {
    name: "unknown operation",
    input: { method: "GET", operation: "getById" },
    expectClarification: true,
  },
  {
    name: "resolved operation",
    input: { method: "GET", operation: "film.getById", params: { id: "1" } },
    expectClarification: false,
  },
];

let pass = 0;
for (const c of cases) {
  const out = await execCallApi(c.input, {});
  const got = out.startsWith("CLARIFICATION_REQUIRED");
  const ok = got === c.expectClarification;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | ${c.name} | expect=${c.expectClarification} | got=${got}`);
}

console.log(`\nTOTAL: ${pass}/${cases.length} (${((pass / cases.length) * 100).toFixed(1)}%)`);

