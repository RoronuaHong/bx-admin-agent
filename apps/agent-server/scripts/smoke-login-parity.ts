import { enrichLoginDataTotalParams, presentLoginDataTotal, extractReportRows } from "../src/report-pc-parity.ts";
import { mockCallApiResult } from "../src/mock-upstream.ts";

const params = enrichLoginDataTotalParams({}, "登录数据统计，近7天，google登录方式的数据和图表");
console.log("params", JSON.stringify(params));
const mocked = mockCallApiResult({
  operation: "report.getLoginDataTotal",
  path: "/film-passport/management/v1.5.0/report/loginDataTotal",
  params,
});
const content = JSON.stringify(mocked, null, 2);
const rows = extractReportRows(content);
console.log("rows", rows.length);
console.log("first", rows[0]);
console.log("last", rows[rows.length - 1]);
const presented = presentLoginDataTotal(rows, params);
console.log("---REPLY---");
console.log(presented.reply.slice(0, 400));
console.log("UI_TABLE", presented.tableBlock.includes("UI_TABLE"));
console.log("UI_CHART", presented.chartUiBlock.includes("UI_CHART"));
console.log("chart", /图表摘要/.test(presented.chartBlock));
console.log("chartJson", presented.chartUiBlock.split("\n")[1]?.slice(0, 200));
