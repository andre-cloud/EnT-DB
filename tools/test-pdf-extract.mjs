// Checks browser PDF extraction (docs/assets/pdf-extract.js) and admin.html wiring.
// Run: node tools/test-pdf-extract.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Syntax checks
for (const rel of ["docs/assets/pdf-extract.js", "docs/assets/common.js", "docs/assets/admin.js"]) {
  new Script(readFileSync(join(root, rel), "utf8"), { filename: rel });
}

// 2. Load score.js, common.js, pdf-extract.js with minimal browser stubs
function makeNode(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    appendChild(ch) { if (ch) this.children.push(ch); return ch; },
    replaceChildren(...args) { this.children = args.filter(Boolean); },
  };
}

globalThis.window = globalThis;
globalThis.ENT_CONFIG = { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "sb_publishable_test" };
globalThis.document = {
  createElement: (t) => makeNode(t),
  createTextNode: (t) => ({ textContent: String(t), children: [] }),
  getElementById: () => null,
  addEventListener: () => {},
  documentElement: makeNode("html"),
  body: makeNode("body"),
  head: makeNode("head"),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.crossref.org/works/")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          author: [{ family: "Elliott" }, { family: "Kayal" }],
          "short-container-title": ["J. Am. Chem. Soc."],
          "published-print": { "date-parts": [[2020]] },
          volume: "142",
          page: "14947-14956",
        },
      }),
    };
  }
  if (u.startsWith("https://doi.org/api/handles/")) {
    return { ok: true, status: 200, json: async () => ({ responseCode: 1 }) };
  }
  if (u.includes("/compound/name/property/IsomericSMILES")) {
    const body = String((init && init.body) || "");
    if (body.includes("coumarin")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ PropertyTable: { Properties: [{ IsomericSMILES: "O=c1ccc2ccccc2o1" }] } }),
      };
    }
    return { ok: false, status: 404 };
  }
  if (u.includes("/compound/smiles/property/IUPACName")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ PropertyTable: { Properties: [{ CID: 1, IUPACName: "chromen-2-one" }] } }),
    };
  }
  if (u.includes("/compound/smiles/synonyms")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ InformationList: { Information: [{ Synonym: ["91-64-5"] }] } }),
    };
  }
  return { ok: false, status: 404 };
};

(0, eval)(readFileSync(join(root, "docs/assets/score.js"), "utf8"));
(0, eval)(readFileSync(join(root, "docs/assets/common.js"), "utf8"));
(0, eval)(readFileSync(join(root, "docs/assets/pdf-extract.js"), "utf8"));

const Ent = globalThis.Ent;
const EntPdf = globalThis.EntPdf;
const T = EntPdf._test;

// Stub OCL-backed helpers on Ent so structureOk / idCode work deterministically in Node
Ent.structureOk = (s) => Boolean(s && !s.includes("BAD"));
Ent.idCode = (s) => (s ? `id:${s}` : null);

// 3. Text normalization
assert.equal(EntPdf.normalizeText("298 kJ mol⁻¹ − 5.0"), "298 kJ mol-1 - 5.0");
assert.equal(EntPdf.normalizeText("ﬂuorescence\u00adtest"), "fluorescencetest");

// 4. Layout table & prose extraction
{
  const layout = [
    "Table 1. Experimental triplet energies (phosphorescence, 77 K, MCH glass)",
    "Compound                ET (kcal/mol)     Singlet (kcal/mol)",
    "Benzophenone            68.6              74.2",
    "Thioxanthone            63.3              78.0",
    "This sentence is prose in the layout table and should be ignored.",
  ].join("\n");
  const tables = T.parseLayoutTables(layout);
  assert.equal(tables.length, 1);

  const doc = {
    name: "jacs.0c05069.pdf",
    metadataDoi: null,
    pages: [
      {
        pageNum: 1,
        text: [
          "Results and Discussion",
          "DOI: 10.1021/jacs.0c05069",
          layout,
          "For styrene, the 0-0 transition to the lowest triplet state is at 2.69 eV by EELS at 15 K.",
          "The triplet energy lies between 42 and 58 kcal/mol, rather than 53.7 kcal/mol.",
          "For compound 4a, DFT (B3LYP/6-31G*) gives a triplet energy of 52.0 kcal/mol.",
        ].join("\n\n"),
        layoutText: layout,
        tables,
      },
    ],
  };

  assert.equal(T.detectDoi(doc), "10.1021/jacs.0c05069");

  const kb = T.buildKnowledgeIndex([]);
  const tHits = T.extractFromTables(doc, kb.byName, { doi: "10.1021/jacs.0c05069", citation: "Elliott et al., J. Am. Chem. Soc. 2020, 142, 14947–14956", defaultRole: "donor" });
  assert.equal(tHits.length, 2);
  assert.equal(tHits[0].name, "Benzophenone");
  assert.equal(tHits[0].et_kcal, 68.6);
  assert.equal(tHits[1].name, "Thioxanthone");
  assert.equal(tHits[1].et_kcal, 63.3);

  const pHits = T.extractFromProse(doc, kb.byName, kb.keys, { doi: "10.1021/jacs.0c05069", citation: "Elliott et al., J. Am. Chem. Soc. 2020, 142, 14947–14956", defaultRole: "acceptor" });
  // Should extract styrene (2.69 eV -> 62.0 kcal/mol) and compound 4a (52.0 kcal/mol, calc),
  // while skipping "between 42 and 58" and "rather than 53.7".
  assert.equal(pHits.length, 2);
  assert.equal(pHits[0].name.toLowerCase(), "styrene");
  assert.equal(pHits[0].et_kcal, 62.0);
  assert.equal(pHits[1].name, "compound 4a");
  assert.equal(pHits[1].origin, "calc");
  assert.equal(pHits[1].et_kcal, 52.0);
}

