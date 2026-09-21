import { getUploadFile } from "../src/uploads.js";
import { parseFile } from "../src/rag/parsers.js";

const id = process.argv[2];
if (!id) {
  console.log("usage: node _probe-attach.mjs <uploadId>");
  process.exit(1);
}
const f = getUploadFile(id);
if (!f) {
  console.log("getUploadFile: null (过期或不存在)");
  process.exit(0);
}
console.log("stored name:", f.name, "mediaType:", f.mediaType, "path:", f.path);
const parsed = await parseFile(f.path);
if ("error" in parsed) {
  console.log("PARSE ERROR:", parsed.error);
} else {
  console.log("PARSE OK; textLen:", parsed.text.length);
  console.log("has 差旅费:", parsed.text.includes("差旅费"));
  console.log("HEAD:", parsed.text.slice(0, 80));
}
