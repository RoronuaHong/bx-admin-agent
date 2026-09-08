import { errorTokenResult, isToolErrorResult, okTokenResult, parseToolResultEnvelope } from "../src/tool-result-contract.ts";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    pass += 1;
    console.log(`PASS | [tool-result-contract] ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL | [tool-result-contract] ${name}`);
  }
}

const ok = okTokenResult("TOOL_PREF_READ", { sample: 1 }, { data: true });
const err = errorTokenResult("TOOL_CALL_API_HTTP_ERROR", { status: 500 }, { detail: "boom" });

check("parse ok envelope", parseToolResultEnvelope(ok)?.ok === true);
check("parse error envelope", parseToolResultEnvelope(err)?._i18n?.code === "TOOL_CALL_API_HTTP_ERROR");
check("json error recognized", isToolErrorResult(err) === true);
check("json ok not recognized as error", isToolErrorResult(ok) === false);
check("legacy text error recognized", isToolErrorResult("错误：请求失败；网络异常") === true);
check("plain text ok not error", isToolErrorResult("done") === false);

console.log(`\ntool-result-contract: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
