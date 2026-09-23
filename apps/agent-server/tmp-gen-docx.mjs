// 临时：生成一个 docx 供解开检查 XML（跑完即删）。
const { execBuiltin } = await import("./src/builtins.js");
const out = await execBuiltin(
  "export_data",
  JSON.stringify({
    filename: "inspect.docx",
    title: "边框验证",
    rows: [
      { 名称: "甲", 数量: 1 },
      { 名称: "乙", 数量: 2 },
    ],
  }),
  "tmp-docx-inspect",
);
console.log("ok=", out.ok, "path=", out.artifact?.path, "bytes=", out.artifact?.bytes);