// 4b. Regression tests from real 21-article corpus
{
  const kb = T.buildKnowledgeIndex([]);
  const docReg = {
    name: "corpus.pdf",
    metadataDoi: "10.1021/jacs.5c22244",
    pages: [
      {
        pageNum: 1,
        text: [
          "By fixing 1/2 the reorganization energy (λ) to 1 eV in eq 4, the best fits yielded the triplet energy of the two model diazenes estimated as 2.3 eV.",
          "The fragmentation kinetics of model diazene 2 were evaluated using PC-6 and PC-10, two photosensitizers differing in triplet energies (2.44 and 2.76 eV, respectively).",
          "Singlet oxygen excitation requires around 23 kcal mol-1.",
          "The set of rate constants gives ΔG≠ = 11.0 ± 0.2 kcal mol-1.",
          "Products 2a and 4a are >30 kcal/mol and the triplet energy of 14 is higher than 56 kcal mol-1.",
          "These styrenes possess triplet energies (ET = 63.0–70.2 kcal mol-1) and ET ≥ 65 kcal mol-1.",
          "A chiral thioxanthone has a triplet energy (ET) of 255 kJ mol 1 and 45.4 kcal mol@1 for the sensitizer, while cis-stilbene is 57 kcal./mole.",
          "Ru(dtbbpy)2(bpy)(PF6 )2 (ET = 46.9 kcal/mol) was used as catalyst.",
          "In contrast, C3, with a triplet energy of 62.7 kcal/mol, is active.",
        ].join("\n\n"),
        layoutText: "",
        tables: [],
      },
    ],
  };
  const hits = T.extractFromProse(docReg, kb.byName, kb.keys, { doi: "10.1021/jacs.5c22244", citation: "Test 2026", defaultRole: "acceptor" });
  const ets = hits.map((h) => h.et_kcal);
  // False positives must NOT be present: 1 eV (23.1), 23, 11.0, >30, >56, range 70.2, >=65
  for (const badEt of [23.1, 23.0, 11.0, 30.0, 56.0, 70.2, 65.0]) {
    assert.ok(!ets.includes(badEt), `False positive et_kcal=${badEt} should not be extracted`);
  }
  // Real values MUST be present: 2.3 eV (53.0), 2.44 eV (56.3), 2.76 eV (63.6), 255 kJ mol 1 (60.9), 45.4 kcal mol@1, 57 kcal./mole, 46.9, 62.7
  for (const goodEt of [53.0, 56.3, 63.6, 60.9, 45.4, 57.0, 46.9, 62.7]) {
    assert.ok(ets.includes(goodEt), `Expected et_kcal=${goodEt} to be extracted (got ${JSON.stringify(ets)})`);
  }
  assert.ok(hits.some((h) => h.name === "PC-6" && h.et_kcal === 56.3));
  assert.ok(hits.some((h) => h.name === "PC-10" && h.et_kcal === 63.6));
  assert.ok(hits.some((h) => h.name === "C3" && h.et_kcal === 62.7));
  assert.ok(hits.some((h) => /Ru\(dtbbpy\)2\(bpy\)\(PF6\s*\)2/i.test(h.name) && h.et_kcal === 46.9));
}

// 4c. Two-column de-interleaving in buildPageFromTextItems
{
  const items = [];
  // Left column lines (x=50..250), Right column lines (x=320..520), same y positions
  for (let i = 0; i < 10; i++) {
    const y = 700 - i * 14;
    items.push({ str: `Left sentence ${i}`, transform: [1, 0, 0, 10, 50, y], width: 150, height: 10 });
    items.push({ str: `Right sentence ${i}`, transform: [1, 0, 0, 10, 320, y], width: 150, height: 10 });
  }
  // Spanning title at top
  items.push({ str: "Full width article title across both columns", transform: [1, 0, 0, 14, 60, 740], width: 400, height: 14 });
  const pg = T.buildPageFromTextItems(1, items);
  const lines = pg.text.split("\n");
  assert.equal(lines[0], "Full width article title across both columns");
  assert.equal(lines[1], "Left sentence 0");
  assert.equal(lines[10], "Left sentence 9");
  assert.equal(lines[11], "Right sentence 0");
  assert.equal(lines[20], "Right sentence 9");
}

