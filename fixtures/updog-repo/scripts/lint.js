import fs from "node:fs";

const source = fs.readFileSync(new URL("../packages/core/core.js", import.meta.url), "utf8");
if (source.includes("var ")) process.exit(1);
console.log("fixture lint passed");
