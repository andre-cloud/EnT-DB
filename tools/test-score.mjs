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
  cite: "Example J. 2000, 1, 1", doi: "https://doi.org/10.1234/example.5678", loc: "Abstract", quote: "0-0 transition at 2.69 eV",
  uv_lmax: "248", uv_eps: "15000", uv_cond: "MeCN", direct_src: "LED", direct_nm: "415",
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
assert.equal(doc.uv_lmax, 248);
assert.equal(doc.uv_eps, 15000);
assert.equal(doc.uv_cond, "MeCN");
assert.deepEqual(doc.direct_exc, { LED: 415 });
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

// DOIs: links are reduced to the DOI inside them; links without one stay invalid
assert.equal(S.cleanDoi("https://doi.org/10.1021/jacs.0c05069"), "10.1021/jacs.0c05069");
assert.equal(S.cleanDoi("https://pubs-acs-org.example-proxy.org/doi/pdf/10.1021/ja00184a008"), "10.1021/ja00184a008");
assert.equal(S.cleanDoi("https://doi-org.example-proxy.org/10.1021/cm051312%2B"), "10.1021/cm051312+");
assert.equal(S.cleanDoi("doi: 10.1039/c8cs00054a."), "10.1039/c8cs00054a");
assert.ok(!S.isDoi(S.cleanDoi("https://pubs.example.org/jacsat/article/145/39/21576")));
assert.ok(S.requiredError(S.normalize({ name: "Ethene", smiles: "C=C", et: "60", doi: "https://example.org/article/1" }), {}).startsWith("Give the source as a DOI"));
// IUPAC name is always required; commercial_name is optional
assert.equal(S.requiredError(S.normalize({ ...full, name: "" }), okCtx), "Enter the IUPAC name.");
assert.equal(S.toDoc(S.normalize({ ...full, commercial_name: "Styrene" }), { total: 0, items: [] }).commercial_name, "Styrene");
assert.equal("commercial_name" in S.toDoc(S.normalize(full), { total: 0, items: [] }), false);
// CAS numbers: format and check digit
assert.ok(S.casValid("100-42-5"));          // styrene
assert.ok(S.casValid("7732-18-5"));         // water
assert.ok(!S.casValid("100-42-6"));
assert.equal(S.cleanCas("100425"), "100-42-5");
assert.equal(S.cleanCas(" 100–42–5 "), "100-42-5");
assert.ok(S.requiredError(S.normalize({ name: "Ethene", smiles: "C=C", et: "60", cite: "x", cas: "100-42-6" }), {}).startsWith("The CAS number"));
assert.equal(S.toDoc(S.normalize({ name: "Ethene", smiles: "C=C", et: "60", cite: "x", cas: "100-42-5" }), { total: 0, items: [] }).cas, "100-42-5");
// reader corrections
let cs = S.checkSuggestion({ commercial_name: "Thioxanthone", et_kcal: "61,2", doi: "https://doi.org/10.1021/jacs.0c05069", uv_lmax: "354", uv_eps: "12000", direct_exc: "LED: 415, Kessil: 427", uses_add: { doi: "10.1021/jacs.3c07678", note: "sensitizer" } });
assert.equal(cs.error, null);
assert.equal(cs.clean.commercial_name, "Thioxanthone");
assert.equal(S.checkSuggestion({ name: "" }).error, "IUPAC name cannot be empty.");
assert.equal(S.checkSuggestion({ commercial_name: "" }).clean.commercial_name, null);
assert.equal(cs.clean.et_kcal, 61.2);
assert.equal(cs.clean.doi, "10.1021/jacs.0c05069");
assert.equal(cs.clean.uv_lmax, 354);
assert.equal(cs.clean.uv_eps, 12000);
assert.deepEqual(cs.clean.direct_exc, { LED: 415, Kessil: 427 });
assert.ok(S.checkSuggestion({ uv_lmax: "50" }).error);
assert.ok(S.checkSuggestion({ direct_exc: "bad value" }).error);
assert.ok(S.checkSuggestion({ ip_hash: "x" }).error);
assert.ok(S.checkSuggestion({ et_kcal: "500" }).error);
assert.ok(S.checkSuggestion({ doi: "https://example.org/x" }).error);
assert.ok(S.checkSuggestion({}).error);