// 5. End-to-end extractFromPdfFiles with mocked readPdfFile
{
  const origRead = EntPdf.readPdfFile;
  EntPdf.readPdfFile = async (file) => ({
    name: file.name,
    metadataDoi: "10.1021/jacs.0c05069",
    pages: [
      {
        pageNum: 1,
        text: [
          "Results",
          "Benzophenone has a triplet energy of 68.6 kcal/mol (phosphorescence, MCH, 77 K).",
          "Thioxanthone has a triplet energy of 63.3 kcal/mol (phosphorescence, MCH, 77 K).",
          "Compound 4a shows a computed triplet energy of 55.1 kcal/mol by TD-DFT (B3LYP/6-31G*).",
        ].join("\n\n"),
        layoutText: "",
        tables: [],
      },
    ],
  });

  const existingRefs = [
    {
      import_key: "jacs.0c05069:exp:1",
      name: "diphenylmethanone",
      smiles: "O=C(c1ccccc1)c1ccccc1",
      idcode: "id:O=C(c1ccccc1)c1ccccc1",
      et_kcal: 68.6,
      origin: "exp",
      doi: "10.1021/jacs.0c05069",
    },
  ];

  const out = await EntPdf.extractFromPdfFiles([{ name: "paper.pdf" }], {
    refEntries: existingRefs,
    defaultRole: "donor",
  });
  EntPdf.readPdfFile = origRead;

  assert.equal(out.skippedDuplicates.length, 1); // Benzophenone matched existingRefs
  assert.equal(out.readyRows.length, 1);         // Thioxanthone ready!
  assert.equal(out.reviewItems.length, 1);       // Compound 4a unresolved!
  assert.equal(out.readyRows[0].doi, "10.1021/jacs.0c05069");
  assert.equal(out.readyRows[0].citation, "Elliott, Kayal, J. Am. Chem. Soc. 2020, 142, 14947–14956");
  assert.equal(out.readyRows[0].et_kcal, 63.3);
  assert.ok(out.readyRows[0].score > 0);
  assert.ok(!out.readyRows[0].import_key.endsWith(":exp:1")); // avoided existing import_key collision

  // Resolving the unresolved candidate manually
  const resolvedRow = await out.resolveCandidate(out.reviewItems[0].cand, "c1ccccc1", "71-43-2", "benzene");
  assert.equal(resolvedRow.smiles, "c1ccccc1");
  assert.equal(resolvedRow.cas, "71-43-2");
  assert.equal(resolvedRow.name, "benzene");
  assert.equal(resolvedRow.origin, "calc");
}

// 5b. Robustness: OCR helpers, file checks, paper/SI pairing, failure isolation
{
  const T = EntPdf._test;

  // Image regions from a page's drawing operators (a 400x200 image placed at 100,500 inside a saved state)
  const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6 };
  const regions = T.imageRegionsFromOps(
    [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    [[], [400, 0, 0, 200, 100, 500], ["img1"], [], [], [20, 0, 0, 20, 10, 10], ["logo"], []],
    OPS
  );
  assert.deepEqual(regions[0], { x0: 100, y0: 500, x1: 500, y1: 700 });
  const pageBox = { x0: 0, y0: 0, x1: 612, y1: 792 };
  assert.equal(T.selectOcrRegions(regions, pageBox, []).length, 1); // the 20x20 logo is dropped
  const textOnImage = Array.from({ length: 6 }, (_, i) => ({ x: 120 + i * 20, y: 600 }));
  assert.equal(T.selectOcrRegions(regions, pageBox, textOnImage).length, 0); // scan that already has a text layer

  // OCR words become a table through the same layout logic as native text
  const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  const line = (y, words) => ({ bbox: { x0: 100, y0: y, x1: 1500, y1: y + 40 }, words });
  const ocrData = {
    lines: [
      line(100, [word("Compound", 100, 100, 330, 140), word("ET", 900, 100, 960, 140), word("(kcal/mol)", 970, 100, 1200, 140)]),
      line(180, [word("Benzophenone", 100, 180, 420, 220), word("68.6", 900, 180, 1000, 220)]),
      line(260, [word("Xanthone", 100, 260, 320, 300), word("74.1", 900, 260, 1000, 300), word("~~", 1300, 260, 1340, 300, 10)]),
    ],
  };
  const items = T.ocrDataToItems(ocrData, 300 / 72, 3300);
  assert.equal(items.length, 7); // the low-confidence smudge is dropped
  const ocrPage = T.buildPageFromTextItems(1, items);
  assert.ok(ocrPage.tables.length >= 1);
  assert.deepEqual(ocrPage.tables[0][1], ["Benzophenone", "68.6"]);
  assert.deepEqual(ocrPage.tables[0][2], ["Xanthone", "74.1"]);

  // File checks give readable reasons
  const enc = (t) => new TextEncoder().encode(t);
  assert.throws(() => T.checkPdfBytes({}, new Uint8Array(0)), /empty/);
  assert.throws(() => T.checkPdfBytes({}, enc("<html>not a pdf</html>")), /not a PDF/);
  T.checkPdfBytes({}, enc("%PDF-1.7\n..."));
  assert.match(T.explainPdfJsError({ name: "PasswordException", message: "No password given" }).message, /password-protected/);
  assert.match(T.explainPdfJsError({ name: "InvalidPDFException", message: "Invalid PDF structure." }).message, /damaged/);

  // SI naming and content
  assert.equal(T.siBaseStem("ja0c05069_si_001.pdf"), "ja0c05069");
  assert.equal(T.siBaseStem("Paper-SI.pdf"), "paper");
  assert.equal(T.siBaseStem("ja0c05069.pdf"), null);
  assert.ok(T.looksLikeSi({ pages: [{ text: "Supporting Information\nfor a great paper" }] }));
  assert.ok(T.looksLikeSi({ pages: [{ text: "cover\n\n   S1\n" }] }));
  assert.ok(!T.looksLikeSi({ pages: [{ text: "A Great Paper\nAuthors\nSupporting Information\nABSTRACT: we show" }] }));

  // One broken file, one paper and its SI under an unrelated name: the batch still comes out
  const filler = " This sentence only pads the page so that it is long enough to count as a real document with a text layer.";
  const origRead = EntPdf.readPdfFile;
  EntPdf.readPdfFile = async (file) => {
    if (file.name === "broken.pdf") throw new Error("The file is damaged or is not a real PDF.");
    if (file.name === "paper.pdf") {
      return {
        name: file.name, metadataDoi: "10.1021/jacs.0c05069", warnings: [], ocrPages: [],
        pages: [{ pageNum: 1, layoutText: "", tables: [], text: "Energy transfer catalysis with aromatic ketone sensitizers\n\nResults\n\nThioxanthone has a triplet energy of 63.3 kcal/mol (phosphorescence, MCH, 77 K)." + filler + filler }],
      };
    }
    return {
      name: file.name, metadataDoi: null, warnings: [], ocrPages: [1],
      pages: [{ pageNum: 1, ocr: "page", layoutText: "", tables: [], text: "Supporting Information\n\nfor the article 10.1021/jacs.0c05069\n\nXanthone has a triplet energy of 74.1 kcal/mol (phosphorescence, MCH, 77 K)." + filler + filler }],
    };
  };
  const statuses = [];
  const out = await EntPdf.extractFromPdfFiles(
    [{ name: "broken.pdf", size: 1 }, { name: "download (3).pdf", size: 2 }, { name: "paper.pdf", size: 3 }, { name: "paper.pdf", size: 3 }],
    { refEntries: [], onStatus: (m) => statuses.push(m) }
  );
  EntPdf.readPdfFile = origRead;

  assert.equal(out.fileReports.length, 3); // the file picked twice is read once
  assert.equal(out.failedFiles.length, 1);
  assert.match(out.failedFiles[0].error, /damaged/);
  assert.equal(out.readyRows.length, 2);
  const si = out.fileReports.find((r) => r.file === "download (3).pdf");
  assert.equal(si.isSi, true);
  assert.equal(si.pairedWith, "paper.pdf");
  assert.match(si.matchedBy, /DOI/);
  const siRow = out.readyRows.find((r) => r.et_kcal === 74.1);
  assert.equal(siRow.doi, "10.1021/jacs.0c05069"); // inherits the paper's DOI
  assert.ok(siRow.location.startsWith("SI (download (3).pdf)"));
  assert.match(siRow.verify_note, /OCR/);
  assert.equal(out.readyRows.find((r) => r.et_kcal === 63.3).location.startsWith("SI"), false);

  // Cancelling stops between files and still returns what was done
  EntPdf.readPdfFile = async (file) => { throw new Error("should not be read"); };
  const cancelledOut = await EntPdf.extractFromPdfFiles([{ name: "a.pdf", size: 1 }], { refEntries: [], signal: { aborted: true } });
  EntPdf.readPdfFile = origRead;
  assert.equal(cancelledOut.cancelled, true);
  assert.equal(cancelledOut.fileReports.length, 0);
}

