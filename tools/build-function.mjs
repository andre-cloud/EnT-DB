// Builds supabase/functions/submit/index.ts by embedding docs/assets/score.js into
// tools/function-template.ts, so the browser preview and the server use the same scoring.
//   node tools/build-function.mjs          write the file
//   node tools/build-function.mjs --check  fail if the file is out of date
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const score = readFileSync(join(root, "docs/assets/score.js"), "utf8");
const template = readFileSync(join(root, "tools/function-template.ts"), "utf8");
const marker = "/*__SCORE_JS__*/";
if (!template.includes(marker)) throw new Error("marker missing in template");
const out = template.replace(marker, () => "// ---- begin docs/assets/score.js ----\n" + score + "// ---- end docs/assets/score.js ----");
const target = join(root, "supabase/functions/submit/index.ts");

if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== out) { console.error("index.ts is out of date: run node tools/build-function.mjs"); process.exit(1); }
  console.log("index.ts is up to date");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out);
  console.log("wrote", target);
}