// ---------- redox potentials ----------
const R = S.redox;
const redoxFull = {
  name: "9,10-Dicyanoanthracene", smiles: "N#Cc1c2ccccc2c(C#N)c2ccccc12", kind: "red", state: "S0", couple: "M/M•−",
  e: "-0.89", unit: "v", unc: "0.01", ref: "SCE", origin: "exp", e_type: "E1/2 (reversible)",
  tech: "Cyclic voltammetry", solvent: "MeCN", electrolyte: "0.1 M TBAPF6", temp: "25 °C",
  cite: "Example J. 2020", doi: "10.1234/example.5678", loc: "Table 1", quote: "E1/2 = −0.89 V vs SCE",
};
const redoxCalc = { ...redoxFull, origin: "calc", e_type: "Computed, adiabatic", func: "M06-2X", basis: "def2-TZVP", solv: "SMD, MeCN" };
// every branch sums to 100, and a complete entry scores 100
for (const p of [redoxFull, redoxCalc]) for (const state of ["S0", "S1", "T1"]) {
  const q = state === "S0" ? p : { ...p, state, excited_from: "estimated", e00: "2.89" };
  const sc = R.scoreEntry(R.normalize(q), okCtx);
  assert.equal(sc.items.reduce((a, i) => a + i.max, 0), 100, p.origin + " " + state + " max");
  assert.equal(sc.total, 100, p.origin + " " + state + " total");
}
// references: conversion to SCE
// references: one table (RedoxDB's), offsets to SCE, both directions
assert.equal(R.toSce(-1, "SCE"), -1);
assert.equal(R.toSce(-1, "SHE"), -1.241);
assert.equal(R.toSce(-1, "NHE"), -1.241);
assert.equal(R.toSce(-1, "Ag/AgCl (sat. KCl)"), -1.045);
assert.equal(R.toSce(-1, "Ag/AgCl (3 M KCl)"), -1.032);
assert.equal(R.toSce(-1, "Ag/AgCl (1 M KCl)"), -1);
assert.equal(R.toSce(-1, "Ag/AgCl (3.5 M NaCl)"), -1.03);
assert.equal(R.toSce(-1, "Ag/AgCl"), -1.045);                       // filling not stated: sat. KCl
assert.equal(R.toSce(-1, "Ag/Ag+ (0.01 M AgNO3, MeCN)"), -0.702);
assert.equal(R.toSce(-1, "Ag/Ag+ (0.1 M AgNO3, MeCN)"), -0.64);
assert.equal(R.toSce(-1, "Me10Fc+/Me10Fc"), -1.13);
assert.equal(R.toSce(-1, "Fc+/Fc", "MeCN"), -0.62);
assert.equal(R.toSce(-1, "Fc+/Fc", "acetonitrile"), -0.62);
assert.equal(R.toSce(-1, "Fc+/Fc", "DMF"), -0.55);
assert.equal(R.toSce(-1, "Fc+/Fc", "CH2Cl2"), -0.54);
assert.equal(R.toSce(-1, "Fc+/Fc", "THF"), -0.44);
assert.equal(R.toSce(-1, "Fc+/Fc", "DMSO"), -0.57);
assert.ok(Number.isNaN(R.toSce(-1, "Fc+/Fc", "")));                 // solvent needed
assert.ok(Number.isNaN(R.toSce(-1, "Fc+/Fc", "MeCN/CH2Cl2 1:1")));  // mixture: not converted
assert.ok(Number.isNaN(R.toSce(-1, "Ag/Ag+")));                     // concentration unknown
assert.ok(Number.isNaN(R.toSce(-1, "other")));
assert.ok(Number.isNaN(R.toSce(null, "SCE")));
for (const r of R.REF_TABLE) {                                       // round trip for every convertible reference
  const sce = R.toSce(-1.234, r.id, "MeCN");
  if (!Number.isNaN(sce)) assert.equal(R.fromSce(sce, r.id, "MeCN"), -1.234, r.id);
}
for (const d of R.DISPLAY_REFS) assert.ok(!Number.isNaN(R.fromSce(-1, d.ref, d.solvent)), d.id);
assert.equal(R.cleanRef("vs. Fc/Fc+"), "Fc+/Fc");
assert.equal(R.cleanRef("ferrocene"), "Fc+/Fc");
assert.equal(R.cleanRef("Ag/AgCl (sat. KCl)"), "Ag/AgCl (sat. KCl)");
assert.equal(R.cleanRef("Ag/AgCl, saturated KCl"), "Ag/AgCl (sat. KCl)");
assert.equal(R.cleanRef("Ag/AgCl (3 M KCl)"), "Ag/AgCl (3 M KCl)");
assert.equal(R.cleanRef("Ag/AgCl (3.5 M NaCl)"), "Ag/AgCl (3.5 M NaCl)");
assert.equal(R.cleanRef("Ag/AgCl"), "Ag/AgCl");
assert.equal(R.cleanRef("Ag/Ag+ (0.01 M AgNO3)"), "Ag/Ag+ (0.01 M AgNO3, MeCN)");
assert.equal(R.cleanRef("Ag/Ag+"), "Ag/Ag+");
assert.equal(R.cleanRef("decamethylferrocene"), "Me10Fc+/Me10Fc");
assert.equal(R.cleanRef("sce"), "SCE");
assert.equal(R.cleanRef("Hg/HgO"), "other");
assert.equal(R.cleanRef(""), "");
// mV and sign
let rf = R.normalize({ ...redoxFull, e: "−1920", unit: "mv", ref: "Fc+/Fc" });
assert.ok(Number.isNaN(rf.v));   // a typographic minus is not a number: the form sends ASCII
rf = R.normalize({ ...redoxFull, e: "-1920", unit: "mv", ref: "Fc+/Fc" });
assert.equal(rf.v, -1.92);
assert.equal(rf.sce, -1.54);
// a value without SCE conversion loses only its conversion points
const fcNoSolvent = R.scoreEntry(R.normalize({ ...redoxFull, ref: "Fc+/Fc", solvent: "" }), okCtx);
assert.equal(item(fcNoSolvent, "Converts to SCE"), 0);
assert.equal(item(fcNoSolvent, "Solvent"), 0);
// required fields
assert.equal(R.requiredError(R.normalize({ ...redoxFull, ref: "" }), okCtx), "Choose the reference electrode the potential was reported against.");
assert.equal(R.requiredError(R.normalize({ ...redoxFull, e: "7" }), okCtx).startsWith("The potential must be"), true);
// E0,0 is optional: an estimated E* without it can be sent, but loses the derivation points
const noE00 = R.normalize({ ...redoxFull, state: "T1", excited_from: "estimated" });
assert.equal(R.requiredError(noE00, okCtx), null);
const deriv = R.scoreEntry(noE00, okCtx).items.find((i) => i.label === "Redox couple or E* derivation");
assert.equal(deriv.got, 0);
assert.equal(deriv.note, "Give the E0,0 used for the estimate");
assert.equal(R.requiredError(R.normalize({ ...redoxFull, state: "T1", excited_from: "direct" }), okCtx), null);
assert.equal(R.requiredError(R.normalize(redoxFull), okCtx), null);
assert.ok(R.requiredError(R.normalize({}), {}));
// ground state drops excited-state fields
rf = R.normalize({ ...redoxFull, excited_from: "estimated", e00: "2.5" });
assert.equal(rf.excited_from, "");
assert.ok(Number.isNaN(rf.e00));
// consistency: compared against SCE with the same kind, state and origin only
rf = R.normalize(redoxFull);
const rcons = (same) => item(R.scoreEntry(rf, { ...okCtx, same }), "Consistency with the database");
assert.equal(rcons([{ name: "a", doi: "x", e_sce: -0.95, origin: "exp", kind: "red", state: "S0" }]), 8);
assert.equal(rcons([{ name: "a", doi: "x", e_sce: -1.05, origin: "exp", kind: "red", state: "S0" }]), 5);
assert.equal(rcons([{ name: "a", doi: "x", e_sce: -1.5, origin: "exp", kind: "red", state: "S0" }]), 2);
assert.equal(rcons([{ name: "a", doi: "10.1234/EXAMPLE.5678", e_sce: -0.89, origin: "exp", kind: "red", state: "S0" }]), 0);
assert.equal(rcons([{ name: "a", doi: "x", e_sce: 2.0, origin: "exp", kind: "red", state: "T1" }]), 8);   // other state: not a peer
assert.equal(rcons([{ name: "a", doi: "x", e_sce: null, origin: "exp", kind: "red", state: "S0" }]), 4);  // nothing to compare
// database row
const rdoc = R.toDoc(R.normalize({ ...redoxFull, state: "T1", excited_from: "estimated", e00: "2.89", e: "2.0", ref: "Fc+/Fc" }), { total: 90, items: [] });
assert.equal(rdoc.e_v, 2);
assert.equal(rdoc.e_sce, 2.38);
assert.equal(rdoc.e_ref, "Fc+/Fc");
assert.equal(rdoc.e_reported, "2 ± 0.01 V vs Fc+/Fc");   // numbers are re-printed, as for et_reported
assert.equal(rdoc.excited_from, "estimated");
assert.equal(rdoc.e00_ev, 2.89);
assert.equal(rdoc.conditions, "MeCN, 0.1 M TBAPF6, 25 °C");
assert.ok(!("status" in rdoc) && !("ip_hash" in rdoc) && !("et_kcal" in rdoc));
const rcalcDoc = R.toDoc(R.normalize(redoxCalc), { total: 1, items: [] });
assert.equal(rcalcDoc.method, "Computation, M06-2X, def2-TZVP");
assert.equal(rcalcDoc.conditions, "SMD, MeCN");
assert.ok(!("solvent" in rcalcDoc));
assert.equal(rcalcDoc.e_sce, -0.89);
// reader corrections
const rcs = R.checkSuggestion({ e_v: "-1.21", e_ref: "fc/fc+", state: "T1", doi: "doi: 10.1021/jacs.0c05069" });
assert.equal(rcs.error, null);
assert.equal(rcs.clean.e_v, -1.21);
assert.equal(rcs.clean.e_ref, "Fc+/Fc");
assert.equal(rcs.clean.doi, "10.1021/jacs.0c05069");
assert.ok(R.checkSuggestion({ e_v: "9" }).error);
assert.ok(R.checkSuggestion({ state: "T2" }).error);
assert.ok(R.checkSuggestion({ e_sce: "-1" }).error);
assert.ok(R.checkSuggestion({ et_kcal: "60" }).error);
assert.deepEqual(R.checkSuggestion({ category: "photocatalyst", uv_lmax: "450", tau_ns: "1100" }).clean, { category: "photocatalyst", uv_lmax: 450, tau_ns: 1100 });
assert.ok(R.checkSuggestion({ category: "solvent" }).error);
assert.ok(R.checkSuggestion({ tau_ns: "-3" }).error);
// photocatalyst / substrate extras are stored but not scored
const extra = R.normalize({ ...redoxFull, category: "photocatalyst", uv_lmax: "452", tau_ns: "1100", activated_group: "C(sp3)-Br" });
assert.equal(R.scoreEntry(extra, okCtx).total, 100);
const extraDoc = R.toDoc(extra, { total: 100, items: [] });
assert.equal(extraDoc.category, "photocatalyst");
assert.equal(extraDoc.uv_lmax, 452);
assert.equal(extraDoc.tau_ns, 1100);
assert.equal(extraDoc.activated_group, "C(sp3)-Br");
assert.equal(R.requiredError(R.normalize({ ...redoxFull, uv_lmax: "50" }), okCtx), "UV-vis λmax must be an integer between 100 and 1500 nm.");
assert.ok(R.requiredError(R.normalize({ ...redoxFull, tau_ns: "-1" }), okCtx));
// unstated Ag/AgCl filling converts, with a note
const agNote = R.scoreEntry(R.normalize({ ...redoxFull, ref: "Ag/AgCl" }), okCtx).items.find((i) => i.label === "Converts to SCE");
assert.equal(agNote.got, 4);
assert.equal(agNote.note, "Filling not stated: saturated KCl assumed");

console.log("score tests passed");
