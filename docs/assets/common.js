/* TrEnDB shared front-end: structure handling (OpenChemLib), search, cards, sketcher, API. */
(function () {
  "use strict";
  var Ent = window.Ent = {};
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
      var out = { svg: m.toSVG(260, 170, undefined, { suppressChiralText: true, suppressESR: true, suppressCIPParity: true, noStereoProblem: true }), formula: "" };
      try { var f = m.getMolecularFormula(); out.formula = f.formula + " · " + fmt(f.relativeWeight, 2) + " g/mol"; } catch (e) {}
      svgCache[smiles] = out; return out;
    } catch (e) { return null; }
  };
  Ent.idCode = function (smiles) { var m = molOf(smiles); try { return m ? m.getIDCode() : null; } catch (e) { return null; } };
  /* true / false when the library is loaded, null when it is not */
  Ent.structureOk = function (smiles) { return window.OCL ? !!molOf(smiles) : null; };

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
      if (q) { var hay = [d.name, d.cas, d.smiles, d.citation, d.cls, d.method, d.doi].join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    if (st.sort === "et-asc") rows.sort(function (a, b) { return a.et_kcal - b.et_kcal; });
    else if (st.sort === "et-desc") rows.sort(function (a, b) { return b.et_kcal - a.et_kcal; });
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
  /* one entry, or several values of the same molecule (one mark each; computed ones hollow) */
  function scale(list) {
    list = Array.isArray(list) ? list : [list];
    var s = el("div", "scale"); s.appendChild(el("div", "track"));
    REFS.forEach(function (r) {
      var t = el("div", "ref"); t.style.left = pct(r.v) + "%"; s.appendChild(t);
      var l = el("div", "lab", r.l); l.style.left = pct(r.v) + "%"; s.appendChild(l);
    });
    list.forEach(function (d) {
      if (d.et_unc) {
        var b = el("div", "band"), a = pct(d.et_kcal - d.et_unc), z = pct(Number(d.et_kcal) + Number(d.et_unc));
        b.style.left = a + "%"; b.style.width = (z - a) + "%"; s.appendChild(b);
      }
    });
    list.forEach(function (d) {
      var m = el("div", "mark" + (list.length > 1 && d.origin === "calc" ? " calc" : "")); m.style.left = pct(d.et_kcal) + "%"; s.appendChild(m);
    });
    var e0 = el("div", "end", String(S_MIN)); e0.style.left = "0"; s.appendChild(e0);
    var e1 = el("div", "end", String(S_MAX)); e1.style.right = "0"; s.appendChild(e1);
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", "Triplet energy " + list.map(function (d) { return d.et_kcal; }).join(", ") + " kcal/mol on a 40 to 80 scale");
    return s;
  }
  /* o.scores, o.simMode, o.dup = Ent.duplicates result, o.onSuggest(d) on the public page,
     o.admin = {busy, drafts, onPatch(id, patch) -> Promise<bool>, approve(d, note)} */
  Ent.card = function (d, o) {
    o = o || {}; var adm = o.admin || null, dup = o.dup || null;
    var c = el("article", "card" + (dup && dup.flag ? " dup" : "")), head = el("div", "head");
    head.appendChild(el("h2", null, d.name || "(unnamed)"));
    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip", d.role === "donor" ? "Donor" : d.role === "both" ? "Donor and acceptor" : "Acceptor"));
    chips.appendChild(el("span", "chip " + (d.origin === "calc" ? "calc" : "exp"), d.origin === "calc" ? "Computed" : "Experimental"));
    if (d.cls) chips.appendChild(el("span", "chip plain", d.cls));
    if (o.simMode && o.scores && o.scores[d.id] != null) chips.appendChild(el("span", "chip", "Similarity " + fmt(o.scores[d.id], 2)));
    if (d.score != null) { var g = EntScore.gradeOf(d.score); chips.appendChild(el("span", "chip " + g.cls, "Score " + d.score + " · " + g.label)); }
    if (adm && d.source_kind === "form") chips.appendChild(el("span", "chip plain", "Form submission"));
    if (d.verify_level === "abstract") chips.appendChild(el("span", "chip warn", "Abstract only"));
    if (d.verify_level === "secondaria") chips.appendChild(el("span", "chip warn", "Source to verify"));
    if (adm && !d.smiles_checked) chips.appendChild(el("span", "chip warn", "Structure unchecked"));
    if (dup && dup.flag) chips.appendChild(el("span", "chip dupchip", dup.dbSame.length ? "Possible duplicate" : "Same value also in the queue"));
    else if (dup && dup.db.length) chips.appendChild(el("span", "chip plain", "New value for a known molecule"));
    head.appendChild(chips); c.appendChild(head);
    if (dup && (dup.db.length || dup.queue.length || dup.stereo.length)) c.appendChild(dupNote(dup));

    var et = el("div", "et");
    et.appendChild(el("span", "v", fmt(Number(d.et_kcal), 1) + (d.et_unc ? " ± " + d.et_unc : "")));
    et.appendChild(el("span", "u", "kcal/mol"));
    et.appendChild(el("span", "alt", fmt(d.et_kcal * 4.184, 0) + " kJ/mol · " + fmt(d.et_kcal / 23.0605, 2) + " eV"));
    c.appendChild(et); c.appendChild(scale(d));

    var st = el("div", "struct"), paper = el("div", "paper"), info = molInfo(d.smiles);
    if (info) paper.innerHTML = info.svg; else paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available";
    st.appendChild(paper);
    var si = el("div", "sinfo");
    if (d.cas) si.appendChild(el("span", "formula", "CAS " + d.cas));
    si.appendChild(el("code", "smiles", d.smiles || "—"));
    if (info && info.formula) si.appendChild(el("span", "formula", info.formula));
    if (d.structure_note) si.appendChild(el("span", "hint", d.structure_note));
    var busy = adm && !!adm.busy[d.id];
    if (adm) {
      var ob = el("button", "btn small", "Open in sketcher"); ob.type = "button"; ob.disabled = busy;
      ob.addEventListener("click", function () {
        Ent.sketcher.open({
          title: "Sketcher · " + (d.name || ""), smiles: d.smiles || "", saveLabel: "Save structure",
          hint: "Edit the drawing or the SMILES, then save. Saving marks the structure as verified.",
          onSave: function (s) { return adm.onPatch(d.id, { smiles: s, idcode: Ent.idCode(s), smiles_checked: true }); }
        });
      });
      si.appendChild(ob);
      var lab = el("label", "check"), cb = el("input"); cb.type = "checkbox"; cb.id = "chk-" + d.id; cb.checked = !!d.smiles_checked; cb.disabled = busy;
      cb.addEventListener("change", function () { adm.onPatch(d.id, { smiles_checked: cb.checked }); });
      lab.appendChild(cb); lab.appendChild(document.createTextNode("Structure verified")); si.appendChild(lab);
    }
    st.appendChild(si); c.appendChild(st);

    var dl = el("dl");
    row(dl, "Reported value", d.et_reported);
    row(dl, "Value type", d.et_type);
    row(dl, "Method", d.method);
    row(dl, "Conditions", d.conditions);
    row(dl, "Source", d.citation);
    row(dl, "Where", d.location);
    if (d.quote) { var qd = el("span"); qd.appendChild(el("q", null, d.quote)); row(dl, "Verbatim", qd); }
    row(dl, "What it says", d.evidence);
    if (d.doi) row(dl, "DOI", doiLink(d.doi, d.doi));
    row(dl, "Verification", d.verify_note);
    row(dl, "UV-vis", d.uv || "Not recorded");
    row(dl, "Direct excitation", d.direct_exc || "Not recorded");
    if (adm) {
      if (d.score_items && d.score_items.length) {
        var lost = d.score_items.filter(function (i) { return i.got < i.max; });
        var edited = d.score_items.filter(function (i) { return i.edited; }).pop();
        row(dl, "Check", (lost.length ? "Points lost on: " + lost.map(function (i) { return i.label + " (" + i.got + "/" + i.max + ")"; }).join("; ") : "All checks passed")
          + (edited ? ". The score predates a curator's edit of " + edited.note + "." : ""));
      }
      row(dl, "Submitted by", d.submitted_by);
      row(dl, "Received", d.created_at ? new Date(d.created_at).toLocaleString() : "");
    }
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

    if (o.onSuggest) {
      var sa = el("div", "actions"), sb = el("button", "btn small", "Suggest a correction"); sb.type = "button";
      sb.addEventListener("click", function () { o.onSuggest(d); });
      sa.appendChild(sb); c.appendChild(sa);
    }

    if (adm) {
      var f = el("label", "field", "Note (optional)"), ni = el("input"); ni.id = "note-" + d.id; ni.type = "text";
      ni.value = adm.drafts[d.id] != null ? adm.drafts[d.id] : (d.note || "");
      ni.addEventListener("input", function () { adm.drafts[d.id] = ni.value; });
      f.appendChild(ni); c.appendChild(f);
      var act = el("div", "actions");
      var decide = function (label, cls, status) {
        var b = el("button", "btn " + cls, label); b.type = "button"; b.disabled = busy;
        b.addEventListener("click", function () {
          var done = function (ok) { if (ok) delete adm.drafts[d.id]; };
          if (status === "approved" && adm.approve) { Promise.resolve(adm.approve(d, ni.value || "")).then(done); return; }
          adm.onPatch(d.id, { status: status, decided_at: new Date().toISOString(), note: ni.value || "" }).then(done);
        });
        act.appendChild(b);
      };
      var eb = el("button", "btn", "Edit entry"); eb.type = "button"; eb.disabled = busy;
      eb.addEventListener("click", function () { Ent.editor.open(d, function (patch) { return adm.onPatch(d.id, patch); }); });
      if (d.status === "pending") { decide("Approve", "primary", "approved"); decide("Reject", "reject", "rejected"); }
      else { decide("Back to queue", "", "pending"); if (d.status === "approved") decide("Reject", "reject", "rejected"); else decide("Approve", "primary", "approved"); }
      act.appendChild(eb);
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
    var et = el("div", "et");
    et.appendChild(el("span", "v", fmt(Number(d.et_kcal), 1) + (d.et_unc ? " ± " + d.et_unc : "")));
    et.appendChild(el("span", "u", "kcal/mol"));
    et.appendChild(el("span", "alt", fmt(d.et_kcal * 4.184, 0) + " kJ/mol · " + fmt(d.et_kcal / 23.0605, 2) + " eV"));
    top.appendChild(et);
    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip " + (d.origin === "calc" ? "calc" : "exp"), d.origin === "calc" ? "Computed" : "Experimental"));
    if (d.score != null) { var g = EntScore.gradeOf(d.score); chips.appendChild(el("span", "chip " + g.cls, "Score " + d.score + " · " + g.label)); }
    if (d.verify_level === "abstract") chips.appendChild(el("span", "chip warn", "Abstract only"));
    if (d.verify_level === "secondaria") chips.appendChild(el("span", "chip warn", "Source to verify"));
    top.appendChild(chips); v.appendChild(top);
    if (!many) v.appendChild(scale(d));
    var dl = el("dl");
    row(dl, "Reported value", d.et_reported);
    row(dl, "Value type", d.et_type);
    row(dl, "Method", d.method);
    row(dl, "Conditions", d.conditions);
    row(dl, "Source", d.citation);
    row(dl, "Where", d.location);
    if (d.quote) { var qd = el("span"); qd.appendChild(el("q", null, d.quote)); row(dl, "Verbatim", qd); }
    row(dl, "What it says", d.evidence);
    if (d.doi) row(dl, "DOI", doiLink(d.doi, d.doi));
    row(dl, "Verification", d.verify_note);
    v.appendChild(dl);
    if (o.onSuggest) {
      var sa = el("div", "actions"), sb = el("button", "btn small", many ? "Suggest a correction to this value" : "Suggest a correction"); sb.type = "button";
      sb.addEventListener("click", function () { o.onSuggest(d); });
      sa.appendChild(sb); v.appendChild(sa);
    }
    return v;
  }
  /* items: entries of one molecule; o = {scores, simMode, onSuggest(d)} */
  Ent.moleculeCard = function (items, o) {
    o = o || {}; items = items.slice().sort(byQuality);
    var p = items[0], many = items.length > 1, c = el("article", "card mol"), head = el("div", "head");
    head.appendChild(el("h2", null, p.name || "(unnamed)"));
    var chips = el("div", "chips"), roles = {};
    items.forEach(function (d) { roles[d.role || "acceptor"] = 1; });
    var role = roles.both || (roles.donor && roles.acceptor) ? "both" : roles.donor ? "donor" : "acceptor";
    chips.appendChild(el("span", "chip", role === "donor" ? "Donor" : role === "both" ? "Donor and acceptor" : "Acceptor"));
    var cls = items.map(function (d) { return d.cls; }).filter(Boolean)[0];
    if (cls) chips.appendChild(el("span", "chip plain", cls));
    if (many) chips.appendChild(el("span", "chip plain", items.length + " values"));
    if (o.simMode && o.scores) {
      var best = null; items.forEach(function (d) { var x = o.scores[d.id]; if (x != null && (best == null || x > best)) best = x; });
      if (best != null) chips.appendChild(el("span", "chip", "Similarity " + fmt(best, 2)));
    }
    head.appendChild(chips); c.appendChild(head);

    if (many) {
      var vals = items.map(function (d) { return Number(d.et_kcal); }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var et = el("div", "et");
      et.appendChild(el("span", "v", lo === hi ? fmt(lo, 1) : fmt(lo, 1) + "–" + fmt(hi, 1)));
      et.appendChild(el("span", "u", "kcal/mol"));
      et.appendChild(elT("span", "alt", items.length + " E_T values, listed below (filled marks: experimental; hollow: computed)"));
      c.appendChild(et); c.appendChild(scale(items));
    }

    var st = el("div", "struct"), paper = el("div", "paper"), info = molInfo(p.smiles);
    if (info) paper.innerHTML = info.svg; else paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available";
    st.appendChild(paper);
    var si = el("div", "sinfo");
    var cas = items.map(function (d) { return d.cas; }).filter(Boolean)[0];
    if (cas) si.appendChild(el("span", "formula", "CAS " + cas));
    si.appendChild(el("code", "smiles", p.smiles || "—"));
    if (info && info.formula) si.appendChild(el("span", "formula", info.formula));
    if (p.structure_note) si.appendChild(el("span", "hint", p.structure_note));
    st.appendChild(si); c.appendChild(st);

    items.forEach(function (d) { c.appendChild(valueBlock(d, o, many)); });

    var first = function (k) { return items.map(function (d) { return d[k]; }).filter(Boolean)[0]; };
    var dl = el("dl");
    row(dl, "UV-vis", first("uv") || "Not recorded");
    row(dl, "Direct excitation", first("direct_exc") || "Not recorded");
    c.appendChild(dl);
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
    return (e.name || "(unnamed)") + " · " + fmt(Number(e.et_kcal), 1) + " kcal/mol · " + (e.origin === "calc" ? "computed" : "experimental")
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
      box.appendChild(el("p", "hint", "A different stereoisomer (E/Z or enantiomer) is in the database: " + dup.stereo.map(function (e) { return e.name; }).join("; ") + ". This is not treated as a duplicate."));
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
    host.replaceChildren(box); host.hidden = false;
    var first = box.querySelector("input, select, textarea, button"); if (first) first.focus();
    return box;
  };
  Ent.closeDialog = function () {
    var host = $("ed"); if (!host || host.hidden) return;
    host.hidden = true; host.replaceChildren();
    if (dlgReturn && dlgReturn.focus) dlgReturn.focus(); dlgReturn = null;
  };

  /* ---------- suggested corrections (purple cards in the queue) ---------- */
  var SUGG_LABEL = {}; EntScore.SUGGEST_FIELDS.forEach(function (f) { SUGG_LABEL[f[0]] = f[1]; });
  function shown(v) {
    if (v == null || v === "") return "(empty)";
    if (typeof v === "object") return (v.doi || "") + (v.note ? " · " + v.note : "");
    return String(v);
  }
  /* s: suggestion row, entry: current entry or null, h = {busy, approve(s), reject(s)} */
  Ent.suggestionCard = function (s, entry, h) {
    var c = el("article", "card sugg"), head = el("div", "head");
    head.appendChild(el("h2", null, "Suggested correction · " + (entry ? entry.name : "entry no longer available")));
    var chips = el("div", "chips"); chips.appendChild(el("span", "chip suggchip", "Correction from a reader"));
    if (entry && entry.cas) chips.appendChild(el("span", "chip plain", "CAS " + entry.cas));
    head.appendChild(chips); c.appendChild(head);
    var wrap = el("div", "tablewrap"), t = el("table", "diff"), tr = el("tr");
    ["Field", "Now in the database", "Suggested"].forEach(function (x) { tr.appendChild(el("th", null, x)); });
    t.appendChild(tr);
    Object.keys(s.changes || {}).forEach(function (k) {
      var r = el("tr"), cur = entry ? (k === "uses_add" ? (Array.isArray(entry.uses) ? entry.uses.map(shown).join("; ") : "") : entry[k]) : "";
      r.appendChild(elT("td", null, SUGG_LABEL[k] || k)); r.appendChild(el("td", "old", shown(cur))); r.appendChild(el("td", "new", shown(s.changes[k])));
      t.appendChild(r);
    });
    wrap.appendChild(t); c.appendChild(wrap);
    var dl = el("dl"); row(dl, "Reason given", s.comment); row(dl, "Submitted by", s.submitted_by);
    row(dl, "Received", s.created_at ? new Date(s.created_at).toLocaleString() : ""); c.appendChild(dl);
    var act = el("div", "actions"), busy = !!h.busy[s.id];
    var ok = el("button", "btn primary", "Approve: apply to the entry"), no = el("button", "btn reject", "Reject");
    ok.type = no.type = "button"; ok.disabled = busy || !entry; no.disabled = busy;
    ok.addEventListener("click", function () { h.approve(s); }); no.addEventListener("click", function () { h.reject(s); });
    act.appendChild(ok); act.appendChild(no); c.appendChild(act);
    if (h.busy[s.id] === "err") c.appendChild(el("p", "err", "Could not save. Try again."));
    return c;
  };

  /* ---------- entry editor (review page) ---------- */
  var EDIT = [
    ["name", "Name", "text"], ["cas", "CAS number", "text"], ["cls", "Class", "text"],
    ["role", "Role", "select", [["acceptor", "Acceptor"], ["donor", "Donor"], ["both", "Donor and acceptor"]]],
    ["origin", "Origin", "select", [["exp", "Experimental"], ["calc", "Computed"]]],
    ["et_kcal", "E_T (kcal/mol)", "number"], ["et_unc", "± Uncertainty (kcal/mol)", "number"],
    ["et_reported", "Value as reported", "text"], ["et_type", "Value type", "text"],
    ["method", "Method", "area"], ["conditions", "Conditions", "text"],
    ["citation", "Citation", "area"], ["doi", "DOI", "text"], ["location", "Where in the paper", "text"],
    ["quote", "Verbatim line", "text"], ["evidence", "What it says", "area"],
    ["uv", "UV-vis", "text"], ["direct_exc", "Direct excitation", "text"],
    ["structure_note", "Structure note", "text"], ["verify_note", "Verification note", "text"]
  ];
  /* Fields the score was computed from: editing one marks the score as older than the entry. */
  var SCORED = ["name", "origin", "et_kcal", "et_unc", "et_type", "method", "conditions", "citation", "doi", "location", "quote", "uv", "direct_exc"];
  function useRow(u) {
    var r = el("div", "ed-use");
    var a = el("label", "field", "DOI of a paper where it was used"), ai = el("input"); ai.type = "text"; ai.className = "mono ed-use-doi"; ai.value = (u && u.doi) || ""; a.appendChild(ai);
    var b = el("label", "field", "What it was used for"), bi = el("input"); bi.type = "text"; bi.className = "ed-use-note"; bi.maxLength = 300; bi.value = (u && u.note) || ""; b.appendChild(bi);
    var x = el("button", "btn small", "Remove"); x.type = "button"; x.addEventListener("click", function () { r.remove(); });
    r.appendChild(a); r.appendChild(b); r.appendChild(x); return r;
  }
  Ent.editor = {
    open: function (d, onSave) {
      var box = el("div", "sk-box"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
      var h = el("h2", null, "Edit · " + (d.name || "")); h.id = "ed-title"; box.setAttribute("aria-labelledby", "ed-title");
      box.appendChild(h);
      box.appendChild(el("p", "hint", "The structure is edited with “Open in sketcher” on the card. Changes are saved for every reader as soon as you press Save."));
      EDIT.forEach(function (f) {
        var lab = elT("label", "field", f[1]), inp;
        if (f[2] === "select") { inp = el("select"); f[3].forEach(function (o) { inp.appendChild(new Option(o[1], o[0])); }); }
        else if (f[2] === "area") { inp = el("textarea"); inp.rows = 2; }
        else { inp = el("input"); inp.type = f[2] === "number" ? "number" : "text"; if (f[2] === "number") inp.step = "any"; }
        inp.id = "ed-" + f[0]; inp.value = d[f[0]] == null ? "" : d[f[0]];
        lab.appendChild(inp); box.appendChild(lab);
      });
      box.appendChild(el("p", "hint", "Papers in which this molecule was used in photocatalysis"));
      var uses = el("div", "stack"); uses.id = "ed-uses";
      (Array.isArray(d.uses) ? d.uses : []).forEach(function (u) { uses.appendChild(useRow(u)); });
      box.appendChild(uses);
      var add = el("button", "btn small", "Add a paper"); add.type = "button"; add.addEventListener("click", function () { uses.appendChild(useRow(null)); });
      var addWrap = el("div", "actions"); addWrap.appendChild(add); box.appendChild(addWrap);
      var err = el("p", "err"); err.hidden = true; err.setAttribute("role", "alert"); box.appendChild(err);
      var act = el("div", "actions"), save = el("button", "btn primary", "Save changes"), cancel = el("button", "btn", "Cancel");
      save.type = "button"; cancel.type = "button"; act.appendChild(save); act.appendChild(cancel); box.appendChild(act);
      cancel.addEventListener("click", Ent.editor.close);
      save.addEventListener("click", function () {
        var patch = {}, bad = "";
        EDIT.forEach(function (f) {
          var v = $("ed-" + f[0]).value.trim(), out, old = d[f[0]] == null ? null : d[f[0]];
          if (f[2] === "number") {
            out = v === "" ? null : EntScore.num(v);
            if (v !== "" && isNaN(out)) bad = f[1] + " must be a number.";
            old = old == null ? null : Number(old);
          } else out = v === "" ? null : v;
          if (f[0] === "doi" && out) out = EntScore.cleanDoi(out);
          if (f[0] === "cas" && out) out = EntScore.cleanCas(out);
          if (out === old) return;
          /* only what changed is checked, so an old odd value never blocks other edits */
          if (f[0] === "doi" && out && !EntScore.isDoi(out)) bad = "Give the source as a DOI (for example 10.1021/jacs.0c05069), not as a link.";
          if (f[0] === "cas" && out && !EntScore.casValid(out)) bad = "“" + out + "” is not a valid CAS number.";
          patch[f[0]] = out;
        });
        /* A number field that the browser could not read shows as empty: keep the old value. */
        EDIT.forEach(function (f) { if (f[2] === "number" && $("ed-" + f[0]).validity && $("ed-" + f[0]).validity.badInput) bad = f[1] + " must be a number."; });
        if ("name" in patch && !patch.name) bad = "The name cannot be empty.";
        if ("et_kcal" in patch && patch.et_kcal == null) bad = "The triplet energy cannot be empty.";
        else if ("et_kcal" in patch && !(patch.et_kcal > 0 && patch.et_kcal <= EntScore.ET_MAX)) bad = "The triplet energy must be above 0 and at most " + EntScore.ET_MAX + " kcal/mol.";
        if ("et_unc" in patch && patch.et_unc != null && patch.et_unc < 0) bad = "The uncertainty cannot be negative.";
        if (("et_kcal" in patch || "et_unc" in patch) && !("et_reported" in patch) && d.et_reported)
          bad = "You changed the value: update “Value as reported” too, so the card does not contradict itself.";
        var list = [];
        Array.prototype.forEach.call(uses.children, function (r) {
          var doi = EntScore.cleanDoi(r.querySelector(".ed-use-doi").value), note = r.querySelector(".ed-use-note").value.trim();
          if (!doi && !note) return;
          if (!EntScore.isDoi(doi)) bad = "“" + (doi || "(empty)") + "” is not a DOI. Give papers as DOIs, not as links.";
          list.push({ doi: doi, note: note });
        });
        if (JSON.stringify(list) !== JSON.stringify(Array.isArray(d.uses) ? d.uses : [])) patch.uses = list.length ? list : null;
        if (bad) { err.textContent = bad; err.hidden = false; return; }
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
      var host = $("ed"); host.replaceChildren(box); host.hidden = false;
      edReturn = document.activeElement;
      var first = $("ed-name"); if (first) first.focus();
    },
    close: function () {
      var host = $("ed"); if (!host || host.hidden) return;
      host.hidden = true; host.replaceChildren();
      if (edReturn && edReturn.focus) edReturn.focus(); edReturn = null;
    }
  };
  var edReturn = null;
  /* Escape closes whichever dialog is open. */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var ed = $("ed"), sk = $("sk");
    if (ed && !ed.hidden) { Ent.editor.close(); Ent.closeDialog(); }
    else if (sk && !sk.hidden) Ent.sketcher.close();
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
  var editor = null, skOpts = null, skReturn = null;
  function skMsg(t) { var m = $("sk-msg"); m.hidden = !t; m.textContent = t || ""; }
  function editorSmiles() {
    if (!editor) return "";
    try { var m = OCL.Molecule.fromMolfile(editor.getMolFile()); return m.toIsomericSmiles ? m.toIsomericSmiles() : m.toSmiles(); }
    catch (e) { try { return editor.getSmiles(); } catch (e2) { return ""; } }
  }
  Ent.sketcher = {
    open: function (opts) {
      skOpts = opts;
      $("sk-title").textContent = opts.title; $("sk-smiles").value = opts.smiles || ""; $("sk-save").textContent = opts.saveLabel;
      $("sk-hint").textContent = opts.hint + " The sketcher is built for a mouse and may respond poorly to touch."; skMsg("");
      skReturn = document.activeElement;
      $("sk").hidden = false; $("sk-smiles").focus();
      if (!editor) {
        try {
          if (!window.OCL || !OCL.StructureEditor) throw new Error("no editor");
          editor = OCL.StructureEditor.createSVGEditor("sk-editor", 1);
          if (editor.setChangeListenerCallback) editor.setChangeListenerCallback(function () { var s = editorSmiles(); if (s) $("sk-smiles").value = s; });
        } catch (e) { editor = null; skMsg("The sketcher is not available in this browser. You can still type the SMILES by hand."); }
      }
      if (editor) { try { editor.setSmiles(opts.smiles || ""); } catch (e) { if (opts.smiles) skMsg("This SMILES could not be drawn."); } }
    },
    close: function () {
      $("sk").hidden = true; skOpts = null;
      if (skReturn && skReturn.focus) skReturn.focus(); skReturn = null;
    },
    bind: function () {
      $("sk-draw").addEventListener("click", function () {
        skMsg(""); if (!editor) return;
        try { editor.setSmiles($("sk-smiles").value.trim()); } catch (e) { skMsg("The SMILES could not be read."); }
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
  api.checkAccess = function (a) {
    return fetch(base + "/rest/v1/rpc/check_access", { method: "POST", headers: headers(), body: creds(a) }).then(asJson);
  };
  /* The API returns at most 1000 rows per request, so long lists are read page by page. */
  var PAGE = 1000;
  function allPages(getPage) {
    var out = [];
    return (function next(offset) {
      return getPage(offset).then(function (rows) {
        out = out.concat(rows || []);
        return rows && rows.length === PAGE ? next(offset + PAGE) : out;
      });
    })(0);
  }
  api.listPublic = function (a) {
    return allPages(function (offset) {
      return fetch(base + "/rest/v1/rpc/list_entries?order=created_at.asc,id.asc&limit=" + PAGE + "&offset=" + offset,
        { method: "POST", headers: headers(), body: creds(a) }).then(asJson);
    });
  };
  api.submit = function (payload) {
    return fetch(base + "/functions/v1/submit", { method: "POST", headers: headers(), body: JSON.stringify(payload) }).then(asJson);
  };

  /* curator session: email + password sign-in */
  function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
  function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; } }
  api.signOut = function () { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} };
  api.signIn = function (email, password) {
    return fetch(base + "/auth/v1/token?grant_type=password",
      { method: "POST", headers: headers(), body: JSON.stringify({ email: email, password: password }) })
      .then(asJson).then(function (r) {
        saveSession({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 });
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
        saveSession({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 });
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
  /* Same patch on many rows, 100 ids per request. -> Promise<number of rows changed> */
  api.adminPatchMany = function (ids, patch) {
    var chunks = []; for (var i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    return authed(function (t) {
      return chunks.reduce(function (p, c) {
        return p.then(function (n) {
          return fetch(base + "/rest/v1/entries?id=in.(" + c.join(",") + ")",
            { method: "PATCH", headers: headers(t, { Prefer: "return=representation" }), body: JSON.stringify(patch) })
            .then(asJson).then(function (rows) { return n + (rows ? rows.length : 0); });
        });
      }, Promise.resolve(0));
    });
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
  api.adminPatch = function (id, patch) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/entries?id=eq." + encodeURIComponent(id),
        { method: "PATCH", headers: headers(t, { Prefer: "return=representation" }), body: JSON.stringify(patch) }).then(asJson);
    });
  };
})();
