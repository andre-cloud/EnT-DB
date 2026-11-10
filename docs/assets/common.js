/* EnT-DB shared front-end: structure handling (OpenChemLib), search, cards, sketcher, API. */
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
  var fmt = Ent.fmt = function (n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); };
  function pct(v) { return Math.max(0, Math.min(100, (v - S_MIN) / (S_MAX - S_MIN) * 100)); }

  /* ---------- OpenChemLib ---------- */
  var OCL_URLS = [
    "https://cdn.jsdelivr.net/npm/openchemlib@8.19.0/dist/openchemlib-full.js",
    "https://unpkg.com/openchemlib@8.19.0/dist/openchemlib-full.js",
    "https://cdn.jsdelivr.net/npm/openchemlib@8.15.0/dist/openchemlib-full.js",
    "https://cdn.jsdelivr.net/npm/openchemlib@7.5.0/dist/openchemlib-full.js"
  ];
  Ent.loadOCL = function (onReady) {
    (function next(urls) {
      if (!urls.length) { var m = $("ocl-msg"); if (m) m.hidden = false; return; }
      var s = document.createElement("script"); s.src = urls[0];
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
  /* -> {hits: null | {id: score}, err: ""} ; hits null means no structure query is active */
  function structureHits(docs, ss) {
    var qs = (ss.smiles || "").trim();
    if (!qs) return { hits: null, err: "" };
    if (!window.OCL) return { hits: null, err: "Structure search needs the structure library, which did not load." };
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
    } catch (e) { return { hits: null, err: "This search type is not available with the loaded structure library." }; }
    return { hits: hits, err: "" };
  }

  /* ---------- search state and controls ---------- */
  Ent.newSearch = function () { return { q: "", origin: "", sort: "added", ss: { smiles: "", mode: "sub", thr: 0.5 }, pager: { shown: 0 } }; };
  Ent.filterRows = function (docs, st) {
    var q = st.q.trim().toLowerCase(), r = structureHits(docs, st.ss), hits = r.hits;
    var rows = docs.filter(function (d) {
      if (st.origin && d.origin !== st.origin) return false;
      if (hits && !(d.id in hits)) return false;
      if (q) { var hay = [d.name, d.smiles, d.citation, d.cls, d.method, d.doi].join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    if (st.sort === "et-asc") rows.sort(function (a, b) { return a.et_kcal - b.et_kcal; });
    else if (st.sort === "et-desc") rows.sort(function (a, b) { return b.et_kcal - a.et_kcal; });
    else if (st.sort === "sim" && hits) rows.sort(function (a, b) { return (hits[b.id] || 0) - (hits[a.id] || 0); });
    else rows.sort(function (a, b) { return String(a.created_at || "") < String(b.created_at || "") ? -1 : 1; });
    return { rows: rows, scores: hits || {}, searching: !!hits, err: r.err };
  };
  Ent.bindSearch = function (st, rerender) {
    var t = null;
    var render = function () { if (st.pager) st.pager.shown = 0; rerender(); };
    $("q").addEventListener("input", function (e) { st.q = e.target.value; render(); });
    $("f-origin").addEventListener("change", function (e) { st.origin = e.target.value; render(); });
    $("f-sort").addEventListener("change", function (e) { st.sort = e.target.value; render(); });
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
  Ent.searchInfo = function (res, total) {
    var info = $("ss-info");
    info.className = res.err ? "err" : "hint";
    info.textContent = res.err ? res.err
      : res.searching ? res.rows.length + " of " + total + " entries match the query."
      : "Exact match includes E/Z geometry; similarity is a Tanimoto score on fragment fingerprints, which ignore E/Z.";
  };

  /* ---------- cards ---------- */
  function link(text, href) { var a = el("a", null, text); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || "")) ? u : null; }
  function row(dl, k, v) {
    if (!v) return;
    dl.appendChild(el("dt", null, k)); var dd = el("dd");
    if (typeof v === "string") dd.textContent = v; else dd.appendChild(v);
    dl.appendChild(dd);
  }
  function scale(d) {
    var s = el("div", "scale"); s.appendChild(el("div", "track"));
    REFS.forEach(function (r) {
      var t = el("div", "ref"); t.style.left = pct(r.v) + "%"; s.appendChild(t);
      var l = el("div", "lab", r.l); l.style.left = pct(r.v) + "%"; s.appendChild(l);
    });
    if (d.et_unc) {
      var b = el("div", "band"), a = pct(d.et_kcal - d.et_unc), z = pct(Number(d.et_kcal) + Number(d.et_unc));
      b.style.left = a + "%"; b.style.width = (z - a) + "%"; s.appendChild(b);
    }
    var m = el("div", "mark"); m.style.left = pct(d.et_kcal) + "%"; s.appendChild(m);
    var e0 = el("div", "end", String(S_MIN)); e0.style.left = "0"; s.appendChild(e0);
    var e1 = el("div", "end", String(S_MAX)); e1.style.right = "0"; s.appendChild(e1);
    s.setAttribute("role", "img"); s.setAttribute("aria-label", "E_T " + d.et_kcal + " kcal/mol on a 40 to 80 scale");
    return s;
  }
  /* o.scores, o.simMode, o.admin = {busy, drafts, onPatch(id, patch) -> Promise<bool>} */
  Ent.card = function (d, o) {
    o = o || {}; var adm = o.admin || null;
    var c = el("article", "card"), head = el("div", "head");
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
    head.appendChild(chips); c.appendChild(head);

    var et = el("div", "et");
    et.appendChild(el("span", "v", fmt(Number(d.et_kcal), 1) + (d.et_unc ? " ± " + d.et_unc : "")));
    et.appendChild(el("span", "u", "kcal/mol"));
    et.appendChild(el("span", "alt", fmt(d.et_kcal * 4.184, 0) + " kJ/mol · " + fmt(d.et_kcal / 23.0605, 2) + " eV"));
    c.appendChild(et); c.appendChild(scale(d));

    var st = el("div", "struct"), paper = el("div", "paper"), info = molInfo(d.smiles);
    if (info) paper.innerHTML = info.svg; else paper.textContent = window.OCL ? "SMILES could not be read" : "Drawing not available";
    st.appendChild(paper);
    var si = el("div", "sinfo");
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
    var links = el("span", "links");
    if (d.doi) links.appendChild(link("DOI " + d.doi, "https://doi.org/" + encodeURI(d.doi)));
    if (safeUrl(d.pdf_url)) links.appendChild(link(d.pdf_label || "Open-access PDF", d.pdf_url));
    if (safeUrl(d.si_url)) links.appendChild(link("Supporting information", d.si_url));
    if (safeUrl(d.url)) links.appendChild(link(d.url_label || "Record", d.url));
    if (links.childNodes.length) row(dl, "Links", links);
    row(dl, "Verification", d.verify_note);
    row(dl, "UV-vis", d.uv || "Not recorded");
    row(dl, "Direct excitation", d.direct_exc || "Not recorded");
    if (adm) {
      if (d.score_items && d.score_items.length) {
        var lost = d.score_items.filter(function (i) { return i.got < i.max; });
        row(dl, "Check", lost.length ? "Points lost on: " + lost.map(function (i) { return i.label + " (" + i.got + "/" + i.max + ")"; }).join("; ") : "All checks passed");
      }
      row(dl, "Submitted by", d.submitted_by);
      row(dl, "Received", d.created_at ? new Date(d.created_at).toLocaleString() : "");
    }
    c.appendChild(dl);

    if (adm) {
      var f = el("label", "field", "Note (optional)"), ni = el("input"); ni.id = "note-" + d.id; ni.type = "text";
      ni.value = adm.drafts[d.id] != null ? adm.drafts[d.id] : (d.note || "");
      ni.addEventListener("input", function () { adm.drafts[d.id] = ni.value; });
      f.appendChild(ni); c.appendChild(f);
      var act = el("div", "actions");
      var decide = function (label, cls, status) {
        var b = el("button", "btn " + cls, label); b.type = "button"; b.disabled = busy;
        b.addEventListener("click", function () {
          adm.onPatch(d.id, { status: status, decided_at: new Date().toISOString(), note: ni.value || "" })
            .then(function (ok) { if (ok) delete adm.drafts[d.id]; });
        });
        act.appendChild(b);
      };
      if (d.status === "pending") { decide("Approve", "primary", "approved"); decide("Reject", "reject", "rejected"); }
      else { decide("Back to queue", "", "pending"); if (d.status === "approved") decide("Reject", "reject", "rejected"); else decide("Approve", "primary", "approved"); }
      c.appendChild(act);
      if (adm.busy[d.id] === "err") c.appendChild(el("p", "err", "Could not save. Try again."));
    }
    return c;
  };

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
  var editor = null, skOpts = null;
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
      $("sk").hidden = false;
      if (!editor) {
        try {
          if (!window.OCL || !OCL.StructureEditor) throw new Error("no editor");
          editor = OCL.StructureEditor.createSVGEditor("sk-editor", 1);
          if (editor.setChangeListenerCallback) editor.setChangeListenerCallback(function () { var s = editorSmiles(); if (s) $("sk-smiles").value = s; });
        } catch (e) { editor = null; skMsg("The sketcher is not available in this browser. You can still type the SMILES by hand."); }
      }
      if (editor) { try { editor.setSmiles(opts.smiles || ""); } catch (e) { if (opts.smiles) skMsg("This SMILES could not be drawn."); } }
    },
    close: function () { $("sk").hidden = true; skOpts = null; },
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
  api.adminPatch = function (id, patch) {
    return authed(function (t) {
      return fetch(base + "/rest/v1/entries?id=eq." + encodeURIComponent(id),
        { method: "PATCH", headers: headers(t, { Prefer: "return=representation" }), body: JSON.stringify(patch) }).then(asJson);
    });
  };
})();