// 5c. Regressions from real papers: columns, complexes, names next to brackets, non-values
{
  const T = EntPdf._test;
  const kb = T.buildKnowledgeIndex([]);
  const names = (sent) => {
    const t = T.tightenComplexFormulas(sent);
    const matches = T.extractEnergyMatchesInSentence(t);
    const spans = T.findMoleculeSpansInSentence(t, kb.keys).spans;
    return T.pairMoleculesToMatches(t, spans, matches).map((n, i) => [n, matches[i][2]]);
  };

  // Two columns whose baselines do not line up: lines sit wholly left or wholly right
  const colLines = [];
  for (let i = 0; i < 12; i++) {
    colLines.push({ y: 700 - i * 12, h: 9, parts: [{ x: 52, w: 238, h: 9, str: "left " + i }] });
    colLines.push({ y: 696 - i * 12, h: 9, parts: [{ x: 306, w: 238, h: 9, str: "right " + i }] });
  }
  const g = T.findGutter(colLines);
  assert.ok(g > 290 && g < 306, "gutter between the columns, got " + g);
  assert.equal(T.findGutter(colLines.filter((l) => l.parts[0].x < 100)), null); // one column: no gutter
  const items = [];
  for (let i = 0; i < 12; i++) {
    items.push({ str: "Left column line number " + i + " of the page", transform: [9, 0, 0, 9, 52, 700 - i * 12], width: 238 });
    items.push({ str: "Right column line number " + i + " of the page", transform: [9, 0, 0, 9, 306, 696 - i * 12], width: 238 });
  }
  items.push({ str: "Downloaded from publisher on some date", transform: [0, 9, -9, 0, 20, 100], width: 600 }); // sideways stamp
  const colText = T.buildPageFromTextItems(1, items).text.split("\n");
  assert.equal(colText[0], "Left column line number 0 of the page");
  assert.equal(colText[11], "Left column line number 11 of the page");
  assert.equal(colText[12], "Right column line number 0 of the page");
  assert.ok(!colText.join(" ").includes("Downloaded"));

  // A landscape table: every item turned by 90 degrees, rows advance along +x
  const rot = [];
  [["Compound", "ET/kJ mol-1"], ["Benzophenone", "287"], ["Xanthone", "310"], ["Anthracene", "178"]].forEach((row, r) => {
    rot.push({ str: row[0], transform: [0, 9, -9, 0, 200 + r * 14, 150], width: 70 });
    rot.push({ str: row[1], transform: [0, 9, -9, 0, 200 + r * 14, 420], width: 50 });
  });
  const rotPage = T.buildPageFromTextItems(1, rot);
  assert.deepEqual(rotPage.tables[0], [["Compound", "ET/kJ mol-1"], ["Benzophenone", "287"], ["Xanthone", "310"], ["Anthracene", "178"]]);

  // Handbook table: empty cells, compound name on its own row, one data row per solvent
  {
    const it = (str, x, y, w) => ({ str, transform: [9, 0, 0, 9, x, y], width: w || str.length * 4.5 });
    const hb = [
      it("Table 3a Photophysical Parameters of Organic Species", 50, 700),
      it("No.", 50, 680), it("Solv.", 75, 680), it("ES /kJ mol-1", 110, 680), it("Ref.", 190, 680), it("ET /kJ mol-1", 240, 680), it("Ref.", 320, 680),
      it("49", 50, 665), it("Benzophenone", 80, 665),
      it("n", 78, 650), it("316", 115, 650), it("[0201]", 185, 650), it("287", 245, 650), it("[7001]", 318, 650),
      it("p", 78, 635), it("290", 245, 635), it("[7001]", 318, 635),            // ES empty: 290 must stay under ET
      it("50", 50, 620), it("Xanthone", 80, 620),
      it("n", 78, 605), it("324", 115, 605), it("[0201]", 185, 605), it("310", 245, 605), it("[7001]", 318, 605),
    ];
    const pg = T.buildPageFromTextItems(7, hb);
    const tb = pg.tables.find((x) => x[0].includes("Solv."));
    assert.ok(tb, "handbook table found");
    assert.deepEqual(tb[3], ["", "p", "", "", "290", "[7001]"]);
    const hbHits = T.extractFromTables({ name: "hb.pdf", pages: [pg] }, kb.byName, { doi: null, citation: "Handbook" });
    assert.deepEqual(hbHits.map((h) => [h.name, h.et_reported, h.conditions]), [
      ["Benzophenone", "287 kJ/mol", "Non-polar solvent"],
      ["Benzophenone", "290 kJ/mol", "Polar solvent"],
      ["Xanthone", "310 kJ/mol", "Non-polar solvent"],
    ]);
  }

  // The minus of "mol-1" set in a symbol font (U+0002), raised above the line
  const sup = T.buildPageFromTextItems(1, [
    { str: "an ET of 61 kcal mol", transform: [9, 0, 0, 9, 305, 362.2], width: 56 },
    { str: "\u0002", transform: [5.6, 0, 0, 5.6, 361, 366], width: 4 },
    { str: "1", transform: [5.6, 0, 0, 5.6, 365, 366], width: 3 },
    { str: ".", transform: [9, 0, 0, 9, 369, 362.2], width: 2 },
  ]).text;
  assert.equal(sup, "an ET of 61 kcal mol-1.");

  // Metal complexes
  assert.equal(T.tightenComplexFormulas("of Ir*[dF(CF 3 )ppy] 2 (dtbbpy) (60.1 kcal mol-1)"), "of Ir*[dF(CF3)ppy]2(dtbbpy) (60.1 kcal mol-1)");
  assert.equal(T.tightenComplexFormulas("Ru(dtbbpy)2(bpy)(PF6 )2 (ET = 46.9 kcal/mol)"), "Ru(dtbbpy)2(bpy)(PF6)2 (ET = 46.9 kcal/mol)");
  assert.equal(T.tightenComplexFormulas("the known [Ir(dFN(Me) 2ppy) 2(CN)2] complex"), "the known [Ir(dFN(Me)2ppy)2(CN)2] complex");
  assert.equal(T.scanComplexes("Ru(bpy)3(PF6)2(ET = 46.8 kcal/mol)58 did not")[0][2], "Ru(bpy)3(PF6)2");
  assert.equal(T.scanComplexes("the known [Ir(dFN(Me)2ppy)2(CN)2] complex")[0][2], "[Ir(dFN(Me)2ppy)2(CN)2]");
  assert.equal(T.complexKey("Ir*[dF(CF3)ppy]2(dtbbpy)"), T.complexKey("[Ir(dF(CF3)ppy)2(dtbbpy)]PF6"));
  assert.equal(T.complexKey("Ir[dF(CF3)ppy2](dtbpy)PF6"), T.complexKey("[Ir(dF(CF3)ppy)2(dtbbpy)]+"));
  assert.equal(T.complexKey("benzophenone"), "");
  assert.ok(kb.byComplex[T.complexKey("Ru(dtbbpy)2(bpy)(PF6)2")]);

  // The name stands right before the bracket that holds the value
  assert.deepEqual(names("We explored the cycloaddition of norbornadiene (NBD, 1c, ET = 62.1 kcal mol-1) with C1 at 370 nm."), [["norbornadiene", 62.1]]);
  assert.deepEqual(names("ET values for 1 a (46.8 kcal mol-1) and 1 b (47.4 kcal mol-1) were calculated."), [["1a", 46.8], ["1b", 47.4]]);
  assert.deepEqual(names("Using 221 (ET = 50.7 kcal/mol) as photocatalyst resulted in 231."), [["221", 50.7]]);
  assert.deepEqual(
    names("sensitizers C1-C5 for isomerization of fumarate 1a-E (E T = 66.0 kcal mol-1) to maleate 1a- Z (ET = 71.0 kcal mol-1)."),
    [["fumarate 1a-E", 66], ["maleate 1a-Z", 71]]
  );
  assert.deepEqual(
    names("[Ir(ppy)2(dtbbpy)]PF6 was inadequate (11%, ET = 2.12 eV, 205 kJ mol-1)."),
    [["[Ir(ppy)2(dtbbpy)]PF6", 2.12]] // not "inadequate", and eV + kJ are one value
  );
  assert.deepEqual(
    names("The greatest ratio is generated by 4CzTPN (Z/E = 8.56, 90% yield of Z-isomer, ET = 2.34 eV (226 kJ mol-1)), followed by 4CzPN (Z/E = 8.10, ET = 2.45 eV (236 kJ mol-1))."),
    [["4CzTPN", 2.34], ["4CzPN", 2.45]]
  );
  assert.deepEqual(
    names("a series of triplet sensitizers: acetonaphthone (ET 59.3 kcal/mole), thioxanthone (ET 65.51, benzophenone (ET 68.5) and acetophenone (ET 73.6)."),
    [["acetonaphthone", 59.3], ["thioxanthone", 65.5], ["benzophenone", 68.5], ["acetophenone", 73.6]]
  );

  // The molecule named between the cue and the value wins over a nearer one
  assert.deepEqual(
    names("The triplet energy of parent thioxanthone has been determined as 264 kJ mol-1, while xanthone is at 310 kJ mol-1."),
    [["thioxanthone", 264], ["xanthone", 310]]
  );
  assert.deepEqual(names("Chrysanthenone was formed; the ET of verbenone = 3.0 eV."), [["verbenone", 3]]);
  // A common noun before the bracket means the molecule is not named here: no guessing
  assert.deepEqual(names("Riboflavin failed; the triplet energy of the photocatalyst (ET = 67 kcal/mol) is too low."), [["(unnamed candidate)", 67]]);
  // A derivative is not the parent compound
  assert.equal(names("The triplet energy of the thioxanthone 1 derivative (263 kJ mol-1) was measured.")[0][0], "thioxanthone 1 derivative");
  // Stray superscripts between number and unit
  assert.deepEqual(names("Acetophenone (ET = 3.21 1 eV) was used."), [["Acetophenone", 3.21]]);
  assert.deepEqual(names("ET for 5a (46.8 kcal 1 mol-1) and 5b (47.4 kcal mol-1)."), [["5a", 46.8], ["5b", 47.4]]);
  // Oxidation states are not molecules
  assert.equal(T.scanComplexes("a new Ir(III) luminophore with a high triplet energy").length, 0);
  assert.equal(T.scanComplexes(T.tightenComplexFormulas("Ru(bpy)3(5a) and Ru(bpz) 32+ (5b)"))[1][2], "Ru(bpz)3");
  // Guessing among several molecules is flagged
  const guess = T.pairWithConfidence("Benzophenone and xanthone were compared and a triplet energy of 69 kcal/mol was found.",
    T.findMoleculeSpansInSentence("Benzophenone and xanthone were compared and a triplet energy of 69 kcal/mol was found.", kb.keys).spans,
    T.extractEnergyMatchesInSentence("Benzophenone and xanthone were compared and a triplet energy of 69 kcal/mol was found."));
  assert.deepEqual(guess.how, ["proximity"]);

  // Inverted index names
  assert.equal(T.uninvertIndexName("Anthracene, 9,10-dibromo-"), "9,10-dibromoanthracene");
  assert.equal(T.uninvertIndexName("Benzonitrile, 4-methoxy-"), "4-methoxybenzonitrile");
  assert.equal(T.uninvertIndexName("9,10-Anthraquinone"), "");
  assert.equal(T.uninvertIndexName("1,4-Benzoquinone, tetrachloro-"), "tetrachloro-1,4-Benzoquinone");
  assert.equal(T.uninvertIndexName("Porphyrin, tetraphenyl-, zinc(II)"), "zinc tetraphenylporphyrin");
  assert.equal(T.uninvertIndexName("Pyrylium, 2,6-dimethyl-4-phenyl-, perchlorate"), "2,6-dimethyl-4-phenylpyrylium perchlorate");
  assert.equal(T.uninvertIndexName("Acetophenone, 4'-phenyl"), "4'-phenylacetophenone");
  assert.equal(T.uninvertIndexName("Benzene, toluene and xylene"), "");

  // Other spellings asked on PubChem: same compound (exact) or only a suggestion
  const queries = (name) => T.nameQueries(name);
  const exactOf = (name) => queries(name).filter((x) => x.exact).map((x) => x.q);
  const guessOf = (name) => queries(name).filter((x) => !x.exact).map((x) => x.q);
  assert.ok(exactOf("β-Carotene").includes("beta-Carotene"));
  assert.ok(exactOf("9-Acridinone").includes("acridone"));
  assert.ok(exactOf("1,8-Naphthalenedicarboximide, N-methyl-").includes("N-methyl-1,8-naphthalimide"));
  assert.ok(exactOf("Phenanthrene, 9-(methylsulfinyl)-").includes("9-methylsulfinylphenanthrene"));
  assert.ok(exactOf("Acridinium, 3,6-diamino-l0-methyl-").includes("3,6-diamino-10-methylacridinium"));
  assert.ok(exactOf("fumaronitrile 3c").includes("fumaronitrile"));
  // a class word or a derivative is never reduced to the parent compound
  assert.deepEqual(exactOf("fumarate 1a-E"), ["fumarate 1a-E"]);
  assert.deepEqual(exactOf("thioxanthone 1 derivative"), ["thioxanthone 1 derivative"]);
  // dropping the metal, the counter-ion or the charge gives another species: suggestion only
  assert.deepEqual(guessOf("Porphyrin, tetraphenyl-, zinc(II)"), ["tetraphenylporphyrin"]);
  assert.deepEqual(guessOf("Fluorescein dianion"), ["fluorescein"]);
  assert.ok(!exactOf("Fluorescein dianion").includes("fluorescein"));
  assert.deepEqual(guessOf("8-acetonaphthone"), ["beta-acetonaphthone"]);
  assert.deepEqual(guessOf("Benzophenone"), []);

  // Labels defined in the paper
  const labDoc = { pages: [
    { pageNum: 1, text: "photoreduction and photooxidation reactions of Ru(bpy) 32+ (1 a) are known.\nWe used [Ir(dFCF3ppy)2(dtb)]+ (PC-10) and the\nhydrodechlorination of 4-chloroanisole (2a, 1 equiv). See benzophenone (S1) and ref (3b)." },
    { pageNum: 2, text: "With thioxanthone (4a) and later xanthone (4a) the label is ambiguous. Dimethyl fumarate (5a) is an ester." }
  ] };
  const defs = T.labelDefinitions(labDoc, kb.keys);
  assert.equal(defs["1a"].name, "Ru(bpy)3");
  assert.equal(defs["pc-10"].name, "[Ir(dFCF3ppy)2(dtb)]");
  assert.equal(defs["2a"].name, "4-chloroanisole");
  assert.equal(defs["4a"], null);
  assert.ok(!("s1" in defs) && !("3b" in defs));
  assert.equal(defs["5a"].name, "Dimethyl fumarate"); // an ester is a compound, not a class word
  const labelled = [{ name: "1a", verify_note: "x" }, { name: "Catalyst PC-10" }, { name: "4a" }, { name: "benzophenone 2a" }, { name: "9b" }];
  T.applyLabelDefinitions(labelled, defs);
  assert.deepEqual(labelled.map((c) => c.name), ["Ru(bpy)3", "[Ir(dFCF3ppy)2(dtb)]", "4a", "benzophenone 2a", "9b"]);
  assert.match(labelled[0].verify_note, /calls this compound “1a”.*p\. 1/);

  // Things that are not a triplet energy of a molecule
  const none = (sent) => assert.deepEqual(T.extractEnergyMatchesInSentence(sent), [], sent);
  none("The energy to undergo triplet-triplet energy transfer is much higher (4.11 and 4.12 eV; Figure 5).");
  none("The 0-0 transition energy (E0,0) was determined to be 3.35 eV at 370 nm.");
  none("These results indicate that the triplet energy of 1 is probably upwards of 70 kcal/mole.");
  none("We postulate that the triplet energy of 14 is higher than 56 kcal mol-1.");
  const page = (text) => ({ name: "x.pdf", pages: [{ pageNum: 2, text, layoutText: "", tables: [] }] });
  const prose = (text) => T.extractFromProse(page(text), kb.byName, kb.keys, { doi: null, citation: null });
  assert.equal(prose("In general, styrenes possess excited state triplet energies (ET) of approximately 60 kcal mol-1.").length, 0);
  assert.equal(prose("Benzophenone has a triplet energy of approximately 69 kcal mol-1.").length, 1);
}

