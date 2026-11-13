/* TrEnDB browser PDF extractor: turns article PDFs into trendb-extract batch JSON (no LLM). */
(function () {
  "use strict";
  var Ent = window.Ent = window.Ent || {};
  var EntPdf = window.EntPdf = window.EntPdf || {};

  var PDFJS_VER = "3.11.174";
  var PDFJS_BASES = [
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + PDFJS_VER + "/build/",
    "https://unpkg.com/pdfjs-dist@" + PDFJS_VER + "/build/"
  ];
  var PDFJS_SRI = {
    worker: "sha256-/qvfMJdw7SS7oxpUZ4Ns3Iz2OccFryfVK1hbBBu4Uns=",
    lib: "sha256-W1eZ5vjGgGYyB6xbQu4U7tKkBvp69I9QwVTwwLFWaUY="
  };

  /* OCR (Tesseract.js) is loaded only when a PDF has scanned pages or picture-only tables. */
  var TESS_VER = "5.1.1", TESS_CORE_VER = "5.1.1";
  var TESS_BASES = ["https://cdn.jsdelivr.net/npm/", "https://unpkg.com/"];
  var TESS_SRI = "sha256-qOKZGNCYsrBuEBK9rv+0rsBEXF1WVHCQI+C9H0QqgOg=";
  var TESS_LANG_PATH = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int";

  var pdfLoadPromise = null;
  function loadScriptFrom(urls, sri, what) {
    return new Promise(function (resolve, reject) {
      (function next(idx) {
        if (idx >= urls.length) {
          reject(new Error("Could not load " + what + ". Check the network connection and try again."));
          return;
        }
        var s = document.createElement("script");
        s.src = urls[idx];
        s.integrity = sri;
        s.crossOrigin = "anonymous";
        s.onload = function () { resolve(idx); };
        s.onerror = function () { s.remove(); next(idx + 1); };
        document.head.appendChild(s);
      })(0);
    });
  }
  function loadScriptWithFallback(file, sri) {
    return loadScriptFrom(PDFJS_BASES.map(function (b) { return b + file; }), sri, "the PDF reader library (" + file + ")");
  }
  function withTimeout(promise, ms, what) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(what + " timed out.")); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  var ocrWorkerPromise = null;
  EntPdf.loadOcr = function () {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    var pLib = window.Tesseract
      ? Promise.resolve(0)
      : loadScriptFrom(TESS_BASES.map(function (b) { return b + "tesseract.js@" + TESS_VER + "/dist/tesseract.min.js"; }), TESS_SRI, "the OCR library");
    ocrWorkerPromise = pLib.then(function (idx) {
      if (!window.Tesseract || !window.Tesseract.createWorker) throw new Error("OCR library did not initialize.");
      var base = TESS_BASES[idx] || TESS_BASES[0];
      return withTimeout(window.Tesseract.createWorker("eng", 1, {
        workerPath: base + "tesseract.js@" + TESS_VER + "/dist/worker.min.js",
        corePath: base + "tesseract.js-core@" + TESS_CORE_VER,
        langPath: TESS_LANG_PATH,
        workerBlobURL: true
      }), 90000, "Starting the OCR engine");
    }).catch(function (err) {
      ocrWorkerPromise = null;
      throw err;
    });
    return ocrWorkerPromise;
  };
  EntPdf.terminateOcr = function () {
    var p = ocrWorkerPromise;
    ocrWorkerPromise = null;
    if (p) p.then(function (w) { return w && w.terminate && w.terminate(); }).catch(function () {});
  };

  EntPdf.loadPdfJs = function () {
    if (window.pdfjsLib && window.pdfjsWorker) return Promise.resolve(window.pdfjsLib);
    if (pdfLoadPromise) return pdfLoadPromise;
    pdfLoadPromise = loadScriptWithFallback("pdf.worker.min.js", PDFJS_SRI.worker)
      .then(function () { return loadScriptWithFallback("pdf.min.js", PDFJS_SRI.lib); })
      .then(function () {
        if (!window.pdfjsLib) throw new Error("PDF reader library did not initialize.");
        return window.pdfjsLib;
      })
      .catch(function (err) {
        pdfLoadPromise = null;
        throw err;
      });
    return pdfLoadPromise;
  };

  /* ---------- Text normalization (mirrors src/trendb/textnorm.py) ---------- */
  var CHAR_MAP = {
    "\u00ad": "", "\u200b": "", "\u200c": "", "\u200d": "", "\ufeff": "",
    "\u2010": "-", "\u2011": "-", "\u2212": "-", "\u2044": "/", "\u2215": "/",
    "\u22c5": "\u00b7", "\u2219": "\u00b7"
  };
  var CHAR_MAP_RE = /[\u00ad\u200b\u200c\u200d\ufeff\u2010\u2011\u2212\u2044\u2215\u22c5\u2219]/g;
  var CTRL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  function normalizeText(text) {
    if (!text) return "";
    var s = String(text);
    if (s.normalize) s = s.normalize("NFKC");
    // Publisher symbol fonts: U+0002 is the minus of "mol-1", and "ð ... Þ" are tall brackets.
    s = s.replace(/\u0002(?=\s*\d)/g, "-").replace(/ð([^ðÞ\n]{1,80})Þ/g, "($1)");
    return s.replace(CTRL_CHARS_RE, " ").replace(CHAR_MAP_RE, function (ch) { return CHAR_MAP[ch] != null ? CHAR_MAP[ch] : ch; });
  }
  function normalizeCell(cell) {
    return normalizeText(cell).replace(/\n/g, " ").trim();
  }
  EntPdf.normalizeText = normalizeText;

  /* ---------- Builtin sensitizer/acceptor seed (mirrors src/trendb/resolvers.py) ---------- */
  var BUILTIN_MOLECULES = {
    "benzophenone": "O=C(c1ccccc1)c1ccccc1",
    "bp": "O=C(c1ccccc1)c1ccccc1",
    "acetophenone": "CC(=O)c1ccccc1",
    "xanthone": "O=c1c2ccccc2oc2ccccc12",
    "thioxanthone": "O=c1c2ccccc2sc2ccccc12",
    "tx": "O=c1c2ccccc2sc2ccccc12",
    "2-isopropylthioxanthone": "O=c1c2cc(C(C)C)ccc2sc2ccccc12",
    "itx": "O=c1c2cc(C(C)C)ccc2sc2ccccc12",
    "9-fluorenone": "O=C1c2ccccc2-c2ccccc12",
    "fluorenone": "O=C1c2ccccc2-c2ccccc12",
    "naphthalene": "c1ccc2ccccc2c1",
    "anthracene": "c1ccc2cc3ccccc3cc2c1",
    "phenanthrene": "c1ccc2c(c1)ccc1ccccc12",
    "pyrene": "c1cc2ccc3cccc4ccc(c1)c2c34",
    "perylene": "c1cc2cccc3c4cccc5cccc(c(c1)c23)c54",
    "biphenyl": "c1ccc(-c2ccccc2)cc1",
    "styrene": "C=Cc1ccccc1",
    "(e)-stilbene": "C(=C/c1ccccc1)\\c1ccccc1",
    "trans-stilbene": "C(=C/c1ccccc1)\\c1ccccc1",
    "(z)-stilbene": "C(=C\\c1ccccc1)\\c1ccccc1",
    "cis-stilbene": "C(=C\\c1ccccc1)\\c1ccccc1",
    "biacetyl": "CC(=O)C(C)=O",
    "2,3-butanedione": "CC(=O)C(C)=O",
    "4czipn": "N#Cc1c(N2c3ccccc3c3ccccc32)c(N2c3ccccc3c3ccccc32)c(N2c3ccccc3c3ccccc32)c(C#N)c1N1c2ccccc2c2ccccc21",
    "carbazole": "c1ccc2c(c1)[nH]c1ccccc21",
    "benzene": "c1ccccc1",
    "toluene": "Cc1ccccc1",
    "acetone": "CC(C)=O",
    "coumarin": "O=c1ccc2ccccc2o1",
    "chalcone": "O=C(/C=C/c1ccccc1)c1ccccc1",
    "triphenylene": "c1ccc2c(c1)c1ccccc1c1ccccc21",
    "chrysene": "c1ccc2c(c1)ccc1c3ccccc3ccc21",
    "benzil": "O=C(C(=O)c1ccccc1)c1ccccc1",
    "acridine": "c1ccc2nc3ccccc3cc2c1",
    "duroquinone": "CC1=C(C)C(=O)C(C)=C(C)C1=O",
    "2,3-dimethyl-1,4-benzoquinone": "CC1=C(C)C(=O)C=CC1=O",
    "2,5-dimethyl-1,4-benzoquinone": "CC1=CC(=O)C(C)=CC1=O",
    "1,4-benzoquinone": "O=C1C=CC(=O)C=C1",
    "1,4-naphthoquinone": "O=C1C=CC(=O)c2ccccc21",
    "benzanthrone": "O=C1c2ccccc2-c2cccc3cccc1c23",
    "2,2'-binaphthyl": "c1ccc2cc(-c3ccc4ccccc4c3)ccc2c1",
    "1-chloronaphthalene": "Clc1cccc2ccccc12",
    "1-bromonaphthalene": "Brc1cccc2ccccc12",
    "2-acetonaphthone": "CC(=O)c1ccc2ccccc2c1",
    "1-naphthyl phenyl ketone": "O=C(c1ccccc1)c1cccc2ccccc12",
    "cis-1,2-diphenylpropene": "C/C(=C/c1ccccc1)c1ccccc1",
    "trans-1,2-diphenylpropene": "C/C(=C\\c1ccccc1)c1ccccc1",
    "9,10-dibromoanthracene": "Brc1c2ccccc2c(Br)c2ccccc12",
    "chloranil": "O=C1C(Cl)=C(Cl)C(=O)C(Cl)=C1Cl",
    "benz[a]anthracene": "c1ccc2cc3c(ccc4ccccc43)cc2c1",
    "1,2-benzanthracene": "c1ccc2cc3c(ccc4ccccc43)cc2c1",
    "dibenz[a,h]anthracene": "c1ccc2c(c1)ccc1cc3c(ccc4ccccc43)cc12",
    "1,2,5,6-dibenzanthracene": "c1ccc2c(c1)ccc1cc3c(ccc4ccccc43)cc12",
    "dibenz[a,c]anthracene": "c1ccc2cc3c4ccccc4c4ccccc4c3cc2c1",
    "1,2,3,4-dibenzanthracene": "c1ccc2cc3c4ccccc4c4ccccc4c3cc2c1",
    "benzo[a]pyrene": "c1ccc2c(c1)cc1ccc3cccc4ccc2c1c34",
    "3,4-benzpyrene": "c1ccc2c(c1)cc1ccc3cccc4ccc2c1c34",
    "7,12-dimethylbenz[a]anthracene": "Cc1c2ccccc2c(C)c2c1ccc1ccccc12",
    "9,10-dimethyl-1,2-benzanthracene": "Cc1c2ccccc2c(C)c2c1ccc1ccccc12",
    "1-acetylpyrene": "CC(=O)c1ccc2ccc3cccc4ccc1c2c34",
    "3-acetylpyrene": "CC(=O)c1ccc2ccc3cccc4ccc1c2c34",
    "trans,trans-1,4-diphenyl-1,3-butadiene": "C(/C=C/c1ccccc1)=C\\c1ccccc1",
    "michler's ketone": "CN(C)c1ccc(C(=O)c2ccc(N(C)C)cc2)cc1",
    "ir(ppy)3": "[Ir]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)c1ccccc1-c1ccccn->31",
    "fac-ir(ppy)3": "[Ir]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)c1ccccc1-c1ccccn->31",
    "ir(dfppy)3": "[Ir]123(c4cc(F)cc(F)c4-c4ccccn->14)(c1cc(F)cc(F)c1-c1ccccn->21)c1cc(F)cc(F)c1-c1ccccn->31",
    "fac-ir(dfppy)3": "[Ir]123(c4cc(F)cc(F)c4-c4ccccn->14)(c1cc(F)cc(F)c1-c1ccccn->21)c1cc(F)cc(F)c1-c1ccccn->31",
    "ru(bpy)3": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccccc1-c1ccccn->21)<-n1ccccc1-c1ccccn->31",
    "[ru(bpy)3]2+": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccccc1-c1ccccn->21)<-n1ccccc1-c1ccccn->31",
    "ru(bpy)3(pf6)2": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccccc1-c1ccccn->21)<-n1ccccc1-c1ccccn->31",
    "[ir(df(cf3)ppy)2(dtbbpy)]+": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C(F)(F)F)cn->14)(c1cc(F)cc(F)c1-c1ccc(C(F)(F)F)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(df(cf3)ppy)2(dtbbpy)]pf6": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C(F)(F)F)cn->14)(c1cc(F)cc(F)c1-c1ccc(C(F)(F)F)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(df(me)ppy)2(dtbbpy)]+": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C)cn->14)(c1cc(F)cc(F)c1-c1ccc(C)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(df(me)ppy)2(dtbbpy)]pf6": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C)cn->14)(c1cc(F)cc(F)c1-c1ccc(C)cn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "ru(bpz)3": "[Ru+2]123(<-n4cncc4-c4cnccn->14)(<-n1cncc1-c1cnccn->21)<-n1cncc1-c1cnccn->31",
    "[ru(bpz)3]2+": "[Ru+2]123(<-n4cncc4-c4cnccn->14)(<-n1cncc1-c1cnccn->21)<-n1cncc1-c1cnccn->31",
    "ru(dtbbpy)2(bpy)": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->21)<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31",
    "ru(dtbbpy)2(bpy)(pf6)2": "[Ru+2]123(<-n4ccccc4-c4ccccn->14)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->21)<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31",
    "ru(phen)3": "[Ru+2]123(<-n4cccc5ccc6cccnc->16c45)(<-n1cccc4ccc5cccnc->25c14)<-n1cccc4ccc5cccnc->35c14",
    "[ru(phen)3]2+": "[Ru+2]123(<-n4cccc5ccc6cccnc->16c45)(<-n1cccc4ccc5cccnc->25c14)<-n1cccc4ccc5cccnc->35c14",
    "ir(ppy)2(dtbbpy)": "[Ir+]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(ppy)2(dtbbpy)]+": "[Ir+]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "[ir(ppy)2(dtbbpy)]pf6": "[Ir+]123(c4ccccc4-c4ccccn->14)(c1ccccc1-c1ccccn->21)(<-n1ccc(C(C)(C)C)cc1-c1cc(C(C)(C)C)ccn->31)",
    "ir(df(cf3)ppy)2(bpy)": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C(F)(F)F)cn->14)(c1cc(F)cc(F)c1-c1ccc(C(F)(F)F)cn->21)(<-n1ccccc1-c1ccccn->31)",
    "[ir(df(cf3)ppy)2(bpy)]+": "[Ir+]123(c4cc(F)cc(F)c4-c4ccc(C(F)(F)F)cn->14)(c1cc(F)cc(F)c1-c1ccc(C(F)(F)F)cn->21)(<-n1ccccc1-c1ccccn->31)",
    "4-czipn": "N#Cc1c(N2c3ccccc3c3ccccc32)c(N2c3ccccc3c3ccccc32)c(N2c3ccccc3c3ccccc32)c(C#N)c1N1c2ccccc2c2ccccc21",
    "2czpn": "N#Cc1cccc(N2c3ccccc3c3ccccc32)c1N1c2ccccc2c2ccccc21",
    "2-chlorothioxanthone": "O=c1c2cc(Cl)ccc2sc2ccccc12",
    "2-fluorothioxanthone": "O=c1c2cc(F)ccc2sc2ccccc12",
    "4-hydroxycoumarin": "O=c1cc(O)c2ccccc2o1",
    "chrysantenone": "CC1=CC(=O)C2(C)CC1C2(C)C",
    "1-naphthaldehyde": "O=Cc1cccc2ccccc12",
    "2-naphthaldehyde": "O=Cc1ccc2ccccc2c1",
    "5,12-naphthacenequinone": "O=C1c2ccccc2C(=O)c2cc3ccccc3cc21"
  };

  var TRAILING_LABEL_RE = /\s*\((?![ezrs]\)|[ezrs],)[^()]*\)\s*$/i;
  var ANONYMOUS_LABEL_RE = /^(?:(?:compound|compd|entry|substrate|catalyst|sensitizer|donor|acceptor|complex|molecule|mol|cat|oxime|diazene|alkene|styrene|ps|pc|c|s|a|d)[-\s]*)?(?:\d+[a-z]{0,3}(?:-[ez])?|[a-z]\d{1,2}|[ivx]+)$/i;

  function normalizeNameKey(name) {
    var t = String(name || "").toLowerCase().replace(/[′’']/g, "'");
    for (var i = 0; i < 3; i++) t = t.replace(TRAILING_LABEL_RE, "");
    return t.replace(/[\s"“”]+/g, "").trim();
  }
  function looksLikeAnonymousLabel(name) {
    var t = String(name || "").trim();
    if (!t || t.length <= 1) return true;
    return ANONYMOUS_LABEL_RE.test(t);
  }

  /* ---------- PDF.js -> PageText (text, layoutText, tables) ---------- */
  function parseLayoutTables(layoutText) {
    var tables = [], cur = [], blankRun = 0;
    String(layoutText || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (!line.trim()) {
        blankRun++;
        if (blankRun >= 2 && cur.length >= 2) { tables.push(cur); cur = []; }
        return;
      }
      blankRun = 0;
      var cols = line.trim().split(/\s{2,}/).map(function (c) { return c.trim(); }).filter(Boolean);
      if (cols.length >= 2) cur.push(cols);
      else {
        if (cur.length >= 2) tables.push(cur);
        cur = [];
      }
    });
    if (cur.length >= 2) tables.push(cur);
    return tables;
  }

  /* Cells of one text line with their horizontal extent: parts closer than a column gap are one cell. */
  function cellsOfLine(parts, fallbackH) {
    var sorted = parts.slice().sort(function (a, b) { return a.x - b.x; });
    var cells = [], cur = null, prevEnd = null;
    sorted.forEach(function (p) {
      var fs = p.h || fallbackH || 10;
      var gap = prevEnd == null ? 0 : p.x - prevEnd;
      if (!cur || gap > Math.max(6, fs * 0.9)) {
        cur = { x0: p.x, x1: p.x + p.w, text: p.str };
        cells.push(cur);
      } else {
        if (gap > Math.max(1.2, fs * 0.16) && !/\s$/.test(cur.text) && !/^\s/.test(p.str)) cur.text += " ";
        cur.text += p.str;
        cur.x1 = Math.max(cur.x1, p.x + p.w);
      }
      prevEnd = p.x + p.w;
    });
    cells.forEach(function (c) { c.text = normalizeText(c.text).trim(); });
    return cells.filter(function (c) { return c.text; });
  }

  /* Tables whose cells are placed under the header column they sit below. Splitting a line on runs
     of spaces loses empty cells, and every value after a gap then lands one column to the left. */
  function alignedTablesFromLines(lines) {
    var tables = [], block = [];
    function flush() {
      if (block.length >= 2) {
        var hi = 0, maxN = 0;
        block.slice(0, 3).forEach(function (r) { if (r.length > maxN) maxN = r.length; });
        // exponents or units printed above the header make a short first row with no words in it
        if (block[0].length * 2 <= maxN && !block[0].some(function (c) { return /[A-Za-z]{2,}/.test(c.text); })) {
          hi = block[1].length >= (block[2] ? block[2].length : 0) || !block[2] ? 1 : 2;
        }
        var head = block[hi];
        var rows = [head.map(function (c) { return c.text; })];
        block.slice(hi + 1).forEach(function (cells) {
          var row = head.map(function () { return ""; });
          cells.forEach(function (cell) {
            var best = 0, bestOv = -Infinity;
            head.forEach(function (hc, j) {
              var ov = Math.min(cell.x1, hc.x1) - Math.max(cell.x0, hc.x0);
              if (ov > bestOv) { bestOv = ov; best = j; }
            });
            row[best] = row[best] ? row[best] + " " + cell.text : cell.text;
          });
          rows.push(row);
        });
        if (rows.length >= 2) tables.push(rows);
      }
      block = [];
    }
    lines.forEach(function (ln) {
      if (!ln.parts.length) return;
      var cells = cellsOfLine(ln.parts, ln.h);
      if (cells.length === 1 && block.length >= 2) {
        // "49 Anthracene, 9-phenyl-": a numbered compound line inside a table stays a row
        var m = /^(\d{1,4})\s+(\S.*[A-Za-z]{3,}.*)$/.exec(cells[0].text);
        if (m) {
          var w = (cells[0].x1 - cells[0].x0) * (m[1].length + 1) / cells[0].text.length;
          cells = [{ x0: cells[0].x0, x1: cells[0].x0 + w, text: m[1] }, { x0: cells[0].x0 + w, x1: cells[0].x1, text: m[2] }];
        }
      }
      if (cells.length >= 2) block.push(cells);
      else flush();
    });
    flush();
    return tables;
  }

  function joinPartsPlain(parts, fallbackH) {
    var sorted = parts.slice().sort(function (a, b) { return a.x - b.x; });
    var buf = "", prevEnd = null;
    sorted.forEach(function (p) {
      if (prevEnd != null) {
        var gap = p.x - prevEnd, fs = p.h || fallbackH || 10;
        if (gap > Math.max(1.2, fs * 0.16) && !/\s$/.test(buf) && !/^\s/.test(p.str)) buf += " ";
      }
      buf += p.str;
      prevEnd = p.x + p.w;
    });
    return normalizeText(buf).trim();
  }

  function joinPartsLayout(parts, fallbackH) {
    var sorted = parts.slice().sort(function (a, b) { return a.x - b.x; });
    var buf = "", prevEnd = null;
    sorted.forEach(function (p) {
      if (prevEnd != null) {
        var gap = p.x - prevEnd, fs = p.h || fallbackH || 10;
        if (gap > Math.max(6, fs * 0.9)) {
          var spaces = Math.min(20, Math.max(2, Math.round(gap / Math.max(3.5, fs * 0.35))));
          buf += new Array(spaces + 1).join(" ");
        } else if (gap > Math.max(1.2, fs * 0.16) && !/\s$/.test(buf) && !/^\s/.test(p.str)) {
          buf += " ";
        }
      }
      buf += p.str;
      prevEnd = p.x + p.w;
    });
    return normalizeText(buf).replace(/\s+$/, "");
  }

  /* Find the gutter between two text columns. Columns whose baselines do not line up produce
     lines that sit wholly on one side, so a side counts whether or not the other side shares the line. */
  function findGutter(lines) {
    var minX = Infinity, maxX = -Infinity;
    lines.forEach(function (ln) {
      ln.parts.forEach(function (p) {
        if (p.x < minX) minX = p.x;
        if (p.x + p.w > maxX) maxX = p.x + p.w;
      });
    });
    var W = maxX - minX;
    if (!(W > 180) || lines.length < 6) return null;
    var best = null;
    for (var g = minX + W * 0.3; g <= minX + W * 0.7; g += 3) {
      var cross = 0, nL = 0, nR = 0;
      lines.forEach(function (ln) {
        if (ln.parts.some(function (p) { return p.x < g - 2 && p.x + p.w > g + 2; })) { cross++; return; }
        var hasL = false, hasR = false;
        ln.parts.forEach(function (p) { if (p.x + p.w <= g + 2) hasL = true; else hasR = true; });
        if (hasL) nL++;
        if (hasR) nR++;
      });
      var sc = Math.min(nL, nR) * 2 - cross * 3;
      if (!best || sc > best.score) best = { g: g, last: g, score: sc, cross: cross, nL: nL, nR: nR };
      else if (sc === best.score && g - best.last <= 3.01) best.last = g; // same gap, keep widening
    }
    if (!best || Math.min(best.nL, best.nR) < 6 || best.score < 8 || best.cross > lines.length * 0.35) return null;
    return (best.g + best.last) / 2; // middle of the gap
  }

  function deinterleaveTwoColumns(lines) {
    var bestG = findGutter(lines);
    if (bestG == null) {
      return lines.map(function (ln) { return joinPartsPlain(ln.parts, ln.h); }).filter(Boolean);
    }

    var out = [], leftBuf = [], rightBuf = [];
    function flushCols() {
      if (leftBuf.length) { out = out.concat(leftBuf); leftBuf = []; }
      if (rightBuf.length) { out = out.concat(rightBuf); rightBuf = []; }
    }
    lines.forEach(function (ln) {
      var crosses = ln.parts.some(function (p) { return p.x < bestG - 3 && p.x + p.w > bestG + 3; });
      if (crosses) {
        flushCols();
        var st = joinPartsPlain(ln.parts, ln.h);
        if (st) out.push(st);
        return;
      }
      var lParts = [], rParts = [], maxL = -Infinity, minR = Infinity;
      ln.parts.forEach(function (p) {
        if (p.x + p.w <= bestG + 3) { lParts.push(p); if (p.x + p.w > maxL) maxL = p.x + p.w; }
        else { rParts.push(p); if (p.x < minR) minR = p.x; }
      });
      if (lParts.length && rParts.length) {
        if ((minR - maxL) >= 8) {
          var lt = joinPartsPlain(lParts, ln.h), rt = joinPartsPlain(rParts, ln.h);
          if (lt) leftBuf.push(lt);
          if (rt) rightBuf.push(rt);
        } else {
          flushCols();
          var st2 = joinPartsPlain(ln.parts, ln.h);
          if (st2) out.push(st2);
        }
      } else if (lParts.length) {
        var lt2 = joinPartsPlain(lParts, ln.h);
        if (lt2) leftBuf.push(lt2);
      } else if (rParts.length) {
        var rt2 = joinPartsPlain(rParts, ln.h);
        if (rt2) rightBuf.push(rt2);
      }
    });
    flushCols();
    return out;
  }

  function buildPageFromTextItems(pageNum, items) {
    var lines = [], deferredScripts = [];
    // Landscape tables are stored as text turned by 90 degrees. Read the page in the direction most
    // of its text runs, and drop what runs otherwise (margin stamps, journal banners).
    function quadrant(tr) { return ((Math.round(Math.atan2(Number(tr[1]) || 0, Number(tr[0]) || 0) / (Math.PI / 2)) % 4) + 4) % 4; }
    var weight = [0, 0, 0, 0];
    (items || []).forEach(function (it) {
      if (it && it.str && it.transform) weight[quadrant(it.transform)] += String(it.str).trim().length;
    });
    var dom = weight.indexOf(Math.max.apply(null, weight));
    (items || []).forEach(function (it) {
      if (!it || it.str == null) return;
      var str = String(it.str);
      if (str === "\u0002") str = "-"; // lone minus of a superscript exponent
      if (!str && !it.hasEOL) return;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      if (quadrant(tr) !== dom) return;
      var e = Number(tr[4]) || 0, f = Number(tr[5]) || 0;
      var x = dom === 0 ? e : dom === 1 ? f : dom === 2 ? -e : -f;
      var y = dom === 0 ? f : dom === 1 ? -e : dom === 2 ? -f : e;
      var h = Math.abs(Math.hypot(Number(tr[2]) || 0, Number(tr[3]) || 0) || Number(it.height) || 10) || 10;
      var w = Math.abs(Number(it.width) || (str.length * h * 0.45)) || 0;
      var line = null;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
        if (Math.abs(lines[i].y - y) <= Math.max(2.5, Math.max(lines[i].h, h) * 0.38)) { line = lines[i]; break; }
      }
      if (!line && str.trim().length <= 4 && h <= 8.2 && /^[-−–+@]?\d{1,2}[a-z+−-]*$|^[-−–+]+$/i.test(str.trim()) && str.indexOf(",") < 0) {
        deferredScripts.push({ x: x, y: y, w: w, h: h, str: str });
        return;
      }
      if (!line) { line = { y: y, h: h, parts: [] }; lines.push(line); }
      if (str) line.parts.push({ x: x, w: w, h: h, str: str });
    });
    deferredScripts.forEach(function (sc) {
      var best = null, bestDy = Infinity;
      lines.forEach(function (ln) {
        var dy = Math.abs(ln.y - sc.y);
        if (dy > Math.max(6.0, ln.h * 0.72)) return;
        var nearX = ln.parts.some(function (p) { return sc.x >= p.x - 6 && sc.x <= p.x + p.w + 14; });
        if (nearX && dy < bestDy) { bestDy = dy; best = ln; }
      });
      if (best) best.parts.push(sc);
      else lines.push({ y: sc.y, h: sc.h, parts: [sc] });
    });
    lines.sort(function (a, b) { return b.y - a.y; });
    var layoutLines = [];
    lines.forEach(function (ln) {
      if (!ln.parts.length) return;
      var lt = joinPartsLayout(ln.parts, ln.h);
      if (lt.trim()) layoutLines.push(lt);
    });
    var plainLines = deinterleaveTwoColumns(lines);
    var text = plainLines.join("\n");
    var layoutText = layoutLines.join("\n");
    var tables = alignedTablesFromLines(lines);
    if (!tables.length) tables = parseLayoutTables(layoutText);
    tables = tables.map(function (tb) {
      return tb.map(function (row) { return row.map(normalizeCell); });
    });
    return { pageNum: pageNum, text: text, layoutText: layoutText, tables: tables };
  }

  /* ---------- OCR helpers ---------- */
  var OCR_MIN_CONF = 55;        // Tesseract word confidence (0-100) below which a word is dropped
  var OCR_MIN_PAGE_CHARS = 80;  // a page with less native text than this is treated as scanned
  var TABLE_CAPTION_RE = /\bTable\s+(?:S?\d+|[IVX]+)\b/i;
  var OCR_MAX_DIM = 3600;       // longest canvas side in px (about 300 dpi for A4/Letter)

  function matMul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  /* Bounding boxes (PDF user space, y up) of the raster images a page paints. */
  function imageRegionsFromOps(fnArray, argsArray, OPS) {
    var ctm = [1, 0, 0, 1, 0, 0], stack = [], out = [];
    var paint = {};
    ["paintImageXObject", "paintJpegXObject", "paintInlineImageXObject", "paintImageXObjectRepeat"].forEach(function (k) {
      if (OPS[k] != null) paint[OPS[k]] = 1;
    });
    for (var i = 0; i < fnArray.length; i++) {
      var fn = fnArray[i], args = argsArray[i] || [];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
      else if (fn === OPS.transform && args.length >= 6) ctm = matMul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (Array.isArray(args[0]) && args[0].length === 6) ctm = matMul(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
      else if (paint[fn]) {
        var xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
        var ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
        out.push({
          x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
          x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys)
        });
      }
    }
    return out;
  }

  /* Keep the images worth reading: large enough to hold text, not already covered by real text. */
  function selectOcrRegions(regions, pageBox, textPoints) {
    var pw = pageBox.x1 - pageBox.x0, ph = pageBox.y1 - pageBox.y0, pageArea = Math.max(1, pw * ph);
    var kept = [];
    (regions || []).forEach(function (r) {
      var x0 = Math.max(r.x0, pageBox.x0), y0 = Math.max(r.y0, pageBox.y0);
      var x1 = Math.min(r.x1, pageBox.x1), y1 = Math.min(r.y1, pageBox.y1);
      var w = x1 - x0, h = y1 - y0;
      if (!(w >= 100 && h >= 30) || (w * h) / pageArea < 0.025) return;
      var inside = 0;
      (textPoints || []).forEach(function (pt) { if (pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) inside++; });
      if (inside >= 5) return; // a scan that already carries a text layer, or a background picture
      var dup = kept.some(function (k) {
        var ix = Math.min(k.x1, x1) - Math.max(k.x0, x0), iy = Math.min(k.y1, y1) - Math.max(k.y0, y0);
        return ix > 0 && iy > 0 && (ix * iy) / (w * h) > 0.8;
      });
      if (!dup) kept.push({ x0: x0, y0: y0, x1: x1, y1: y1 });
    });
    kept.sort(function (a, b) { return (b.y1 - a.y1) || (a.x0 - b.x0); });
    return kept.slice(0, 8);
  }

  /* Tesseract result -> text items shaped like pdf.js ones, so the same line/column/table logic applies. */
  function ocrDataToItems(data, scale, canvasHeight, minConf) {
    var items = [], sc = scale || 1, conf = minConf == null ? OCR_MIN_CONF : minConf;
    function addWord(w, lineBox) {
      var txt = String((w && w.text) || "").trim();
      if (!txt || !w.bbox) return;
      if (typeof w.confidence === "number" && w.confidence < conf) return;
      var lb = lineBox || w.bbox;
      var h = Math.max(4, (lb.y1 - lb.y0) / sc);
      items.push({
        str: txt,
        transform: [1, 0, 0, h * 0.8, w.bbox.x0 / sc, (canvasHeight - lb.y1) / sc],
        width: Math.max(1, (w.bbox.x1 - w.bbox.x0) / sc),
        height: h * 0.8
      });
    }
    var lines = (data && data.lines) || [];
    if (lines.length) {
      lines.forEach(function (ln) { (ln.words || []).forEach(function (w) { addWord(w, ln.bbox); }); });
    } else {
      ((data && data.words) || []).forEach(function (w) { addWord(w, null); });
    }
    return items;
  }

  function countChars(text) { return String(text || "").replace(/\s+/g, "").length; }

  function renderPageToCanvas(page) {
    var base = page.getViewport({ scale: 1 });
    var scale = Math.min(300 / 72, OCR_MAX_DIM / Math.max(base.width, base.height, 1));
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // intent "print" makes pdf.js draw without requestAnimationFrame, which browsers pause in a
    // background tab: OCR keeps going when the curator switches to another tab.
    var task = page.render({ canvasContext: ctx, viewport: viewport, intent: "print" });
    return withTimeout(task.promise, 120000, "Rendering a page for OCR").then(function () {
      return { canvas: canvas, viewport: viewport, scale: scale };
    }, function (err) {
      try { task.cancel(); } catch (e) {}
      canvas.width = 0; canvas.height = 0;
      throw err;
    });
  }

  function recognizeCanvas(worker, canvas, psm) {
    return worker.setParameters({ tessedit_pageseg_mode: String(psm) })
      .then(function () { return withTimeout(worker.recognize(canvas), 180000, "OCR of a page"); })
      .then(function (res) { return (res && res.data) || {}; });
  }

  /* OCR one page: the whole page when it has no text layer, otherwise only its text-bearing images.
     Resolves to { page, mode } where mode is "page", "images" or null (nothing gained). */
  function ocrPage(pdfjsLib, page, built, textItems, withImages) {
    var scanned = countChars(built.text) < OCR_MIN_PAGE_CHARS;
    if (!scanned && !withImages) return Promise.resolve({ page: built, mode: null });
    // On a page with real text, pictures are mostly schemes and spectra. Reading them costs
    // seconds each and yields nothing, so only pages that announce a table are worth it.
    if (!scanned && !TABLE_CAPTION_RE.test(built.text)) return Promise.resolve({ page: built, mode: null });
    var pRegions = scanned ? Promise.resolve([]) : withTimeout(page.getOperatorList(), 60000, "Listing the page images").then(function (ops) {
      var vb = page.view || [0, 0, 612, 792];
      var pts = (textItems || []).map(function (it) {
        var tr = it.transform || [];
        return { x: Number(tr[4]) || 0, y: Number(tr[5]) || 0 };
      });
      return selectOcrRegions(imageRegionsFromOps(ops.fnArray, ops.argsArray, pdfjsLib.OPS),
        { x0: vb[0], y0: vb[1], x1: vb[2], y1: vb[3] }, pts);
    });
    // A page with almost no text is a scan only if a picture covers most of it; otherwise it is a
    // blank, a cover or a figure page of a normal PDF, and reading it would only cost time.
    var pIsScan = !scanned ? Promise.resolve(false) : withTimeout(page.getOperatorList(), 60000, "Listing the page images").then(function (ops) {
      var vb = page.view || [0, 0, 612, 792], area = Math.max(1, (vb[2] - vb[0]) * (vb[3] - vb[1]));
      return imageRegionsFromOps(ops.fnArray, ops.argsArray, pdfjsLib.OPS).some(function (r) {
        var w = Math.min(r.x1, vb[2]) - Math.max(r.x0, vb[0]), h = Math.min(r.y1, vb[3]) - Math.max(r.y0, vb[1]);
        return w > 0 && h > 0 && (w * h) / area >= 0.5;
      });
    });
    return Promise.all([pRegions, pIsScan]).then(function (both) {
      var regions = both[0];
      if (scanned && !both[1]) return { page: built, mode: null };
      if (!scanned && !regions.length) return { page: built, mode: null };
      return EntPdf.loadOcr().then(function (worker) {
        return renderPageToCanvas(page).then(function (r) {
          function done(v) { r.canvas.width = 0; r.canvas.height = 0; return v; }
          if (scanned) {
            return recognizeCanvas(worker, r.canvas, 3).then(function (data) {
              var ocrBuilt = buildPageFromTextItems(built.pageNum, ocrDataToItems(data, r.scale, r.canvas.height));
              if (countChars(ocrBuilt.text) <= countChars(built.text)) return done({ page: built, mode: null });
              return done({ page: ocrBuilt, mode: "page" });
            }, function (e) { done(null); throw e; });
          }
          var merged = { pageNum: built.pageNum, text: built.text, layoutText: built.layoutText, tables: built.tables.slice() };
          var gained = false;
          return regions.reduce(function (q, reg) {
            return q.then(function () {
              var rect = r.viewport.convertToViewportRectangle([reg.x0, reg.y0, reg.x1, reg.y1]);
              var px0 = Math.max(0, Math.floor(Math.min(rect[0], rect[2]))), py0 = Math.max(0, Math.floor(Math.min(rect[1], rect[3])));
              var px1 = Math.min(r.canvas.width, Math.ceil(Math.max(rect[0], rect[2]))), py1 = Math.min(r.canvas.height, Math.ceil(Math.max(rect[1], rect[3])));
              if (px1 - px0 < 40 || py1 - py0 < 20) return;
              var crop = document.createElement("canvas");
              crop.width = px1 - px0; crop.height = py1 - py0;
              crop.getContext("2d").drawImage(r.canvas, px0, py0, crop.width, crop.height, 0, 0, crop.width, crop.height);
              return recognizeCanvas(worker, crop, 6).then(function (data) {
                var items = ocrDataToItems(data, r.scale, crop.height);
                crop.width = 0; crop.height = 0;
                if (items.length < 6) return; // a structure drawing or a photo, not a table
                var sub = buildPageFromTextItems(built.pageNum, items);
                if (countChars(sub.text) < 25) return;
                merged.text += "\n\n" + sub.text;
                merged.layoutText += "\n\n" + sub.layoutText;
                merged.tables = merged.tables.concat(sub.tables);
                gained = true;
              });
            });
          }, Promise.resolve()).then(function () {
            return done({ page: gained ? merged : built, mode: gained ? "images" : null });
          }, function (e) { done(null); throw e; });
        });
      });
    });
  }

  /* ---------- Reading a PDF ---------- */
  function pdfError(message, code) {
    var e = new Error(message);
    e.pdfCode = code || "unreadable";
    return e;
  }
  function explainPdfJsError(err) {
    var name = (err && err.name) || "", msg = (err && err.message) || "";
    if (err && err.pdfCode) return err;
    if (name === "PasswordException" || /password/i.test(msg)) return pdfError("The PDF is password-protected; remove the password and try again.", "password");
    if (name === "InvalidPDFException" || /invalid pdf|bad xref|missing pdf/i.test(msg)) return pdfError("The file is damaged or is not a real PDF.", "invalid");
    if (name === "MissingPDFException") return pdfError("The file could not be opened.", "missing");
    return pdfError(msg || "The PDF could not be read.", "unreadable");
  }
  function isCancelled(signal) { return !!(signal && signal.aborted); }
  function cancelError() { var e = new Error("Cancelled."); e.cancelled = true; return e; }

  var MAX_PDF_BYTES = 250 * 1024 * 1024;
  function checkPdfBytes(file, bytes) {
    if (!bytes || !bytes.length) throw pdfError("The file is empty.", "empty");
    if (bytes.length > MAX_PDF_BYTES) throw pdfError("The file is larger than 250 MB.", "too_large");
    var head = "", n = Math.min(bytes.length, 1024);
    for (var i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
    if (head.indexOf("%PDF-") < 0) throw pdfError("The file is not a PDF (no %PDF header).", "not_pdf");
  }

  /* opts: { ocr: true|false (scanned pages), ocrImages: false|true (picture tables on text pages,
     slow), maxOcrPages: 40, signal: {aborted} }.
     Resolves to { name, metadataDoi, pages, warnings, ocrPages, skippedPages }; rejects with a readable message. */
  EntPdf.readPdfFile = function (file, onProgress, opts) {
    opts = opts || {};
    var useOcr = opts.ocr !== false, maxOcr = opts.maxOcrPages == null ? 40 : opts.maxOcrPages;
    var name = (file && file.name) || "article.pdf";
    return EntPdf.loadPdfJs().then(function (pdfjsLib) {
      return file.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        checkPdfBytes(file, bytes);
        // isEvalSupported:false closes the font-eval hole in pdf.js 3.x for untrusted PDFs.
        return pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, stopAtErrors: false }).promise;
      }).then(function (pdfDoc) {
        return pdfDoc.getMetadata().catch(function () { return null; }).then(function (meta) {
          var metaDoi = null;
          var info = (meta && meta.info) || {};
          Object.keys(info).forEach(function (k) {
            if (metaDoi || typeof info[k] !== "string") return;
            var m = ANY_DOI_RE.exec(info[k]);
            if (m) {
              var cand = EntScore.cleanDoi(m[0]);
              if (EntScore.isDoi(cand)) metaDoi = cand;
            }
          });
          var pages = [], total = pdfDoc.numPages || 0;
          var warnings = [], ocrPages = [], skippedPages = [], ocrUsed = 0, ocrBroken = false, ocrCapHit = false;
          var chain = Promise.resolve();
          for (var p = 1; p <= total; p++) {
            (function (pageNum) {
              chain = chain.then(function () {
                if (isCancelled(opts.signal)) throw cancelError();
                if (onProgress) onProgress(pageNum, total, "read");
                return pdfDoc.getPage(pageNum).then(function (page) {
                  return page.getTextContent().then(function (tc) {
                    var built = buildPageFromTextItems(pageNum, tc.items);
                    var scanned = countChars(built.text) < OCR_MIN_PAGE_CHARS;
                    if (!useOcr || ocrBroken) return built;
                    if (ocrUsed >= maxOcr) { if (scanned) ocrCapHit = true; return built; }
                    if (onProgress && scanned) onProgress(pageNum, total, "ocr");
                    return ocrPage(pdfjsLib, page, built, tc.items, opts.ocrImages === true).then(function (res) {
                      if (res.mode) {
                        ocrUsed++;
                        res.page.ocr = res.mode;
                        ocrPages.push(pageNum);
                      }
                      return res.page;
                    }, function (err) {
                      if (/OCR (library|engine)|Could not load|did not initialize|Starting the OCR/i.test((err && err.message) || "")) {
                        ocrBroken = true;
                        warnings.push("OCR is unavailable (" + err.message + "); scanned pages and picture tables were not read.");
                      } else {
                        warnings.push("OCR failed on page " + pageNum + ": " + ((err && err.message) || "unknown error") + ".");
                      }
                      return built;
                    });
                  }).then(function (built) {
                    pages.push(built);
                    if (page.cleanup) page.cleanup();
                  });
                }).catch(function (err) {
                  if (err && err.cancelled) throw err;
                  // One unreadable page must not cost the rest of the paper.
                  skippedPages.push(pageNum);
                  pages.push({ pageNum: pageNum, text: "", layoutText: "", tables: [] });
                });
              });
            })(p);
          }
          function finish() { try { if (pdfDoc.destroy) pdfDoc.destroy(); } catch (e) {} }
          return chain.then(function () {
            finish();
            if (skippedPages.length) warnings.push("Could not read page(s) " + skippedPages.join(", ") + ".");
            if (ocrCapHit) warnings.push("Only the first " + maxOcr + " scanned pages were read by OCR; split the PDF to read the rest.");
            var fp = (pdfDoc.fingerprints && pdfDoc.fingerprints[0]) || null;
            return { name: name, metadataDoi: metaDoi, pages: pages, warnings: warnings, ocrPages: ocrPages, skippedPages: skippedPages, fingerprint: fp };
          }, function (err) { finish(); throw err; });
        });
      });
    }).catch(function (err) {
      if (err && err.cancelled) throw err;
      throw explainPdfJsError(err);
    });
  };

  /* ---------- Paper / Supporting Information pairing (mirrors src/trendb/grouping.py) ---------- */
  var SI_SUFFIX_RE = /^(.+?)[\s_.\-]+(?:si|esi|supp|suppl|supporting|supplementary|supplemental)(?:[\s_.\-]*(?:info|information|material|materials|data))?(?:[\s_.\-]*\d{1,3})?$/i;
  var SI_TITLE_RE = /^\W{0,3}(?:electronic\s+)?(?:support(?:ing|ive)|supplementa(?:ry|l))\s+(?:information|material|materials|data)\b/i;
  var SI_PAGE_LABEL_RE = /^\s*(?:page\s+)?S[-\s]?\d{1,3}\s*$/im;
  var ARTICLE_MARK_RE = /^\s*(?:abstract|introduction)\b/im;

  function fileStem(name) { return String(name || "").replace(/\.[A-Za-z0-9]{1,5}$/, ""); }
  function siBaseStem(name) {
    var m = SI_SUFFIX_RE.exec(fileStem(name).trim());
    return m ? m[1].trim().toLowerCase() : null;
  }
  function looksLikeSi(doc) {
    var texts = (doc.pages || []).slice(0, 2).map(function (p) { return p.text || ""; });
    if (!texts.length) return false;
    if (texts.some(function (t) { return SI_PAGE_LABEL_RE.test(t); })) return true;
    var head = texts[0].split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 12);
    return head.some(function (l) { return SI_TITLE_RE.test(l); }) && !ARTICLE_MARK_RE.test(texts[0]);
  }
  function squash(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function titleLines(doc) {
    var first = (doc.pages && doc.pages[0] && doc.pages[0].text) || "";
    return first.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 15)
      .filter(function (l) { return l.length >= 30; }).map(squash).filter(function (l) { return l.length >= 25; });
  }
  function doisIn(doc) {
    var out = {}, re = new RegExp(ANY_DOI_RE.source, "g");
    (doc.pages || []).slice(0, 2).forEach(function (p) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(p.text || "")) !== null) {
        var d = EntScore.cleanDoi(m[0]);
        if (EntScore.isDoi(d)) out[d.toLowerCase()] = 1;
      }
    });
    return out;
  }

  /* Marks each doc with isSi / paper (index of its paper, or -1) / matchedBy. */
  function groupDocs(docs) {
    var stems = {};
    docs.forEach(function (d) { stems[fileStem(d.name).toLowerCase()] = 1; });
    docs.forEach(function (d) {
      var base = siBaseStem(d.name);
      d.isSi = base != null || looksLikeSi(d);
      d.paper = -1; d.matchedBy = "";
    });
    var mains = [];
    docs.forEach(function (d, i) { if (!d.isSi) mains.push(i); });
    var mainDoi = {}, mainTitles = {}, owners = {};
    mains.forEach(function (i) {
      var doi = detectDoi(docs[i]);
      mainDoi[i] = doi ? doi.toLowerCase() : null;
      mainTitles[i] = titleLines(docs[i]);
      var seen = {};
      mainTitles[i].forEach(function (l) { if (!seen[l]) { seen[l] = 1; owners[l] = (owners[l] || 0) + 1; } });
    });
    docs.forEach(function (d) {
      if (!d.isSi) return;
      var base = siBaseStem(d.name);
      var byName = mains.filter(function (i) { return base != null && fileStem(docs[i].name).toLowerCase() === base; });
      if (byName.length === 1) { d.paper = byName[0]; d.matchedBy = "file name"; return; }
      var dois = doisIn(d);
      var byDoi = mains.filter(function (i) { return mainDoi[i] && dois[mainDoi[i]]; });
      if (byDoi.length === 1) { d.paper = byDoi[0]; d.matchedBy = "DOI printed in the SI"; return; }
      var cover = squash((d.pages && d.pages[0] && d.pages[0].text) || "");
      var byTitle = mains.filter(function (i) {
        return mainTitles[i].some(function (l) { return owners[l] === 1 && cover.indexOf(l) >= 0; });
      });
      if (byTitle.length === 1) { d.paper = byTitle[0]; d.matchedBy = "paper title on the SI cover page"; return; }
      if (mains.length === 1) { d.paper = mains[0]; d.matchedBy = "only paper in the upload"; }
    });
    return docs;
  }

  /* ---------- Regexes & extraction helpers (mirrors src/trendb/pdf_extract.py) ---------- */
  var URL_RE = /https?:\/\/\S+/gi;
  var ANY_DOI_RE = /10\.\d{4,9}\/[^\s"<>\]\[),;]+/;
  var ACS_PDF_URL_RE = /pubs\.acs\.org\/[^/\s]+\/article-pdf\/(?:[^/\s]+\/)+([a-z]{2}\d{4,}[a-z]\d{3}|[a-z]+\.[a-z0-9]+)\.pdf/i;
  var ACS_STEM_RE = /^([a-z]{2}\d{5}a\d{3}|(?:jacs|joc|orglett|jo|ol|cm|jp)\.[a-z0-9]+)$/i;
  var CAS_INLINE_RE = /\b(\d{2,7}-\d{2}-\d)\b/g;

  var UNIT_PAT = "(?:kcal\\.?\\s*(?:/|per)\\s*mole?|kcal[\\s\\u00b7.]*mole?(?:\\s*[-\\u2212\\u2013@]\\s*1|\\s+1)?|kJ\\.?\\s*(?:/|per)\\s*mole?|kJ[\\s\\u00b7.]*mole?(?:\\s*[-\\u2212\\u2013@]\\s*1|\\s+1)?|eV|cm\\s*[-\\u2212\\u2013]\\s*1)";
  var ET_VAL_TAIL = "(?:[^.;\\n]|\\.(?=\\d)){0,85}?(?:=|is|of|at|:|~|\\u2248|\\u2245|as|about|around|[BE](?=\\s\\d))?\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:\\u00b1\\s*(\\d+(?:[.,]\\d+)?)\\s*)?(" + UNIT_PAT + ")\\b";
  var ET_AFTER_WORD_RE = new RegExp(
    "(?:triplet(?:\\s+state)?(?:\\s+excitation)?\\s+energ(?:y|ies)(?!\\s+transfer)|0\\s*[-\\u2013]\\s*0\\s+transition(?:\\s+to\\s+the\\s+lowest\\s+triplet\\s+state)?|(?:vertical|adiabatic)\\s+excitation\\s+energy|0\\s*[-\\u2013]\\s*0\\s+band(?:s)?(?:\\s*\\([^)]+\\))?)" + ET_VAL_TAIL,
    "gi"
  );
  var ET_AFTER_SYM_RE = new RegExp("\\b(?:E_?\\s*T|T_?\\s*1)\\b" + ET_VAL_TAIL, "g");
  var ET_BEFORE_WORD_RE = new RegExp(
    "(\\d+(?:[.,]\\d+)?)\\s*(?:\\u00b1\\s*(\\d+(?:[.,]\\d+)?)\\s*)?(" + UNIT_PAT + ")(?:[^.;\\n]|\\.(?=\\d)){0,45}?\\btriplet(?:\\s+state)?(?:\\s+energy|energies)\\b",
    "gi"
  );
  var ET_BEFORE_SYM_RE = new RegExp(
    "(\\d+(?:[.,]\\d+)?)\\s*(?:\\u00b1\\s*(\\d+(?:[.,]\\d+)?)\\s*)?(" + UNIT_PAT + ")(?:[^.;\\n]|\\.(?=\\d)){0,45}?\\b(?:E_?\\s*T|T_?\\s*1)\\b",
    "g"
  );
  var PHOS_NM_RE = /(?:triplet\s+emission|phosphorescence(?:\s+0\s*[-–]\s*0)?(?:\s+band|\s+maximum|\s+peak|\s+onset)?)[^.;\n]{0,45}?\b(\d{3}(?:\.\d+)?)\s*nm\b/gi;
  var TABLE_VAL_RE = new RegExp(
    "^\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:\\u00b1\\s*(\\d+(?:[.,]\\d+)?))?\\s*(?:(" + UNIT_PAT + ")|(nm))?(?:\\s*[\\^*\\u2020\\u2021\\u00a7'\\u00b7]*[a-z](?:,[a-z])?|\\s*[*\\u2020\\u2021\\u00a7]+)?\\s*$",
    "i"
  );
  var PAIR_UNIT_RE = new RegExp("(\\d+(?:[.,]\\d+)?)\\s*(?:\\u00b1\\s*(\\d+(?:[.,]\\d+)?)\\s*)?(" + UNIT_PAT + ")\\b", "gi");
  var AND_PAIR_UNIT_RE = new RegExp("(\\d+(?:[.,]\\d+)?)\\s+and\\s+(\\d+(?:[.,]\\d+)?)\\s*(" + UNIT_PAT + ")\\b", "gi");

  var CALC_HINT_RE = /\b(?:DFT|TD-?DFT|B3LYP|ωB97X-?D4?|wB97X-?D4?|M06-?2X|CAM-B3LYP|PBE0|MN15|TPSSh|r2SCAN-3c|CASSCF|CCSD\(T\)|MRCI|comput(?:ed|ational)|calculat(?:ed|ion))\b/i;
  var CALC_HINT_RE_G = new RegExp(CALC_HINT_RE.source, "gi");
  var EXP_HINT_RE = /\b(?:phosphorescence|photoacoustic|PAC\b|EELS|electron-energy-loss|quenching|bracketing|sensitization|emission|77\s*°?\s*K|glass|measured|experimental|luminescence|TRIR|singlet[-–]triplet\s+absorption|S0\s*(?:→|->)\s*T1|oxygen\s+pressure|Saltiel\s+plot|kinetic\s+spectrophotometry)\b/i;
  var EXP_HINT_RE_G = new RegExp(EXP_HINT_RE.source, "gi");
  var FUNC_RE = /\b(ωB97X-?D4?|wB97X-?D4?|CAM-B3LYP|B3LYP(?:-D3(?:BJ)?)?|M06-?2X|PBE0|MN15|TPSSh|r2SCAN-3c|CCSD\(T\)|CASSCF)\b/i;
  var BASIS_RE = /\b(aug-cc-pV[DTQ]Z|cc-pV[DTQ]Z|def2-[STQ]ZVPP?D?|6-311\+?G\([^)]+\)|6-31\+?\+?G\([^)]+\)|6-31G\*+|LANL2DZ)\b/;
  var SOLV_MODEL_RE = /\b(IEF-?PCM|CPCM|PCM|SMD|COSMO|gas\s+phase)\b/i;
  var TEMP_RE = /\b(\d{1,3}(?:\.\d+)?\s*°?\s*[KC]|room\s+temperature|r\.?t\.?)\b/i;
  var SOLVENT_RE = /\b(methylcyclohexane(?:\s+glass)?|2-?MeTHF|MCH|MCIP|EPA|solid\s+argon|MeCN|acetonitrile|CD3CN|CH2Cl2|DCM|dichloromethane|CHCl3|chloroform|CDCl3|THF|toluene|benzene|cyclohexane|n-?heptane|heptane|isopentane|methanol|MeOH|ethanol|EtOH|Et2O|diethyl\s+ether|DMSO(?:-d6)?|DMF|CCl4|hexane|water)\b/i;
  var UV_RE = /(?:UV[-–\s]?vis|absorption(?:\s+max(?:imum)?)?|λ_?\s*max)\s*(?:at|=|:|of)?\s*[^.;\n]{0,45}?\b\d{3}(?:\.\d+)?\s*nm\b/i;
  var DIRECT_EXC_RE = /(?:irradiat(?:ed|ion)|excit(?:ed|ation)|LED|Kessil|laser)\s*(?:at|with|using|:)?\s*(?:a\s+)?(\d{3,4})\s*nm|(\d{3,4})\s*nm\s*(LED|Kessil|laser)\b/gi;
  var SECTION_RE = /^\s*(Abstract|Introduction|Results(?:\s+and\s+Discussion)?|Discussion|Conclusion[s]?|Experimental(?:\s+Section)?|Computational\s+Details|Methods|Supporting\s+Information)\b/i;
  var CHEM_NAME_RE = /\b(?:[EZRS]-|\([EZRS]\)-|(?:\d+,)*\d+-)?(?:[A-Za-z0-9,'′\[\]()\-]*(?:thioxanthone|xanthone|benzophenone|acetophenone|fluorenone|benzanthrone|coumarin|chalcone|stilbene|styrene|anthracene|naphthalene|phenanthrene|pyrene|perylene|chrysene|triphenylene|acridine|carbazole|binaphthyl|benzanthracene|dibenzanthracene|benzpyrene|diphenylpropene|acetonaphthone|naphthaldehyde|naphthacenequinone|benzil|quinone|duroquinone|flavin|enone|boronate|biphenyl|biacetyl|azide|oxime|acrylate)|(?:Ir|Ru)\*?(?:\[[^\]]+\]|\([^)]+\))+(?:\s*\([^)]+\)|\[[^\]]+\]|\d+|[+]|PF6|BF4|Cl)*)\b/g;

  var ET_HEADER_CUE_RE = /triplet|(?<![a-z])e_?\s*\(?t\d*\)?(?![a-z])|(?<![a-z])t_?1(?![a-z0-9])/i;
  var OTHER_ENERGY_HEADER_RE = /singlet|fluoresc|(?<![a-z])e_?\s*\(?s\d*\)?(?![a-z])|(?<![a-z])s_?1(?![a-z0-9])|δg|δh|Δg|Δh|(?<![a-z])bde(?![a-z])|redox|e\s*1\/2|e_?ox|e_?red|barrier|activation|strain/i;
  var NON_ENERGY_COL_RE = /\b(?:concn|conc|wavelength|sec[-−]1|m[-−]1|kq|k1|k_q|k_1|β|beta|filter|lifetime|yield)\b/i;
  var PROSE_WORD_RE = /\b(?:the|of|to|and|is|are|was|were|that|which|with|for|in|by|this|these)\b/gi;
  var HEADER_CONT_RE = /\b(?:kcal|mole?|kj|ev|nm|temp|solvent|condition|matrix|ref|method|basis|concn|sec-?1|isomer|wavelength)\b/i;
  var PURE_NUM_CELL_RE = /^\d{2,3}(?:\.\d+)?(?:\s*[*†‡§]|[a-z])?$/i;
  var RANGE_OR_NEG_PREFIX_RE = /(?:(?:>|>=|≥|<|<=|≤)\s*|\b(?:between|from|ranging\s+from|rather\s+than|instead\s+of|more\s+than|less\s+than|higher\s+than|lower\s+than|greater\s+than|smaller\s+than|below|above|under|over|upwards\s+of|at\s+least|at\s+most|exceeding|differ(?:s|ence)?\s+by|deficient[^.;\n]{0,25}\bby)\s*|\b(?:between|from|ranging\s+from)\s+\d+(?:[.,]\d+)?\s+(?:and|to)\s*|\d+(?:[.,]\d+)?\s*(?:[-–—]|to)\s*)$/i;
  var TRIPLET_CONTEXT_RE = /\b(?:triplet|phosphorescence|singlet[-–]triplet|s0\s*(?:→|->)\s*t1)\b|\b(?:E_?\s*T|T_?\s*1)\b/i;
  var CLAUSE_SPLIT_RE = /[;,]|\b(?:whereas|while|but|and)\b/gi;
  var SINGLET_WORD_RE = /\bsinglet(?:\s+oxygen)?\b|\bfluorescence\b|\breorganization\s+energy\b|\bactivation(?:\s+energy|\s+barrier)?\b|\bbarrier\b|\bbond\s+dissociation\b|\bBDE\b|\bredox\b|\boxidation\b|\breduction\b|\bHOMO\b|\bLUMO\b|\bband\s*gap\b|\b1O2\b|\bexcitation\s+of\s+oxygen\b|\bS0\s*(?:→|->)\s*S1\b/i;
  var SINGLET_SYM_RE = /Δ[GH]|δ[GH]|(?<![A-Za-z])(?:S_?\s*1|E_?\s*S|λ)(?![A-Za-z0-9])/;
  var TRIPLET_CUE_RE = /\btriplet\b|\bphosphorescence\b|\b(?:T_?\s*1|E_?\s*T)\b/;

  var KCAL_PER_EV = 23.06054783;
  var KJ_PER_KCAL = 4.184;
  var KCAL_PER_CM = 2.85914e-3;

  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }
  function stripUrls(text) {
    if (text == null) return null;
    var s = String(text).replace(URL_RE, "").replace(/\s{2,}/g, " ").trim();
    return s || null;
  }
  function truncateQuote(text, maxWords) {
    if (!text) return null;
    var s = stripUrls(String(text).replace(/\s+/g, " ").trim());
    if (!s) return null;
    var words = s.split(" ");
    if (words.length > (maxWords || 22)) s = words.slice(0, maxWords || 22).join(" ");
    return s.slice(0, 300);
  }
  function normalizeUnit(uRaw) {
    var u = String(uRaw || "").toLowerCase().replace(/\s+/g, "");
    if (u.indexOf("cm") === 0) return "cm";
    if (u.indexOf("kj") >= 0) return "kj";
    if (u.indexOf("ev") >= 0) return "ev";
    if (u.indexOf("nm") >= 0) return "nm";
    return "kcal";
  }
  function parseNum(raw, unit) {
    var txt = String(raw || "").trim();
    if (unit === "cm" && /^\d{1,3},\d{3}$/.test(txt)) txt = txt.replace(",", "");
    return EntScore.num(txt);
  }
  function convertEnergy(val, unc, unit) {
    if (!isFinite(val)) return { et_kcal: null, unc_kcal: null, rep: "" };
    var hasUnc = unc != null && isFinite(unc);
    var repUnc = hasUnc ? (" ± " + Number(unc.toPrecision(6))) : "";
    var repVal = String(Number(val.toPrecision(6)));
    if (unit === "kcal") return { et_kcal: round1(val), unc_kcal: hasUnc ? round2(Math.abs(unc)) : null, rep: repVal + repUnc + " kcal/mol" };
    if (unit === "kj") return { et_kcal: round1(val / KJ_PER_KCAL), unc_kcal: hasUnc ? round2(Math.abs(unc) / KJ_PER_KCAL) : null, rep: repVal + repUnc + " kJ/mol" };
    if (unit === "ev") return { et_kcal: round1(val * KCAL_PER_EV), unc_kcal: hasUnc ? round2(Math.abs(unc) * KCAL_PER_EV) : null, rep: repVal + repUnc + " eV" };
    if (unit === "nm") {
      if (val <= 0) return { et_kcal: null, unc_kcal: null, rep: "" };
      return { et_kcal: round1(28591.5 / val), unc_kcal: null, rep: repVal + " nm (phosphorescence)" };
    }
    if (unit === "cm") return { et_kcal: round1(val * KCAL_PER_CM), unc_kcal: hasUnc ? round2(Math.abs(unc) * KCAL_PER_CM) : null, rep: repVal + repUnc + " cm-1" };
    return { et_kcal: null, unc_kcal: null, rep: "" };
  }

  function detectDoi(doc) {
    if (doc.metadataDoi && EntScore.isDoi(doc.metadataDoi)) return doc.metadataDoi;
    var i, m, cand;
    for (i = 0; i < Math.min(2, doc.pages.length); i++) {
      var head = doc.pages[i].text.split(/\b(?:References|Bibliography|Notes and References)\b/)[0];
      m = ANY_DOI_RE.exec(head);
      if (m) {
        cand = EntScore.cleanDoi(m[0]);
        if (EntScore.isDoi(cand)) return cand;
      }
    }
    var stem = String(doc.name || "").replace(/\.pdf$/i, "");
    m = ANY_DOI_RE.exec(stem.replace(/_/g, "/"));
    if (m) {
      cand = EntScore.cleanDoi(m[0]);
      if (EntScore.isDoi(cand)) return cand;
    }
    for (i = 0; i < Math.min(2, doc.pages.length); i++) {
      m = ACS_PDF_URL_RE.exec(doc.pages[i].text);
      if (m) {
        cand = "10.1021/" + m[1];
        if (EntScore.isDoi(cand)) return cand;
      }
    }
    m = ACS_STEM_RE.exec(stem.trim());
    if (m) {
      cand = "10.1021/" + m[1];
      if (EntScore.isDoi(cand)) return cand;
    }
    return null;
  }
  EntPdf.detectDoi = detectDoi;

  function classifyOrigin(text, defOrigin) {
    var calcHits = (String(text || "").match(CALC_HINT_RE_G) || []).length;
    var expHits = (String(text || "").match(EXP_HINT_RE_G) || []).length;
    if (calcHits > expHits) return "calc";
    if (expHits > calcHits) return "exp";
    return defOrigin || "exp";
  }

  function extractMethodAndConditions(text, origin) {
    var funcM = FUNC_RE.exec(text), basisM = BASIS_RE.exec(text), solvModM = SOLV_MODEL_RE.exec(text);
    var solvM = SOLVENT_RE.exec(text), tempM = TEMP_RE.exec(text);
    if (origin === "calc") {
      var func = funcM ? funcM[1] : null, basis = basisM ? basisM[1] : null;
      var solvParts = [solvModM ? solvModM[1] : null, solvM ? solvM[1] : null].filter(Boolean);
      var solv = solvParts.length ? solvParts.join(", ") : null;
      var etType = /\badiabatic\b/i.test(text) ? "Computed, adiabatic"
        : /\bvertical\b/i.test(text) ? "Computed, vertical"
        : "Computed; vertical or adiabatic not specified";
      var method = [/TD-?DFT/i.test(text) ? "TD-DFT" : "DFT", func, basis].filter(Boolean).join(", ");
      return { etType: etType, method: method, conditions: solv || "Solvent model not stated", fOrSolv: func, bOrTemp: basis, solvModel: solv };
    }
    var low = String(text || "").toLowerCase(), tech = "";
    if (low.indexOf("phosphorescence") >= 0) tech = "Phosphorescence";
    else if (low.indexOf("photoacoustic") >= 0 || /\bpac\b/.test(text)) tech = "Photoacoustic calorimetry";
    else if (low.indexOf("electron-energy-loss") >= 0 || low.indexOf("eels") >= 0) tech = "Electron-energy-loss spectroscopy";
    else if (low.indexOf("singlet-triplet absorption") >= 0 || low.indexOf("singlet–triplet absorption") >= 0 || low.indexOf("s0→t1") >= 0 || low.indexOf("s0->t1") >= 0 ||
      (low.indexOf("absorption") >= 0 && (low.indexOf("o2") >= 0 || low.indexOf("oxygen") >= 0 || low.indexOf("heavy-atom") >= 0 || low.indexOf("mei") >= 0))) {
      tech = (low.indexOf("o2") >= 0 || low.indexOf("oxygen") >= 0 || low.indexOf("heavy-atom") >= 0 || low.indexOf("mei") >= 0)
        ? "S0→T1 absorption (O2 or heavy-atom perturbed)" : "S0→T1 absorption";
    } else if (low.indexOf("quenching") >= 0 || low.indexOf("bracketing") >= 0 || low.indexOf("kinetics") >= 0 || low.indexOf("saltiel") >= 0 || low.indexOf("different plots") >= 0) {
      tech = "Energy-transfer bracketing or quenching kinetics";
    } else if (/\b(?:77|93)\s*°?\s*k\b/.test(low) || low.indexOf("emission") >= 0) {
      tech = "Phosphorescence";
    }
    var etTypeExp = /\b0\s*[-–]\s*0\b/.test(text) ? "Spectroscopic, 0-0 band"
      : /\b(?:onset|maximum|vertical)\b/i.test(text) ? "Spectroscopic, vertical (band onset or maximum)"
      : (/\brelaxed\b/i.test(text) || tech === "Photoacoustic calorimetry") ? "Relaxed triplet"
      : tech === "Energy-transfer bracketing or quenching kinetics" ? "From energy-transfer kinetics"
      : "Other or not stated";
    var solvent = solvM ? solvM[1] : null;
    var temp = tempM ? tempM[1].trim().replace(/\s*°\s*K$/i, " K") : null;
    var cond = [solvent, temp].filter(Boolean).join(", ") || "Not stated";
    return { etType: etTypeExp, method: tech || "Not stated", conditions: cond, fOrSolv: solvent, bOrTemp: temp, solvModel: null };
  }

  function extractUv(text) {
    var m = UV_RE.exec(text);
    if (!m) return { uv_lmax: null, uv_eps: null, uv_cond: null };
    var raw = stripUrls(m[0].trim()) || "";
    var lm = /λmax\s*(?:at|=|:)?\s*(\d{3,4})\s*nm|\b(\d{3,4})\s*nm\b/i.exec(raw);
    var lmax = lm ? parseInt(lm[1] || lm[2], 10) : null;
    if (lmax != null && (lmax < 100 || lmax > 1500)) lmax = null;
    var em = /\bε\s*=?\s*([0-9][0-9,]*)/.exec(raw);
    var eps = em ? parseInt(em[1].replace(/,/g, ""), 10) : null;
    var cm = /\(([^()]+)\)\s*$/.exec(raw);
    var cond = cm && !/^ε\b/i.test(cm[1].trim()) ? cm[1].trim().slice(0, 65) : null;
    return { uv_lmax: lmax, uv_eps: eps, uv_cond: cond };
  }
  function extractDirectExc(text) {
    var out = {}, m;
    DIRECT_EXC_RE.lastIndex = 0;
    while ((m = DIRECT_EXC_RE.exec(text)) !== null) {
      var nm, src;
      if (m[1]) {
        nm = parseInt(m[1], 10);
        var low = m[0].toLowerCase();
        src = low.indexOf("led") >= 0 ? "LED" : low.indexOf("kessil") >= 0 ? "Kessil" : low.indexOf("laser") >= 0 ? "laser" : "irradiation";
      } else {
        nm = parseInt(m[2], 10);
        src = m[3];
      }
      if (nm >= 100 && nm <= 1500) out[src] = nm;
    }
    return Object.keys(out).length ? out : null;
  }

  function detectHeaderUnit(header) {
    var low = String(header || "").toLowerCase();
    if (low.indexOf("kcal") >= 0) return "kcal";
    if (/\bkj\b/.test(low)) return "kj";
    if (/(?:^|[^a-z])ev(?![a-z])/.test(low)) return "ev";
    if (/cm\s*[-−–]\s*1/.test(low)) return "cm";
    if (/(?:^|[^a-z])nm(?![a-z])/.test(low)) return "nm";
    return null;
  }
  function isEtHeader(header, tableCtx) {
    if (NON_ENERGY_COL_RE.test(header)) return false;
    var hasCue = ET_HEADER_CUE_RE.test(header);
    if (OTHER_ENERGY_HEADER_RE.test(header) && !/triplet/i.test(header)) return false;
    if (hasCue) return true;
    var u = detectHeaderUnit(header);
    return (u === "kcal" || u === "kj" || u === "ev" || u === "cm") && TRIPLET_CONTEXT_RE.test(tableCtx || "");
  }
  function looksLikeProse(cell) {
    var words = String(cell || "").trim().split(/\s+/);
    return words.length >= 5 && (String(cell || "").match(PROSE_WORD_RE) || []).length >= 2;
  }
  function mergeTableHeader(tb) {
    var headerRows = [tb[0]], dataStart = 1;
    for (var i = 1; i < Math.min(3, tb.length); i++) {
      var row = tb[i];
      var rowTxt = row.map(function (c) { return c.trim(); }).filter(Boolean).join(" ");
      if (!rowTxt) { dataStart++; continue; }
      var hasNum = row.some(function (c) { return PURE_NUM_CELL_RE.test(c.trim()); });
      if (!hasNum && HEADER_CONT_RE.test(rowTxt)) { headerRows.push(row); dataStart++; }
      else break;
    }
    var width = Math.max.apply(null, headerRows.map(function (r) { return r.length; }));
    var merged = [];
    for (var ci = 0; ci < width; ci++) {
      merged.push(headerRows.map(function (r) { return (r[ci] || "").trim(); }).filter(Boolean).join(" "));
    }
    return { header: merged, dataStart: dataStart };
  }
  function cleanCondCell(val) {
    return (stripUrls(String(val || "").trim()) || "").replace(/\s*°\s*K\b/gi, " K").replace(/\^([a-z*†‡§])\b/gi, "").trim();
  }
  function cleanMoleculeName(raw, knownMap) {
    var m = /^(.*[a-z]{4,})(\d{1,3})$/.exec(raw);
    if (!m) return raw;
    if (knownMap[normalizeNameKey(raw)]) return raw;
    return knownMap[normalizeNameKey(m[1])] ? m[1] : raw;
  }

  function extractFromTables(doc, knownMap, opts) {
    var results = [];
    doc.pages.forEach(function (page) {
      var capMatches = [], mCap;
      var capRe = /(Table\s+(?:S?\d+|[IVX]+)\b[^\n]*)/gi;
      while ((mCap = capRe.exec(page.text)) !== null) capMatches.push({ match: mCap[1], idx: mCap.index });
      var footRe = /[^\n]*(?:0\s*[-–]\s*0\s+band|phosphorescence|triplet\s+energy\s+assignments)[^\n]{0,220}/gi;
      var footCtx = (page.text.match(footRe) || []).slice(0, 3).map(function (s) { return s.trim(); }).join(" ");

      page.tables.forEach(function (tb, tbIdx) {
        if (tb.length < 2) return;
        var mh = mergeTableHeader(tb), header = mh.header, dataStart = mh.dataStart;
        if (dataStart >= tb.length) return;
        var cap = capMatches.length ? capMatches[Math.min(tbIdx, capMatches.length - 1)] : null;
        var tableLabel = cap ? cap.match.trim().slice(0, 80) : ("p. " + page.pageNum);
        var pageCtx = [cap ? cap.match.trim() : page.text.slice(0, 500), footCtx].filter(Boolean).join(" ");
        var precedingTxt = cap ? page.text.slice(Math.max(0, cap.idx - 500), cap.idx) : "";

        var nameCol = null, casCol = null, smiCol = null, methodCol = null, condCols = [], solvCol = null, tempCol = null, refCol = null, uvCol = null;
        var etCols = [];
        header.forEach(function (h, ci) {
          var hl = h.toLowerCase();
          if (nameCol === null && ["compound", "molecule", "name", "substance", "sensitizer", "catalyst", "substrate", "donor", "acceptor", "entry"].some(function (k) { return hl.indexOf(k) >= 0; })) {
            nameCol = ci;
          } else if (casCol === null && hl.indexOf("cas") >= 0) casCol = ci;
          else if (smiCol === null && hl.indexOf("smiles") >= 0) smiCol = ci;
          else if (methodCol === null && ["method", "functional", "basis", "technique"].some(function (k) { return hl.indexOf(k) >= 0; })) methodCol = ci;
          else if (["solvent", "condition", "matrix", "temp"].some(function (k) { return hl.indexOf(k) >= 0; })) {
            condCols.push(ci);
            if (hl.indexOf("solvent") >= 0 && solvCol === null) solvCol = ci;
            if (hl.indexOf("temp") >= 0 && tempCol === null) tempCol = ci;
          } else if (refCol === null && /\bref(?:erence)?s?\b/.test(hl)) refCol = ci;
          else if (uvCol === null && ["uv", "λmax", "lambda", "abs"].some(function (k) { return hl.indexOf(k) >= 0; })) uvCol = ci;
          else if (isEtHeader(h, (cap ? cap.match : "") + " " + header.join(" "))) {
            var origHint = ["calc", "comp", "dft"].some(function (k) { return hl.indexOf(k) >= 0; }) ? "calc"
              : (["exp", "meas", "obs"].some(function (k) { return hl.indexOf(k) >= 0; }) ? "exp" : null);
            etCols.push({ ci: ci, unitHint: detectHeaderUnit(h), originHint: origHint });
          }
        });
        if (!etCols.length) return;
        if (header.some(function (h) { return looksLikeProse(h) || h.length > 60; })) return;
        var nameGuessed = nameCol === null;
        if (nameCol === null) nameCol = 0;

        // Handbook layout: "49  Anthracene, 9-phenyl-" on its own row, then one row per solvent
        // ("n" non-polar, "p" polar) carrying the numbers.
        var blockName = null, hasSolvCode = header.some(function (h) { return /^solv\.?(?:\s|$)/i.test(h.trim()); });
        for (var rIdx = dataStart; rIdx < tb.length; rIdx++) {
          var row = tb[rIdx];
          if (nameCol >= row.length) continue;
          var filled = row.map(function (c) { return String(c || "").trim(); }).filter(Boolean);
          if (filled.length === 2 && /^\d{1,4}$/.test(filled[0]) && /[A-Za-z]{3,}/.test(filled[1]) && !TABLE_VAL_RE.test(filled[1])) {
            blockName = filled[1];
            continue;
          }
          var rawName = row[nameCol].trim().replace(/\s*[*†‡§]+$/, "").trim();
          var solvCode = null;
          if (blockName && (!rawName || /^[a-z]$/i.test(rawName) || /^\d{1,4}$/.test(rawName))) {
            var mCode = /^([np])(?:\s|$)/i.exec(filled[0] || "");
            if (mCode) solvCode = mCode[1].toLowerCase();
            rawName = blockName;
          }
          if (rawName.length < 2) continue;
          if (!rawName || ["entry", "compound", "substance", "sensitizer", "name", "-", "—"].indexOf(rawName.toLowerCase()) >= 0) continue;
          if (looksLikeProse(rawName)) continue;
          if (nameGuessed && /^[\d.,\s±]+(?:[*†‡§]|[a-z])?$/i.test(rawName)) continue;
          rawName = cleanMoleculeName(rawName, knownMap);
          var warnings = [];
          if (/[-,(]$/.test(rawName)) warnings.push("Name looks truncated (cell wrapped across lines); check the table.");
          var inlineVal = /\((\d{2,3}(?:\.\d+)?)\)\s*$/.exec(rawName);
          if (inlineVal) warnings.push("Name cell carries a value in parentheses (" + inlineVal[1] + "); check which number is the triplet energy.");

          var rowText = row.join(" | ");
          var casInline = (casCol !== null && casCol < row.length) ? row[casCol].trim() : null;
          if (!casInline) {
            CAS_INLINE_RE.lastIndex = 0;
            var cm;
            while ((cm = CAS_INLINE_RE.exec(rowText)) !== null) {
              if (EntScore.casValid(cm[1])) { casInline = cm[1]; break; }
            }
          }
          var rawSmi = (smiCol !== null && smiCol < row.length) ? (row[smiCol].trim() || null) : null;

          etCols.forEach(function (ec) {
            if (ec.ci >= row.length) return;
            var cell = row[ec.ci].trim();
            var vm = TABLE_VAL_RE.exec(cell);
            if (!vm) return;
            var unit = normalizeUnit(vm[3] || vm[4] || ec.unitHint);
            var val = parseNum(vm[1], unit);
            var unc = vm[2] ? parseNum(vm[2], unit) : null;
            if (unc != null && !isFinite(unc)) unc = null;
            var conv = convertEnergy(val, unc, unit);
            if (conv.et_kcal == null || conv.et_kcal < 20.0 || conv.et_kcal > EntScore.ET_MAX) return;

            var condParts = condCols.map(function (cIdx) { return cIdx < row.length ? cleanCondCell(row[cIdx]) : ""; }).filter(Boolean);
            var ctxBlob = [pageCtx, header[ec.ci], (methodCol !== null && methodCol < row.length) ? row[methodCol] : "", condParts.join(" ")].join(" ");
            var origin = ec.originHint || ((CALC_HINT_RE.test(ctxBlob) || EXP_HINT_RE.test(ctxBlob)) ? classifyOrigin(ctxBlob, "exp") : classifyOrigin(precedingTxt, "exp"));
            var mc = extractMethodAndConditions(ctxBlob, origin);
            var method = (methodCol !== null && methodCol < row.length && row[methodCol].trim()) ? (stripUrls(row[methodCol].trim()) || mc.method) : mc.method;
            var conditions = condParts.length ? condParts.join(", ") : mc.conditions;
            var fOrSolv = mc.fOrSolv, bOrTemp = mc.bOrTemp;
            if (hasSolvCode && solvCode && !condParts.length) {
              conditions = solvCode === "n" ? "Non-polar solvent" : "Polar solvent";
              fOrSolv = conditions;
            }
            if (condParts.length && origin !== "calc") {
              if (!fOrSolv && solvCol !== null && solvCol < row.length && row[solvCol].trim()) fOrSolv = cleanCondCell(row[solvCol]) || null;
              if (!bOrTemp && tempCol !== null && tempCol < row.length && row[tempCol].trim()) bOrTemp = cleanCondCell(row[tempCol]) || null;
            }
            var uv = (uvCol !== null && uvCol < row.length && row[uvCol].trim()) ? extractUv(row[uvCol].trim()) : extractUv(rowText);
            var dirExc = extractDirectExc(rowText);
            var refVal = (refCol !== null && refCol < row.length && row[refCol].trim()) ? row[refCol].trim() : null;
            var vNote = "Automatically extracted from PDF table; verify structure and values." + (refVal ? (" Cited ref in table: " + refVal + ".") : "");

            results.push({
              name: rawName.slice(0, 200),
              raw_cas: casInline || null,
              raw_smiles: rawSmi,
              et_kcal: conv.et_kcal,
              et_unc: conv.unc_kcal,
              et_reported: conv.rep,
              origin: origin,
              et_type: mc.etType,
              method: method,
              conditions: conditions,
              doi: opts.doi,
              citation: opts.citation,
              location: tableLabel + ", row " + rIdx + " (p. " + page.pageNum + ")",
              quote: truncateQuote(rawName + ": " + header[ec.ci] + " = " + cell),
              evidence: stripUrls(("Extracted from table row: " + rowText).slice(0, 400)),
              verify_level: "primaria",
              verify_note: vNote,
              uv_lmax: uv.uv_lmax,
              uv_eps: uv.uv_eps,
              uv_cond: uv.uv_cond,
              direct_exc: dirExc,
              cls: opts.defaultCls || null,
              role: opts.defaultRole || "acceptor",
              unit: (unit === "kcal" || unit === "kj" || unit === "ev") ? unit : "kcal",
              raw_et: (unit === "kcal" || unit === "kj" || unit === "ev") ? val : conv.et_kcal,
              raw_unc: (unit === "kcal" || unit === "kj" || unit === "ev") ? unc : conv.unc_kcal,
              tech: origin === "calc" ? null : (method === "Not stated" ? null : method),
              solvent: origin === "calc" ? null : fOrSolv,
              temp: origin === "calc" ? null : bOrTemp,
              func: origin === "calc" ? fOrSolv : null,
              basis: origin === "calc" ? bOrTemp : null,
              solv: origin === "calc" ? mc.solvModel : null,
              warnings: warnings.slice(),
              pdf_file: doc.name,
              page_num: page.pageNum
            });
          });
        }
      });
    });
    return results;
  }

  function clauseAround(sent, start, end) {
    var left = 0, m;
    CLAUSE_SPLIT_RE.lastIndex = 0;
    while ((m = CLAUSE_SPLIT_RE.exec(sent)) !== null) {
      if (m.index >= start) break;
      left = m.index + m[0].length;
    }
    CLAUSE_SPLIT_RE.lastIndex = end;
    var mr = CLAUSE_SPLIT_RE.exec(sent);
    return sent.slice(left, mr ? mr.index : sent.length);
  }
  function isSingletValue(sent, start, end) {
    var cl = clauseAround(sent, start, end);
    return (SINGLET_WORD_RE.test(cl) || SINGLET_SYM_RE.test(cl)) && !TRIPLET_CUE_RE.test(cl);
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /* Subscripts come out of a PDF as loose digits: "Ir*[dF(CF 3 )ppy] 2 (dtbbpy)", "(PF6 )2".
     Close those gaps, but only inside a metal-complex formula. */
  var COMPLEX_START_RE = /(?:fac-|mer-)?\[?(?:Ir|Ru|Os|Re|Pt|Cu)\*?[\[(]/g;
  function tightenComplexFormulas(text) {
    var out = "", last = 0, m;
    COMPLEX_START_RE.lastIndex = 0;
    while ((m = COMPLEX_START_RE.exec(text)) !== null) {
      var end = Math.min(text.length, m.index + 70);
      var win = text.slice(m.index, end), prev;
      do {
        prev = win;
        win = win.replace(/([A-Za-z\])])\s(\d{1,2})\s?(?=[)\]])/g, "$1$2")   // CF 3 ) -> CF3)
          .replace(/([A-Za-z0-9])\s([)\]])/g, "$1$2")                        // PF6 )  -> PF6)
          .replace(/([)\]])\s(\d{1,2})(?=[A-Za-z\s(\[\],.;:]|$)/g, "$1$2")   // ] 2    -> ]2
          .replace(/([A-Za-z])\s(\d{1,2})\s(?=-)/g, "$1$2")                 // CF 3 - -> CF3-
          .replace(/-\s(?=\()/g, "")                                         // dFN- (Me) -> dFN(Me)
          .replace(/([)\]]\d{1,2})\s(?=[(\[](?!\s*(?:E_?\s?T\b|triplet|\d|[^()]{0,25}=)))/g, "$1") // ]2 ( -> ]2(, but not "(ET = ...)"
          .replace(/([)\]])\s?(\d)([1-4]\+)/g, "$1$2 $3")                    // ) 32+ -> )3 2+
          .replace(/([(\[])\s/g, "$1");
      } while (win !== prev);
      out += text.slice(last, m.index) + win;
      last = end;
      COMPLEX_START_RE.lastIndex = end;
    }
    return out + text.slice(last);
  }

  /* A metal complex name with its brackets balanced: "[Ir(dFN(Me)2ppy)2(CN)2]", "Ru(dtbbpy)2(bpy)(PF6)2". */
  function scanComplexes(sentence) {
    var spans = [], m;
    COMPLEX_START_RE.lastIndex = 0;
    while ((m = COMPLEX_START_RE.exec(sentence)) !== null) {
      var i = m.index, depth = 0, end = -1;
      for (; i < sentence.length && i < m.index + 90; i++) {
        var ch = sentence[i];
        // "Ru(bpy)3(PF6)2(ET = 46.8 kcal/mol)": the bracket with the energy is not part of the name
        if (ch === "(" && depth === 0 && /^\(\s*(?:E_?\s?T\b|triplet\b|[^()]{0,25}=)/.test(sentence.slice(i, i + 30))) break;
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") { depth--; if (depth < 0) break; }
        else if (depth === 0 && !/[A-Za-z0-9+*\-]/.test(ch)) break;
        if (depth === 0) end = i + 1;
      }
      if (end > m.index + 5 && !/^\[?[A-Z][a-z]\*?\((?:I{1,3}|IV|V|VI)\)\]?$/.test(sentence.slice(m.index, end))) {
        var name = sentence.slice(m.index, end).replace(/[-+]+$/, "");
        spans.push([m.index, m.index + name.length, name]);
        COMPLEX_START_RE.lastIndex = Math.max(COMPLEX_START_RE.lastIndex, end);
      }
    }
    return spans;
  }

  /* Key under which every spelling of one complex meets: brackets, charge, counter-ion and the
     excited-state star are dropped. "Ir*[dF(CF3)ppy]2(dtbbpy)" = "[Ir(dF(CF3)ppy)2(dtbbpy)]PF6". */
  function complexKey(name) {
    var t = String(name || "").toLowerCase().replace(/^(?:fac|mer)-/, "");
    if (!/^\[?(?:ir|ru|os|re|pt|cu)[*\[(]/.test(t)) return "";
    t = t.replace(/\s+/g, "").replace(/dtbpy/g, "dtbbpy").replace(/\(?(?:pf6|bf4|otf|clo4|cl)\)?\d?$/, "").replace(/\d?[+]$/, "").replace(/\](?:\d?\+)?$/, "]");
    return t.replace(/[^a-z0-9]+/g, "");
  }

  /* Class words that are not a molecule on their own; they count only with a label ("oxime 1b-E"). */
  var GENERIC_CLASS_RE = /^(?:oximes?|enones?|azides?|acrylates?|boronates?|quinones?|quinolones?|flavins?|styrenes|alkenes?|dienes?|ketones?|arenes?|fumarates?|maleates?|cinnamates?|maleimides?|indoles?)$/i;
  var LABEL_AFTER_RE = /^\s+((?:\d+[a-z]{0,2}|[A-Z]\d{1,2}[a-z]?)(?:-\s?[EZ])?)(?![A-Za-z0-9])/;
  /* A compound number with a letter right after a name ("fumaronitrile 3c") is part of the name. */
  var LETTER_LABEL_AFTER_RE = /^\s+(\d+[a-z]{1,2}(?:-\s?[EZ])?)(?![A-Za-z0-9])/;
  /* "thioxanthone 1 derivative", "coumarin fragment 57", "xanthone-based": not the parent compound. */
  var DERIVATIVE_AFTER_RE = /^((?:\s+\d+[a-z]?)?[\s-]+(?:derivatives?|fragments?|analogues?|analogs?|moiet(?:y|ies)|units?|cores?|scaffolds?|based|type|substituted)(?:\s+\d+[a-z]?)?)(?![A-Za-z])/i;
  var EXTRA_NAME_RE = /\b(?:(?:\d(?:,\d)+-)?\d(?:Cz|DPA)[A-Za-z]{1,8}N|norbornadiene|quadricyclane|fumaronitrile|tetracene|pentacene|azulene|camphorquinone)\b/g;

  function findMoleculeSpansInSentence(sentence, knownKeys) {
    var casFound = null, cm;
    CAS_INLINE_RE.lastIndex = 0;
    while ((cm = CAS_INLINE_RE.exec(sentence)) !== null) {
      if (EntScore.casValid(cm[1])) { casFound = cm[1]; break; }
    }
    var spans = [];
    function overlaps(s, e) { return spans.some(function (sp) { return !(e <= sp[0] || s >= sp[1]); }); }

    var low = sentence.toLowerCase().replace(/[′’]/g, "'");
    var lowCompact = low.replace(/\s+/g, "");
    knownKeys.forEach(function (nk) {
      if (nk.length < 3 || looksLikeAnonymousLabel(nk) || lowCompact.indexOf(nk) < 0) return;
      var pat = new RegExp("(?<![A-Za-z0-9])" + nk.split("").map(escapeRegex).join("\\s*") + "(?![A-Za-z0-9])", "g");
      var m;
      while ((m = pat.exec(low)) !== null) {
        if (!overlaps(m.index, m.index + m[0].length)) {
          spans.push([m.index, m.index + m[0].length, sentence.slice(m.index, m.index + m[0].length).trim()]);
        }
      }
    });

    scanComplexes(sentence).forEach(function (sp) {
      // a longer bracket-balanced complex replaces a shorter dictionary hit inside it
      spans = spans.filter(function (o) { return o[1] <= sp[0] || o[0] >= sp[1] || (o[1] - o[0]) >= (sp[1] - sp[0]); });
      if (!overlaps(sp[0], sp[1])) spans.push(sp);
    });

    CHEM_NAME_RE.lastIndex = 0;
    var mc;
    while ((mc = CHEM_NAME_RE.exec(sentence)) !== null) {
      var tok = mc[0].replace(/^[ ,.;:()]+|[ ,.;:()]+$/g, "");
      var mEnd = mc.index + mc[0].length;
      if (GENERIC_CLASS_RE.test(tok)) {
        var lab = LABEL_AFTER_RE.exec(sentence.slice(mEnd));
        if (!lab) continue;
        tok = tok + " " + lab[1].replace(/\s/g, "");
        mEnd += lab[0].length;
      } else {
        var lab2 = LETTER_LABEL_AFTER_RE.exec(sentence.slice(mEnd)) || DERIVATIVE_AFTER_RE.exec(sentence.slice(mEnd));
        if (lab2) { tok = (tok + " " + lab2[1]).replace(/\s+/g, " "); mEnd += lab2[0].length; }
      }
      if (tok.length >= 4 && !overlaps(mc.index, mEnd)) {
        spans.push([mc.index, mEnd, tok]);
      }
    }
    EXTRA_NAME_RE.lastIndex = 0;
    var mx;
    while ((mx = EXTRA_NAME_RE.exec(sentence)) !== null) {
      var xEnd = mx.index + mx[0].length, xTok = mx[0];
      var lab3 = LETTER_LABEL_AFTER_RE.exec(sentence.slice(xEnd));
      if (lab3 && !/^(?:\d(?:,\d)+-)?\d(?:Cz|DPA)/.test(xTok)) { xTok = xTok + " " + lab3[1].replace(/\s/g, ""); xEnd += lab3[0].length; }
      if (!overlaps(mx.index, xEnd)) spans.push([mx.index, xEnd, xTok]);
    }

    if (!spans.length) {
      var lblRe = /\b((?:compound|compd|substrate|sensitizer|donor|acceptor|complex|catalyst|oxime|diazene|alkene|styrene)\s+(?:[A-Z]?\d+[a-z]{0,2}(?:-[EZ])?)|(?:PC|PS|Cat)-\d+[a-z]?|C\d+)\b/gi, ml;
      while ((ml = lblRe.exec(sentence)) !== null) spans.push([ml.index, ml.index + ml[1].length, ml[1]]);
    }
    // "thioxanthone 1 derivative", "benzophenone 3a": the words after the name change what it is
    spans = spans.map(function (sp) {
      var after = sentence.slice(sp[1]);
      var ext = DERIVATIVE_AFTER_RE.exec(after) || LETTER_LABEL_AFTER_RE.exec(after);
      if (!ext || / (?:derivatives?|fragments?|based|type)\b/i.test(sp[2])) return sp;
      return [sp[0], sp[1] + ext[0].length, (sp[2] + " " + ext[1]).replace(/\s+/g, " ").replace(/ -/g, "-")];
    });
    spans.sort(function (a, b) { return a[0] - b[0]; });
    return { spans: spans, cas: casFound };
  }

  function hasNonTripletPrefix(sent, valPos) {
    var pfx = sent.slice(Math.max(0, valPos - 45), valPos);
    if (RANGE_OR_NEG_PREFIX_RE.test(pfx)) return true;
    return /(?:Δ[GH][≠‡]?|reorganization\s+energy|activation\s+(?:energy|barrier)|excitation\s+of\s+oxygen|singlet\s+oxygen|\bλ\s*\)?\s*(?:to|=)?)\s*$/i.test(pfx);
  }

  /* Footnote marks and exponents land between a number and its unit: "ET = 3.21 1 eV",
     "(46.8 kcal 1 mol-1)". Drop them, keeping the length so positions still line up. */
  function blankStrayScripts(sent) {
    return sent
      .replace(/(\d[.,]\d+)(\s\d{1,2})(?=\s(?:eV|kcal|kJ)\b)/g, function (_, a, b) { return a + b.replace(/\d/g, " "); })
      .replace(/\b(kcal|kJ)(\s\d)(?=\smol)/g, function (_, a, b) { return a + "  "; });
  }

  function extractEnergyMatchesInSentence(sentRaw) {
    var sent = blankStrayScripts(sentRaw);
    var matches = [];
    var rxGroups = [
      [[ET_AFTER_WORD_RE, false], [ET_AFTER_SYM_RE, false]],
      [[ET_BEFORE_WORD_RE, false], [ET_BEFORE_SYM_RE, false]],
      [[PHOS_NM_RE, true]]
    ];
    for (var gi = 0; gi < rxGroups.length; gi++) {
      var grp = rxGroups[gi];
      for (var ri = 0; ri < grp.length; ri++) {
        var rx = grp[ri][0], isNm = grp[ri][1], m;
        rx.lastIndex = 0;
        while ((m = rx.exec(sent)) !== null) {
          var valPos = (!isNm && m[1]) ? (m.index + m[0].lastIndexOf(m[1])) : m.index;
          if (hasNonTripletPrefix(sent, valPos)) continue;
          if (!isNm && /\b0\s*[-–]\s*0\s+(?:band|transition)/i.test(m[0]) && !TRIPLET_CONTEXT_RE.test(sent)) continue;
          if (matches.some(function (x) { return !(m.index + m[0].length <= x[0] || m.index >= x[1]); })) continue;
          if (isNm) {
            var vnm = EntScore.num(m[1]);
            if (isFinite(vnm)) matches.push([m.index, m.index + m[0].length, vnm, null, "nm", m[0]]);
          } else {
            var unit = normalizeUnit(m[3]), val = parseNum(m[1], unit), unc = m[2] ? parseNum(m[2], unit) : null;
            if (unc != null && !isFinite(unc)) unc = null;
            if (isFinite(val) && !isSingletValue(sent, valPos, m.index + m[0].length)) {
              matches.push([m.index, m.index + m[0].length, val, unc, unit, m[0], valPos]);
            }
          }
        }
      }
      if (matches.length) break;
    }
    if (!matches.length) return [];

    if (matches[0][4] !== "nm") {
      AND_PAIR_UNIT_RE.lastIndex = 0;
      var ma;
      while ((ma = AND_PAIR_UNIT_RE.exec(sent)) !== null) {
        if (/(?:mol(?:e)?|cm)\s*[-−–@]?\s*$/i.test(sent.slice(Math.max(0, ma.index - 10), ma.index))) continue;
        if (hasNonTripletPrefix(sent, ma.index) || isSingletValue(sent, ma.index, ma.index + ma[0].length)) continue;
        var uA = normalizeUnit(ma[3]), v1 = parseNum(ma[1], uA), v2 = parseNum(ma[2], uA);
        if (isFinite(v1) && isFinite(v2)) {
          matches = matches.filter(function (x) { return x[1] <= ma.index || x[0] >= ma.index + ma[0].length; });
          matches.push([ma.index, ma.index + ma[1].length, v1, null, uA, ma[0]]);
          matches.push([ma.index, ma.index + ma[0].length, v2, null, uA, ma[0]]);
        }
      }
      var covered = function (s, e) { return matches.some(function (x) { return !(e <= x[0] || s >= x[1]); }); };
      PAIR_UNIT_RE.lastIndex = 0;
      var mp;
      while ((mp = PAIR_UNIT_RE.exec(sent)) !== null) {
        var pe = mp.index + mp[0].length;
        if (covered(mp.index, pe)) continue;
        if (hasNonTripletPrefix(sent, mp.index) || isSingletValue(sent, mp.index, pe)) continue;
        var uP = normalizeUnit(mp[3]), vp = parseNum(mp[1], uP), up = mp[2] ? parseNum(mp[2], uP) : null;
        if (up != null && !isFinite(up)) up = null;
        if (isFinite(vp)) matches.push([mp.index, pe, vp, up, uP, mp[0]]);
      }
    }
    // "thioxanthone (ET 65.5), benzophenone (ET 68.5)": later items of a list drop the unit
    if (matches[0][4] !== "nm") {
      var listRe = /\(\s*E_?\s?T\s*=?\s*(\d{2,3}(?:\.\d)?)\d?\s*[),]/g, ml;
      while ((ml = listRe.exec(sent)) !== null) {
        var ls = ml.index, le = ml.index + ml[0].length;
        if (matches.some(function (x) { return !(le <= x[0] || ls >= x[1]); })) continue;
        var lv = parseNum(ml[1], matches[0][4]);
        if (isFinite(lv)) matches.push([ls + 1, le, lv, null, matches[0][4], ml[0]]);
      }
    }
    matches.sort(function (a, b) { return a[0] - b[0]; });
    // "ET = 2.12 eV, 205 kJ mol-1": one quantity in two units is one value
    matches = matches.filter(function (mt, i) {
      if (!i) return true;
      var pv = matches[i - 1];
      if (pv[4] === mt[4] || mt[0] - pv[1] > 14) return true;
      var a = convertEnergy(pv[2], null, pv[4]).et_kcal, b = convertEnergy(mt[2], null, mt[4]).et_kcal;
      return !(a != null && b != null && Math.abs(a - b) <= 1.0);
    });
    return matches;
  }

  var NOT_A_NAME_RE = /^(?:energy|energies|state|states|value|values|complex|complexes|catalysts?|sensitizers?|photocatalysts?|photosensitizers?|substrates?|products?|reactions?|isomers?|species|that|with|and|of|the|triplet|singlet|respectively|group|groups|ligands?|conditions|yield|yields|ref|refs|figure|table|scheme)$/i;
  /* Word parts that only chemical names have. A suffix test is useless here: "inadequate",
     "alone" and "define" all end like compounds. */
  var CHEMISH_RE = /(?:benz|naphth|phen(?:yl|anthr|one|ol)|pyr(?:id|ene|role|imid|azin)|thio|fluor|chlor|brom|iod[oi]|nitr[oi]|cyclo|methyl|ethyl|propyl|butyl|acet(?:o|yl)|carbon|carbox|quin|anthr|xanth|diene|triene|stilb|styr|azo|oxim|imin|furan|indol|coumar|chalc|maleim|fumar|cinnam|ketone|aldehyde|\d,\d|\d-[a-z])/i;
  var ROLE_NOUN_RE = /^(?:complex|complexes|catalysts?|sensitizers?|photocatalysts?|photosensitizers?|substrates?|products?|isomers?|species|ligands?|derivatives?|compounds?|dyes?|chromophores?)$/i;
  var HEDGE_RE = /(?:approximately|approx\.?|around|near|about|roughly|ca\.?|typically|generally|[~≈∼]|E_?\s?T\s+[BE])\s*\d/i;

  /* "norbornadiene (NBD, 1c, ET = 62.1 ...)": a value given in brackets belongs to what stands
     right before the bracket. Returns that name, or null. */
  function nameBeforeParen(sent, spans, valPos) {
    var open = sent.lastIndexOf("(", valPos);
    if (open < 0 || valPos - open > 90) return null;
    if (sent.slice(open, valPos).indexOf(")") >= 0) return null;
    var before = sent.slice(0, open).replace(/\s+$/, "");
    for (var j = 0; j < spans.length; j++) {
      if (spans[j][1] >= before.length - 1 && spans[j][1] <= open) return spans[j][2];
    }
    var m = /((?:[A-Za-z][A-Za-z0-9,'′\-\[\]]{3,}\s+)?(?:\d+\s?[a-z]{1,2}(?:-\s?[EZ])?|\d+[a-z]?-\s?[EZ]|[A-Z]\d{1,2}[a-z]?)|\d+·[A-Z][A-Za-z0-9 ]{1,6}|(?:[Uu]sing|with|of|for|and|by)\s+\d{1,3}|[A-Za-z][A-Za-z0-9,'′\-\[\]]{4,})$/.exec(before);
    if (!m) return null;
    var tok = m[1].replace(/\s+/g, " ").trim().replace(/-\s([EZ])$/, "-$1");
    var bare = /^(?:[Uu]sing|with|of|for|and|by)\s+(\d{1,3})$/.exec(tok);
    if (bare) return bare[1];                                              // "Using 221 (ET = ...)"
    var words = tok.split(" "), lastW = words[words.length - 1];
    // "the photocatalyst (ET = 67 ...)", "the oxime (ET = 2.34 eV)": something is meant, but it is
    // not named here; guessing the nearest molecule would attach the value to the wrong one.
    if (ROLE_NOUN_RE.test(lastW) || GENERIC_CLASS_RE.test(lastW)) return "";
    if (NOT_A_NAME_RE.test(lastW)) return null;
    var lbl = /^(\d+)\s?([a-z]{1,2})(?:-\s?([EZ]))?$/.exec(tok);
    if (lbl) return lbl[1] + lbl[2] + (lbl[3] ? "-" + lbl[3] : "");        // "1 a" -> "1a"
    if (/\d/.test(lastW) && lastW.length <= 6) {
      var clean = tok.replace(/-\s([EZ])$/, "-$1");
      return NOT_A_NAME_RE.test(words[0]) && words.length > 1 ? clean.split(" ").slice(1).join(" ") : clean;
    }
    return CHEMISH_RE.test(tok) && !GENERIC_CLASS_RE.test(tok) ? tok : null;
  }

  /* "triplet energy of thioxanthone has been determined as 264 kJ/mol", "ET of verbenone = 3.0 eV":
     a molecule named between the cue and the value is the one meant. */
  function nameInsideCue(spans, mt) {
    if (mt[6] == null || mt[6] <= mt[0]) return null;
    var inside = spans.filter(function (sp) { return sp[0] >= mt[0] && sp[1] <= mt[6]; });
    return inside.length === 1 ? inside[0][2] : null;
  }

  /* Names for each match plus how they were found. "proximity" means a guess among several
     molecules in the sentence, which the curator must confirm. */
  function pairWithConfidence(sent, spans, matches) {
    var how = matches.map(function () { return "anchored"; });
    var names = matches.map(function (mt, i) {
      var vp = mt[6] != null ? mt[6] : mt[0];
      var inCue = nameInsideCue(spans, mt);
      if (inCue) return inCue;
      var byParen = nameBeforeParen(sent, spans, vp);
      if (byParen === "") { how[i] = "none"; return "(unnamed candidate)"; }
      return byParen;
    });
    if (names.some(function (x) { return x === null; })) {
      var rest = pairByPosition(sent, spans, matches);
      var distinct = {};
      spans.forEach(function (sp) { distinct[normalizeNameKey(sp[2])] = 1; });
      var many = Object.keys(distinct).length > 1;
      names = names.map(function (x, i) {
        if (x !== null) return x;
        how[i] = rest[i] === "(unnamed candidate)" ? "none" : (many ? "proximity" : "single");
        return rest[i];
      });
    }
    return { names: names, how: how };
  }

  function pairMoleculesToMatches(sent, spans, matches) {
    return pairWithConfidence(sent, spans, matches).names;
  }

  function pairByPosition(sent, spans, matches) {
    if (!spans.length) return matches.map(function () { return "(unnamed candidate)"; });
    if (spans.length === 1) return matches.map(function () { return spans[0][2]; });
    var assigned = matches.map(function () { return null; });
    matches.forEach(function (mt, i) {
      var nextMs = i + 1 < matches.length ? matches[i + 1][0] : sent.length;
      var lim = Math.min(nextMs, mt[1] + 45);
      var tail = sent.slice(mt[1], lim);
      if (/^\s*(?:for|of)\s+/i.test(tail)) {
        for (var j = 0; j < spans.length; j++) {
          if (spans[j][0] >= mt[1] && spans[j][0] < lim) { assigned[i] = spans[j][2]; break; }
        }
      }
    });
    if (assigned.every(function (x) { return x !== null; })) return assigned;
    if (spans.length === matches.length && assigned.every(function (x) { return x === null; })) {
      return spans.map(function (sp) { return sp[2]; });
    }
    if (/\brespectively\b/i.test(sent) && assigned.every(function (x) { return x === null; })) {
      var before = spans.filter(function (sp) { return sp[1] <= matches[0][0]; });
      if (before.length >= matches.length) {
        var tailSpans = before.slice(before.length - matches.length);
        return tailSpans.map(function (sp) { return sp[2]; });
      }
    }
    return matches.map(function (mt, i) {
      if (assigned[i] !== null) return assigned[i];
      var cl = clauseAround(sent, mt[0], mt[1]);
      var clStart = sent.indexOf(cl), clEnd = clStart >= 0 ? clStart + cl.length : sent.length;
      var sameClause = spans.filter(function (sp) { return sp[0] >= clStart && sp[1] <= clEnd; });
      var pool = sameClause.length ? sameClause : spans;
      var best = pool[0], bestD = Infinity;
      pool.forEach(function (sp) {
        var d = (sp[0] <= mt[0] && mt[0] <= sp[1]) ? 0 : Math.min(Math.abs(mt[0] - sp[1]), Math.abs(sp[0] - mt[1]));
        if (d < bestD) { bestD = d; best = sp; }
      });
      return best[2];
    });
  }

  /* ---------- Paper-local labels defined in the text: "Ru(bpy)3 2+ (1a)", "[Ir(...)]+ (PC-6)" ---------- */
  var LABEL_TOKEN = "(?:PC|PS|Cat)-\\d+[a-z]?|[A-RU-Z]\\d{1,2}[a-z]?|\\d{1,3}\\s?[a-z]{1,2}(?:-[EZ])?";
  var LABEL_DEF_RE = new RegExp("\\(\\s*(" + LABEL_TOKEN + ")\\s*(?=[,)])", "g");
  var LABEL_NAME_RE = new RegExp("^(?:(.*?)\\s+)?(" + LABEL_TOKEN + ")$");
  function labelKey(s) { return String(s || "").toLowerCase().replace(/\s+/g, ""); }

  function definedNameBefore(before, knownKeys) {
    var cx = scanComplexes(before), last = cx[cx.length - 1];
    if (last && /^[\s\d+]{0,5}$/.test(before.slice(last[1]))) return last[2];
    var trimmed = before.replace(/\s+$/, "");
    var sp = findMoleculeSpansInSentence(trimmed, knownKeys).spans, s = sp[sp.length - 1];
    if (s && s[1] === trimmed.length) {
      if (looksLikeAnonymousLabel(s[2]) || LABEL_NAME_RE.test(s[2]) || GENERIC_CLASS_RE.test(s[2]) ||
          / (?:derivatives?|fragments?|based|type)\b/i.test(s[2])) return "";
      return s[2];
    }
    // "4-chloroanisole (1a", "ethyl 4-nitrobenzoate (3b": the last word, with the alkyl words before it
    var m = /((?:(?:[A-Za-z\-]*yl|sodium|potassium)\s+)*)([A-Za-z0-9][A-Za-z0-9,'′\-\[\]]{4,})$/.exec(trimmed);
    if (!m || !/[a-z]{4}/.test(m[2]) || !CHEMISH_RE.test(m[2])) return "";
    if (GENERIC_CLASS_RE.test(m[2]) || ROLE_NOUN_RE.test(m[2]) || NOT_A_NAME_RE.test(m[2])) return "";
    return (m[1] + m[2]).trim();
  }

  /* label -> { name, id, page }; a label given to two different names is left out (null). */
  function labelDefinitions(doc, knownKeys) {
    var defs = {};
    (doc.pages || []).forEach(function (page) {
      var text = tightenComplexFormulas(String(page.text || "").replace(/-\n(?=[a-z])/g, "").replace(/\s+/g, " "));
      var m;
      LABEL_DEF_RE.lastIndex = 0;
      while ((m = LABEL_DEF_RE.exec(text)) !== null) {
        var name = definedNameBefore(text.slice(Math.max(0, m.index - 120), m.index), knownKeys);
        if (!name) continue;
        var k = labelKey(m[1]), id = complexKey(name) || normalizeNameKey(name);
        if (!(k in defs)) defs[k] = { name: name, id: id, page: page.pageNum };
        else if (defs[k] && defs[k].id !== id) defs[k] = null;
      }
    });
    return defs;
  }

  /* Replace a label used as a name ("1a", "Catalyst C2", "PC-6") by the name the paper gives it. */
  function applyLabelDefinitions(cands, defs) {
    cands.forEach(function (c) {
      var lm = LABEL_NAME_RE.exec(String(c.name || "").trim());
      if (!lm) return;
      var lead = (lm[1] || "").trim();
      if (lead && !ROLE_NOUN_RE.test(lead) && !GENERIC_CLASS_RE.test(lead)) return;
      var d = defs[labelKey(lm[2])];
      if (!d) return;
      c.verify_note = ((c.verify_note || "") + " The paper calls this compound “" + c.name + "”; the name “" + d.name +
        "” was read from where the label is defined (p. " + d.page + "): confirm it.").trim();
      c.name = d.name;
    });
  }

  function extractFromProse(doc, knownMap, knownKeys, opts) {
    var results = [];
    doc.pages.forEach(function (page) {
      var curSec = "p. " + page.pageNum;
      var text = page.text.replace(/(?<!\bcis)(?<!\btrans)-\n([a-z])/g, "$1");
      var paragraphs = [], buf = [];
      text.split(/\r?\n/).forEach(function (rawLn) {
        var ln = rawLn.trim();
        if (!ln) {
          if (buf.length) { paragraphs.push([curSec, buf.join(" ")]); buf = []; }
          return;
        }
        var sm = SECTION_RE.exec(ln);
        if (sm && ln.length <= 120) {
          if (buf.length) { paragraphs.push([curSec, buf.join(" ")]); buf = []; }
          curSec = sm[1].trim();
          var rest = ln.slice(sm[0].length).replace(/^[ :.—-]+/, "");
          if (rest) buf.push(rest);
          return;
        }
        buf.push(ln);
      });
      if (buf.length) paragraphs.push([curSec, buf.join(" ")]);

      paragraphs.forEach(function (pair) {
        var secLabel = pair[0], joined = tightenComplexFormulas(pair[1].replace(/\s+/g, " "));
        var sentences = joined.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/);
        sentences.forEach(function (sent) {
          var matches = extractEnergyMatchesInSentence(sent);
          if (!matches.length) return;
          var spRes = findMoleculeSpansInSentence(sent, knownKeys);
          var pairing = pairWithConfidence(sent, spRes.spans, matches), paired = pairing.names;
          var origin = classifyOrigin(sent, "exp");
          var mc = extractMethodAndConditions(sent, origin);
          var uv = extractUv(sent), dirExc = extractDirectExc(sent);
          var isAbs = secLabel.toLowerCase().indexOf("abstract") >= 0 || (page.pageNum === 1 && sent.slice(0, 40).toLowerCase().indexOf("abstract") >= 0);

          matches.forEach(function (mt, idx) {
            var val = mt[2], unc = mt[3], unit = mt[4], snippet = mt[5];
            var conv = convertEnergy(val, unc, unit);
            if (conv.et_kcal == null || conv.et_kcal < 20.0 || conv.et_kcal > EntScore.ET_MAX) return;
            var molName = cleanMoleculeName(paired[idx], knownMap);
            // A rough figure with no molecule attached ("styrenes possess triplet energies of
            // approximately 60 kcal/mol") describes a class, not an entry.
            if ((molName === "(unnamed candidate)" || (/s$/.test(molName) && !knownMap[normalizeNameKey(molName)])) &&
                HEDGE_RE.test(sent.slice(Math.max(0, mt[0] - 25), mt[1]))) return;
            results.push({
              name: molName.slice(0, 200),
              raw_cas: spRes.cas || null,
              raw_smiles: null,
              et_kcal: conv.et_kcal,
              et_unc: conv.unc_kcal,
              et_reported: conv.rep,
              origin: origin,
              et_type: mc.etType,
              method: mc.method,
              conditions: mc.conditions,
              doi: opts.doi,
              citation: opts.citation,
              location: isAbs ? "Abstract" : (secLabel === ("p. " + page.pageNum) ? secLabel : (secLabel + ", p. " + page.pageNum)),
              quote: truncateQuote(snippet),
              evidence: stripUrls(sent.slice(0, 400)),
              verify_level: isAbs ? "abstract" : "primaria",
              verify_note: "Automatically extracted from PDF text; verify structure and values." +
                (pairing.how[idx] === "proximity" ? " Several molecules are named in the sentence and this one was chosen by proximity: confirm the value belongs to it." : ""),
              uv_lmax: uv.uv_lmax,
              uv_eps: uv.uv_eps,
              uv_cond: uv.uv_cond,
              direct_exc: dirExc,
              cls: opts.defaultCls || null,
              role: opts.defaultRole || "acceptor",
              unit: (unit === "kcal" || unit === "kj" || unit === "ev") ? unit : "kcal",
              raw_et: (unit === "kcal" || unit === "kj" || unit === "ev") ? val : conv.et_kcal,
              raw_unc: (unit === "kcal" || unit === "kj" || unit === "ev") ? unc : conv.unc_kcal,
              tech: origin === "calc" ? null : (mc.method === "Not stated" ? null : mc.method),
              solvent: origin === "calc" ? null : mc.fOrSolv,
              temp: origin === "calc" ? null : mc.bOrTemp,
              func: origin === "calc" ? mc.fOrSolv : null,
              basis: origin === "calc" ? mc.bOrTemp : null,
              solv: origin === "calc" ? mc.solvModel : null,
              warnings: [],
              pdf_file: doc.name,
              page_num: page.pageNum
            });
          });
        });
      });
    });
    return results;
  }

  /* ---------- Knowledge index & online resolvers (PubChem / Crossref / doi.org) ---------- */
  function buildKnowledgeIndex(refEntries) {
    var byName = {}, byCas = {}, byIdcode = {}, bySmiles = {};
    Object.keys(BUILTIN_MOLECULES).forEach(function (k) {
      byName[normalizeNameKey(k)] = { smiles: BUILTIN_MOLECULES[k], cas: null, cls: null, role: null };
    });
    (refEntries || []).forEach(function (r) {
      var smi = String((r && r.smiles) || "").trim();
      if (!smi) return;
      var name = String(r.name || "").trim();
      var cas = r.cas ? EntScore.cleanCas(r.cas) : "";
      if (cas && !EntScore.casValid(cas)) cas = "";
      var info = { smiles: smi, cas: cas || null, cls: r.cls || null, role: r.role || null, iupac: name || null };
      var idc = r.idcode || (Ent.idCode ? Ent.idCode(smi) : null);
      if (idc && !byIdcode[idc]) byIdcode[idc] = info;
      if (!bySmiles[smi]) bySmiles[smi] = info;
      if (cas && !byCas[cas]) byCas[cas] = info;
      if (name) {
        var nk = normalizeNameKey(name);
        if (nk && !byName[nk]) byName[nk] = info;
        var m = /\(([^()]{2,20})\)\s*$/.exec(name);
        if (m && !looksLikeAnonymousLabel(m[1])) {
          var alias = normalizeNameKey(m[1]);
          if (alias && !byName[alias]) byName[alias] = info;
        }
      }
    });
    var byComplex = {};
    Object.keys(byName).forEach(function (k) {
      var ck = complexKey(k);
      if (ck && !byComplex[ck]) byComplex[ck] = byName[k];
    });
    var keys = Object.keys(byName).sort(function (a, b) { return b.length - a.length; });
    return { byName: byName, byCas: byCas, byIdcode: byIdcode, bySmiles: bySmiles, byComplex: byComplex, keys: keys };
  }

  function formatCrossrefCitation(msg) {
    if (!msg) return null;
    var authors = (msg.author || []).map(function (a) { return a && a.family; }).filter(Boolean);
    var authorStr = authors.length > 6 ? (authors[0] + " et al.") : authors.join(", ");
    var jList = msg["short-container-title"] || msg["container-title"] || [];
    var journal = jList[0] || "";
    var year = "";
    ["published-print", "published-online", "issued", "created"].forEach(function (k) {
      if (year) return;
      var parts = ((msg[k] && msg[k]["date-parts"] && msg[k]["date-parts"][0]) || []);
      if (parts[0]) year = String(parts[0]);
    });
    var vol = String(msg.volume || "");
    var page = String(msg.page || msg["article-number"] || "").replace(/-/g, "\u2013");
    var out = [authorStr, [journal, year].filter(Boolean).join(" "), vol, page].filter(Boolean).join(", ");
    return out || null;
  }

  function fetchCrossrefCitation(doi) {
    var d = EntScore.cleanDoi(doi);
    if (!EntScore.isDoi(d)) return Promise.resolve(null);
    return fetch("https://api.crossref.org/works/" + encodeURIComponent(d))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return formatCrossrefCitation(j && j.message); })
      .catch(function () { return null; });
  }

  function checkDoiResolves(doi) {
    var d = EntScore.cleanDoi(doi);
    if (!EntScore.isDoi(d)) return Promise.resolve(false);
    return fetch("https://doi.org/api/handles/" + encodeURIComponent(d))
      .then(function (r) {
        if (r.status === 404) return false;
        if (!r.ok) return null;
        return r.json().then(function (b) { return b && b.responseCode === 1; });
      })
      .catch(function () { return null; });
  }

  /* ---------- Other spellings of a name worth asking PubChem for ---------- */
  var NAME_SYNONYMS = {
    "9-acridinone": "acridone",
    "9-xanthione": "xanthione",
    "thiofluorenone": "9H-fluorene-9-thione",
    "benz[b]acridin-12-one": "benz[b]acridin-12(5H)-one"
  };
  var INDEX_SUFFIX_RE = /^(?:perchlorate|chloride|bromide|iodide|tetrafluoroborate|hexafluorophosphate|hydrochloride|inner salt|sodium salt|(?:di|tri)?(?:methyl|ethyl) ester)$/i;
  var INDEX_METAL_RE = /^(zinc|magnesium|copper|palladium|platinum|nickel|cobalt|iron|tin|aluminium|aluminum)\((?:I{1,3}|IV)\)$/i;
  var ION_WORD_RE = /\s+(dianion|anion|cation|dication)$/i;
  function spellGreek(s) {
    return s.replace(/α/g, "alpha").replace(/β/g, "beta").replace(/γ/g, "gamma").replace(/δ/g, "delta");
  }

  /* Index names are inverted: "Anthracene, 9,10-dibromo-" is 9,10-dibromoanthracene and
     "Porphyrin, tetraphenyl-, zinc(II)" is zinc tetraphenylporphyrin. Returns
     { full, core, dropped }: core is the name without metal, counter-ion or charge word, which
     is a different species and may only be offered as a suggestion. */
  function uninvertParts(name) {
    var parts = String(name || "").trim().split(/,\s+/);
    var base = parts[0], stereo = "", pre = "", suf = [], metal = "", dropped = [];
    var ms = /^(\((?:[EZRS],?)+\)-)(.+)$/.exec(base);
    if (ms) { stereo = ms[1]; base = ms[2]; }
    var mi = ION_WORD_RE.exec(base);
    if (mi) { suf.push(mi[1]); base = base.slice(0, mi.index); }
    if (!/[A-Za-z]{4,}/.test(base) || (parts.length === 1 && !mi)) return null;
    for (var i = 1; i < parts.length; i++) {
      var p = parts[i].trim(), mm;
      if (/^\((?:[EZRS],?)+\)-?$/.test(p)) stereo = p.replace(/-?$/, "-");
      else if ((mm = INDEX_METAL_RE.exec(p))) metal = mm[1].toLowerCase();
      else if (INDEX_SUFFIX_RE.test(p)) suf.push(p);
      else if (/-$/.test(p) || /^[\dN][\dN,'′]*-[A-Za-z()\d,'\-]+$/.test(p)) pre += p.replace(/-$/, "");
      else return null;
    }
    var lb = /^[A-Z][a-z]/.test(base) ? base.charAt(0).toLowerCase() + base.slice(1) : base;
    var core = stereo + pre + (pre && /^[\d(]/.test(lb) ? "-" : "") + lb;
    var full = (metal ? metal + " " : "") + core + (suf.length ? " " + suf.join(" ") : "");
    if (metal) dropped.push(metal);
    dropped = dropped.concat(suf);
    return { full: full, core: core, dropped: dropped };
  }
  function uninvertIndexName(name) {
    var u = /,\s/.test(String(name || "")) ? uninvertParts(name) : null;
    return u ? u.full : "";
  }

  /* Queries for one name, best first. exact: the same compound written another way.
     Not exact: a related species (parent without the metal, a guessed Greek letter), which is
     only shown to the curator as a suggestion. */
  function nameQueries(name) {
    var n0 = String(name || "").trim(), out = [], seen = {};
    function add(q, exact, why) {
      q = String(q || "").replace(/\s+/g, " ").trim();
      var k = q.toLowerCase();
      if (q.length < 3 || seen[k] || looksLikeAnonymousLabel(q)) return;
      seen[k] = 1;
      out.push({ q: q, exact: exact, why: why || "" });
      var g = spellGreek(q);
      if (g !== q && !seen[g.toLowerCase()]) { seen[g.toLowerCase()] = 1; out.push({ q: g, exact: exact, why: why || "" }); }
    }
    add(n0, true);
    // "1,4-Benzoquinone,tetrachloro-" (comma without space), "l0-methyl" (letter l read for 1)
    var fixed = n0.replace(/,(?=[A-Za-z]{4})/g, ", ").replace(/(^|[\s,\-(])l(?=\d)/g, "$11");
    add(fixed, true);
    var stripped = fixed.replace(TRAILING_LABEL_RE, "").trim();
    if (stripped !== fixed && !/\((?:I{1,3}|IV)\)$/.test(fixed)) add(stripped, true);
    // "fumaronitrile 3c": the compound number is not part of the name
    var ml = /^(.{5,}?)\s+\d+[a-z]{0,2}(?:-[EZ])?$/.exec(fixed);
    if (ml && !GENERIC_CLASS_RE.test(ml[1]) && !ROLE_NOUN_RE.test(ml[1].split(" ").pop()) &&
        !/\b(?:derivatives?|fragments?|analogues?|analogs?|moiet(?:y|ies)|units?|cores?|scaffolds?|based|type|substituted)\b/i.test(ml[1])) add(ml[1], true);
    var syn = NAME_SYNONYMS[normalizeNameKey(fixed)];
    if (syn) add(syn, true);
    var u = uninvertParts(fixed), forms = [fixed];
    if (u) { add(u.full, true); forms.push(u.full); }
    forms.forEach(function (f) {
      var alt = f.replace(/naphthalenedicarboximide/i, "naphthalimide").replace(/\(([a-z]{6,})\)/g, "$1");
      if (alt !== f) add(alt, true);
    });
    if (u && u.dropped.length && u.core !== u.full) add(u.core, false, "without “" + u.dropped.join(", ") + "”");
    // old prints: the Greek beta comes out as "8-" or "B-" ("8-acetonaphthone")
    var mb = /^[8B]-([a-z]{6,})$/.exec(fixed);
    if (mb) add("beta-" + mb[1], false, "reading “" + fixed.charAt(0) + "-” as a Greek beta");
    return out;
  }

  function lookupSmilesByName(query, attempt) {
    var q = String(query || "").trim();
    if (!q || looksLikeAnonymousLabel(q)) return Promise.resolve("");
    var tries = attempt || 0;
    return fetch("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/property/IsomericSMILES,CanonicalSMILES,SMILES/JSON", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=" + encodeURIComponent(q)
    }).then(function (r) {
      // PubChem answers 503/429 when asked too fast: wait and ask again instead of giving up
      if ((r.status === 503 || r.status === 429) && tries < 3) {
        return sleep(1200 * (tries + 1)).then(function () { return lookupSmilesByName(q, tries + 1); });
      }
      if (r.status === 400 || r.status === 404 || !r.ok) return "";
      return r.json().then(function (j) {
        var p = j && j.PropertyTable && j.PropertyTable.Properties && j.PropertyTable.Properties[0];
        return (p && (p.IsomericSMILES || p.CanonicalSMILES || p.SMILES || p.ConnectivitySMILES)) || "";
      });
    }).catch(function () { return ""; });
  }
  EntPdf.lookupSmilesByName = lookupSmilesByName;

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function resolveCandidateOnline(cand, kb, cache) {
    var cas = cand.raw_cas ? EntScore.cleanCas(cand.raw_cas) : "";
    if (cas && !EntScore.casValid(cas)) cas = "";
    var rawSmi = (cand.raw_smiles || "").trim();
    var smi = "", clsHint = null, roleHint = null, src = "";

    if (rawSmi && Ent.structureOk && Ent.structureOk(rawSmi) !== false) {
      smi = rawSmi; src = "explicit_smiles";
    } else if (cas && kb.byCas[cas]) {
      smi = kb.byCas[cas].smiles; clsHint = kb.byCas[cas].cls; roleHint = kb.byCas[cas].role; src = "local_cas";
    } else {
      var nk = normalizeNameKey(cand.name);
      var cpk = complexKey(cand.name);
      // the last digit of a complex name is often a glued compound number: "Ir[dF(CF3)ppy]2(dtbbpy)6"
      var hit = (nk && kb.byName[nk]) || (cpk && kb.byComplex && (kb.byComplex[cpk] || kb.byComplex[cpk.replace(/\d$/, "")])) || null;
      if (hit) {
        smi = hit.smiles; cas = cas || hit.cas || "";
        clsHint = hit.cls; roleHint = hit.role; src = "local_dict";
      }
    }

    var pSmi;
    if (smi) {
      pSmi = Promise.resolve({ smiles: smi, cas: cas, clsHint: clsHint, roleHint: roleHint, src: src });
    } else if (cas) {
      var ck = "cas:" + cas;
      if (ck in cache) pSmi = Promise.resolve(cache[ck]);
      else pSmi = sleep(220).then(function () { return lookupSmilesByName(cas); }).then(function (found) {
        var r = { smiles: found || "", cas: cas, clsHint: null, roleHint: null, src: found ? "pubchem_cas" : "unresolved" };
        cache[ck] = r; return r;
      });
    } else if (looksLikeAnonymousLabel(cand.name)) {
      pSmi = Promise.resolve({ smiles: "", cas: "", clsHint: null, roleHint: null, src: "anonymous" });
    } else {
      var nm = cand.name.trim();
      var ckN = "name:" + nm.toLowerCase();
      if (ckN in cache) pSmi = Promise.resolve(cache[ckN]);
      else {
        var qs = nameQueries(nm);
        var exactQs = qs.filter(function (x) { return x.exact; }).slice(0, 7);
        var guessQs = qs.filter(function (x) { return !x.exact; }).slice(0, 3);
        var firstHit = function (list) {
          return list.reduce(function (p, x) {
            return p.then(function (hit) {
              if (hit) return hit;
              return sleep(220).then(function () { return lookupSmilesByName(x.q); }).then(function (found) {
                return found ? { smiles: found, q: x.q, why: x.why } : null;
              });
            });
          }, Promise.resolve(null));
        };
        pSmi = firstHit(exactQs).then(function (hit) {
          if (hit) {
            return { smiles: hit.smiles, cas: "", clsHint: null, roleHint: null, src: "pubchem_name",
                     via: hit.q.toLowerCase() !== nm.toLowerCase() ? hit.q : null };
          }
          return firstHit(guessQs).then(function (g) {
            return { smiles: "", cas: "", clsHint: null, roleHint: null, src: "unresolved",
                     suggest: g ? { smiles: g.smiles, query: g.q, why: g.why } : null };
          });
        }).then(function (r) { cache[ckN] = r; return r; });
      }
    }

    return pSmi.then(function (res) {
      if (!res.smiles) return { resolved: false, cand: cand, res: res };
      if (Ent.structureOk && Ent.structureOk(res.smiles) === false) return { resolved: false, cand: cand, res: res };
      var idc = Ent.idCode ? Ent.idCode(res.smiles) : null;
      var known = (idc && kb.byIdcode[idc]) || kb.bySmiles[res.smiles] || null;
      var finalCas = res.cas || (known && known.cas) || "";
      var finalIupac = (known && known.iupac) || "";

      var extra = Promise.resolve();
      if (!finalIupac && Ent.lookupIupac) {
        var ik = "iupac:" + res.smiles;
        if (ik in cache) finalIupac = cache[ik];
        else extra = extra.then(function () { return sleep(200); }).then(function () { return Ent.lookupIupac(res.smiles); }).then(function (n) {
          finalIupac = n || ""; cache[ik] = finalIupac;
        }, function () {});
      }
      if (!finalCas && Ent.lookupCas) {
        var ack = "pcas:" + res.smiles;
        if (ack in cache) finalCas = cache[ack];
        else extra = extra.then(function () { return sleep(200); }).then(function () { return Ent.lookupCas(res.smiles); }).then(function (list) {
          finalCas = (list && list[0]) || ""; cache[ack] = finalCas;
        }, function () {});
      }
      return extra.then(function () {
        return {
          resolved: true,
          cand: cand,
          smiles: res.smiles,
          idcode: idc,
          cas: finalCas || null,
          iupac: finalIupac || null,
          clsHint: res.clsHint || (known && known.cls) || null,
          roleHint: res.roleHint || (known && known.role) || null,
          src: res.src,
          via: res.via || null
        };
      });
    });
  }

  /* ---------- Build uniform batch rows (mirrors src/trendb/batch.py) ---------- */
  function doiSlug(doi, fallbackName) {
    if (doi && doi.indexOf("/") >= 0) {
      var s = doi.split("/", 2)[1].replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
      if (s) return s.slice(0, 60);
    }
    var fb = String(fallbackName || "pdf").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return (fb || "pdf").slice(0, 60);
  }

  function scoreAndBuildRow(item, importKey, doiOk, refEntries) {
    var cand = item.cand;
    var origName = String(cand.name || "").trim();
    var name = (item.iupac || origName || "(unnamed)").slice(0, 200);
    var structureNote = null;
    if (item.iupac && origName && origName !== "(unnamed candidate)" && item.iupac.toLowerCase() !== origName.toLowerCase()) {
      structureNote = "Paper name: " + origName + ". Automatically resolved; verify against paper.";
    } else {
      structureNote = "Automatically resolved; verify against paper.";
    }
    if (item.via) structureNote = structureNote.replace("Automatically resolved", "Found on PubChem as \u201c" + item.via + "\u201d");
    var doi = cand.doi ? EntScore.cleanDoi(cand.doi) : null;
    if (doi && !EntScore.isDoi(doi)) doi = null;
    var cas = item.cas ? EntScore.cleanCas(item.cas) : null;
    if (cas && !EntScore.casValid(cas)) cas = null;

    var same = [];
    (refEntries || []).forEach(function (ref) {
      if (!ref || !ref.smiles) return;
      var refCas = ref.cas ? EntScore.cleanCas(ref.cas) : "";
      if (cas && refCas) { if (cas !== refCas) return; }
      else if (item.idcode && ref.idcode) { if (item.idcode !== ref.idcode) return; }
      else if (ref.smiles !== item.smiles) return;
      same.push({ name: ref.name, doi: ref.doi, et_kcal: ref.et_kcal, origin: ref.origin });
    });

    var norm = EntScore.normalize({
      name: name,
      commercial_name: "",
      cas: cas || "",
      cls: cand.cls || item.clsHint || "",
      smiles: item.smiles,
      role: cand.role || item.roleHint || "acceptor",
      et: cand.raw_et != null ? cand.raw_et : cand.et_kcal,
      unit: cand.unit || "kcal",
      unc: cand.raw_unc != null ? cand.raw_unc : cand.et_unc,
      origin: cand.origin,
      kind: cand.et_type,
      tech: cand.tech || "",
      solvent: cand.solvent || "",
      temp: cand.temp || "",
      func: cand.func || "",
      basis: cand.basis || "",
      solv: cand.solv || "",
      cite: cand.citation || "",
      doi: doi || "",
      loc: cand.location || "",
      quote: cand.quote || "",
      uv_lmax: cand.uv_lmax,
      uv_eps: cand.uv_eps,
      uv_cond: cand.uv_cond || "",
      direct_exc: cand.direct_exc
    });
    var sc = EntScore.scoreEntry(norm, {
      structureOk: Ent.structureOk ? Ent.structureOk(item.smiles) : true,
      doiResolves: doi ? doiOk : null,
      same: same
    });

    return {
      import_key: importKey,
      name: name,
      commercial_name: null,
      cas: cas,
      smiles: item.smiles,
      idcode: item.idcode || (Ent.idCode ? Ent.idCode(item.smiles) : null),
      smiles_checked: false,
      structure_note: structureNote,
      cls: (cand.cls || item.clsHint || null) ? String(cand.cls || item.clsHint).slice(0, 80) : null,
      role: (cand.role || item.roleHint) === "donor" ? "donor" : (cand.role || item.roleHint) === "both" ? "both" : "acceptor",
      origin: cand.origin === "calc" ? "calc" : "exp",
      et_kcal: round1(cand.et_kcal),
      et_unc: cand.et_unc != null ? round2(cand.et_unc) : null,
      et_reported: cand.et_reported || null,
      et_type: cand.et_type || null,
      method: cand.method || null,
      conditions: cand.conditions || null,
      citation: cand.citation || null,
      doi: doi,
      location: cand.location || null,
      quote: cand.quote || null,
      evidence: cand.evidence || null,
      verify_level: cand.verify_level || "primaria",
      verify_note: cand.verify_note || null,
      uv_lmax: cand.uv_lmax != null ? cand.uv_lmax : null,
      uv_eps: cand.uv_eps != null ? cand.uv_eps : null,
      uv_cond: cand.uv_cond || null,
      direct_exc: cand.direct_exc || null,
      source_kind: "literature",
      score: sc.total,
      score_items: sc.items,
      uses: null
    };
  }
  EntPdf.scoreAndBuildRow = scoreAndBuildRow;

  EntPdf.extractFromPdfFiles = function (files, opts) {
    opts = opts || {};
    var refEntries = opts.refEntries || [];
    var kb = buildKnowledgeIndex(refEntries);
    var usedKeys = {};
    refEntries.forEach(function (r) { if (r && r.import_key) usedKeys[r.import_key] = 1; });

    var readyRows = [], reviewItems = [], skippedDuplicates = [], fileReports = [];
    var resolverCache = {}, doiResCache = {}, citeCache = {}, slugCounters = {};
    var allRefs = refEntries.slice();

    function isDuplicateOfExisting(item) {
      return allRefs.some(function (ref) {
        if (!ref || !ref.smiles) return false;
        var refCas = ref.cas ? EntScore.cleanCas(ref.cas) : "";
        var sameMol = (item.cas && refCas) ? (item.cas === refCas)
          : (item.idcode && ref.idcode) ? (item.idcode === ref.idcode)
          : (ref.smiles === item.smiles);
        if (!sameMol) return false;
        return Ent.sameValue
          ? Ent.sameValue({ origin: item.cand.origin, et_kcal: item.cand.et_kcal, doi: item.cand.doi }, ref)
          : (Math.abs(Number(item.cand.et_kcal) - Number(ref.et_kcal)) <= 0.1 && (item.cand.origin || "exp") === (ref.origin || "exp"));
      });
    }

    function nextImportKey(cand) {
      var slug = doiSlug(cand.doi, cand.pdf_file);
      var orig = cand.origin === "calc" ? "calc" : "exp";
      var keyPair = slug + "|" + orig;
      var idx = slugCounters[keyPair] || 0;
      var ik;
      do {
        idx++;
        ik = slug + ":" + orig + ":" + idx;
      } while (usedKeys[ik]);
      slugCounters[keyPair] = idx;
      usedKeys[ik] = 1;
      return ik;
    }

    var fileList = Array.prototype.slice.call(files || []);
    var total = fileList.length, cancelled = false, docs = [];
    function status(msg, done) { if (opts.onStatus) opts.onStatus(msg, done, total); }
    function failReport(name, err) {
      fileReports.push({
        file: name, error: (err && err.message) || "The PDF could not be read.", pages: 0, chars: 0, doi: null, citation: null,
        doiOk: null, extracted: 0, ready: 0, review: 0, duplicates: 0, warnings: [], ocrPages: [], isSi: false, pairedWith: null, matchedBy: ""
      });
    }

    /* Phase 1: read every file. A file that cannot be read is reported and the others go on. */
    var seenFiles = {};
    var pRead = fileList.reduce(function (p, file, fi) {
      return p.then(function () {
        if (cancelled) return;
        if (isCancelled(opts.signal)) { cancelled = true; return; }
        var fname = (file && file.name) || ("file " + (fi + 1));
        var fkey = fname + "|" + ((file && file.size) || 0);
        if (seenFiles[fkey]) return; // the same file picked twice
        seenFiles[fkey] = 1;
        status("Reading PDF " + (fi + 1) + " / " + total + ": " + fname + "…", fi);
        return EntPdf.readPdfFile(file, function (pg, tot, phase) {
          status((phase === "ocr" ? "OCR on " : "Reading ") + fname + " (page " + pg + " / " + tot + ")…", fi);
        }, { ocr: opts.ocr, ocrImages: opts.ocrImages, maxOcrPages: opts.maxOcrPages, signal: opts.signal }).then(function (doc) {
          doc.name = doc.name || fname;
          doc.pages = doc.pages || [];
          doc.warnings = doc.warnings || [];
          doc.chars = doc.pages.reduce(function (acc, pg) { return acc + countChars(pg.text); }, 0);
          if (doc.chars < 200) {
            failReport(fname, pdfError(opts.ocr === false
              ? "No text layer (scanned PDF) and OCR is switched off."
              : "No readable text, even with OCR" + (doc.warnings.length ? " (" + doc.warnings[0] + ")" : "") + ".", "no_text"));
            return;
          }
          var twin = docs.filter(function (d) {
            return d.pages.length === doc.pages.length && d.chars === doc.chars &&
              squash((d.pages[0] || {}).text).slice(0, 600) === squash((doc.pages[0] || {}).text).slice(0, 600);
          })[0];
          if (twin) {
            failReport(fname, pdfError("Same document as " + twin.name + "; read once.", "duplicate"));
            return;
          }
          docs.push(doc);
        }, function (err) {
          if (err && err.cancelled) { cancelled = true; return; }
          failReport(fname, err);
        });
      });
    }, Promise.resolve());

    /* Phase 2: pair Supporting Information with its paper; papers are processed first. */
    function processDoc(doc, di, order) {
      var paper = doc.isSi && doc.paper >= 0 ? docs[doc.paper] : null;
      var onlyPaper = docs.filter(function (d) { return !d.isSi; }).length <= 1;
      var doi = (opts.doiOverride && onlyPaper) ? EntScore.cleanDoi(opts.doiOverride) : (paper ? paper.doi : detectDoi(doc));
      if (doi && !EntScore.isDoi(doi)) doi = null;
      doc.doi = doi;
      var warnings = doc.warnings.slice();
      if (opts.doiOverride && !onlyPaper) warnings.push("DOI override ignored: it applies only when a single paper is uploaded.");
      if (doc.isSi && !paper) warnings.push("Looks like Supporting Information but no uploaded paper matches it; processed on its own.");

      var pCite = Promise.resolve(opts.citationOverride && onlyPaper ? stripUrls(opts.citationOverride) : (paper ? paper.citation : null));
      if (!(opts.citationOverride && onlyPaper) && !paper && doi) {
        if (doi in citeCache) pCite = Promise.resolve(citeCache[doi]);
        else pCite = fetchCrossrefCitation(doi).then(function (c) { citeCache[doi] = c; return c; });
      }
      var pDoiOk = Promise.resolve(null);
      if (doi) {
        if (doi in doiResCache) pDoiOk = Promise.resolve(doiResCache[doi]);
        else pDoiOk = checkDoiResolves(doi).then(function (ok) { doiResCache[doi] = ok; return ok; });
      }

      return Promise.all([pCite, pDoiOk]).then(function (metaRes) {
        var citation = metaRes[0], doiOk = metaRes[1];
        if (!citation && doc.pages.length) {
          var firstLine = (doc.pages[0].text.split(/\r?\n/).filter(function (l) { return l.trim().length > 12; })[0] || "").trim();
          citation = stripUrls(firstLine.slice(0, 200));
        }
        doc.citation = citation;
        var extOpts = { doi: doi, citation: citation, defaultRole: opts.defaultRole || "acceptor", defaultCls: opts.defaultCls || null };
        var tableHits = extractFromTables(doc, kb.byName, extOpts);
        var proseHits = extractFromProse(doc, kb.byName, kb.keys, extOpts);

        var combined = tableHits.slice(), seenHits = {};
        tableHits.forEach(function (c) { seenHits[normalizeNameKey(c.name) + "|" + c.origin + "|" + round1(c.et_kcal)] = 1; });
        proseHits.forEach(function (c) {
          var k = normalizeNameKey(c.name) + "|" + c.origin + "|" + round1(c.et_kcal);
          if (!seenHits[k]) { seenHits[k] = 1; combined.push(c); }
        });

        doc.labelDefs = labelDefinitions(doc, kb.keys);
        var defs = doc.labelDefs;
        if (paper && paper.labelDefs) {
          defs = {};
          Object.keys(paper.labelDefs).forEach(function (k) { defs[k] = paper.labelDefs[k]; });
          Object.keys(doc.labelDefs).forEach(function (k) { defs[k] = doc.labelDefs[k]; });
        }
        applyLabelDefinitions(combined, defs);

        var ocrByPage = {};
        doc.pages.forEach(function (pg) { if (pg.ocr) ocrByPage[pg.pageNum] = pg.ocr; });
        combined.forEach(function (c) {
          if (doc.isSi && !/^SI\b/.test(c.location || "")) {
            c.location = ("SI (" + doc.name + "), " + (c.location || "")).slice(0, 200);
            c.verify_note = "Extracted from Supporting Information; verify structure and values.";
          }
          var mode = ocrByPage[c.page_num];
          if (mode) {
            c.verify_note = ((c.verify_note || "") + (mode === "page"
              ? " Read by OCR from a scanned page; check every digit against the PDF."
              : " May come from a picture read by OCR; check every digit against the PDF.")).trim();
          }
        });

        var resolvedList = [];
        return combined.reduce(function (q, cand, ci) {
          return q.then(function () {
            if (isCancelled(opts.signal)) throw cancelError();
            status("Resolving " + doc.name + ": " + (ci + 1) + " / " + combined.length + " (" + cand.name + ")", order);
            return resolveCandidateOnline(cand, kb, resolverCache).then(function (res) { resolvedList.push(res); }, function () {
              resolvedList.push({ resolved: false, cand: cand, res: { smiles: "", src: "unresolved" } });
            });
          });
        }, Promise.resolve()).then(function () {
          var fReady = 0, fRev = 0, fDup = 0;
          resolvedList.forEach(function (item) {
            if (!item.resolved) {
              fRev++;
              var sg = item.res && item.res.suggest;
              if (sg && Ent.structureOk && Ent.structureOk(sg.smiles) === false) sg = null;
              reviewItems.push({
                cand: item.cand,
                reason: looksLikeAnonymousLabel(item.cand.name)
                  ? "Paper-local label without structure; draw or enter SMILES."
                  : "Could not resolve SMILES automatically; draw, paste SMILES, or search PubChem.",
                doiOk: doiOk,
                draftSmiles: sg ? sg.smiles : "",
                note: sg ? ("Not found as written. PubChem has \u201c" + sg.query + "\u201d (" + sg.why +
                  "): it may not be the same species, so check the structure before adding.") : "",
                noteIsErr: false
              });
              return;
            }
            if (isDuplicateOfExisting(item)) {
              fDup++;
              skippedDuplicates.push({
                name: item.iupac || item.cand.name,
                smiles: item.smiles,
                et_kcal: item.cand.et_kcal,
                origin: item.cand.origin,
                doi: item.cand.doi
              });
              return;
            }
            var row = scoreAndBuildRow(item, nextImportKey(item.cand), doiOk, allRefs);
            readyRows.push(row);
            allRefs.push(row);
            fReady++;
          });
          fileReports.push({
            file: doc.name,
            error: null,
            pages: doc.pages.length,
            chars: doc.chars,
            doi: doi,
            citation: citation,
            doiOk: doiOk,
            extracted: combined.length,
            ready: fReady,
            review: fRev,
            duplicates: fDup,
            warnings: warnings,
            ocrPages: doc.ocrPages || [],
            isSi: !!doc.isSi,
            pairedWith: paper ? paper.name : null,
            matchedBy: doc.matchedBy || ""
          });
        });
      });
    }

    return pRead.then(function () {
      if (opts.ocr !== false) EntPdf.terminateOcr();
      groupDocs(docs);
      var order = [];
      docs.forEach(function (d, i) { if (!d.isSi) order.push(i); });
      docs.forEach(function (d, i) { if (d.isSi) order.push(i); });
      return order.reduce(function (p, di, n) {
        return p.then(function () {
          if (cancelled) return;
          if (isCancelled(opts.signal)) { cancelled = true; return; }
          var doc = docs[di];
          status("Extracting from " + doc.name + "…", Math.min(total, n));
          return Promise.resolve().then(function () { return processDoc(doc, di, Math.min(total, n)); }).catch(function (err) {
            if (err && err.cancelled) { cancelled = true; return; }
            // Whatever goes wrong inside one paper stays inside that paper.
            failReport(doc.name, new Error("Extraction failed: " + ((err && err.message) || "unknown error")));
          });
        });
      }, Promise.resolve());
    }).then(function () {
      var okReports = fileReports.filter(function (r) { return !r.error; });
      var slug = okReports.length === 1
        ? doiSlug(okReports[0].doi, okReports[0].file)
        : ("pdf_batch_" + okReports.length + "_articles");
      return {
        slug: slug,
        cancelled: cancelled,
        readyRows: readyRows,
        reviewItems: reviewItems,
        skippedDuplicates: skippedDuplicates,
        fileReports: fileReports,
        failedFiles: fileReports.filter(function (r) { return !!r.error; }),
        resolveCandidate: function (cand, smiles, cas, iupac) {
          var idc = Ent.idCode ? Ent.idCode(smiles) : null;
          var item = { cand: cand, smiles: smiles, idcode: idc, cas: cas || null, iupac: iupac || null, clsHint: null, roleHint: null };
          var doi = cand.doi ? EntScore.cleanDoi(cand.doi) : null;
          var pOk = doi ? ((doi in doiResCache) ? Promise.resolve(doiResCache[doi]) : checkDoiResolves(doi)) : Promise.resolve(null);
          return pOk.then(function (ok) {
            var row = scoreAndBuildRow(item, nextImportKey(cand), ok, allRefs);
            allRefs.push(row);
            return row;
          });
        }
      };
    }, function (err) {
      EntPdf.terminateOcr();
      throw err;
    });
  };

  /* Expose internal extraction functions for unit tests */
  EntPdf._test = {
    buildPageFromTextItems: buildPageFromTextItems,
    parseLayoutTables: parseLayoutTables,
    extractFromTables: extractFromTables,
    extractFromProse: extractFromProse,
    detectDoi: detectDoi,
    findGutter: findGutter,
    alignedTablesFromLines: alignedTablesFromLines,
    tightenComplexFormulas: tightenComplexFormulas,
    scanComplexes: scanComplexes,
    complexKey: complexKey,
    uninvertIndexName: uninvertIndexName,
    nameQueries: nameQueries,
    labelDefinitions: labelDefinitions,
    applyLabelDefinitions: applyLabelDefinitions,
    findMoleculeSpansInSentence: findMoleculeSpansInSentence,
    extractEnergyMatchesInSentence: extractEnergyMatchesInSentence,
    pairMoleculesToMatches: pairMoleculesToMatches,
    pairWithConfidence: pairWithConfidence,
    extractFromProse: extractFromProse,
    imageRegionsFromOps: imageRegionsFromOps,
    selectOcrRegions: selectOcrRegions,
    ocrDataToItems: ocrDataToItems,
    checkPdfBytes: checkPdfBytes,
    explainPdfJsError: explainPdfJsError,
    siBaseStem: siBaseStem,
    looksLikeSi: looksLikeSi,
    groupDocs: groupDocs,
    buildKnowledgeIndex: buildKnowledgeIndex,
    formatCrossrefCitation: formatCrossrefCitation
  };
})();
