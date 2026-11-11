// Fails if any published data or page carries a link where only a DOI belongs, or a DOI that is malformed.
// Run: node tools/check-links.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
(0, eval)(readFileSync(join(root, "docs/assets/score.js"), "utf8"));
const S = globalThis.EntScore;
const problems = [];
const forbidden = /ezproxy|unibo\.it/i;

const bdir = join(root, "docs/batches");
for (const f of readdirSync(bdir).filter((x) => /^batch-\d+\.json$/.test(x))) {
  for (const r of JSON.parse(readFileSync(join(bdir, f), "utf8"))) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && (/https?:\/\//i.test(v) || forbidden.test(v))) problems.push(`${f} ${r.import_key} ${k}: contains a link`);
    }
    if (r.doi && !S.isDoi(r.doi)) problems.push(`${f} ${r.import_key}: "${r.doi}" is not a DOI`);
    for (const u of r.uses || []) if (!S.isDoi(u.doi)) problems.push(`${f} ${r.import_key}: used-in "${u.doi}" is not a DOI`);
    if (r.cas && !S.casValid(r.cas)) problems.push(`${f} ${r.import_key}: "${r.cas}" is not a valid CAS number`);
  }
}
const seed = readFileSync(join(root, "supabase/seed.sql"), "utf8");
if (/'https?:\/\//i.test(seed) || forbidden.test(seed)) problems.push("supabase/seed.sql contains a link");
for (const f of ["docs/index.html", "docs/admin.html", "docs/assets/common.js", "docs/assets/app.js", "docs/assets/admin.js"]) {
  if (forbidden.test(readFileSync(join(root, f), "utf8"))) problems.push(`${f} mentions a library proxy`);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("link check passed: DOIs only");
