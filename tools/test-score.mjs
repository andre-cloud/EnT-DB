// Checks the scoring rules. Run: node tools/test-score.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
(0, eval)(readFileSync(join(root, "docs/assets/score.js"), "utf8"));
const S = globalThis.EntScore;

const full = {
  name: "Styrene", smiles: "C=Cc1ccccc1", role: "acceptor", et: "2.69", unit: "ev", unc: "0.02",
  origin: "exp", kind: "Spectroscopic, 0-0 band", tech: "Electron-energy-loss spectroscopy", solvent: "Solid argon", temp: "15 K",
  cite: "Example J. 2000, 1, 1", doi: "https://doi.org/10.1234/example.5678", loc: "Abstract", quote: "0-0 transition at 2.69 eV", uv: "248 nm",
};
const okCtx = { structureOk: true, doiResolves: true, same: [] };

// every branch sums to 100
for (const origin of ["exp", "calc"]) {
  const sc = S.scoreEntry(S.normalize({ ...full, origin }), okCtx);
  assert.equal(sc.items.reduce((a, i) => a + i.max, 0), 100, origin + " max");
}
// a complete experimental entry scores 100
let f = S.normalize(full);
assert.equal(S.scoreEntry(f, okCtx).total, 100);
assert.equal(S.scoreEntry(f, okCtx).grade, "Good");
// unit conversion and DOI clean-up
assert.ok(Math.abs(f.kcal - 62.03) < 0.01);
assert.equal(f.doi, "10.1234/example.5678");
assert.ok(Math.abs(S.normalize({ et: "205", unit: "kj" }).kcal - 49.0) < 0.01);
// an empty form scores 0 and cannot be sent
f = S.normalize({});
assert.equal(S.scoreEntry(f, { structureOk: false, doiResolves: null, same: null }).total, 0);
assert.ok(S.requiredError(f, {}));
// wrong unit is caught by the plausibility range
assert.equal(S.scoreEntry(S.normalize({ ...full, unit: "kcal" }), okCtx).items.find((i) => i.label.startsWith("E_T")).got, 0);
// consistency: agreement, disagreement, duplicate
f = S.normalize(full);
const cons = (same) => S.scoreEntry(f, { ...okCtx, same }).items.find((i) => i.label.startsWith("Consistency")).got;
assert.equal(cons([{ name: "a", doi: "x", et_kcal: 61 }]), 8);
assert.equal(cons([{ name: "a", doi: "x", et_kcal: 54 }]), 5);
assert.equal(cons([{ name: "a", doi: "x", et_kcal: 40 }]), 2);
assert.equal(cons([{ name: "a", doi: "10.1234/EXAMPLE.5678", et_kcal: 62.03 }]), 0);
// an unresolved DOI loses its points; an unchecked one is not counted as resolved
assert.equal(S.scoreEntry(f, { ...okCtx, doiResolves: false }).total, 94);
assert.equal(S.scoreEntry(f, { ...okCtx, doiResolves: null }).total, 94);
// length caps
assert.equal(S.normalize({ name: "x".repeat(1000) }).name.length, 200);
// database row
const doc = S.toDoc(f, S.scoreEntry(f, okCtx));
assert.equal(doc.et_kcal, 62);
assert.equal(doc.et_reported, "2.69 ± 0.02 eV");
assert.equal(doc.et_unc, 0.5);
assert.equal(doc.score, 100);
assert.ok(!("status" in doc) && !("ip_hash" in doc));

console.log("score tests passed");
