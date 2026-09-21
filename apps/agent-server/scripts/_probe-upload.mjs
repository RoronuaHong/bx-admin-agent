import fs from "node:fs";

const PDF = "d:\\Code\\bx-admin-agent\\docs\\knowledge\\财务\\差旅费补充规定.pdf";
const buf = fs.readFileSync(PDF);
const form = new FormData();
form.append("files", new Blob([buf], { type: "application/pdf" }), "差旅费补充规定.pdf");

try {
  const res = await fetch("http://localhost:8787/chat/upload", { method: "POST", body: form });
  const text = await res.text();
  console.log("HTTP", res.status);
  console.log("BODY", text);
} catch (e) {
  console.log("ERR", e.message);
}