// 5d. Regressions from the arts/ciao review files
{
  const kb = T.buildKnowledgeIndex([]);
  const one = (text) => T.extractFromProse({ name: "r.pdf", pages: [{ pageNum: 3, text, layoutText: "", tables: [] }] },
    kb.byName, kb.keys, { doi: null, citation: null });
  const vals = (text) => one(text).map((h) => h.et_kcal);
  const named = (text) => one(text).map((h) => [h.name, h.et_kcal]);
  // bounds, limits, class statements and changes are not values of a molecule
  assert.deepEqual(vals("Their triplet energies (ET up to 2.81 eV) are among the highest known to date."), []);
  assert.deepEqual(vals("The three experiments demonstrate that it is able to sensitize substrates with triplet energies up to 3.0 eV."), []);
  assert.deepEqual(vals("In particular, the triplet energies (ET) of the most commonly used Ir PCs do not typically exceed 2.75 eV and their photoreducing strength is modest."), []);
  assert.deepEqual(vals("Nevertheless, the triplet energy level (ET ) of 64 kcal mol-1 has represented a plateau until very recent advances."), []);
  assert.deepEqual(vals("An iridium complex is capable of sensitizing certain styrenes (ET 250 kJ mol-1)."), []);
  assert.deepEqual(vals("Considering the triplet energies of the oxime esters of aliphatic carboxylic acids (ET = 45.4 kcal mol-1), we envisioned a transfer."), []);
  assert.deepEqual(vals("This example shows that despite nearly identical thermodynamics (same triplet energy of 2.50 eV for both photosensitizers), lifetimes matter."), []);
  assert.deepEqual(vals("Lewis acid activation lowers both the triplet energy (62.6 kcal mol-1 - 52.1 kcal mol-1) and the barrier."), []);
  // one molecule and two values: the second value belongs to someone else
  assert.deepEqual(named("For the [Ir(dFN(Me)2ppy)2(BCF)2] / Bph donor-acceptor couple we estimate a driving-force based on the triplet energies of 2.99 and 2.84 eV."),
    [["[Ir(dFN(Me)2ppy)2(BCF)2]", 69.0], ["(unnamed candidate)", 65.5]]);
  // gold complexes, esters, common substrates and compound numbers
  assert.deepEqual(named("[Au(SIPr)Cbz] and [Au(IPr)(Cbz)] have higher triplet energy (ET) values (66.6 and 66.3 kcal mol-1, respectively)."),
    [["[Au(SIPr)Cbz]", 66.6], ["[Au(IPr)(Cbz)]", 66.3]]);
  assert.deepEqual(named("As a first test reaction, we chose the photoisomerization of trans-methyl cinnamate (ET = 2.38 eV) to its cis-isomer."),
    [["trans-methyl cinnamate", 54.9]]);
  assert.deepEqual(named("We examined methyl fumarate E-3a (ET = 66.2 kcal mol-1) and methyl maleate Z-3a (ET = 71.0 kcal mol-1)."),
    [["methyl fumarate", 66.2], ["methyl maleate", 71.0]]);
  assert.deepEqual(named("The triplet energy of cinnamic aldehyde (6a) for example has been determined as ET = 300 kJ mol-1."),
    [["cinnamic aldehyde", 71.7]]);
  assert.deepEqual(named("The cyclization was inhibited in the presence of isoprene, a more efficient triplet quencher due to its lower ET value of 60 kcal mol-1."),
    [["isoprene", 60.0]]);
  assert.deepEqual(named("The triplet energy of 3 is higher (74.6 kcal mol-1) compared to 1a (63.2 kcal mol-1) and [Au(SIPr)(Cbz)] (67.9 kcal mol-1)."),
    [["3", 74.6], ["1a", 63.2], ["[Au(SIPr)(Cbz)]", 67.9]]);
  assert.deepEqual(named("These values correspond to ET values of 65.9 kcal mol-1 for 3g and higher for the other complexes."), [["3g", 65.9]]);
  assert.deepEqual(vals("Fewer photocatalysts have ET values that exceed 64 kcal mol-1."), []);
  assert.deepEqual(vals("The excited complex lies above the substrate ET (by ~0.9 eV) in this case."), []);
  assert.equal(T.scanComplexes("we used fac-Ir(pmb)3(where pmb represents a carbene) here")[0][2], "fac-Ir(pmb)3");
  // a value that refers back to the complex named in the sentence before
  const back = one("We attached B(C6F5)3 to give [Ir(dFN(Me)2ppy)2(BCF)2]. This new complex exhibits an exceptionally high triplet energy of 2.99 eV.");
  assert.equal(back[0].name, "(unnamed candidate)");
  assert.equal(back[0].suggest_name, "[Ir(dFN(Me)2ppy)2(BCF)2]");

  // ligatures in the private area, decided from the document's own words
  const lig = { pages: [{ text: "the simplest of avonoids, avone with an ET value\nflavone is cheap", layoutText: "avone", tables: [[["avone"]]] }] };
  assert.deepEqual(T.fixPrivateLigatures(lig), ["U+E104 read as “fl”"]);
  assert.match(lig.pages[0].text, /flavonoids, flavone with/);
  assert.equal(lig.pages[0].tables[0][0][0], "flavone");
  assert.equal(EntPdf.normalizeText("E1/2 = 1.56 V"), "E1/2 = +1.56 V");

  // a table name cell that swallowed the absorption column
  const tdoc = { name: "t.pdf", pages: [{ pageNum: 5, text: "Table 1. Summary of photophysical data", layoutText: "",
    tables: [[["complex", "ET /eV"], ["[Ru(bpy)2(BCF) 2] 390 (7500)", "2.50"], ["[Ru(bpy)3] 452 (13 000)", "2.12"]]] }] };
  assert.deepEqual(T.extractFromTables(tdoc, kb.byName, { doi: null, citation: null }).map((h) => h.name), ["[Ru(bpy)2(BCF)2]", "[Ru(bpy)3]"]);

  // OPSIN only where it cannot guess: no metals, no substituents without locants
  const oq = (name) => T.opsinQueries(name, T.nameQueries(name)).map((x) => x.q);
  assert.ok(oq("2-Pyridyl 3-thienyl ketone").includes("2-Pyridyl 3-thienyl ketone"));
  assert.ok(oq("Pyrylium, 2,6-dimethyl-4-phenyl-, perchlorate").includes("2,6-dimethyl-4-phenylpyrylium perchlorate"));
  assert.deepEqual(oq("Porphyrin, zinc(II)"), []);
  assert.deepEqual(oq("Tetrabenzoporphyrin, zinc(II)"), []);
  assert.ok(!oq("1,3-Butadiene, di(2-thienyl)-").some((q) => /^di\(/.test(q)));
  // known misprints of the handbook
  assert.ok(T.nameQueries("1,4-Benzoquinone,tetrachioro-").some((x) => x.exact && x.q === "tetrachloro-1,4-Benzoquinone"));
  assert.ok(T.nameQueries("1,8-Naphthalenedicarboximide, N-methy-").some((x) => x.exact && x.q === "N-methyl-1,8-naphthalimide"));
}

// 6. admin.html wiring checks
const adminHtml = readFileSync(join(root, "docs/admin.html"), "utf8");
for (const needle of [
  'id="pdf-box"',
  'id="pdf-drop"',
  'id="pdf-file"',
  'id="pdf-go"',
  'id="pdf-dl-json"',
  'id="pdf-load-up"',
  'id="pdf-review-open"',
  'id="pdf-modal"',
  "https://api.crossref.org",
  "https://doi.org",
  "assets/pdf-extract.js",
  'id="pdf-ocr"',
  'id="pdf-files"',
  "worker-src blob:",
  "'wasm-unsafe-eval'",
  "https://www.ebi.ac.uk",
]) {
  assert.ok(adminHtml.includes(needle), `admin.html missing: ${needle}`);
}

console.log("pdf-extract tests passed");
