/* TrEnDB shared front-end: structure handling (OpenChemLib), search, cards, sketcher, API. */
(function () {
  "use strict";
  var Ent = window.Ent = window.Ent || {};
  var CFG = window.ENT_CONFIG || {};
  var REFS = [{ l: "Ru", v: 46.5 }, { l: "Ir", v: 55.2 }, { l: "TX", v: 63.3 }, { l: "BP", v: 68 }];
  var S_MIN = 40, S_MAX = 80;
  var svgCache = {}, molCache = {}, idxCache = {};

  var $ = Ent.$ = function (id) { return document.getElementById(id); };
  var el = Ent.el = function (tag, cls, text) {
    var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e;
  };
  /* Writes text into an element, showing "E_T" as E with a subscript T. */
  var setText = Ent.setText = function (node, text) {
    node.replaceChildren();
    String(text == null ? "" : text).split("E_T").forEach(function (part, i) {
      if (i) { node.appendChild(document.createTextNode("E")); node.appendChild(el("sub", null, "T")); }
      if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  };
  var elT = Ent.elT = function (tag, cls, text) { return setText(el(tag, cls), text); };
  var fmt = Ent.fmt = function (n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); };
  function pct(v) { return Math.max(0, Math.min(100, (v - S_MIN) / (S_MAX - S_MIN) * 100)); }
  function trimStr(v) { return v == null ? "" : String(v).trim(); }
  var displayName = Ent.displayName = function (d) {
    return (d && (trimStr(d.commercial_name) || trimStr(d.name))) || "(unnamed)";
  };
  var renderMolTitle = Ent.renderMolTitle = function (host, d, prefix) {
    var comm = d ? trimStr(d.commercial_name) : "", iupac = d ? trimStr(d.name) : "";
    var box = el("div", "card-title");
    box.appendChild(el("h2", null, (prefix || "") + (comm || iupac || "(unnamed)")));
    if (comm && iupac && comm.toLowerCase() !== iupac.toLowerCase()) {
      var sub = el("p", "iupac-sub", iupac);
      sub.title = "IUPAC name";
      box.appendChild(sub);
    }
    host.appendChild(box);
    return box;
  };

  /* ---------- OpenChemLib ---------- */
  /* The same version as the server (supabase/functions/submit), so structure codes match.
     The integrity hash makes the browser refuse a file that differs from the published one;
     a curator's session token lives in this page, so a tampered library must never run. */
  var OCL_URLS = [
    "https://cdn.jsdelivr.net/npm/openchemlib@8.19.0/dist/openchemlib-full.js",
    "https://unpkg.com/openchemlib@8.19.0/dist/openchemlib-full.js"
  ];
  var OCL_SRI = "sha256-QXEA2RW3DM6tLPYhhn9caWyk+jMJ6IllT31UYjDydSk=";
  Ent.loadOCL = function (onReady) {
    (function next(urls) {
      if (!urls.length) { var m = $("ocl-msg"); if (m) m.hidden = false; return; }
      var s = document.createElement("script"); s.src = urls[0];
      s.integrity = OCL_SRI; s.crossOrigin = "anonymous";
      s.onload = function () { if (window.OCL) onReady(); else next(urls.slice(1)); };
      s.onerror = function () { next(urls.slice(1)); };
      document.head.appendChild(s);
    })(OCL_URLS);
  };
  var molOf = Ent.molOf = function (smiles) {
    if (!window.OCL || !smiles) return null;
    if (smiles in molCache) return molCache[smiles];
    var m = null;
    try { m = OCL.Molecule.fromSmiles(smiles); if (!(m.getAllAtoms() > 0)) m = null; } catch (e) { m = null; }
    molCache[smiles] = m; return m;
  };
  var molInfo = Ent.molInfo = function (smiles) {
    if (svgCache[smiles]) return svgCache[smiles];
    var m = molOf(smiles); if (!m) return null;
    try {
      var rendered = Ent.renderStructure ? Ent.renderStructure(m, { cssThemed: true, width: 290, height: 185 }) : null;
      var svg = rendered ? rendered.svg : m.toSVG(260, 170, undefined, { suppressChiralText: true, suppressESR: true, suppressCIPParity: true, noStereoProblem: true });
      var out = { svg: svg, formula: "" };
      try { var f = m.getMolecularFormula(); out.formula = f.formula + " · " + fmt(f.relativeWeight, 2) + " g/mol"; } catch (e) {}
      svgCache[smiles] = out; return out;
    } catch (e) { return null; }
  };
  Ent.idCode = function (smiles) { var m = molOf(smiles); try { return m ? m.getIDCode() : null; } catch (e) { return null; } };
  /* true / false when the library is loaded, null when it is not */
  Ent.structureOk = function (smiles) { return window.OCL ? !!molOf(smiles) : null; };

  /* ---------- CAS numbers & IUPAC names from PubChem ---------- */
  function pubchemPost(by, endpoint, query) {
    return fetch("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/" + by + "/" + endpoint + "/JSON", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: by + "=" + encodeURIComponent(query)   /* POST: "/", "#" and "\\" break URL paths */
    }).then(function (r) {
      if (r.status === 404 || r.status === 400) return { status: r.status, json: null };   /* unknown or unreadable input */
      if (!r.ok) { var e = new Error("PubChem answered " + r.status); e.status = r.status; throw e; }
      return r.json().then(function (j) { return { status: r.status, json: j }; });
    });
  }

  function parseCasResponse(res, by) {
    if (res.status === 400) return { values: [], code: "bad_input", reason: by === "smiles" ? "PubChem could not parse SMILES (HTTP 400)" : "PubChem could not read this name (HTTP 400)" };
    if (res.status === 404) return { values: [], code: "not_found", reason: "Not found on PubChem" };
    var seen = {}, out = [];
    ((res.json && res.json.InformationList && res.json.InformationList.Information) || []).forEach(function (inf) {
      (inf.Synonym || []).forEach(function (syn) {
        var c = String(syn).trim(); if (EntScore.casValid(c) && !seen[c]) { seen[c] = 1; out.push(c); }
      });
    });
    if (!out.length) return { values: [], code: "no_cas", reason: "On PubChem, but no CAS number listed" };
    return { values: out, code: "ok", reason: "" };
  }

  function parseIupacResponse(res, by) {
    if (res.status === 400) return { value: "", code: "bad_input", reason: by === "smiles" ? "PubChem could not parse SMILES (HTTP 400)" : "PubChem could not read this name (HTTP 400)" };
    if (res.status === 404) return { value: "", code: "not_found", reason: "Not found on PubChem" };
    var p = res.json && res.json.PropertyTable && res.json.PropertyTable.Properties && res.json.PropertyTable.Properties[0];
    var name = (p && p.CID && p.IUPACName) ? String(p.IUPACName) : "";
    if (!name) return { value: "", code: "no_iupac", reason: "On PubChem, but no IUPAC name listed" };
    return { value: name, code: "ok", reason: "" };
  }

  /* Detailed CAS lookup by SMILES: resolves to { values, code, reason }. Rejects on network / HTTP 5xx / 429 errors. */
  Ent.lookupCasDetailed = function (smiles) {
    var q = String(smiles || "").trim();
    if (!q) return Promise.resolve({ values: [], code: "no_smiles", reason: "Missing SMILES" });
    return pubchemPost("smiles", "synonyms", q).then(function (res) { return parseCasResponse(res, "smiles"); });
  };

  /* Detailed CAS lookup by compound name: resolves to { values, code, reason }. */
  Ent.lookupCasByName = function (name) {
    var q = String(name || "").trim();
    if (!q) return Promise.resolve({ values: [], code: "no_name", reason: "Enter a name to look up" });
    return pubchemPost("name", "synonyms", q).then(function (res) { return parseCasResponse(res, "name"); });
  };

  /* A CAS number cannot be computed from a structure: it is looked up on PubChem, whose synonyms
     include the CAS numbers depositors gave. Resolves to the valid ones, most relevant first;
     [] when PubChem does not know the structure or lists no CAS number. Rejects on network errors. */
  Ent.lookupCas = function (smiles) {
    return Ent.lookupCasDetailed(smiles).then(function (r) { return r.values; });
  };

  /* Detailed IUPAC lookup by SMILES: resolves to { value, code, reason }. Rejects on network / HTTP 5xx / 429 errors. */
  Ent.lookupIupacDetailed = function (smiles) {
    var q = String(smiles || "").trim();
    if (!q) return Promise.resolve({ value: "", code: "no_smiles", reason: "Missing SMILES" });
    return pubchemPost("smiles", "property/IUPACName", q).then(function (res) { return parseIupacResponse(res, "smiles"); });
  };

  /* Detailed IUPAC lookup by compound name: resolves to { value, code, reason }. */
  Ent.lookupIupacByName = function (name) {
    var q = String(name || "").trim();
    if (!q) return Promise.resolve({ value: "", code: "no_name", reason: "Enter a name to look up" });
    return pubchemPost("name", "property/IUPACName", q).then(function (res) { return parseIupacResponse(res, "name"); });
  };

  /* IUPAC name of a structure from PubChem; "" when PubChem does not know it. Rejects on network errors. */
  Ent.lookupIupac = function (smiles) {
    return Ent.lookupIupacDetailed(smiles).then(function (r) { return r.value; });
  };

  function isUsefulCommercialName(val) {
    var s = String(val || "").trim();
    if (!s) return false;
    if (EntScore.casValid(EntScore.cleanCas(s))) return false;
    if (/^(?:CID\s*\d+|InChI=|[A-Z]{14}-[A-Z]{10}-[A-Z]$)/i.test(s)) return false;
    if (/^(?:DTXSID\d|CHEMBL\d|UNII-|EC\s*\d|EINECS|NSC[-\s]?\d|AKOS|MFCD\d|ZINC\d|SCHEMBL\d|BDBM\d)/i.test(s)) return false;
    return true;
  }

  function parseSynonymsList(res) {
    var seen = {}, out = [];
    ((res && res.json && res.json.InformationList && res.json.InformationList.Information) || []).forEach(function (inf) {
      (inf.Synonym || []).forEach(function (syn) {
        var s = String(syn || "").trim();
        if (!isUsefulCommercialName(s)) return;
        var k = s.toLowerCase();
        if (!seen[k]) { seen[k] = 1; out.push(s.slice(0, 200)); }
      });
    });
    return out;
  }

  /* Detailed commercial/common name lookup by CAS number via PubChem (Title, falling back to Synonyms). */
  Ent.lookupCommercialNameDetailed = function (cas) {
    var cleaned = EntScore.cleanCas(cas);
    if (!cleaned) return Promise.resolve({ value: "", synonyms: [], code: "no_cas", reason: "Missing CAS number" });
    if (!EntScore.casValid(cleaned)) return Promise.resolve({ value: "", synonyms: [], code: "bad_input", reason: "Invalid CAS number" });
    return pubchemPost("name", "property/Title", cleaned).then(function (res) {
      if (res.status === 400) return { value: "", synonyms: [], code: "bad_input", reason: "PubChem could not read this CAS (HTTP 400)" };
      if (res.status === 404) return { value: "", synonyms: [], code: "not_found", reason: "Not found on PubChem" };
      var p = res.json && res.json.PropertyTable && res.json.PropertyTable.Properties && res.json.PropertyTable.Properties[0];
      var title = (p && p.CID && p.Title) ? String(p.Title).trim() : "";
      if (isUsefulCommercialName(title)) {
        return { value: title.slice(0, 200), synonyms: [], code: "ok", reason: "" };
      }
      return pubchemPost("name", "synonyms", cleaned).then(function (synRes) {
        if (synRes.status === 400) return { value: "", synonyms: [], code: "bad_input", reason: "PubChem could not read this CAS (HTTP 400)" };
        if (synRes.status === 404) return { value: "", synonyms: [], code: "not_found", reason: "Not found on PubChem" };
        var syns = parseSynonymsList(synRes);
        if (!syns.length) return { value: "", synonyms: [], code: "no_name", reason: "On PubChem, but no commercial name listed" };
        return { value: syns[0], synonyms: syns.slice(0, 8), code: "ok", reason: "" };
      });
    });
  };

  Ent.lookupCommercialName = function (cas) {
    return Ent.lookupCommercialNameDetailed(cas).then(function (r) { return r.value; });
  };

  /* Look up PubChem synonyms for a CAS number or compound name: resolves to { values, code, reason }. */
  Ent.lookupCommercialSynonyms = function (query, by) {
    var q = String(query || "").trim();
    if (!q) return Promise.resolve({ values: [], code: "no_query", reason: "Enter a CAS number or name to look up" });
    var mode = by === "smiles" ? "smiles" : "name";
    if (mode === "name" && /^\d[\d\s–—-]*\d$/.test(q)) {
      var cleaned = EntScore.cleanCas(q);
      if (EntScore.casValid(cleaned)) q = cleaned;
    }
    return pubchemPost(mode, "synonyms", q).then(function (res) {
      if (res.status === 400) return { values: [], code: "bad_input", reason: mode === "smiles" ? "PubChem could not parse SMILES (HTTP 400)" : "PubChem could not read this query (HTTP 400)" };
      if (res.status === 404) return { values: [], code: "not_found", reason: "Not found on PubChem" };
      var syns = parseSynonymsList(res);
      if (!syns.length) return { values: [], code: "no_name", reason: "On PubChem, but no commercial name listed" };
      return { values: syns.slice(0, 8), code: "ok", reason: "" };
    });
  };

  function fpIndex(searcher, smiles) {
    if (smiles in idxCache) return idxCache[smiles];
    var m = molOf(smiles), ix = null;
    if (m) { try { ix = searcher.createIndex(m); } catch (e) { try { ix = m.getIndex(); } catch (e2) { ix = null; } } }
    idxCache[smiles] = ix; return ix;
  }
  /* -> {hits: null | {id: score}, err: ""} ; hits null means no structure query is active.
     A query that cannot be run matches nothing, so a failed search never shows (or bulk-approves) everything. */
  function structureHits(docs, ss) {
    var qs = (ss.smiles || "").trim();
    if (!qs) return { hits: null, err: "" };
    if (!window.OCL) return { hits: {}, err: "Structure search needs the structure library, which did not load." };
    var q = null;
    try { q = OCL.Molecule.fromSmiles(qs); if (!(q.getAllAtoms() > 0)) q = null; } catch (e) { q = null; }
    if (!q) return { hits: {}, err: "The query SMILES could not be read." };
    var hits = {};
    try {
      if (ss.mode === "exact") {
        var qid = q.getIDCode();
        docs.forEach(function (d) { var m = molOf(d.smiles); if (m && m.getIDCode() === qid) hits[d.id] = 1; });
      } else if (ss.mode === "sub") {
        q.setFragment(true);
        var s = new OCL.SSSearcher(); s.setFragment(q);
        docs.forEach(function (d) { var m = molOf(d.smiles); if (!m) return; s.setMolecule(m); if (s.isFragmentInMolecule()) hits[d.id] = 1; });
      } else {
        var sw = new OCL.SSSearcherWithIndex(), qi = sw.createIndex(q);
        docs.forEach(function (d) {
          var ix = fpIndex(sw, d.smiles); if (!ix) return;
          var t = OCL.SSSearcherWithIndex.getSimilarityTanimoto(qi, ix); if (t >= ss.thr) hits[d.id] = t;
        });
      }
    } catch (e) { return { hits: {}, err: "This search type is not available with the loaded structure library." }; }
    return { hits: hits, err: "" };
  }

  /* ---------- search state and controls ---------- */
  Ent.newSearch = function (sort) { return { q: "", cas: "", origin: "", role: "", cls: "", etmin: NaN, etmax: NaN, sort: sort || "added", defSort: sort || "added", ss: { smiles: "", mode: "sub", thr: 0.5 }, pager: { shown: 0 } }; };
  Ent.filterRows = function (docs, st) {
    var q = st.q.trim().toLowerCase(), r = structureHits(docs, st.ss), hits = r.hits;
    var rows = docs.filter(function (d) {
      if (st.origin && d.origin !== st.origin) return false;
      if (st.cas && String(d.cas || "").indexOf(st.cas) !== 0) return false;
      if (st.role && d.role !== st.role && d.role !== "both") return false;
      if (st.cls && (d.cls || "") !== st.cls) return false;
      if (!isNaN(st.etmin) && !(Number(d.et_kcal) >= st.etmin)) return false;
      if (!isNaN(st.etmax) && !(Number(d.et_kcal) <= st.etmax)) return false;
      if (hits && !(d.id in hits)) return false;
      if (q) { var hay = [d.name, d.commercial_name, d.cas, d.smiles, d.citation, d.cls, d.method, d.doi].join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    if (st.sort === "et-asc") rows.sort(function (a, b) { return a.et_kcal - b.et_kcal; });
    else if (st.sort === "et-desc") rows.sort(function (a, b) { return b.et_kcal - a.et_kcal; });
    else if (st.sort === "received-desc") rows.sort(function (a, b) {
      var ta = Date.parse(a.created_at || "") || 0, tb = Date.parse(b.created_at || "") || 0;
      return tb - ta || (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0);
    });
    else if (st.sort === "approvals") rows.sort(function (a, b) {
      var da = approvalsOf(b).length - approvalsOf(a).length;
      if (da) return da;
      var ds = (Number(b.score) || 0) - (Number(a.score) || 0);
      return ds || (String(a.created_at || "") < String(b.created_at || "") ? -1 : 1);
    });
    else if (st.sort === "review") rows.sort(function (a, b) {
      var d = (Number(b.score) || 0) - (Number(a.score) || 0);
      return d || (String(a.created_at || "") < String(b.created_at || "") ? -1 : 1);
    });
    else if (st.sort === "sim" && hits) rows.sort(function (a, b) { return (hits[b.id] || 0) - (hits[a.id] || 0); });
    else rows.sort(function (a, b) {
      var x = String(a.created_at || ""), y = String(b.created_at || "");
      return x < y ? -1 : x > y ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
    return { rows: rows, scores: hits || {}, searching: !!hits, err: r.err };
  };
  Ent.bindSearch = function (st, rerender) {
    var t = null;
    var render = function () { if (st.pager) st.pager.shown = 0; rerender(); };
    $("q").addEventListener("input", function (e) { st.q = e.target.value; render(); });
    $("f-origin").addEventListener("change", function (e) { st.origin = e.target.value; render(); });
    $("f-cas").addEventListener("input", function (e) { st.cas = EntScore.cleanCas(e.target.value); render(); });
    $("f-sort").addEventListener("change", function (e) { st.sort = e.target.value; render(); });
    $("f-role").addEventListener("change", function (e) { st.role = e.target.value; render(); });
    $("f-cls").addEventListener("change", function (e) { st.cls = e.target.value; render(); });
    $("f-etmin").addEventListener("input", function (e) { st.etmin = parseFloat(e.target.value); render(); });
    $("f-etmax").addEventListener("input", function (e) { st.etmax = parseFloat(e.target.value); render(); });
    $("f-reset").addEventListener("click", function () {
      var fresh = Ent.newSearch(st.defSort);
      ["q", "cas", "origin", "role", "cls", "etmin", "etmax", "sort"].forEach(function (k) { st[k] = fresh[k]; });
      st.ss.smiles = ""; st.ss.mode = fresh.ss.mode; st.ss.thr = fresh.ss.thr;
      ["q", "f-cas", "f-origin", "f-role", "f-cls", "f-etmin", "f-etmax", "ss-smiles"].forEach(function (id) { $(id).value = ""; });
      $("f-sort").value = st.sort; $("ss-mode").value = st.ss.mode; $("ss-thr").value = String(st.ss.thr); $("ss-thr").hidden = true;
      render();
    });
    $("ss-smiles").addEventListener("input", function (e) {
      clearTimeout(t); var v = e.target.value; t = setTimeout(function () { st.ss.smiles = v; render(); }, 350);
    });
    $("ss-mode").addEventListener("change", function (e) {
      st.ss.mode = e.target.value;
      if (st.ss.mode === "sim") { st.sort = "sim"; $("f-sort").value = "sim"; }
      $("ss-thr").hidden = st.ss.mode !== "sim"; render();
    });
    $("ss-thr").addEventListener("change", function (e) {
      var x = parseFloat(e.target.value); st.ss.thr = isNaN(x) ? 0.5 : Math.max(0, Math.min(1, x)); render();
    });
    $("ss-draw").addEventListener("click", function () {
      Ent.sketcher.open({
        title: "Sketcher · search query", smiles: st.ss.smiles, saveLabel: "Use as query",
        hint: "Draw the structure or fragment to search for.",
        onSave: function (s) { st.ss.smiles = s; $("ss-smiles").value = s; render(); return true; }
      });
    });
    $("ss-clear").addEventListener("click", function () { st.ss.smiles = ""; $("ss-smiles").value = ""; render(); });
  };
  /* Keeps the class menu in step with the classes present in the data, and the search
     state in step with the menu: a class that is no longer listed stops filtering. */
  var classSig = "";
  Ent.fillClasses = function (docs, st) {
    var seen = {}; docs.forEach(function (d) { if (d.cls) seen[d.cls] = 1; });
    if (st && st.cls && !seen[st.cls]) st.cls = "";
    var list = Object.keys(seen).sort(), sig = list.join("|"), sel = $("f-cls");
    if (sig !== classSig) {
      classSig = sig;
      sel.replaceChildren(new Option("All classes", ""));
      list.forEach(function (c) { sel.appendChild(new Option(c, c)); });
    }
    sel.value = st ? st.cls : (seen[sel.value] ? sel.value : "");
  };
  Ent.searchInfo = function (res, total) {
    var info = $("ss-info");
    info.className = res.err ? "err" : "hint";
    info.textContent = res.err ? res.err
      : res.rows.length < total ? res.rows.length + " of " + total + " entries match the search and filters."
      : "Exact match includes E/Z geometry; similarity is a Tanimoto score on fragment fingerprints, which ignore E/Z.";
    var badge = $("ss-active-badge");
    if (badge) badge.hidden = !res.searching;
  };

  function flashBtn(btn, label) {
    if (!btn) return;
    var orig = btn.getAttribute("data-orig") || btn.textContent;
    btn.setAttribute("data-orig", orig);
    btn.textContent = label || "Copied";
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(function () { btn.textContent = orig; }, 1400);
  }
  Ent.copyText = function (text, btn, flashLabel) {
    var val = String(text || "");
    if (!val) return;
    function flash() { flashBtn(btn, flashLabel || "Copied"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(flash, function () { fallbackCopy(val, flash); });
    } else fallbackCopy(val, flash);
  };
  function fallbackCopy(val, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = val; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) {}
  }
  function copyBtn(getVal, label) {
    var b = el("button", "btn tiny", "Copy"); b.type = "button";
    b.setAttribute("aria-label", label || "Copy value");
    b.addEventListener("click", function (e) { e.stopPropagation(); Ent.copyText(typeof getVal === "function" ? getVal() : getVal, b); });
    return b;
  }
  function safeXyzName(title) {
    var s = String(title || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    return (s ? s.slice(0, 64) : "molecule") + ".xyz";
  }
  function buildXYZ(smiles, title) {
    var smi = String(smiles || "").trim();
    if (!smi) { Ent.toast("Give a SMILES structure first."); return null; }
    if (!window.OCL || typeof Ent.molToXYZ !== "function") {
      Ent.toast("3D structure generator is still loading — try again in a moment.");
      return null;
    }
    var xyz = Ent.molToXYZ(smi, title);
    if (!xyz) { Ent.toast("Could not generate a 3D XYZ geometry for this structure."); return null; }
    return xyz;
  }
  Ent.downloadXYZ = function (smiles, title, btn) {
    var xyz = buildXYZ(smiles, title);
    if (!xyz) return false;
    var blob = new Blob([xyz], { type: "chemical/x-xyz;charset=utf-8" });
    if (Ent.downloadBlob) Ent.downloadBlob(blob, safeXyzName(title));
    else {
      var url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = safeXyzName(title); a.style.display = "none";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    flashBtn(btn, "Saved");
    return true;
  };
  function xyzBtns(getSmiles, getTitle, cls) {
    var btnCls = "btn " + (cls || "tiny");
    var dl = el("button", btnCls, "Download XYZ"); dl.type = "button";
    dl.setAttribute("aria-label", "Download 3D XYZ coordinates");
    dl.addEventListener("click", function (e) {
      e.stopPropagation();
      Ent.downloadXYZ(typeof getSmiles === "function" ? getSmiles() : getSmiles, typeof getTitle === "function" ? getTitle() : getTitle, dl);
    });
    var cp = el("button", btnCls, "Copy XYZ"); cp.type = "button";
    cp.setAttribute("aria-label", "Copy 3D XYZ coordinates to clipboard");
    cp.addEventListener("click", function (e) {
      e.stopPropagation();
      var smi = typeof getSmiles === "function" ? getSmiles() : getSmiles;
      var ttl = typeof getTitle === "function" ? getTitle() : getTitle;
      var xyz = buildXYZ(smi, ttl);
      if (xyz) Ent.copyText(xyz, cp, "Copied");
    });
    return { dl: dl, cp: cp };
  }
  function smilesAndXyzActions(smiles, title) {
    if (!smiles) return el("span", "hint", "No SMILES");
    var row = el("div", "sinfo-actions"), smiBtn = el("button", "btn tiny", "Copy SMILES");
    smiBtn.type = "button";
    smiBtn.title = "Copy SMILES: " + smiles;
    smiBtn.setAttribute("aria-label", "Copy SMILES");
    smiBtn.addEventListener("click", function (ev) { ev.stopPropagation(); Ent.copyText(smiles, smiBtn, "Copied"); });
    var btns = xyzBtns(smiles, title, "tiny");
    row.appendChild(smiBtn); row.appendChild(btns.dl); row.appendChild(btns.cp);
    return row;
  }
  var syncModalOpen = Ent.syncModalOpen = function () {
    var ed = $("ed"), sk = $("sk"), ei = $("ei-modal"), pm = $("pdf-modal");
    var open = !!((ed && !ed.hidden) || (sk && !sk.hidden) || (ei && !ei.hidden) || (pm && !pm.hidden));
    document.body.classList.toggle("modal-open", open);
  };

  var THEME_KEY = "entdb-theme", THEMES = ["auto", "light", "dark"];
  function applyTheme(t, btn) {
    if (THEMES.indexOf(t) < 0) t = "auto";
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    if (btn) btn.textContent = "Theme: " + t.charAt(0).toUpperCase() + t.slice(1);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  Ent.initTheme = function (btnId) {
    var btn = $(btnId);
    var saved = "auto";
    try { saved = localStorage.getItem(THEME_KEY) || "auto"; } catch (e) {}
    applyTheme(saved, btn);
    if (btn) btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") || "auto";
      applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length], btn);
    });
  };

  Ent.toast = function (msg, opts) {
    opts = opts || {};
    var host = $("toast-host"); if (!host) return;
    while (host.children.length >= 3) host.firstElementChild.remove();
    var node = el("div", "toast");
    node.appendChild(el("span", "grow", msg));
    var timer = null;
    function close() { clearTimeout(timer); node.remove(); }
    if (opts.actionLabel && opts.onAction) {
      var act = el("button", "btn tiny", opts.actionLabel); act.type = "button";
      act.addEventListener("click", function () { act.disabled = true; Promise.resolve(opts.onAction()).finally(close); });
      node.appendChild(act);
    }
    var x = el("button", "toast-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", close);
    node.appendChild(x);
    host.appendChild(node);
    timer = setTimeout(close, opts.timeoutMs || 7000);
  };

  /* ---------- cards ---------- */
  function link(text, href) { var a = el("a", null, text); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; }
  /* Sources are linked only through doi.org, and only when the value is a DOI. */
  var doiLink = Ent.doiLink = function (doi, text) {
    var d = EntScore.cleanDoi(doi);
    return EntScore.isDoi(d) ? link(text || ("DOI " + d), "https://doi.org/" + encodeURI(d)) : el("span", null, String(doi || ""));
  };
  function row(dl, k, v) {
    if (!v) return;
    dl.appendChild(elT("dt", null, k)); var dd = el("dd");
    if (typeof v === "string") setText(dd, v); else dd.appendChild(v);
    dl.appendChild(dd);
  }
  function callout(text, quoted) {
    /* only the verbatim line looks like a quotation; the paraphrase is ordinary text */
    var box = el("span", quoted ? "quote-callout" : "evidence-note");
    if (quoted) box.appendChild(el("q", null, text));
    else setText(box, text);
    return box;
  }
  /* "SI, p. S14" / "Table S3" -> si; any other location -> article; no location -> null */
  Ent.sourceKind = function (location) {
    var loc = String(location || "").trim();
    if (!loc) return null;
    return (/^(SI|ESI)\b/i.test(loc) || /^Suppl|^Supporting/i.test(loc) || /\bS-?\d+\b/.test(loc)) ? "si" : "article";
  };
  function sourceChip(d) {
    var kind = Ent.sourceKind(d.location);
    if (!kind) return null;
    var chip = el("span", "chip plain", kind === "si" ? "SI" : "Article");
    chip.title = kind === "si" ? "Value taken from the Supporting Information" : "Value taken from the article";
    return chip;
  }
  function paperExcerptRows(dl, d) {
    row(dl, "Where", d.location);
    if (d.quote) row(dl, "Verbatim", callout(d.quote, true));
    if (d.evidence) row(dl, "What it says", callout(d.evidence, false));
  }
  /* one entry, or several values of the same molecule (green filled: experimental; purple hollow: computed) */
  function scale(list) {
    list = Array.isArray(list) ? list : [list];
    var s = el("div", "scale"); s.appendChild(el("div", "track"));
    REFS.forEach(function (r) {
      var t = el("div", "ref"); t.style.left = pct(r.v) + "%"; s.appendChild(t);
      var l = el("div", "lab", r.l); l.style.left = pct(r.v) + "%"; s.appendChild(l);
    });
    list.forEach(function (d) {
      if (d.et_unc) {
        var b = el("div", "band " + (d.origin === "calc" ? "calc" : "exp")), a = pct(d.et_kcal - d.et_unc), z = pct(Number(d.et_kcal) + Number(d.et_unc));
        b.style.left = a + "%"; b.style.width = (z - a) + "%"; s.appendChild(b);
      }
    });
    list.forEach(function (d) {
      var m = el("div", "mark " + (d.origin === "calc" ? "calc" : "exp")); m.style.left = pct(d.et_kcal) + "%"; s.appendChild(m);
    });
    var e0 = el("div", "end", String(S_MIN)); e0.style.left = "0"; s.appendChild(e0);
    var e1 = el("div", "end", String(S_MAX)); e1.style.right = "0"; s.appendChild(e1);
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", "Triplet energy " + list.map(function (d) { return d.et_kcal; }).join(", ") + " kcal/mol on a 40 to 80 scale");
    return s;
  }
  function scoreDetails(d) {
    var g = EntScore.gradeOf(d.score);
    if (!Array.isArray(d.score_items) || !d.score_items.length) {
      return el("span", "chip " + g.cls, "Score " + d.score + " · " + g.label);
    }
    var det = el("details", "score-details");
    var sum = el("summary", "chip " + g.cls, "Score " + d.score + " · " + g.label + " ▾");
    sum.title = "Show scoring breakdown";
    det.appendChild(sum);
    var pop = el("div", "score-pop"), ul = el("ul");
    d.score_items.forEach(function (item) {
      var cls = item.edited ? "" : item.got >= item.max ? "full" : item.got === 0 ? "zero" : "";
      var li = el("li", cls);
      li.appendChild(el("span", "pts", item.edited ? "Edit" : (item.got + "/" + item.max)));
      var txt = elT("span", null, item.label);
      if (item.note) txt.appendChild(elT("small", null, item.note));
      li.appendChild(txt);
      ul.appendChild(li);
    });
    pop.appendChild(ul); det.appendChild(pop);
    return det;
  }

  function inlineCasLookup(d, adm, busy) {
    var wrap = el("div", "cas-inline");
    wrap.appendChild(el("span", "hint", "No CAS"));
    var btn = el("button", "btn tiny", "Lookup CAS"); btn.type = "button"; btn.disabled = busy;
    var status = el("span", "hint"); status.setAttribute("aria-live", "polite");
    var picks = el("span", "chip-group");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      btn.disabled = true; status.textContent = "Asking PubChem…"; picks.replaceChildren();
      Ent.lookupCas(d.smiles).then(function (list) {
        btn.disabled = false;
        if (!list.length) { status.textContent = "Not on PubChem"; return; }
        status.textContent = "Found:";
        list.slice(0, 3).forEach(function (cas, idx) {
          var apply = el("button", "btn tiny" + (idx === 0 ? " primary" : ""), "Use " + cas);
          apply.type = "button";
          apply.addEventListener("click", function (ev) {
            ev.stopPropagation();
            apply.disabled = true; status.textContent = "Saving…";
            adm.onPatch(d.id, { cas: cas });
          });
          picks.appendChild(apply);
        });
      }, function () { btn.disabled = false; status.textContent = "PubChem unavailable"; });
    });
    wrap.appendChild(btn); wrap.appendChild(status); wrap.appendChild(picks);
    return wrap;
  }

  function bindPaperPreview(paper, getCardData) {
    if (!Ent.cardGraphic) return;
    paper.classList.add("paper-interactive");
    paper.setAttribute("role", "button");
    paper.setAttribute("tabindex", "0");
    paper.setAttribute("aria-label", "View molecule card graphic");
    paper.title = "Click for slide/paper molecule card graphic";
    function openGfx(ev) { ev.stopPropagation(); Ent.cardGraphic.open(getCardData()); }
    paper.addEventListener("click", openGfx);
    paper.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openGfx(ev); }
    });
  }

  function approvalsOf(d) {
    var list = d && Array.isArray(d.approvals) ? d.approvals : [];
    var seen = {}, out = [];
    list.forEach(function (a) {
      var em = a && a.email ? String(a.email).trim().toLowerCase() : "";
      if (!em || seen[em]) return;
      seen[em] = 1;
      out.push({ email: em, at: a.at || "" });
    });
    return out;
  }
  Ent.approvalsOf = approvalsOf;
  Ent.approvalState = function (d, myEmail) {
    var list = approvalsOf(d);
    var me = String(myEmail || "").trim().toLowerCase();
    var byMe = !!me && list.some(function (a) { return a.email === me; });
    var byOthers = list.filter(function (a) { return a.email !== me; });
    return { list: list, count: list.length, byMe: byMe, byOthers: byOthers, needed: Math.max(0, 2 - list.length) };
  };
  function fmtApprovalDate(iso) {
    if (!iso) return "";
    var t = Date.parse(iso);
    return isNaN(t) ? "" : new Date(t).toLocaleString();
  }
  function approvalNoteBox(ap, status, kindLabel) {
    if (!ap.count) return null;
    if (status === "pending") {
      var box = el("div", "approval-note " + (ap.byMe ? "mine" : "ready"));
      if (ap.byMe) {
        var mineAt = "";
        ap.list.forEach(function (a) { if (a.email && !ap.byOthers.some(function (o) { return o.email === a.email; })) mineAt = fmtApprovalDate(a.at); });
        box.appendChild(el("p", null, "Verified by you (1/2)" + (mineAt ? " on " + mineAt : "") + " — awaiting a second curator to accept this " + (kindLabel || "value") + "."));
      } else {
        var who = ap.byOthers.map(function (a) {
          var dt = fmtApprovalDate(a.at);
          return a.email + (dt ? " (" + dt + ")" : "");
        }).join(", ");
        box.appendChild(el("p", null, "Verified (1/2) by " + who + " — your confirmation will accept this " + (kindLabel || "value") + "."));
      }
      return box;
    }
    if (status === "approved" && ap.count >= 2) {
      var abox = el("div", "approval-note done");
      abox.appendChild(el("p", null, "Verified (" + ap.count + "/2) by " + ap.list.map(function (a) { return a.email; }).join(" and ") + "."));
      return abox;
    }
    return null;
  }

  /* o.scores, o.simMode, o.dup = Ent.duplicates result, o.clusterTag, o.onSuggest(d),
     o.admin = {email, busy, drafts, activeId, onFocusCard, onPatch(id, patch) -> Promise<bool>, approve(d, note), reject(d, note), revoke(d, note), selected, onSelect, onDelete} */
  Ent.card = function (d, o) {
    o = o || {}; var adm = o.admin || null, dup = o.dup || null;
    var ap = adm ? Ent.approvalState(d, adm.email) : null;
    var cls = "card" + (dup && dup.flag ? " dup" : "") + (adm && adm.activeId === d.id ? " kb-focus" : "");
    var c = el("article", cls), head = el("div", "head");
    c.setAttribute("data-id", d.id);
    if (adm && adm.onFocusCard) {
      c.addEventListener("click", function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest("a,button,input,textarea,select,summary,label,.paper-interactive")) return;
        adm.onFocusCard(d.id);
      });
    }
    if (adm && (adm.selected || d.created_at || d.submitted_by)) {
      var top = el("div", "card-top");
      if (adm.selected) {
        var pick = el("label", "selpick"), selBox = el("input"), card = c; selBox.type = "checkbox"; selBox.checked = !!adm.selected[d.id];
        if (selBox.checked) card.classList.add("picked");
        selBox.addEventListener("change", function () { adm.onSelect(d.id, selBox.checked); card.classList.toggle("picked", selBox.checked); });
        pick.appendChild(selBox); pick.appendChild(document.createTextNode("Select")); top.appendChild(pick);
      }
      var metaParts = [];
      if (d.source_kind === "form") metaParts.push("Form submission"); else if (d.source_kind) metaParts.push(d.source_kind);
      if (d.submitted_by) metaParts.push(d.submitted_by);
      if (d.created_at) metaParts.push(new Date(d.created_at).toLocaleDateString());
      if (metaParts.length) {
        var mt = el("span", "card-meta-top", metaParts.join(" · "));
        if (d.created_at) mt.title = new Date(d.created_at).toLocaleString();
        top.appendChild(mt);
      }
      head.appendChild(top);
    }
    if (o.clusterTag) head.appendChild(el("span", "cluster-tag", o.clusterTag));
    renderMolTitle(head, d);

    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip", d.role === "donor" ? "Donor" : d.role === "both" ? "Donor and acceptor" : "Acceptor"));
    chips.appendChild(el("span", "chip " + (d.origin === "calc" ? "calc" : "exp"), d.origin === "calc" ? "Computed" : "Experimental"));
    var srcChip = sourceChip(d); if (srcChip) chips.appendChild(srcChip);
    if (d.cls) chips.appendChild(el("span", "chip plain", d.cls));
    if (o.simMode && o.scores && o.scores[d.id] != null) chips.appendChild(el("span", "chip", "Similarity " + fmt(o.scores[d.id], 2)));
    if (d.score != null) chips.appendChild(scoreDetails(d));
    if (d.verify_level === "abstract") chips.appendChild(el("span", "chip warn", "Abstract only"));
    if (d.verify_level === "secondaria") chips.appendChild(el("span", "chip warn", "Source to verify"));
    if (adm && !d.smiles_checked) chips.appendChild(el("span", "chip warn", "Structure unchecked"));
    if (adm && ap && d.status === "pending" && ap.count >= 1) {
      chips.appendChild(el("span", "chip " + (ap.byMe ? "verify1-me" : "verify1-other"), ap.byMe ? "1/2 verified · by you" : "1/2 verified · needs 2nd check"));
    } else if (adm && ap && d.status === "approved" && ap.count >= 2) {
      var vchip = el("span", "chip verify2", ap.count + "/2 verified");
      vchip.title = ap.list.map(function (a) { return a.email; }).join(", ");
      chips.appendChild(vchip);
    }
    if (dup && dup.flag) chips.appendChild(el("span", "chip dupchip", dup.dbSame.length ? "Possible duplicate" : "Same value also in the queue"));
    else if (dup && dup.db.length) chips.appendChild(el("span", "chip plain", "New value for a known molecule"));
    head.appendChild(chips); c.appendChild(head);
    if (adm && ap) {
      var apBox = approvalNoteBox(ap, d.status, "value");
      if (apBox) c.appendChild(apBox);
    }
    if (dup && (dup.db.length || dup.queue.length || dup.stereo.length)) c.appendChild(dupNote(dup));

    var etVal = Number(d.et_kcal);
    var et = el("div", "et " + (d.origin === "calc" ? "calc" : "exp"));
    et.appendChild(el("span", "v", fmt(etVal, 1) + (d.et_unc ? " ± " + d.et_unc : "")));
    et.appendChild(el("span", "u", "kcal/mol"));
    et.appendChild(el("span", "alt", fmt(d.et_kcal * 4.184, 0) + " kJ/mol · " + fmt(d.et_kcal / 23.0605, 2) + " eV"));
    if (isFinite(etVal) && (etVal < S_MIN || etVal > S_MAX)) {
      et.appendChild(el("span", "chip warn", etVal < S_MIN ? "Off scale (<40)" : "Off scale (>80)"));
    }
    c.appendChild(et); c.appendChild(scale(d));

    var st = el("div", "struct"), paper = el("div", "paper"), info = molInfo(d.smiles);
    if (info) {
      paper.innerHTML = info.svg;
      bindPaperPreview(paper, function () {
        return {
          name: d.name, commercial_name: d.commercial_name, smiles: d.smiles, role: d.role, origin: d.origin, cls: d.cls,
          cas: d.cas, et_kcal: d.et_kcal, et_unc: d.et_unc, formula: info.formula,
          method: d.method, conditions: d.conditions, citation: d.citation, doi: d.doi
        };
      });
    } else paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available";
    st.appendChild(paper);
    var si = el("div", "sinfo"), busy = adm && !!adm.busy[d.id];
    if (d.cas) {
      var casRow = el("div", "copy-row");
      casRow.appendChild(el("span", "formula", "CAS " + d.cas));
      casRow.appendChild(copyBtn(d.cas, "Copy CAS number"));
      si.appendChild(casRow);
    } else if (adm && d.smiles) {
      si.appendChild(inlineCasLookup(d, adm, busy));
    }
    si.appendChild(smilesAndXyzActions(d.smiles, displayName(d)));
    if (info && info.formula) si.appendChild(el("span", "formula", info.formula));
    if (d.structure_note) si.appendChild(el("span", "hint", d.structure_note));
    if (adm) {
      var saRow = el("div", "sinfo-actions");
      var ob = el("button", "btn small", "Open in sketcher"); ob.type = "button"; ob.disabled = busy;
      ob.addEventListener("click", function () {
        Ent.sketcher.open({
          title: "Sketcher · " + displayName(d), smiles: d.smiles || "", saveLabel: "Save structure",
          hint: "Edit the drawing or the SMILES, then save. Saving marks the structure as verified.",
          onSave: function (s) { return adm.onPatch(d.id, { smiles: s, idcode: Ent.idCode(s), smiles_checked: true }); }
        });
      });
      saRow.appendChild(ob);
      var lab = el("label", "check"), cb = el("input"), chkMsg = el("span", "hint");
      cb.type = "checkbox"; cb.id = "chk-" + d.id; cb.checked = !!d.smiles_checked; cb.disabled = busy;
      chkMsg.setAttribute("aria-live", "polite");
      cb.addEventListener("change", function () {
        chkMsg.textContent = "Saving…";
        adm.onPatch(d.id, { smiles_checked: cb.checked }).then(function (ok) { if (!ok) chkMsg.textContent = ""; });
      });
      lab.appendChild(cb); lab.appendChild(document.createTextNode("Structure verified"));
      saRow.appendChild(lab); saRow.appendChild(chkMsg);
      si.appendChild(saRow);
    }
    st.appendChild(si); c.appendChild(st);

    var dl = el("dl");
    row(dl, "Reported value", d.et_reported);
    row(dl, "Value type", d.et_type);
    row(dl, "Method", d.method);
    row(dl, "Conditions", d.conditions);
    row(dl, "Source", d.citation);
    paperExcerptRows(dl, d);
    if (d.doi) {
      var doiRow = el("div", "copy-row"), dw = el("span", "doi-wrap");
      dw.appendChild(doiLink(d.doi, d.doi)); doiRow.appendChild(dw);
      doiRow.appendChild(copyBtn(EntScore.cleanDoi(d.doi) || d.doi, "Copy DOI"));
      row(dl, "DOI", doiRow);
    }
    if (d.verify_note) {
      var vn = el("span", (d.verify_level === "abstract" || d.verify_level === "secondaria") ? "verify-callout" : null, d.verify_note);
      row(dl, "Verification", vn);
    }
    var uvTxt = EntScore.formatUv(d), dirTxt = EntScore.formatDirectExc(d.direct_exc);
    if (uvTxt) row(dl, "UV-vis", uvTxt);
    if (dirTxt) row(dl, "Direct excitation", dirTxt);
    c.appendChild(dl);

    var usesList = Array.isArray(d.uses) ? d.uses.filter(function (u) { return u && u.doi; }) : [];
    if (usesList.length) {
      var ul = el("ul", "uses");
      usesList.forEach(function (u) {
        var li = el("li"); li.appendChild(doiLink(u.doi, "doi:" + EntScore.cleanDoi(u.doi)));
        if (u.note) li.appendChild(document.createTextNode(" · " + u.note));
        ul.appendChild(li);
      });
      c.appendChild(el("p", "hint", "Used in photocatalysis")); c.appendChild(ul);
    }
    var rxList = Array.isArray(d.reactions) ? d.reactions : [];
    if (rxList.length && Ent.reactionsAdminList && adm && adm.onPatch) {
      var rxa = Ent.reactionsAdminList({
        list: rxList, substrate: d.smiles, name: displayName(d), busy: adm.busy && adm.busy[d.id],
        open: d.status === "pending",
        label: d.status === "pending" ? "check them before approving" : "",
        save: function (next) { return Promise.resolve(adm.onPatch(d.id, { reactions: next.length ? next : null })).then(function (r) { return r !== false; }); }
      });
      if (rxa) c.appendChild(rxa);
    } else if (rxList.length && Ent.reactionsSection) {
      var rxs = Ent.reactionsSection(rxList.map(function (rx) { return { rx: rx, substrate: d.smiles }; }), displayName(d));
      if (rxs) c.appendChild(rxs);
    }

    if (o.onSuggest) {
      var sa = el("div", "actions"), sb = el("button", "btn small", "Suggest a correction"); sb.type = "button";
      sb.addEventListener("click", function () { o.onSuggest(d); });
      sa.appendChild(sb); c.appendChild(sa);
    }

    if (adm) {
      var curNote = adm.drafts[d.id] != null ? adm.drafts[d.id] : (d.note || "");
      var f = el("label", "field", "Curator note (optional)"), ni = el("input");
      ni.id = "note-" + d.id; ni.type = "text"; ni.value = curNote; ni.placeholder = "Reason or context for this decision…";
      ni.addEventListener("input", function () { adm.drafts[d.id] = ni.value; });
      f.appendChild(ni);
      var noteBtn = el("button", "btn tiny ghost note-toggle", "+ Add note"); noteBtn.type = "button";
      f.hidden = !curNote; noteBtn.hidden = !!curNote;
      noteBtn.addEventListener("click", function () { noteBtn.hidden = true; f.hidden = false; ni.focus(); });
      c.appendChild(noteBtn); c.appendChild(f);

      var act = el("div", "actions");
      var decide = function (label, clsName, status, actName, disabledExtra) {
        var b = el("button", "btn " + clsName, label); b.type = "button"; b.disabled = busy || !!disabledExtra;
        if (actName) b.setAttribute("data-act", actName);
        b.addEventListener("click", function () {
          var done = function (ok) { if (ok) delete adm.drafts[d.id]; };
          if (status === "approved" && adm.approve) { Promise.resolve(adm.approve(d, ni.value || "")).then(done); return; }
          if (status === "rejected" && adm.reject) { Promise.resolve(adm.reject(d, ni.value || "")).then(done); return; }
          adm.onPatch(d.id, { status: status, decided_at: status === "pending" ? null : new Date().toISOString(), note: ni.value || "" }).then(done);
        });
        act.appendChild(b);
      };
      var eb = el("button", "btn", "Edit entry"); eb.type = "button"; eb.disabled = busy;
      eb.addEventListener("click", function () { Ent.editor.open(d, function (patch) { return adm.onPatch(d.id, patch); }); });
      if (d.status === "pending") {
        if (ap && ap.byMe) {
          decide("Verified by you (" + ap.count + "/2)", "primary", "approved", "approve", true);
          if (adm.revoke) {
            var rb = el("button", "btn", "Withdraw verification"); rb.type = "button"; rb.disabled = busy;
            rb.setAttribute("data-act", "revoke");
            rb.addEventListener("click", function () {
              Promise.resolve(adm.revoke(d, ni.value || "")).then(function (ok) { if (ok) delete adm.drafts[d.id]; });
            });
            act.appendChild(rb);
          }
        } else {
          decide(ap && ap.count >= 1 ? "Approve (2/2)" : "Verify (1/2)", "primary", "approved", "approve");
        }
        decide("Reject", "reject", "rejected", "reject");
      } else {
        decide("Back to queue", "", "pending");
        if (d.status === "approved") decide("Reject", "reject", "rejected", "reject");
        else decide("Verify (1/2)", "primary", "approved", "approve");
      }
      act.appendChild(eb);
      if (d.status === "rejected" && adm.onDelete) {
        var db = el("button", "btn danger", "Delete permanently"); db.type = "button"; db.disabled = busy;
        db.addEventListener("click", function () { adm.onDelete([d]); });
        act.appendChild(db);
      }
      c.appendChild(act);
      if (adm.busy[d.id] === "err") c.appendChild(el("p", "err", "Could not save. Try again."));
    }
    return c;
  };

  /* ---------- one card per molecule (public page) ----------
     Entries are grouped by CAS number, then by structure code (which keeps E/Z and R/S apart),
     then by identical SMILES. Two entries with different CAS numbers are never grouped. */
  Ent.groupByMolecule = function (rows) {
    var groups = [], byKey = {};
    function fits(g, k) { return g && !(k.cas && g.cas && g.cas !== k.cas); }
    rows.forEach(function (d) {
      var k = keysOf(d), g = null;
      if (k.cas) g = byKey["cas:" + k.cas] || null;
      if (!g && k.id && fits(byKey["id:" + k.id], k)) g = byKey["id:" + k.id];
      if (!g && k.smi && fits(byKey["smi:" + k.smi], k)) g = byKey["smi:" + k.smi];
      if (!g) { g = { cas: "", items: [] }; groups.push(g); }
      g.items.push(d); if (k.cas && !g.cas) g.cas = k.cas;
      if (k.cas) byKey["cas:" + k.cas] = g;
      if (k.id) byKey["id:" + k.id] = g;
      if (k.smi) byKey["smi:" + k.smi] = g;
    });
    /* rows arrive sorted, so each group sits where its first value would: the order of the list is kept */
    return groups.map(function (g) { return g.items; });
  };
  function byQuality(a, b) {
    var oa = a.origin === "calc" ? 1 : 0, ob = b.origin === "calc" ? 1 : 0;
    if (oa !== ob) return oa - ob;
    return (Number(b.score) || 0) - (Number(a.score) || 0);
  }
  function valueBlock(d, o, many) {
    var v = el("section", "val");
    var top = el("div", "valtop");
    var etVal = Number(d.et_kcal);
    var et = el("div", "et " + (d.origin === "calc" ? "calc" : "exp"));
    et.appendChild(el("span", "v", fmt(etVal, 1) + (d.et_unc ? " ± " + d.et_unc : "")));
    et.appendChild(el("span", "u", "kcal/mol"));
    et.appendChild(el("span", "alt", fmt(d.et_kcal * 4.184, 0) + " kJ/mol · " + fmt(d.et_kcal / 23.0605, 2) + " eV"));
    if (isFinite(etVal) && (etVal < S_MIN || etVal > S_MAX)) {
      et.appendChild(el("span", "chip warn", etVal < S_MIN ? "Off scale (<40)" : "Off scale (>80)"));
    }
    top.appendChild(et);
    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip " + (d.origin === "calc" ? "calc" : "exp"), d.origin === "calc" ? "Computed" : "Experimental"));
    var srcChip = sourceChip(d); if (srcChip) chips.appendChild(srcChip);
    if (d.score != null) chips.appendChild(scoreDetails(d));
    top.appendChild(chips); v.appendChild(top);
    if (!many) v.appendChild(scale(d));
    var dl = el("dl");
    row(dl, "Reported value", d.et_reported);
    row(dl, "Value type", d.et_type);
    row(dl, "Method", d.method);
    row(dl, "Conditions", d.conditions);
    row(dl, "Source", d.citation);
    if (d.doi) {
      var doiRow = el("div", "copy-row"), dw = el("span", "doi-wrap");
      dw.appendChild(doiLink(d.doi, d.doi)); doiRow.appendChild(dw);
      doiRow.appendChild(copyBtn(EntScore.cleanDoi(d.doi) || d.doi, "Copy DOI"));
      row(dl, "DOI", doiRow);
    }
    v.appendChild(dl);
    if (d.location || d.quote || d.evidence) {
      var det = el("details", "paper-details");
      det.appendChild(el("summary", null, "Paper details"));
      var pdl = el("dl");
      paperExcerptRows(pdl, d);
      det.appendChild(pdl);
      v.appendChild(det);
    }
    if (o.onSuggest) {
      var sa = el("div", "actions"), sb = el("button", "btn small", many ? "Suggest a correction to this value" : "Suggest a correction"); sb.type = "button";
      sb.addEventListener("click", function () { o.onSuggest(d); });
      sa.appendChild(sb); v.appendChild(sa);
    }
    return v;
  }
  Ent.slideItemKey = function (items) {
    var arr = Array.isArray(items) ? items : [items];
    for (var i = 0; i < arr.length; i++) {
      var k = keysOf(arr[i]);
      if (k.cas) return "cas:" + k.cas;
      if (k.id) return "id:" + k.id;
      if (k.smi) return "smi:" + k.smi;
    }
    return "row:" + String((arr[0] && (arr[0].id || arr[0].name)) || "");
  };
  Ent.slideItemFromGroup = function (items) {
    var sorted = (Array.isArray(items) ? items : [items]).slice().sort(byQuality);
    var p = sorted[0], roles = {}, vals = [];
    sorted.forEach(function (d) {
      roles[d.role || "acceptor"] = 1;
      if (isFinite(Number(d.et_kcal))) vals.push(Number(d.et_kcal));
    });
    var role = roles.both || (roles.donor && roles.acceptor) ? "both" : roles.donor ? "donor" : "acceptor";
    var comm = sorted.map(function (d) { return trimStr(d.commercial_name); }).filter(Boolean)[0] || "";
    var iupac = trimStr(p.name) || sorted.map(function (d) { return trimStr(d.name); }).filter(Boolean)[0] || "";
    return {
      key: Ent.slideItemKey(sorted), name: iupac, commercial_name: comm, smiles: p.smiles, role: role,
      et_kcal: Number(p.et_kcal),
      et_min: vals.length ? Math.min.apply(null, vals) : Number(p.et_kcal),
      et_max: vals.length ? Math.max.apply(null, vals) : Number(p.et_kcal),
      cls: sorted.map(function (d) { return d.cls; }).filter(Boolean)[0] || ""
    };
  };

  /* what every view of one molecule shows: the best value first, names, role, class, CAS */
  function groupSummary(items) {
    items = items.slice().sort(byQuality);
    var p = items[0], roles = {};
    items.forEach(function (d) { roles[d.role || "acceptor"] = 1; });
    return {
      items: items, p: p, many: items.length > 1, key: Ent.slideItemKey(items),
      comm: items.map(function (d) { return trimStr(d.commercial_name); }).filter(Boolean)[0] || "",
      iupac: trimStr(p.name) || items.map(function (d) { return trimStr(d.name); }).filter(Boolean)[0] || "",
      role: roles.both || (roles.donor && roles.acceptor) ? "both" : roles.donor ? "donor" : "acceptor",
      cls: items.map(function (d) { return d.cls; }).filter(Boolean)[0] || "",
      cas: items.map(function (d) { return d.cas; }).filter(Boolean)[0] || ""
    };
  }
  function roleLabel(role) { return role === "donor" ? "Donor" : role === "both" ? "Donor and acceptor" : "Acceptor"; }
  function bestSimilarity(items, o) {
    if (!o.simMode || !o.scores) return null;
    var best = null; items.forEach(function (d) { var x = o.scores[d.id]; if (x != null && (best == null || x > best)) best = x; });
    return best;
  }
  function slidePickBtn(items, o, picked) {
    var pickBtn = el("button", "chip slide-pick", picked ? "✓ Slide" : "+ Slide");
    pickBtn.type = "button";
    pickBtn.setAttribute("aria-pressed", String(picked));
    pickBtn.title = "Select multiple molecules to compare in one E_T slide";
    pickBtn.addEventListener("click", function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      o.onSlideToggle(Ent.slideItemFromGroup(items));
    });
    return pickBtn;
  }

  /* the address of a molecule's own page: the same key the slide selection uses */
  Ent.moleculeKey = function (items) { return groupSummary(items).key; };
  Ent.moleculeHref = function (items) { return "#mol/" + encodeURIComponent(Ent.moleculeKey(items)); };
  /* -> every value of the molecule a key names, or null. Any value of the group may carry the key,
     so the page is found whatever order the values arrive in. */
  Ent.findMolecule = function (docs, key) {
    var m = /^(cas|id|smi):([\s\S]*)$/.exec(String(key || ""));
    if (!m || !m[2]) return null;
    var kind = m[1], val = m[2];
    var groups = Ent.groupByMolecule(docs);
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].some(function (d) { return keysOf(d)[kind] === val; })) return groups[i];
    }
    return null;
  };

  /* The list shows one summary card per molecule: structure, every E_T value as a tick on the
     40–80 scale (filled green: experimental; hollow purple: computed) and the best value's source.
     The whole card links to the molecule's own page, where Ent.moleculeCard shows everything.
     o = {scores, simMode, isSlidePicked(key), onSlideToggle(item)} */
  Ent.moleculeSummary = function (items, o) {
    o = o || {};
    var g = groupSummary(items), p = g.p;
    items = g.items;
    var picked = o.isSlidePicked ? !!o.isSlidePicked(g.key) : false;
    var c = el("article", "card mol mol-sum" + (picked ? " mol-picked" : "")), head = el("div", "head");

    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip", roleLabel(g.role)));
    var hasExp = items.some(function (d) { return d.origin !== "calc"; });
    var hasCalc = items.some(function (d) { return d.origin === "calc"; });
    chips.appendChild(el("span", "chip " + (hasExp ? "exp" : "calc"), hasExp && hasCalc ? "Experimental and computed" : hasExp ? "Experimental" : "Computed"));
    if (g.cls) chips.appendChild(el("span", "chip plain", g.cls));
    if (g.many) chips.appendChild(el("span", "chip plain", items.length + " values"));
    var sim = bestSimilarity(items, o);
    if (sim != null) chips.appendChild(el("span", "chip", "Similarity " + fmt(sim, 2)));
    if (o.onSlideToggle && Ent.slideGraphic) chips.appendChild(slidePickBtn(items, o, picked));
    head.appendChild(chips);

    var title = renderMolTitle(head, { name: g.iupac, commercial_name: g.comm }), h2 = title.querySelector("h2");
    var link = el("a", "mol-link", h2.textContent);
    link.href = Ent.moleculeHref(items);
    link.title = "Open the full card";
    h2.replaceChildren(link);
    c.appendChild(head);

    var body = el("div", "sum-body");
    var paper = el("div", "paper"), info = molInfo(p.smiles);
    if (info) paper.innerHTML = info.svg;
    else paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available";
    body.appendChild(paper);

    var panel = el("div", "sum-et");
    panel.appendChild(elT("p", "sum-lab", "Triplet energy (E_T)"));
    var vals = items.map(function (d) { return Number(d.et_kcal); }).filter(isFinite);
    var et = el("div", "et" + (hasExp && !hasCalc ? " exp" : !hasExp && hasCalc ? " calc" : ""));
    if (vals.length) {
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var one = vals.length === 1;
      et.appendChild(el("span", "v", one ? fmt(lo, 1) + (p.et_unc ? " ± " + p.et_unc : "") : lo === hi ? fmt(lo, 1) : fmt(lo, 1) + "–" + fmt(hi, 1)));
      et.appendChild(el("span", "u", "kcal/mol"));
      panel.appendChild(et);
      panel.appendChild(el("p", "alt", one
        ? fmt(lo * 4.184, 0) + " kJ/mol · " + fmt(lo / 23.0605, 2) + " eV"
        : vals.length + " values · " + fmt(lo * 4.184, 0) + (lo === hi ? "" : "–" + fmt(hi * 4.184, 0)) + " kJ/mol"));
      if (lo < S_MIN || hi > S_MAX) panel.appendChild(el("span", "chip warn", "Off scale (" + (lo < S_MIN ? "<40" : ">80") + ")"));
    } else {
      et.appendChild(el("span", "v", "—"));
      panel.appendChild(et);
    }
    panel.appendChild(scale(items));
    var meta = el("div", "sum-meta");
    if (info && info.formula) meta.appendChild(el("span", "formula", info.formula));
    if (g.cas) meta.appendChild(el("span", "formula", "CAS " + g.cas));
    var how = [trimStr(p.method), trimStr(p.conditions)].filter(Boolean).join(" · ");
    if (how) { var hw = el("span", "sum-how", how); hw.title = how; meta.appendChild(hw); }
    if (meta.childNodes.length) panel.appendChild(meta);
    body.appendChild(panel);
    c.appendChild(body);

    var srcSeen = {}, nSrc = 0;
    items.forEach(function (d) {
      var k = (EntScore.cleanDoi(d.doi || "") || trimStr(d.citation)).toLowerCase();
      if (k && !srcSeen[k]) { srcSeen[k] = 1; nSrc++; }
    });
    var cite = trimStr(p.citation);
    if (cite || p.doi) {
      var foot = el("div", "sum-foot");
      var ct = el("span", "sum-cite", cite + (nSrc > 1 ? (cite ? " · " : "") + "+" + (nSrc - 1) + (nSrc === 2 ? " other source" : " other sources") : ""));
      ct.title = cite;
      foot.appendChild(ct);
      if (p.doi) foot.appendChild(el("span", "sum-doi", "doi:" + (EntScore.cleanDoi(p.doi) || p.doi)));
      c.appendChild(foot);
    }
    return c;
  };

  /* items: entries of one molecule; o = {scores, simMode, onSuggest(d), isSlidePicked(key), onSlideToggle(item)} */
  Ent.moleculeCard = function (items, o) {
    o = o || {};
    var g = groupSummary(items), p = g.p, many = g.many, molKey = g.key, comm = g.comm, iupac = g.iupac, role = g.role;
    items = g.items;
    var picked = o.isSlidePicked ? !!o.isSlidePicked(molKey) : false;
    var c = el("article", "card mol" + (picked ? " mol-picked" : "")), head = el("div", "head");
    renderMolTitle(head, { name: iupac, commercial_name: comm });
    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip", roleLabel(role)));
    var cls = g.cls;
    if (cls) chips.appendChild(el("span", "chip plain", cls));
    if (many) chips.appendChild(el("span", "chip plain", items.length + " values"));
    var best = bestSimilarity(items, o);
    if (best != null) chips.appendChild(el("span", "chip", "Similarity " + fmt(best, 2)));
    if (o.onSlideToggle && Ent.slideGraphic) chips.appendChild(slidePickBtn(items, o, picked));
    head.appendChild(chips); c.appendChild(head);

    if (many) {
      var vals = items.map(function (d) { return Number(d.et_kcal); }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var hasExp = items.some(function (d) { return d.origin !== "calc"; });
      var hasCalc = items.some(function (d) { return d.origin === "calc"; });
      var rangeCls = (hasExp && !hasCalc) ? " exp" : (!hasExp && hasCalc) ? " calc" : "";
      var et = el("div", "et" + rangeCls);
      et.appendChild(el("span", "v", lo === hi ? fmt(lo, 1) : fmt(lo, 1) + "–" + fmt(hi, 1)));
      et.appendChild(el("span", "u", "kcal/mol"));
      et.appendChild(elT("span", "alt", items.length + " E_T values, listed below (filled green: experimental; hollow purple: computed)"));
      c.appendChild(et); c.appendChild(scale(items));
    }

    var st = el("div", "struct"), paper = el("div", "paper"), info = molInfo(p.smiles);
    var cas = items.map(function (d) { return d.cas; }).filter(Boolean)[0];
    if (info) {
      paper.innerHTML = info.svg;
      bindPaperPreview(paper, function () {
        return {
          name: iupac, commercial_name: comm, smiles: p.smiles, role: role, cls: cls, cas: cas,
          values: items, formula: info.formula, method: p.method,
          conditions: p.conditions, citation: p.citation, doi: p.doi
        };
      });
    } else paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available";
    st.appendChild(paper);
    var si = el("div", "sinfo");
    if (cas) {
      var casRow = el("div", "copy-row");
      casRow.appendChild(el("span", "formula", "CAS " + cas));
      casRow.appendChild(copyBtn(cas, "Copy CAS number"));
      si.appendChild(casRow);
    }
    si.appendChild(smilesAndXyzActions(p.smiles, comm || iupac));
    if (info && info.formula) si.appendChild(el("span", "formula", info.formula));
    if (p.structure_note) si.appendChild(el("span", "hint", p.structure_note));
    st.appendChild(si); c.appendChild(st);

    items.forEach(function (d) { c.appendChild(valueBlock(d, o, many)); });

    var firstUv = items.map(EntScore.formatUv).filter(Boolean)[0];
    var firstDir = items.map(function (d) { return EntScore.formatDirectExc(d.direct_exc); }).filter(Boolean)[0];
    if (firstUv || firstDir) {
      var dl = el("dl");
      if (firstUv) row(dl, "UV-vis", firstUv);
      if (firstDir) row(dl, "Direct excitation", firstDir);
      c.appendChild(dl);
    }
    var seen = {}, usesList = [];
    items.forEach(function (d) {
      (Array.isArray(d.uses) ? d.uses : []).forEach(function (u) {
        if (!u || !u.doi) return; var k = EntScore.cleanDoi(u.doi).toLowerCase(); if (seen[k]) return; seen[k] = 1; usesList.push(u);
      });
    });
    if (usesList.length) {
      var ul = el("ul", "uses");
      usesList.forEach(function (u) {
        var li = el("li"); li.appendChild(doiLink(u.doi, "doi:" + EntScore.cleanDoi(u.doi)));
        if (u.note) li.appendChild(document.createTextNode(" · " + u.note));
        ul.appendChild(li);
      });
      c.appendChild(el("p", "hint", "Used in photocatalysis")); c.appendChild(ul);
    }
    var rxAll = [];
    items.forEach(function (d) {
      (Array.isArray(d.reactions) ? d.reactions : []).forEach(function (rx) { if (rx && typeof rx === "object") rxAll.push({ rx: rx, substrate: d.smiles || p.smiles }); });
    });
    if (rxAll.length && Ent.reactionsSection) {
      var rxs = Ent.reactionsSection(rxAll, comm || iupac || "molecule");
      if (rxs) c.appendChild(rxs);
    }
    return c;
  };

  /* ---------- duplicates ----------
     The same molecule is recognised, in order of priority, by CAS number, by structure
     (OpenChemLib canonical code, which keeps E/Z and R/S apart), by identical SMILES and by
     name. When both entries carry a CAS number, the CAS number alone decides. A different
     stereoisomer (E/Z, enantiomer) is reported but never counted as a duplicate. */
  var keyCache = {};
  function nameKey(n) {
    var t = String(n || "").toLowerCase().replace(/[′’']/g, "'");
    for (var i = 0; i < 3; i++) t = t.replace(/\s*\((?![ezrs]\)|[ezrs],)[^()]*\)\s*$/, "");   /* trailing labels such as "(TX)", not "(E)" */
    return t.replace(/[\s"“”]+/g, "").trim();
  }
  function keysOf(d) {
    var ck = d.id + "|" + d.smiles + "|" + d.cas + "|" + d.name;
    if (keyCache[ck] && (keyCache[ck].ocl || !window.OCL)) return keyCache[ck];
    var k = { cas: d.cas || "", smi: d.smiles || "", name: nameKey(d.name), id: null, skel: null, ocl: !!window.OCL };
    var m = molOf(d.smiles);
    if (m) {
      try { k.id = m.getIDCode(); } catch (e) {}
      try { var c = m.getCompactCopy ? m.getCompactCopy() : OCL.Molecule.fromSmiles(d.smiles); c.stripStereoInformation(); k.skel = c.getIDCode(); } catch (e) { k.skel = null; }
    }
    keyCache[ck] = k; return k;
  }
  /* -> null when nothing matches, else why the two entries look like the same molecule */
  function sameMolecule(a, b) {
    var x = keysOf(a), y = keysOf(b);
    if (x.cas && y.cas) return x.cas === y.cas ? "same CAS number" : null;
    if (x.id && y.id && x.id === y.id) return "same structure";
    if (x.smi && x.smi === y.smi) return "same SMILES";
    if (x.name && x.name === y.name) return x.id && y.id && x.id !== y.id ? "same name, but the structures differ" : "same name";
    return null;
  }
  function stereoPartner(a, b) {
    var x = keysOf(a), y = keysOf(b);
    if (x.cas && y.cas && x.cas === y.cas) return false;
    return !!(x.skel && y.skel && x.skel === y.skel && x.id !== y.id);
  }
  /* Two values of the same molecule are the same data when they are both measured or both
     computed and either come from the same paper and agree within 1 kcal/mol, or agree within
     0.1 kcal/mol (the same number cited by another paper). Anything else is a new value, which
     is kept beside the existing ones on the molecule's card. */
  var sameValue = Ent.sameValue = function (a, b) {
    if ((a.origin || "exp") !== (b.origin || "exp")) return false;
    var dv = Math.abs(Number(a.et_kcal) - Number(b.et_kcal));
    if (isNaN(dv)) return false;
    var x = EntScore.cleanDoi(a.doi || "").toLowerCase(), y = EntScore.cleanDoi(b.doi || "").toLowerCase();
    return x && x === y ? dv <= 1 : dv <= 0.1;
  };
  /* d against the database (approved entries) and the rest of the queue (pending entries).
     -> {flag, db: [{entry, why, same}], queue: [...], stereo: [entries]}
     flag (yellow card) = the same value is already there; a new value for a known molecule is not flagged. */
  Ent.duplicates = function (d, approved, pending) {
    var res = { flag: false, db: [], queue: [], stereo: [] };
    (approved || []).forEach(function (e) {
      if (e.id === d.id) return;
      var why = sameMolecule(d, e);
      if (why) res.db.push({ entry: e, why: why, same: sameValue(d, e) }); else if (stereoPartner(d, e)) res.stereo.push(e);
    });
    (pending || []).forEach(function (e) {
      if (e.id === d.id) return;
      var why = sameMolecule(d, e); if (why) res.queue.push({ entry: e, why: why, same: sameValue(d, e) });
    });
    var isSame = function (m) { return m.same; };
    res.dbSame = res.db.filter(isSame); res.queueSame = res.queue.filter(isSame);
    res.flag = res.dbSame.length > 0 || res.queueSame.length > 0;
    return res;
  };
  function describe(e) {
    var comm = trimStr(e.commercial_name), iupac = trimStr(e.name);
    var label = comm && iupac && comm.toLowerCase() !== iupac.toLowerCase() ? (comm + " (" + iupac + ")") : (comm || iupac || "(unnamed)");
    return label + " · " + fmt(Number(e.et_kcal), 1) + " kcal/mol · " + (e.origin === "calc" ? "computed" : "experimental")
      + (e.doi ? " · " + e.doi : "");
  }
  function dupNote(dup) {
    var box = el("div", "dupnote" + (dup.flag ? "" : " info"));
    var tag = function (m) { return " (" + m.why + (m.same ? "; same value" : "; different value") + ")"; };
    if (dup.db.length) {
      box.appendChild(el("p", null, dup.dbSame.length ? "Already in the database:" : "This molecule is in the database; this is a new value and will be added to its card:"));
      var ul = el("ul"); dup.db.forEach(function (m) { ul.appendChild(el("li", m.same ? "same" : null, describe(m.entry) + tag(m))); }); box.appendChild(ul);
    }
    if (dup.queue.length) {
      box.appendChild(el("p", null, "Also waiting in the queue:"));
      var uq = el("ul"); dup.queue.forEach(function (m) { uq.appendChild(el("li", m.same ? "same" : null, describe(m.entry) + tag(m))); }); box.appendChild(uq);
    }
    if (dup.stereo.length) {
      box.appendChild(el("p", "hint", "A different stereoisomer (E/Z or enantiomer) is in the database: " + dup.stereo.map(function (e) { return displayName(e); }).join("; ") + ". This is not treated as a duplicate."));
    }
    return box;
  }

  /* ---------- dialogs (one at a time, in the #ed host) ---------- */
  var dlgReturn = null;
  Ent.dialog = function (title, build) {
    var box = el("div", "sk-box"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    var h = el("h2", null, title); h.id = "dlg-title"; box.setAttribute("aria-labelledby", "dlg-title"); box.appendChild(h);
    var host = $("ed"); dlgReturn = document.activeElement;
    build(box);
    host.replaceChildren(box); host.hidden = false; syncModalOpen();
    var first = box.querySelector("input, select, textarea, button"); if (first) first.focus();
    return box;
  };
  Ent.closeDialog = function () {
    var host = $("ed"); if (!host || host.hidden) return;
    host.hidden = true; host.replaceChildren(); syncModalOpen();
    if (dlgReturn && dlgReturn.focus) dlgReturn.focus(); dlgReturn = null;
  };

  /* ---------- suggested corrections (purple cards in the queue) ---------- */
  var SUGG_LABEL = {}; EntScore.SUGGEST_FIELDS.forEach(function (f) { SUGG_LABEL[f[0]] = f[1]; });
  function shown(v) {
    if (v == null || v === "") return "(empty)";
    if (Array.isArray(v)) return v.length ? v.map(shown).join("; ") : "(empty)";
    if (typeof v === "object") {
      if ("doi" in v) return (v.doi || "") + (v.note ? " · " + v.note : "");
      return EntScore.formatDirectExc(v);
    }
    return String(v);
  }
  function suggThumb(smiles, label) {
    var box = el("div", "sugg-thumb");
    var info = molInfo(smiles);
    if (info) box.innerHTML = info.svg; else box.textContent = label || "No drawing";
    return box;
  }
  /* s: suggestion row, entry: current entry or null, h = {email, busy, approve(s, note), revoke(s, note), reject(s, note), edit(s, entry, note)} */
  Ent.suggestionCard = function (s, entry, h) {
    var ap = Ent.approvalState(s, h && h.email);
    var c = el("article", "card sugg"), head = el("div", "head");
    if (entry) renderMolTitle(head, entry, "Suggested correction · ");
    else head.appendChild(el("h2", null, "Suggested correction · entry no longer available"));
    var chips = el("div", "chips"); chips.appendChild(el("span", "chip suggchip", "Correction from a reader"));
    if (ap.count >= 1) {
      chips.appendChild(el("span", "chip " + (ap.byMe ? "verify1-me" : "verify1-other"), ap.byMe ? "1/2 verified · by you" : "1/2 verified · needs 2nd check"));
    }
    if (entry && entry.cas) chips.appendChild(el("span", "chip plain", "CAS " + entry.cas));
    if (entry && entry.origin) chips.appendChild(el("span", "chip " + (entry.origin === "calc" ? "calc" : "exp"), entry.origin === "calc" ? "Computed" : "Experimental"));
    if (entry && entry.et_kcal != null) chips.appendChild(el("span", "chip plain", fmt(Number(entry.et_kcal), 1) + " kcal/mol"));
    head.appendChild(chips); c.appendChild(head);
    var apBox = approvalNoteBox(ap, s.status || "pending", "correction");
    if (apBox) c.appendChild(apBox);

    if (entry && (entry.smiles || (s.changes && s.changes.smiles))) {
      var st = el("div", "sugg-struct"), chSmi = s.changes && s.changes.smiles;
      if (entry.smiles) st.appendChild(suggThumb(entry.smiles, "Current"));
      if (chSmi && chSmi !== entry.smiles) {
        st.appendChild(el("span", "hint", "→"));
        st.appendChild(suggThumb(chSmi, "Suggested"));
      }
      var sm = el("div", "sinfo");
      var info = molInfo(entry.smiles || chSmi);
      if (info && info.formula) sm.appendChild(el("span", "formula", info.formula));
      if (entry.doi) {
        var dr = el("div", "copy-row"), dw = el("span", "doi-wrap");
        dw.appendChild(doiLink(entry.doi, "Source DOI: " + entry.doi)); dr.appendChild(dw);
        sm.appendChild(dr);
      }
      st.appendChild(sm); c.appendChild(st);
    }

    var wrap = el("div", "tablewrap"), t = el("table", "diff"), tr = el("tr");
    ["Field", "Now in the database", "Suggested"].forEach(function (x) { tr.appendChild(el("th", null, x)); });
    t.appendChild(tr);
    Object.keys(s.changes || {}).forEach(function (k) {
      var r = el("tr"), cur = entry ? (k === "uses_add" ? (Array.isArray(entry.uses) ? entry.uses.map(shown).join("; ") : "") : entry[k]) : "";
      var nowTxt = shown(cur), newTxt = shown(s.changes[k]);
      if (k === "reactions_add" || k === "reactions") {
        var have = entry && Array.isArray(entry.reactions) ? entry.reactions.length : 0, add = Array.isArray(s.changes[k]) ? s.changes[k].length : 0;
        nowTxt = have ? have + (have === 1 ? " reaction" : " reactions") : "(none)";
        newTxt = k === "reactions" ? add + " reactions in total (listed below)" : "+ " + add + (add === 1 ? " reaction" : " reactions") + " (listed below)";
      }
      r.appendChild(elT("td", null, SUGG_LABEL[k] || (k === "reactions" ? "Reactions (edited by a curator)" : k))); r.appendChild(el("td", (k === "reactions_add" || k === "uses_add") ? null : "old", nowTxt)); r.appendChild(el("td", "new", newTxt));
      t.appendChild(r);
    });
    wrap.appendChild(t); c.appendChild(wrap);
    var sgRx = s.changes && (s.changes.reactions_add || s.changes.reactions);
    if (Array.isArray(sgRx) && sgRx.length && Ent.reactionsAdminList && entry) {
      var rxKey = s.changes.reactions_add ? "reactions_add" : "reactions";
      var have2 = Array.isArray(entry.reactions) ? entry.reactions.length : 0;
      var over = rxKey === "reactions_add" && have2 + sgRx.length > EntScore.MAX_REACTIONS;
      var rxa = Ent.reactionsAdminList({
        list: sgRx, substrate: (s.changes.smiles || entry.smiles), name: displayName(entry), busy: h.busy[s.id], open: true,
        label: rxKey === "reactions_add" ? "proposed" : "after the curator's edit",
        save: function (next) {
          var ch = {}; Object.keys(s.changes).forEach(function (k) { ch[k] = s.changes[k]; });
          if (next.length) ch[rxKey] = next; else delete ch[rxKey];
          return h.patchChanges ? h.patchChanges(s, ch) : false;
        }
      });
      if (rxa) c.appendChild(rxa);
      if (over) c.appendChild(el("p", "err", "With these the entry would have " + (have2 + sgRx.length) + " reactions; at most " + EntScore.MAX_REACTIONS + " are allowed. Delete some before approving."));
    }
    var dl = el("dl"); row(dl, "Reason given", s.comment); row(dl, "Submitted by", s.submitted_by);
    row(dl, "Received", s.created_at ? new Date(s.created_at).toLocaleString() : ""); c.appendChild(dl);

    var nf = el("label", "field", "Curator note (optional)"), ni = el("input");
    ni.type = "text"; ni.value = s.note || ""; ni.placeholder = "Note saved on the suggestion record…";
    nf.appendChild(ni);
    var noteToggle = el("button", "btn tiny ghost note-toggle", "+ Add curator note"); noteToggle.type = "button";
    nf.hidden = !s.note; noteToggle.hidden = !!s.note;
    noteToggle.addEventListener("click", function () { noteToggle.hidden = true; nf.hidden = false; ni.focus(); });
    c.appendChild(noteToggle); c.appendChild(nf);

    var act = el("div", "actions"), busy = !!h.busy[s.id];
    if (ap.byMe) {
      var doneBtn = el("button", "btn primary", "Verified by you (" + ap.count + "/2)");
      doneBtn.type = "button"; doneBtn.disabled = true;
      act.appendChild(doneBtn);
      if (h.revoke) {
        var rev = el("button", "btn", "Withdraw verification");
        rev.type = "button"; rev.disabled = busy;
        rev.addEventListener("click", function () { h.revoke(s, ni.value.trim()); });
        act.appendChild(rev);
      }
    } else {
      var ok = el("button", "btn primary", ap.count >= 1 ? "Approve & apply (2/2)" : "Verify correction (1/2)");
      ok.type = "button"; ok.disabled = busy || !entry;
      ok.addEventListener("click", function () { h.approve(s, ni.value.trim()); });
      act.appendChild(ok);
    }
    var no = el("button", "btn reject", "Reject");
    no.type = "button"; no.disabled = busy;
    no.addEventListener("click", function () { h.reject(s, ni.value.trim()); });
    act.appendChild(no);
    if (entry && h.edit) {
      var ed = el("button", "btn", "Edit & verify…"); ed.type = "button"; ed.disabled = busy;
      ed.addEventListener("click", function () { h.edit(s, entry, ni.value.trim()); });
      act.appendChild(ed);
    }
    c.appendChild(act);
    if (h.busy[s.id] === "err") c.appendChild(el("p", "err", "Could not save. Try again."));
    return c;
  };

  /* ---------- entry editor (review page) ---------- */
  var EDIT = [
    ["name", "IUPAC name", "text"], ["commercial_name", "Commercial name (optional)", "text"], ["cas", "CAS number", "text"], ["cls", "Class", "text"],
    ["role", "Role", "select", [["acceptor", "Acceptor"], ["donor", "Donor"], ["both", "Donor and acceptor"]]],
    ["origin", "Origin", "select", [["exp", "Experimental"], ["calc", "Computed"]]],
    ["et_kcal", "E_T (kcal/mol)", "number"], ["et_unc", "± Uncertainty (kcal/mol)", "number"],
    ["et_reported", "Value as reported", "text"], ["et_type", "Value type", "text"],
    ["method", "Method", "area"], ["conditions", "Conditions", "text"],
    ["citation", "Citation", "area"], ["doi", "DOI", "text"], ["location", "Where in the paper", "text"],
    ["quote", "Verbatim line", "text"], ["evidence", "What it says", "area"],
    ["uv_lmax", "UV-vis λmax (nm)", "number"], ["uv_eps", "UV-vis ε (M⁻¹ cm⁻¹)", "number"], ["uv_cond", "UV-vis conditions", "text"],
    ["direct_exc", "Direct excitation (e.g. LED: 415, Kessil: 427)", "direct_map"],
    ["structure_note", "Structure note", "text"], ["verify_note", "Verification note", "text"]
  ];
  var EDIT_MAP = {}; EDIT.forEach(function (f) { EDIT_MAP[f[0]] = f; });
  var EDIT_GROUPS = [
    { legend: "Molecule", rows: [["name"], ["commercial_name"], ["cas", "cls", "role"], ["structure_note"]] },
    { legend: "Triplet energy", rows: [["origin", "et_kcal", "et_unc"], ["et_reported", "et_type"], ["method", "conditions"]] },
    { legend: "Source & verification", rows: [["citation"], ["doi", "location"], ["quote"], ["evidence"], ["verify_note"]] },
    { legend: "Absorption & excitation", rows: [["uv_lmax", "uv_eps", "uv_cond"], ["direct_exc"]] }
  ];
  /* Fields the score was computed from: editing one marks the score as older than the entry. */
  var SCORED = ["name", "origin", "et_kcal", "et_unc", "et_type", "method", "conditions", "citation", "doi", "location", "quote", "uv_lmax", "uv_eps", "uv_cond", "direct_exc"];
  function useRow(u, onChange) {
    var r = el("div", "ed-use");
    var a = el("label", "field", "DOI of a paper where it was used"), ai = el("input"); ai.type = "text"; ai.className = "mono ed-use-doi"; ai.value = (u && u.doi) || ""; a.appendChild(ai);
    var b = el("label", "field", "What it was used for"), bi = el("input"); bi.type = "text"; bi.className = "ed-use-note"; bi.maxLength = 300; bi.value = (u && u.note) || ""; b.appendChild(bi);
    var x = el("button", "btn small", "Remove"); x.type = "button"; x.addEventListener("click", function () { r.remove(); if (onChange) onChange(); });
    if (onChange) { ai.addEventListener("input", onChange); bi.addEventListener("input", onChange); }
    r.appendChild(a); r.appendChild(b); r.appendChild(x); return r;
  }
  /* "Look up on PubChem" under the CAS field: fills the first match and lists the others. */
  function casLookup(inp, getSmiles) {
    var wrap = el("div", "actions"), b = el("button", "btn small", "Look up on PubChem"), msg = el("span", "hint");
    b.type = "button"; msg.setAttribute("aria-live", "polite");
    b.addEventListener("click", function () {
      var smi = (typeof getSmiles === "function" ? getSmiles() : getSmiles) || "";
      if (!smi.trim()) { msg.textContent = "Give the SMILES first."; return; }
      b.disabled = true; msg.textContent = "Asking PubChem…";
      Ent.lookupCas(smi).then(function (list) {
        b.disabled = false;
        if (!list.length) { msg.textContent = "PubChem has no CAS number for this structure."; return; }
        inp.value = list[0]; inp.dispatchEvent(new Event("input", { bubbles: true }));
        msg.textContent = "From PubChem; check it before saving." + (list.length > 1 ? " PubChem also lists: " + list.slice(1, 6).join(", ") + (list.length > 6 ? "…" : "") : "");
      }, function () { b.disabled = false; msg.textContent = "PubChem could not be reached. Try again."; });
    });
    wrap.appendChild(b); wrap.appendChild(msg); return wrap;
  }
  /* "IUPAC name from PubChem" under a name field (editor and submission form). */
  var iupacLookup = Ent.iupacLookup = function (inp, getSmiles) {
    var wrap = el("div", "actions"), b = el("button", "btn small", "IUPAC name from PubChem"), msg = el("span", "hint");
    b.type = "button"; msg.setAttribute("aria-live", "polite");
    b.addEventListener("click", function () {
      var smi = (getSmiles() || "").trim();
      if (!smi) { msg.textContent = "Give the SMILES first."; return; }
      b.disabled = true; msg.textContent = "Asking PubChem…";
      Ent.lookupIupac(smi).then(function (n) {
        b.disabled = false;
        if (!n) { msg.textContent = "PubChem does not know this structure: write the IUPAC name by hand."; return; }
        inp.value = n; inp.dispatchEvent(new Event("input", { bubbles: true }));
        msg.textContent = "From PubChem; check stereodescriptors (E/Z, R/S) against the structure.";
      }, function () { b.disabled = false; msg.textContent = "PubChem could not be reached. Try again."; });
    });
    wrap.appendChild(b); wrap.appendChild(msg); return wrap;
  };
  var edCanClose = null;
  Ent.editor = {
    open: function (d, onSave, opts) {
      opts = opts || {};
      var overrides = opts.overrides || null;
      var origSmiles = d.smiles || "", curSmiles = (overrides && overrides.smiles) || origSmiles;
      var box = el("div", "sk-box ed-box"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");

      var head = el("div", "ed-head");
      var h = el("h2", null, opts.title || ("Edit · " + displayName(d))); h.id = "ed-title"; box.setAttribute("aria-labelledby", "ed-title");
      var headAct = el("div", "ed-head-actions"), doiSlot = el("span"), closeX = el("button", "btn small", "Close");
      closeX.type = "button"; closeX.setAttribute("aria-label", "Close editor");
      headAct.appendChild(doiSlot); headAct.appendChild(closeX);
      head.appendChild(h); head.appendChild(headAct); box.appendChild(head);

      var body = el("div", "ed-body");
      if (opts.banner) {
        body.appendChild(el("p", "banner", opts.banner));
      } else if (!overrides && d.status === "pending" && approvalsOf(d).length > 0) {
        body.appendChild(el("p", "banner", "This entry has 1/2 verification. Editing the value, structure, method, or source will reset verifications to 0/2."));
      }

      /* Live structure panel inside editor so stereodescriptors & CAS can be verified visually */
      var stWrap = el("div", "ed-struct"), paper = el("div", "paper"), si = el("div", "sinfo");
      var smiRow = el("div", "copy-row"), smiCode = el("code", "smiles"), smiCopy = copyBtn(function () { return curSmiles; }, "Copy SMILES");
      var fml = el("span", "formula"), skBtn = el("button", "btn small", "Edit structure in sketcher"); skBtn.type = "button";
      var xyzEd = xyzBtns(function () { return curSmiles; }, function () { return (fieldInputs.commercial_name && fieldInputs.commercial_name.value.trim()) || (fieldInputs.name && fieldInputs.name.value.trim()) || displayName(d); }, "small");
      var stAct = el("div", "actions"); stAct.appendChild(skBtn); stAct.appendChild(xyzEd.dl); stAct.appendChild(xyzEd.cp);
      smiRow.appendChild(smiCode); smiRow.appendChild(smiCopy);
      si.appendChild(smiRow); si.appendChild(fml); si.appendChild(stAct);
      stWrap.appendChild(paper); stWrap.appendChild(si); body.appendChild(stWrap);
      function drawStruct() {
        var info = molInfo(curSmiles);
        if (info) { paper.innerHTML = info.svg; fml.textContent = info.formula || ""; }
        else { paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available"; fml.textContent = ""; }
        smiCode.textContent = curSmiles || "—";
        xyzEd.dl.disabled = xyzEd.cp.disabled = !curSmiles;
        stWrap.classList.toggle("changed", curSmiles !== origSmiles);
      }

      var fieldLabs = {}, fieldInputs = {};
      function buildField(k) {
        var f = EDIT_MAP[k]; if (!f) return null;
        var lab = el("label", "field"), lbl = elT("span", null, f[1]), inp;
        lab.appendChild(lbl);
        if (f[2] === "select") { inp = el("select"); f[3].forEach(function (o) { inp.appendChild(new Option(o[1], o[0])); }); }
        else if (f[2] === "area") { inp = el("textarea"); inp.rows = 2; }
        else {
          inp = el("input"); inp.type = f[2] === "number" ? "number" : "text";
          if (f[2] === "number") inp.step = "any";
          if (k === "doi" || k === "cas") inp.className = "mono";
        }
        inp.id = "ed-" + f[0];
        var init = overrides && (f[0] in overrides) ? overrides[f[0]] : d[f[0]];
        inp.value = f[2] === "direct_map" ? EntScore.formatDirectExc(init) : (init == null ? "" : String(init));
        lab.appendChild(inp);
        if (f[0] === "cas") lab.appendChild(casLookup(inp, function () { return curSmiles; }));
        if (f[0] === "name") lab.appendChild(iupacLookup(inp, function () { return curSmiles; }));
        fieldLabs[k] = lab;
        fieldInputs[k] = inp;
        return lab;
      }

      EDIT_GROUPS.forEach(function (grp) {
        var fs = el("fieldset"), lg = el("legend", null, grp.legend);
        fs.appendChild(lg);
        grp.rows.forEach(function (rowKeys) {
          if (rowKeys.length === 1) { var one = buildField(rowKeys[0]); if (one) fs.appendChild(one); return; }
          var fr = el("div", "frow");
          rowKeys.forEach(function (k) { var fld = buildField(k); if (fld) fr.appendChild(fld); });
          fs.appendChild(fr);
        });
        body.appendChild(fs);
      });

      var usesFs = el("fieldset"), usesLg = el("legend", null, "Photocatalysis uses");
      usesFs.appendChild(usesLg);
      var uses = el("div", "stack"); uses.id = "ed-uses";
      var initUses = Array.isArray(d.uses) ? d.uses.slice() : [];
      if (overrides && overrides.uses_add) initUses.push(overrides.uses_add);
      initUses.forEach(function (u) { uses.appendChild(useRow(u, syncDirty)); });
      usesFs.appendChild(uses);
      var add = el("button", "btn small", "Add a paper"); add.type = "button";
      add.addEventListener("click", function () { uses.appendChild(useRow(null, syncDirty)); syncDirty(); });
      var addWrap = el("div", "actions"); addWrap.appendChild(add); usesFs.appendChild(addWrap);
      body.appendChild(usesFs);

      var origRx = Array.isArray(d.reactions) ? d.reactions : [];
      var initRx = origRx.slice();
      if (overrides && Array.isArray(overrides.reactions)) initRx = overrides.reactions.slice();
      else if (overrides && Array.isArray(overrides.reactions_add)) initRx = initRx.concat(overrides.reactions_add);
      var rxEd = null;
      if (Ent.reactionsEditor) {
        var rxFs = el("fieldset"); rxFs.appendChild(el("legend", null, "Reactions it was employed in"));
        rxEd = Ent.reactionsEditor({
          substrate: function () { return curSmiles; }, name: function () { return fieldInputs.name.value.trim() || displayName(d); },
          defaultRole: function () { return fieldInputs.role.value; }, initial: initRx, max: EntScore.MAX_REACTIONS,
          onChange: function () { syncDirty(); }
        });
        rxFs.appendChild(rxEd.el); body.appendChild(rxFs);
      }
      box.appendChild(body);

      var foot = el("div", "ed-foot");
      var err = el("p", "err"); err.hidden = true; err.setAttribute("role", "alert"); foot.appendChild(err);
      var dirtyBar = el("div", "ed-dirty-confirm"); dirtyBar.hidden = true;
      var dirtyQ = el("span", null, "You have unsaved changes."), dirtyBtns = el("div", "actions");
      var keepBtn = el("button", "btn small", "Keep editing"), discBtn = el("button", "btn small danger primary", "Discard changes");
      keepBtn.type = discBtn.type = "button"; dirtyBtns.appendChild(keepBtn); dirtyBtns.appendChild(discBtn);
      dirtyBar.appendChild(dirtyQ); dirtyBar.appendChild(dirtyBtns); foot.appendChild(dirtyBar);

      var footRow = el("div", "ed-foot-row"), dirtyMsg = el("span", "hint", "No changes yet");
      var act = el("div", "actions"), save = el("button", "btn primary", opts.saveLabel || "Save changes"), cancel = el("button", "btn", "Cancel");
      save.type = cancel.type = "button"; act.appendChild(save); act.appendChild(cancel);
      footRow.appendChild(dirtyMsg); footRow.appendChild(act); foot.appendChild(footRow);
      box.appendChild(foot);

      function collectState(validate) {
        var patch = {}, bad = "";
        if (curSmiles !== origSmiles) {
          patch.smiles = curSmiles;
          patch.idcode = Ent.idCode(curSmiles);
          patch.smiles_checked = true;
        }
        EDIT.forEach(function (f) {
          var v = fieldInputs[f[0]].value.trim(), out, old = d[f[0]] == null ? null : d[f[0]];
          if (f[2] === "direct_map") {
            var dm = EntScore.parseDirectExc(v);
            if (dm.bad) { if (validate) bad = f[1] + " must be like \"LED: 415, Kessil: 427\" or JSON {\"LED\": 415}."; else patch[f[0]] = v; return; }
            out = dm.map;
            if (JSON.stringify(out) === JSON.stringify(old)) return;
            patch[f[0]] = out; return;
          }
          if (f[2] === "number") {
            out = v === "" ? null : EntScore.num(v);
            if (v !== "" && isNaN(out)) { if (validate) bad = f[1] + " must be a number."; else { patch[f[0]] = v; return; } }
            old = old == null ? null : Number(old);
          } else out = v === "" ? null : v;
          if (f[0] === "doi" && out) out = EntScore.cleanDoi(out);
          if (f[0] === "cas" && out) out = EntScore.cleanCas(out);
          if (out === old) return;
          if (validate) {
            /* only what changed is checked, so an old odd value never blocks other edits */
            if (f[0] === "doi" && out && !EntScore.isDoi(out)) bad = "Give the source as a DOI (for example 10.1021/jacs.0c05069), not as a link.";
            if (f[0] === "cas" && out && !EntScore.casValid(out)) bad = "“" + out + "” is not a valid CAS number.";
          }
          patch[f[0]] = out;
        });
        if (validate) {
          EDIT.forEach(function (f) { var inp = fieldInputs[f[0]]; if (f[2] === "number" && inp.validity && inp.validity.badInput) bad = f[1] + " must be a number."; });
          if (("name" in patch && !patch.name) || (!d.name && !("name" in patch))) bad = "The IUPAC name cannot be empty.";
          if ("et_kcal" in patch && patch.et_kcal == null) bad = "The triplet energy cannot be empty.";
          else if ("et_kcal" in patch && !(patch.et_kcal > 0 && patch.et_kcal <= EntScore.ET_MAX)) bad = "The triplet energy must be above 0 and at most " + EntScore.ET_MAX + " kcal/mol.";
          if ("et_unc" in patch && patch.et_unc != null && patch.et_unc < 0) bad = "The uncertainty cannot be negative.";
          if (("et_kcal" in patch || "et_unc" in patch) && !("et_reported" in patch) && d.et_reported)
            bad = "You changed the value: update “Value as reported” too, so the card does not contradict itself.";
        }
        var list = [];
        Array.prototype.forEach.call(uses.children, function (r) {
          var doi = EntScore.cleanDoi(r.querySelector(".ed-use-doi").value), note = r.querySelector(".ed-use-note").value.trim();
          if (!doi && !note) return;
          if (validate && !EntScore.isDoi(doi)) bad = "“" + (doi || "(empty)") + "” is not a DOI. Give papers as DOIs, not as links.";
          list.push({ doi: doi, note: note });
        });
        if (JSON.stringify(list) !== JSON.stringify(Array.isArray(d.uses) ? d.uses : [])) patch.uses = list.length ? list : null;
        if (rxEd) {
          var rxRaw = rxEd.value(), rxChk = EntScore.checkReactions(rxRaw, 0);
          var rxNow = rxChk.error ? rxRaw : rxChk.clean;
          if (validate) {
            var rxPend = rxEd.pending();
            if (rxPend) bad = rxPend;
            else if (rxChk.error) bad = rxChk.error;
            else {
              var rxBad = rxChk.smiles.filter(function (x) { return Ent.structureOk(x) === false; })[0];
              if (rxBad) bad = "A structure in the reactions could not be read: " + rxBad;
            }
          }
          if (JSON.stringify(rxNow) !== JSON.stringify(origRx)) patch.reactions = rxNow.length ? rxNow : null;
        }
        return { patch: patch, bad: bad };
      }

      function syncDoiLink() {
        var raw = fieldInputs.doi.value.trim(), cleaned = EntScore.cleanDoi(raw);
        doiSlot.replaceChildren();
        if (EntScore.isDoi(cleaned)) {
          var a = link("Open DOI", "https://doi.org/" + encodeURI(cleaned));
          a.className = "btn small"; doiSlot.appendChild(a);
        }
      }

      function syncDirty() {
        var res = collectState(false), patch = res.patch;
        Object.keys(fieldLabs).forEach(function (k) { fieldLabs[k].classList.toggle("changed", k in patch); });
        var n = Object.keys(patch).filter(function (k) { return k !== "idcode" && k !== "smiles_checked"; }).length;
        dirtyMsg.textContent = n ? n + (n === 1 ? " field modified" : " fields modified") : "No changes yet";
        if (!n) dirtyBar.hidden = true;
        syncDoiLink();
        return n;
      }

      EDIT.forEach(function (f) {
        var inp = fieldInputs[f[0]];
        inp.addEventListener("input", syncDirty);
        inp.addEventListener("change", syncDirty);
      });

      skBtn.addEventListener("click", function () {
        Ent.sketcher.open({
          title: "Sketcher · " + (fieldInputs.name.value.trim() || d.name || ""), smiles: curSmiles, saveLabel: "Apply to editor",
          hint: "Edit the drawing or SMILES, then apply to review the change inside the editor.",
          onSave: function (s) { curSmiles = s; drawStruct(); syncDirty(); return true; }
        });
      });

      function requestClose() {
        if (!syncDirty()) { Ent.editor.close(); return; }
        dirtyBar.hidden = false; keepBtn.focus();
      }
      edCanClose = requestClose;
      keepBtn.addEventListener("click", function () { dirtyBar.hidden = true; });
      discBtn.addEventListener("click", Ent.editor.close);
      cancel.addEventListener("click", requestClose);
      closeX.addEventListener("click", requestClose);

      save.addEventListener("click", function () {
        var res = collectState(true), patch = res.patch;
        if (res.bad) { err.textContent = res.bad; err.hidden = false; return; }
        if (!Object.keys(patch).length) { Ent.editor.close(); return; }
        var touched = SCORED.filter(function (k) { return k in patch; });
        if (touched.length && Array.isArray(d.score_items)) {
          patch.score_items = d.score_items.filter(function (i) { return !i.edited; })
            .concat([{ label: "Edited by a curator", got: 0, max: 0, edited: true, note: touched.join(", ") + " on " + new Date().toLocaleDateString("en-CA") }]);
        }
        save.disabled = true; err.hidden = true;
        Promise.resolve(onSave(patch)).then(function (ok) {
          save.disabled = false;
          if (ok) Ent.editor.close(); else { err.textContent = "Could not save. Try again."; err.hidden = false; }
        });
      });

      var host = $("ed"); host.replaceChildren(box); host.hidden = false; syncModalOpen();
      edReturn = document.activeElement;
      drawStruct(); syncDirty();
      var first = $("ed-name"); if (first) first.focus();
    },
    requestClose: function () { if (edCanClose) edCanClose(); else { Ent.editor.close(); Ent.closeDialog(); } },
    close: function () {
      var host = $("ed"); if (!host || host.hidden) return;
      edCanClose = null;
      host.hidden = true; host.replaceChildren(); syncModalOpen();
      if (edReturn && edReturn.focus) edReturn.focus(); edReturn = null;
    }
  };
  var edReturn = null;
  /* Backdrop click closes active dialog (respecting dirty-state confirmation for the editor). */
  document.addEventListener("click", function (e) {
    var ed = $("ed"), sk = $("sk");
    if (sk && !sk.hidden && e.target === sk) { Ent.sketcher.close(); return; }
    if (ed && !ed.hidden && e.target === ed) { Ent.editor.requestClose(); }
  });
  /* Escape closes whichever dialog is topmost (sketcher before editor). */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var ed = $("ed"), sk = $("sk");
    if (sk && !sk.hidden) Ent.sketcher.close();
    else if (ed && !ed.hidden) Ent.editor.requestClose();
  });

  /* ---------- long lists: draw 50 cards at a time ---------- */
  var STEP = 50;
  /* pager = {shown: n}; reset pager.shown to 0 when the filters change */
  Ent.drawList = function (list, rows, makeCard, pager, rerender) {
    if (!pager.shown) pager.shown = STEP;
    var nodes = rows.slice(0, pager.shown).map(makeCard);
    if (rows.length > pager.shown) {
      var more = el("button", "btn", "Show " + Math.min(STEP, rows.length - pager.shown) + " more (" + (rows.length - pager.shown) + " not shown)");
      more.type = "button";
      more.addEventListener("click", function () { pager.shown += STEP; rerender(); });
      nodes.push(more);
    }
    list.replaceChildren.apply(list, nodes);
  };

  /* ---------- sketcher ---------- */
  var editor = null, skOpts = null, skReturn = null, suppressChange = false;
  function skMsg(t) { var m = $("sk-msg"); m.hidden = !t; m.textContent = t || ""; }
  function editorSmiles() {
    if (!editor) return "";
    try {
      var m = OCL.Molecule.fromMolfile(editor.getMolFile());
      return Ent.molToSmiles ? Ent.molToSmiles(m) : (m.toIsomericSmiles ? m.toIsomericSmiles() : m.toSmiles());
    } catch (e) { try { return editor.getSmiles(); } catch (e2) { return ""; } }
  }
  function loadEditorStructure(smi) {
    if (!editor) return;
    suppressChange = true;
    try {
      var mf = smi && Ent.toCleanMolfile ? Ent.toCleanMolfile(smi) : null;
      if (mf && editor.setMolFile) editor.setMolFile(mf);
      else editor.setSmiles(smi || "");
    } finally {
      suppressChange = false;
    }
  }
  Ent.sketcher = {
    open: function (opts) {
      skOpts = opts;
      $("sk-title").textContent = opts.title; $("sk-smiles").value = opts.smiles || ""; $("sk-save").textContent = opts.saveLabel;
      $("sk-hint").textContent = opts.hint + " The sketcher is built for a mouse and may respond poorly to touch."; skMsg("");
      skReturn = document.activeElement;
      $("sk").hidden = false; syncModalOpen(); $("sk-smiles").focus();
      if (!editor) {
        try {
          if (!window.OCL || !OCL.StructureEditor) throw new Error("no editor");
          editor = OCL.StructureEditor.createSVGEditor("sk-editor", 1);
          if (editor.setChangeListenerCallback) editor.setChangeListenerCallback(function () {
            if (suppressChange) return;
            var s = editorSmiles(); if (s) $("sk-smiles").value = s;
          });
        } catch (e) { editor = null; skMsg("The sketcher is not available in this browser. You can still type the SMILES by hand."); }
      }
      if (editor) { try { loadEditorStructure(opts.smiles || ""); } catch (e) { if (opts.smiles) skMsg("This SMILES could not be drawn."); } }
    },
    close: function () {
      $("sk").hidden = true; skOpts = null; syncModalOpen();
      if (skReturn && skReturn.focus) skReturn.focus(); skReturn = null;
    },
    bind: function () {
      $("sk-draw").addEventListener("click", function () {
        skMsg(""); if (!editor) return;
        try { loadEditorStructure($("sk-smiles").value.trim()); } catch (e) { skMsg("The SMILES could not be read."); }
      });
      $("sk-read").addEventListener("click", function () { var s = editorSmiles(); if (s) { $("sk-smiles").value = s; skMsg(""); } else skMsg("The drawing could not be read."); });
      $("sk-close").addEventListener("click", Ent.sketcher.close);
      $("sk-save").addEventListener("click", function () {
        var s = $("sk-smiles").value.trim(); if (!s) { skMsg("The SMILES is empty."); return; }
        if (Ent.structureOk(s) === false) { skMsg("The SMILES could not be read. Fix it first."); return; }
        if (!skOpts) return;
        $("sk-save").disabled = true;
        Promise.resolve(skOpts.onSave(s)).then(function (ok) {
          $("sk-save").disabled = false;
          if (ok) Ent.sketcher.close(); else skMsg("Could not save. Try again.");
        });
      });
    }
  };

  /* ---------- API (Supabase REST, no client library) ---------- */
  var base = String(CFG.supabaseUrl || "").replace(/\/+$/, ""), anon = CFG.supabaseAnonKey || "";
  var SESSION_KEY = "entdb-admin-session";
  var api = Ent.api = { configured: !!(base && anon) };

  function headers(token, extra) {
    /* A signed-in curator sends their session token. Anonymous calls send only the API key:
       the new "sb_..." keys are not JWTs and must not be used as a Bearer token. */
    var h = { apikey: anon, "Content-Type": "application/json" };
    if (token) h.Authorization = "Bearer " + token;
    else if (!/^sb_/.test(anon)) h.Authorization = "Bearer " + anon;
    for (var k in (extra || {})) h[k] = extra[k];
    return h;
  }
  function asJson(r) {
    return r.text().then(function (t) {
      var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
      if (!r.ok) { var err = new Error((body && (body.error || body.message || body.msg)) || ("HTTP " + r.status)); err.status = r.status; throw err; }
      return body;
    });
  }
  function creds(a) { return JSON.stringify({ p_user: (a && a.user) || "", p_pass: (a && a.pass) || "" }); }
  /* -> Promise<true|false>: true when the site is open or the login matches */
  api.checkAccess = function (a, token) {
    return fetch(base + "/rest/v1/rpc/check_access", { method: "POST", headers: headers(token || null), body: creds(a) }).then(asJson);
  };
  /* The API returns at most 1000 rows per request, so long lists are read page by page. */
  var PAGE = 1000;
  var PUBLIC_COLS = "id,created_at,name,commercial_name,cas,smiles,idcode,structure_note,cls,role,origin,et_kcal,et_unc,et_reported,et_type,method,conditions,citation,doi,location,quote,evidence,uv_lmax,uv_eps,uv_cond,direct_exc,score,uses,reactions";
  function allPages(getPage) {
    var out = [];
    return (function next(offset) {
      return getPage(offset).then(function (rows) {
        out = out.concat(rows || []);
        return rows && rows.length === PAGE ? next(offset + PAGE) : out;
      });
    })(0);
  }
  api.listPublic = function (a, useAdmin) {
    if (useAdmin) {
      return authed(function (t) {
        function fetchWithCols(cols) {
          return allPages(function (offset) {
            return fetch(base + "/rest/v1/entries?select=" + cols + "&status=eq.approved&order=created_at.asc,id.asc&limit=" + PAGE + "&offset=" + offset,
              { headers: headers(t) }).then(asJson);
          });
        }
        /* columns added later (reactions, commercial_name) are dropped while the database does not have them yet */
        function tryCols(cols) {
          return fetchWithCols(cols).catch(function (err) {
            var msg = (err && err.message) || "";
            if (err && err.status === 400 && /reactions/i.test(msg) && cols.indexOf(",reactions") >= 0) return tryCols(cols.replace(",reactions", ""));
            if (err && err.status === 400 && /commercial_name/i.test(msg) && cols.indexOf(",commercial_name,") >= 0) return tryCols(cols.replace(",commercial_name,", ","));
            throw err;
          });
        }
        return tryCols(PUBLIC_COLS);
      });
    }
    return allPages(function (offset) {
      return fetch(base + "/rest/v1/rpc/list_entries?order=created_at.asc,id.asc&limit=" + PAGE + "&offset=" + offset,
        { method: "POST", headers: headers(), body: creds(a) }).then(asJson);
    });
  };
  api.submit = function (payload) {
    return api.token().then(function (t) {
      return fetch(base + "/functions/v1/submit", { method: "POST", headers: headers(t || null), body: JSON.stringify(payload) }).then(asJson);
    });
  };

  /* curator session: email + password sign-in */
  function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
  function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; } }
  function tokenEmail(tok, fallback) {
    if (fallback) return fallback;
    try {
      var p = String(tok || "").split(".")[1];
      if (!p) return "";
      var j = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
      return j.email || "";
    } catch (e) { return ""; }
  }
  api.sessionEmail = function () {
    var s = readSession();
    return s ? tokenEmail(s.access_token, s.email) : "";
  };
  api.signOut = function () { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} };
  api.signIn = function (email, password) {
    return fetch(base + "/auth/v1/token?grant_type=password",
      { method: "POST", headers: headers(), body: JSON.stringify({ email: email, password: password }) })
      .then(asJson).then(function (r) {
        saveSession({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000, email: (r.user && r.user.email) || email || "" });
        return true;
      });
  };
  /* -> Promise<token | null>, refreshing when close to expiry */
  api.token = function () {
    var s = readSession(); if (!s || !s.access_token) return Promise.resolve(null);
    if (s.expires_at - Date.now() > 60000) return Promise.resolve(s.access_token);
    if (!s.refresh_token) { api.signOut(); return Promise.resolve(null); }
    return fetch(base + "/auth/v1/token?grant_type=refresh_token",
      { method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: s.refresh_token }) })
      .then(asJson).then(function (r) {
        saveSession({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000, email: (r.user && r.user.email) || s.email || "" });
        return r.access_token;
      }, function () { api.signOut(); return null; });
  };
  function authed(fn) {
    return api.token().then(function (t) { if (!t) { var e = new Error("Signed out"); e.status = 401; throw e; } return fn(t); });
  }
  api.isAdmin = function () {
    return authed(function (t) { return fetch(base + "/rest/v1/rpc/is_admin", { method: "POST", headers: headers(t), body: "{}" }).then(asJson); });
  };
  api.adminList = function () {
    return authed(function (t) {
      return allPages(function (offset) {
        return fetch(base + "/rest/v1/entries?select=*&order=created_at.asc,id.asc&limit=" + PAGE + "&offset=" + offset, { headers: headers(t) }).then(asJson);
      });
    });
  };
  /* Same patch on many rows, 100 ids per request. -> Promise<updated rows> / Promise<number changed> */
  function patchManyRows(ids, patch) {
    var chunks = []; for (var i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    return authed(function (t) {
      return chunks.reduce(function (p, c) {
        return p.then(function (all) {
          return fetch(base + "/rest/v1/entries?id=in.(" + c.join(",") + ")",
            { method: "PATCH", headers: headers(t, { Prefer: "return=representation" }), body: JSON.stringify(patch) })
            .then(asJson).then(function (rows) { return all.concat(rows || []); });
        });
      }, Promise.resolve([]));
    });
  }
  api.adminPatchManyRows = patchManyRows;
  api.adminPatchMany = function (ids, patch) {
    return patchManyRows(ids, patch).then(function (rows) { return rows.length; });
  };
  /* Insert literature rows; rows whose import_key already exists are skipped. */
  api.adminImport = function (rows) {
    var chunks = []; for (var i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
    return authed(function (t) {
      return chunks.reduce(function (p, c) {
        return p.then(function () {
          return fetch(base + "/rest/v1/entries?on_conflict=import_key",
            { method: "POST", headers: headers(t, { Prefer: "resolution=ignore-duplicates,return=minimal" }), body: JSON.stringify(c) }).then(asJson);
        });
      }, Promise.resolve());
    });
  };
  /* Literature batches published with the site: index.json lists the files. */
  api.batches = function () {
    return fetch("batches/index.json", { cache: "no-store" }).then(asJson).then(function (idx) {
      return Promise.all((idx.files || []).map(function (f) { return fetch("batches/" + f, { cache: "no-store" }).then(asJson); }));
    }).then(function (lists) { return [].concat.apply([], lists); });
  };
  /* Suggested corrections. A database without the suggestions table (schema not re-run yet)
     simply has none. */
  api.adminSuggestions = function () {
    return authed(function (t) {
      return fetch(base + "/rest/v1/suggestions?select=*&status=eq.pending&order=created_at.asc&limit=500", { headers: headers(t) })
        .then(function (r) { return r.status === 404 ? [] : asJson(r); });
    });
  };
  api.adminPatchSuggestion = function (id, patch) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/suggestions?id=eq." + encodeURIComponent(id),
        { method: "PATCH", headers: headers(t, { Prefer: "return=representation" }), body: JSON.stringify(patch) }).then(asJson);
    });
  };
  /* Permanent removal (curators only; RLS allows delete to admins). -> Promise<number deleted> */
  api.adminDeleteMany = function (ids) {
    var chunks = []; for (var i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    return authed(function (t) {
      return chunks.reduce(function (p, c) {
        return p.then(function (n) {
          return fetch(base + "/rest/v1/entries?id=in.(" + c.join(",") + ")",
            { method: "DELETE", headers: headers(t, { Prefer: "return=representation" }) })
            .then(asJson).then(function (rows) { return n + (rows ? rows.length : 0); });
        });
      }, Promise.resolve(0));
    });
  };
  api.adminPatch = function (id, patch) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/entries?id=eq." + encodeURIComponent(id),
        { method: "PATCH", headers: headers(t, { Prefer: "return=representation" }), body: JSON.stringify(patch) }).then(asJson);
    });
  };
  api.adminApproveMany = function (ids, note) {
    var chunks = []; for (var i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    return authed(function (t) {
      return chunks.reduce(function (p, c) {
        return p.then(function (all) {
          return fetch(base + "/rest/v1/rpc/approve_entries", {
            method: "POST",
            headers: headers(t),
            body: JSON.stringify({ p_ids: c, p_note: note === undefined ? null : note })
          }).then(asJson).then(function (rows) { return all.concat(rows || []); });
        });
      }, Promise.resolve([]));
    });
  };
  api.adminApprove = function (id, note) {
    return api.adminApproveMany([id], note);
  };
  api.adminRevokeApproval = function (id, note) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/rpc/revoke_entry_approval", {
        method: "POST",
        headers: headers(t),
        body: JSON.stringify({ p_id: id, p_note: note === undefined ? null : note })
      }).then(asJson);
    });
  };
  api.adminApproveSuggestion = function (id, note) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/rpc/approve_suggestion", {
        method: "POST",
        headers: headers(t),
        body: JSON.stringify({ p_id: id, p_note: note === undefined ? null : note })
      }).then(asJson);
    });
  };
  api.adminRevokeSuggestionApproval = function (id, note) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/rpc/revoke_suggestion_approval", {
        method: "POST",
        headers: headers(t),
        body: JSON.stringify({ p_id: id, p_note: note === undefined ? null : note })
      }).then(asJson);
    });
  };
})();
