import fs from "node:fs";
const p = ".data/notify-channels.json";
const d = JSON.parse(fs.readFileSync(p, "utf8"));
console.log(JSON.stringify(d, null, 1));
