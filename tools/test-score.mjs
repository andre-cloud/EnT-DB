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
assert.equal(doc.et_unc, 0.46);   // 0.02 eV, kept to two decimals
assert.equal(doc.score, 100);
assert.ok(!("status" in doc) && !("ip_hash" in doc));

// computed branch: a complete computed entry scores 100; a non-computed value type loses 3
const calc = { ...full, origin: "calc", kind: "Computed, adiabatic", func: "B3LYP", basis: "6-31G*", solv: "PCM, MeCN" };
assert.equal(S.scoreEntry(S.normalize(calc), okCtx).total, 100);
const item = (sc, l) => sc.items.find((i) => i.label === l).got;
assert.equal(item(S.scoreEntry(S.normalize({ ...calc, kind: "Relaxed triplet" }), okCtx), "Value type matches a computation"), 0);
// ...and so does a measured entry with a computed value type
assert.equal(item(S.scoreEntry(S.normalize({ ...full, kind: "Computed, vertical" }), okCtx), "Value type stated"), 5);
// a structure that could not be checked gets no points but is not refused
const unchecked = S.scoreEntry(S.normalize(full), { ...okCtx, structureOk: null });
assert.equal(item(unchecked, "Structure parses"), 0);
assert.equal(S.requiredError(S.normalize(full), { structureOk: null }), null);
// a verbatim line longer than 25 words loses its points
assert.equal(item(S.scoreEntry(S.normalize({ ...full, quote: "w ".repeat(26) }), okCtx), "Verbatim line"), 0);
// DOI clean-up and validation
assert.equal(S.normalize({ doi: "doi: 10.1021/jacs.0c05069" }).doi, "10.1021/jacs.0c05069");
assert.equal(S.normalize({ doi: "http://dx.doi.org/10.1021/jacs.0c05069" }).doi, "10.1021/jacs.0c05069");
assert.equal(item(S.scoreEntry(S.normalize({ ...full, doi: "jacs.0c05069" }), okCtx), "DOI well formed"), 0);
// grade boundaries
assert.equal(S.gradeOf(80).label, "Good"); assert.equal(S.gradeOf(79).label, "Fair");
assert.equal(S.gradeOf(50).label, "Fair"); assert.equal(S.gradeOf(49).label, "Poor");
// consistency unknown (no structure match possible) scores 0
assert.equal(S.scoreEntry(f, { ...okCtx, same: null }).items.find((i) => i.label.startsWith("Consistency")).got, 0);
// duplicate edge: 62.05 is stored as 62.1, and a later 62.05 is still a duplicate
const f2 = S.normalize({ ...full, et: "62.05", unit: "kcal", unc: "" });
assert.equal(S.scoreEntry(f2, { ...okCtx, same: [{ name: "a", doi: "10.1234/example.5678", et_kcal: 62.1 }] })
  .items.find((i) => i.label.startsWith("Consistency")).got, 0);
// a measured value is not compared with computed ones of the same molecule
assert.equal(cons([{ name: "a", doi: "10.1234/example.5678", et_kcal: 62.0, origin: "calc" }]), 8);
assert.equal(cons([{ name: "a", doi: "x", et_kcal: 40, origin: "calc" }, { name: "b", doi: "y", et_kcal: 61, origin: "exp" }]), 8);
// E_T must be a number in (0, 200] kcal/mol
assert.ok(S.requiredError(S.normalize({ ...full, et: "1e308" }), okCtx));
assert.ok(S.requiredError(S.normalize({ ...full, et: "-3", unit: "kcal" }), okCtx));
assert.ok(S.requiredError(S.normalize({ ...full, et: "250", unit: "kcal" }), okCtx));
assert.equal(S.requiredError(S.normalize({ ...full, et: "200", unit: "kcal" }), okCtx), null);
// strict numbers, decimal comma accepted
assert.ok(isNaN(S.num("62abc")));
assert.equal(S.num("2,69"), 2.69);
assert.equal(S.num(" 61.5 "), 61.5);
// small uncertainties survive rounding
assert.equal(S.toDoc(S.normalize({ ...full, unc: "0.1", unit: "kj", et: "250" }), { total: 0, items: [] }).et_unc, 0.02);
// "used in" papers
assert.ok(S.requiredError(S.normalize({ ...full, usedoi: "not a doi" }), okCtx));
assert.ok(S.requiredError(S.normalize({ ...full, usenote: "used as donor" }), okCtx));
const used = S.toDoc(S.normalize({ ...full, usedoi: "https://doi.org/10.1/x", usenote: "donor" }), { total: 0, items: [] });
assert.deepEqual(used.uses, [{ doi: "10.1/x", note: "donor" }]);

console.log("score tests passed");
