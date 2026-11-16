// Checks the maths of the Redox section (docs/assets/redox.js) and its reaction library.
// Run: node tools/test-redox.mjs
// The ES5 port was also checked once against RedoxDB's original advisor (1600 cases, all identical).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = globalThis;
for (const f of ["score.js", "redox-reactions.js", "redox.js"]) (0, eval)(readFileSync(join(root, "docs/assets", f), "utf8"));
const M = globalThis.EntRedoxMath, lib = globalThis.EntRedoxReactions, S = globalThis.EntScore;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ---------- cycles: ΔG of each step, V vs SCE ----------
const pc = { e_ox: 0.8, e_red: -1.4, e_star_ox: -1.7, e_star_red: 1.1 };
const D = { name: "amine", E_ox: 0.9 }, A = { name: "halide", E_red: -1.2 };
let cs = M.cycles(pc, D, A, "donor");
const red = cs.find((c) => c.mode === "reductive"), ox = cs.find((c) => c.mode === "oxidative");
near(red.steps[0].g, 0.9 - 1.1);    // PC* oxidises D: Eox(D) − E*red
near(red.steps[1].g, -1.4 - -1.2);  // PC•− reduces A: Ered(PC) − Ered(A)
near(ox.steps[0].g, -1.7 - -1.2);   // PC* reduces A: E*ox − Ered(A)
near(ox.steps[1].g, 0.9 - 0.8);     // PC•+ oxidises D: Eox(D) − Eox(PC)
assert.equal(red.verdict, "good");  // −0.2 and −0.2
assert.equal(ox.verdict, "border"); // worst +0.1 (≤ 0.15)
assert.equal(cs[0].mode, "reductive");  // sorted by score
// thresholds
const v = (g) => M.cycles({ e_star_red: 1.0, e_red: -5 }, { name: "d", E_ox: 1.0 + g }, { name: "a", E_red: 0 }, "donor")[0].verdict;
assert.equal(v(-0.05), "good"); assert.equal(v(0.15), "border"); assert.equal(v(0.16), "bad");
// an estimated ("soft") photochemical step cannot make a cycle feasible
const soft = M.cycles({ e_star_red: 1.0, e_red: -2 }, { name: "d", E_ox: 0.5, soft: true }, { name: "a", E_red: -1 }, "acceptor")[0];
assert.equal(soft.verdict, "border");
// missing data
assert.equal(M.cycles({ e_star_red: 1.0 }, null, { name: "a", E_red: -1 }, "donor")[0].verdict, "unknown");
assert.equal(M.bestCycle({ e_star_red: 1.0 }, null, null, null, "donor"), null);
// equal cycles: the mechanism reported by the authors wins
const twin = { e_ox: 1.0, e_red: -1.0, e_star_ox: -1.5, e_star_red: 1.5 };
assert.equal(M.bestCycle(twin, { name: "d", E_ox: 0.5 }, { name: "a", E_red: -0.5 }, "oxidative", "donor").mode, "oxidative");
assert.equal(M.bestCycle(twin, { name: "d", E_ox: 0.5 }, { name: "a", E_red: -0.5 }, "reductive", "donor").mode, "reductive");

// ---------- excited-state potentials, E0,0, quenching ----------
const x = M.excited(0.77, -1.33, 2.1);
near(x.eso, 0.77 - 2.1); near(x.esr, -1.33 + 2.1);
assert.equal(M.excited(null, -1, 2).eso, null);
near(M.e00From("nm", 450), 1239.84 / 450);
near(M.e00From("kcal", 63.3), 63.3 / 23.0605);
assert.equal(M.e00From("ev", -1), null);
near(M.coulomb(37.5, 7), -14.4 / (37.5 * 7));
const q = M.quench(0.8, -1.5, -1.7, 1.12, -0.05);
near(q.reductive, 0.8 - 1.12 - 0.05); near(q.oxidative, -1.7 - -1.5 - 0.05);
// crossing of two normalised spectra (mirror images around 500 nm cross at 500 nm)
const xs = []; for (let w = 350; w <= 700; w += 1) xs.push(w);
const gauss = (c) => xs.map((w) => Math.exp(-((w - c) ** 2) / (2 * 30 ** 2)));
const cr = M.crossing({ x: xs, y: gauss(450) }, { x: xs, y: gauss(550) });
near(cr.lambda, 500, 0.5); near(cr.e00, 1239.84 / cr.lambda);
assert.ok(M.crossing(null, null).msg);
// instrument tables: header, decimal commas, semicolons
const tab = M.parseNumericTable("Instrument X\nWavelength;Abs\n400,0;0,12\n401,0;0,15\n402,0;0,20\n");
assert.deepEqual(tab.headers, ["Wavelength", "Abs"]);
assert.deepEqual(tab.cols, [[400, 401, 402], [0.12, 0.15, 0.2]]);
assert.deepEqual(M.parseNumericTable("1 2\n3 4\n").cols, [[1, 3], [2, 4]]);
// photon flux: 100 mW at 450 nm ≈ 3.76e-7 einstein/s
near(M.photonFlux(100, 450), 3.7617e-7, 1e-10);

// ---------- reaction library ----------
assert.equal(lib.length, 23);
const ids = new Set();
for (const r of lib) {
  assert.ok(r.id && !ids.has(r.id), "unique id " + r.id); ids.add(r.id);
  assert.ok(r.key === "donor" || r.key === "acceptor", r.id);
  assert.ok(r.reported_quenching === "reductive" || r.reported_quenching === "oxidative", r.id);
  /* the substrate to activate always has a potential; the partner may not (e.g. a radical intermediate) */
  const keyE = r.key === "donor" ? r.donor.E_ox : r.acceptor.E_red;
  assert.ok(typeof keyE === "number" && Math.abs(keyE) < 4, r.id);
  [r.donor.E_ox, r.acceptor.E_red].forEach((e) => assert.ok(e == null || (typeof e === "number" && Math.abs(e) < 4), r.id));
  if (r.doi) assert.ok(S.isDoi(r.doi), "DOI of " + r.id);
  else assert.ok(r.citation, "source of " + r.id);
}
// ---------- landmarks of the potential scale (common.js), V vs SCE ----------
globalThis.document = { getElementById() { return null; }, createElement() { return { style: {}, classList: { add() {} }, setAttribute() {}, appendChild() {} }; },
  addEventListener() {}, documentElement: { setAttribute() {}, dataset: {} } };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
(0, eval)(readFileSync(join(root, "docs/assets/common.js"), "utf8"));
const E = globalThis.Ent;
assert.deepEqual(E.REDOX_LANDMARKS.map((r) => [r.name, r.v]), [["Li+/Li", -3.28], ["Ru(bpy)3 2+/+", -1.33], ["SCE", 0], ["Ru(bpy)3 3+/2+", 1.29]]);
near(-3.04 - 0.241, -3.28, 0.002);   // Li+/Li: standard potential vs SHE, moved to SCE
assert.ok(E.REDOX_MIN <= -3.28 && E.REDOX_MAX >= 1.29);   // every landmark sits on the scale
const fc = S.redox.DISPLAY_REFS.find((d) => d.id === "Fc+/Fc (MeCN)");
E.redoxLandmarks(fc).forEach((r) => near(r.v, r.sce - 0.38, 1e-9));   // shown vs Fc+/Fc: all shift by −0.38 V
console.log("redox tests passed");
