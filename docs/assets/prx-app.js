/* PhotoreDBox public page: browse approved redox potentials, search, PhotoTool, submit, and the
   curator sign-in bridge. Same backend, login and rules as TrEnDB (app.js); the data are the rows
   of public_redox. Triplet energies are read only to offer E0,0 of a triplet. */
(function () {
  "use strict";
  var $ = Ent.$, el = Ent.el, api = Ent.api, RS = EntScore.redox;
  var state = {
    docs: [], redox: [], view: "db", section: "db", toolsRoute: { tool: "", data: "" }, dataVer: 0, loaded: false, failed: false, failDetail: "",
    access: null, isAdmin: false, gated: false, curatorModal: false, triage: "",
    search: Ent.newSearch("received-desc")
  };
  var ACCESS_KEY = "entdb-access";   /* the same shared login as TrEnDB, kept for the browser tab only */
  function readAccess() { try { return JSON.parse(sessionStorage.getItem(ACCESS_KEY) || "null"); } catch (e) { return null; } }
  function saveAccess(a) { try { if (a) sessionStorage.setItem(ACCESS_KEY, JSON.stringify(a)); else sessionStorage.removeItem(ACCESS_KEY); } catch (e) {} }

  Ent.initTheme("theme-toggle");

  function syncAuthUi() {
    $("go-admin").hidden = !state.isAdmin;
    var ce = $("curator-email"), em = state.isAdmin && api.sessionEmail ? api.sessionEmail() : "";
    ce.textContent = em || (state.isAdmin ? "Curator" : ""); ce.hidden = !state.isAdmin;
    $("pub-signin").hidden = state.isAdmin || state.gated || !api.configured;
    $("lock").hidden = !(state.gated || state.isAdmin);
  }

  /* ---------- sections: Home, Database, Tools (the address holds where you are) ---------- */
  function readRoute() {
    var h = (location.hash || "").replace(/^#/, ""), parts = h.split("/");
    if (parts[0] === "db") { state.section = "db"; state.view = "db"; }
    else if (parts[0] === "submit") { state.section = "db"; state.view = "submit"; }
    else if (parts[0] === "mol") {
      state.section = "db"; state.view = "mol";
      var raw = parts.slice(1).join("/");
      try { state.molKey = decodeURIComponent(raw); } catch (e) { state.molKey = raw; }
    }
    else if (parts[0] === "tools") { state.section = "tools"; state.toolsRoute = { tool: parts[1] || "", data: parts.slice(2).join("/") }; }
    else if (parts[0] === "home") { location.replace("../index.html#home"); }   /* the home is common to both sites */
    else { state.section = "db"; state.view = "db"; }
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else { readRoute(); render(); } }
  window.addEventListener("hashchange", function () {
    var was = state.section === "db" ? state.view : "";
    if (was === "db") state.listScroll = window.scrollY;
    readRoute();
    if (state.view === "mol") state.cameFromList = was === "db";
    render();
    window.scrollTo(0, was === "mol" && state.section === "db" && state.view === "db" ? (state.listScroll || 0) : 0);
  });
  var toolsCtx = {
    docs: function () { return state.docs; },
    redox: function () { return state.redox; },
    loaded: function () { return state.loaded; },
    failed: function () { return state.failed; },
    version: function () { return state.dataVer; },
    base: "#tools"
  };
  function renderSections() {
    var sec = state.section;
    Array.prototype.forEach.call(document.querySelectorAll("#sections a"), function (a) {
      if (a.getAttribute("data-sec") === sec) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    $("tools-view").hidden = sec !== "tools";
    $("db-section").hidden = sec !== "db";
    if (sec === "tools") { readRoute(); window.EntRedox.render($("tools-view"), state.toolsRoute, toolsCtx); }
    return sec === "db";
  }

  /* ---------- quick filter pills & database summary (as on TrEnDB) ---------- */
  function multiValueSet(rows) {
    var set = {};
    Ent.groupByMolecule(rows).forEach(function (items) { if (items.length > 1) items.forEach(function (d) { set[d.id] = 1; }); });
    return set;
  }
  var TRIAGE_PRED = {
    exp: function (d) { return d.origin !== "calc"; },
    calc: function (d) { return d.origin === "calc"; },
    pc: function (d) { return d.category === "photocatalyst"; },
    sub: function (d) { return d.category === "substrate"; },
    excited: function (d) { return !!d.state && d.state !== "S0"; }
  };
  function summary(rows, multiSet) {
    var exp = rows.filter(function (d) { return d.origin !== "calc"; }).length;
    $("st-mols").textContent = Ent.groupByMolecule(rows).length;
    $("st-vals").textContent = rows.length;
    $("st-exp").textContent = exp;
    $("st-calc").textContent = rows.length - exp;
    var counts = { "": rows.length, multi: 0 };
    Object.keys(TRIAGE_PRED).forEach(function (k) { counts[k] = rows.filter(TRIAGE_PRED[k]).length; });
    rows.forEach(function (d) { if (multiSet && multiSet[d.id]) counts.multi++; });
    if (state.triage && !counts[state.triage]) state.triage = "";
    Array.prototype.forEach.call($("triage-bar").querySelectorAll(".pill"), function (btn) {
      var k = btn.getAttribute("data-triage"), cnt = counts[k] || 0;
      var badge = btn.querySelector(".n"); if (badge) badge.textContent = cnt;
      btn.hidden = k !== "" && cnt === 0 && state.triage !== k;
      btn.setAttribute("aria-pressed", String((state.triage || "") === k));
    });
  }
  $("triage-bar").addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".pill") : null;
    if (!btn) return;
    state.triage = btn.getAttribute("data-triage") || "";
    state.search.pager.shown = 0;
    render();
  });
  $("f-reset").addEventListener("click", function () { state.triage = ""; });
  function render() {
    if (!renderSections()) return;
    var rows = state.redox;
    $("n-db").textContent = rows.length;
    Ent.fillClasses(rows, state.search);
    var sub = state.view === "submit", mol = state.view === "mol", list = $("list"), status = $("status");
    $("tab-db").setAttribute("aria-selected", String(!sub));
    $("tab-submit").setAttribute("aria-selected", String(sub));
    $("db-view").hidden = sub || mol;
    $("pub-toggle-aside").hidden = sub || mol;
    $("form").hidden = !sub;
    $("mol-view").hidden = !mol;
    if (!mol) document.title = BASE_TITLE;
    if (sub) { status.hidden = true; updateForm(); return; }
    if (mol) { renderMolPage(); return; }
    if (!state.loaded) {
      summary([], {}); status.hidden = false; list.replaceChildren();
      status.textContent = state.failed
        ? ("The database could not be loaded" + (state.failDetail ? " (" + state.failDetail + "). " : ". ") + "Reload the page to try again.")
        : "Loading the database…";
      return;
    }
    var multiSet = multiValueSet(rows);
    summary(rows, multiSet);
    var res = Ent.filterRows(rows, state.search);
    if (state.triage === "multi") res.rows = res.rows.filter(function (d) { return !!multiSet[d.id]; });
    else if (state.triage && TRIAGE_PRED[state.triage]) res.rows = res.rows.filter(TRIAGE_PRED[state.triage]);
    Ent.searchInfo(res, rows.length);
    Ent.drawList(list, Ent.groupByMolecule(res.rows), function (items) {
      return Ent.moleculeSummary(items, { scores: res.scores, simMode: state.search.ss.mode === "sim" });
    }, state.search.pager, render);
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = rows.length ? "No entry matches the current search and filters."
        : "No redox potentials have been approved yet. Use “Submit entry” to propose the first one.";
    }
  }

  /* ---------- a molecule's own page ---------- */
  var BASE_TITLE = document.title;
  function renderMolPage() {
    var host = $("mol-view"), back = el("button", "btn small mol-back", "← Back to database");
    back.type = "button";
    back.addEventListener("click", function () { if (state.cameFromList) history.back(); else go("#db"); });
    document.title = BASE_TITLE;
    var nodes = [back], items = state.loaded ? Ent.findMolecule(state.redox, state.molKey) : null;
    if (!state.loaded) nodes.push(el("p", "status", state.failed ? "The database could not be loaded. Reload the page to try again." : "Loading the database…"));
    else if (!items && /^id:/.test(state.molKey || "") && !window.OCL) nodes.push(el("p", "status", "Loading the structure library…"));
    else if (!items) nodes.push(el("p", "status", "This molecule is not in the database. It may have been removed, or merged with another entry."));
    else {
      var card = Ent.moleculeCard(items, { onSuggest: openSuggest });
      nodes.push(card);
      var h = card.querySelector("h2");
      document.title = (h ? h.textContent + " · " : "") + "PhotoreDBox";
    }
    host.replaceChildren.apply(host, nodes);
  }

  /* ---------- submission form (one redox potential) ---------- */
  var MOL_FIELDS = ["name", "commercial_name", "cas", "cls", "smiles", "cite", "doi", "loc", "quote", "by", "website"];
  var REDOX_FIELDS = ["kind", "state", "couple", "e", "unit", "unc", "ref", "origin", "e_type", "excited_from", "e00", "e00_note",
                      "tech", "solvent", "electrolyte", "temp", "func", "basis", "solv", "category", "activated_group", "uv_lmax", "tau_ns"];
  RS.REFS.forEach(function (r) { $("fm-r-ref").appendChild(new Option(r === "other" ? "Other (not convertible)" : r, r)); });
  function payload() {
    var p = { property: "redox" };
    MOL_FIELDS.forEach(function (k) { p[k] = $("fm-" + k).value; });
    REDOX_FIELDS.forEach(function (k) { p[k] = $("fm-r-" + k).value; });
    return p;
  }
  function context(f) {
    var ok = Ent.structureOk(f.smiles), same = null;
    if (ok) { var id = Ent.idCode(f.smiles); same = state.redox.filter(function (d) { return Ent.idCode(d.smiles) === id; }); }
    return { structureOk: ok, doiResolves: null, same: same };
  }
  /* E0,0 of a triplet: the molecule's measured triplet energy, when the database has one */
  function tripletE00(smiles) {
    if (!Ent.structureOk(smiles)) return null;
    var id = Ent.idCode(smiles), vals = state.docs.filter(function (d) { return Ent.idCode(d.smiles) === id && d.origin !== "calc"; })
      .map(function (d) { return Number(d.et_kcal); }).filter(isFinite);
    if (!vals.length) return null;
    var kcal = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    return { ev: Math.round(kcal / 23.0605 * 100) / 100, kcal: kcal, n: vals.length };
  }
  $("fm-r-calc").addEventListener("click", function () {
    var g = EntScore.num($("fm-r-ground").value), e00 = EntScore.num($("fm-r-e00").value);
    if (isNaN(g) || isNaN(e00)) { fmMsg("fm-err", "Give the ground-state potential and E₀,₀ to compute E*."); return; }
    /* E*red = Ered + E0,0; E*ox = Eox − E0,0 */
    var v = $("fm-r-kind").value === "ox" ? g - e00 : g + e00;
    $("fm-r-e").value = String(Math.round(v * 1000) / 1000); $("fm-r-unit").value = "v";
    $("fm-r-excited_from").value = "estimated";
    fmMsg(); updateForm();
  });
  function updateForm() {
    var f = RS.normalize(payload()), ctx = context(f);
    var calc = f.origin === "calc", excited = f.state !== "S0";
    $("fm-r-exp").hidden = calc; $("fm-r-calc-fs").hidden = !calc; $("fm-r-excited").hidden = !excited;
    var hint = $("fm-r-e00-hint"), t = excited && f.state === "T1" ? tripletE00(f.smiles) : null;
    hint.hidden = !t;
    if (t) {
      hint.replaceChildren(Ent.elT("span", null, "This molecule's measured E_T is " + Ent.fmt(t.ev, 2) + " eV (" + Ent.fmt(t.kcal, 1) + " kcal/mol" + (t.n > 1 ? ", mean of " + t.n : "") + "). "));
      var use = el("button", "btn small", "Use it as E₀,₀"); use.type = "button";
      use.addEventListener("click", function () {
        $("fm-r-e00").value = String(t.ev);
        if (!$("fm-r-e00_note").value) $("fm-r-e00_note").value = "Triplet energy (E_T)";
        updateForm();
      });
      hint.appendChild(use);
    }
    var info = f.smiles ? Ent.molInfo(f.smiles) : null, pv = $("fm-preview");
    if (info) { pv.innerHTML = info.svg; $("fm-formula").textContent = info.formula; }
    else { pv.textContent = !f.smiles ? "Type a SMILES or draw the structure" : window.OCL ? "SMILES could not be read" : "Drawing not available"; $("fm-formula").textContent = ""; }
    var known = f.smiles || f.cas || f.name ? Ent.duplicates({ id: "__form", name: f.name, cas: f.cas, smiles: f.smiles }, state.redox, []) : null, kn = $("fm-known");
    if (known && (known.db.length || known.stereo.length)) {
      kn.hidden = false;
      kn.textContent = known.db.length
        ? "Already in the database: " + known.db.map(function (m) {
          var q = Ent.REDOX_QTY.filter(function (x) { return x.id === Ent.redoxQuantity(m.entry); })[0];
          return Ent.displayName(m.entry) + " (" + Ent.fmtV(Number(m.entry.e_v)) + " V vs " + m.entry.e_ref + ", " + (q ? q.name.toLowerCase() : "") + ", " + m.why + ")";
        }).join("; ") + ". A different value (another paper, state or method) is welcome: it appears beside the existing ones. To fix an existing value, use “Suggest a correction” on its card."
        : "A different stereoisomer is in the database (" + known.stereo.map(function (e) { return Ent.displayName(e); }).join("; ") + "). Check the E/Z or R/S assignment.";
    } else kn.hidden = true;
    var sc = RS.scoreEntry(f, ctx), g = EntScore.gradeOf(sc.total);
    $("fm-score").textContent = sc.total; $("fm-grade").textContent = g.label; $("fm-grade").className = "chip " + g.cls;
    var ul = $("fm-items");
    ul.replaceChildren.apply(ul, sc.items.map(function (i) {
      var li = el("li", i.got === i.max ? "full" : i.got === 0 ? "zero" : ""); li.appendChild(el("span", "pts", i.got + "/" + i.max));
      var tx = Ent.elT("span", null, i.label); if (i.note) tx.appendChild(Ent.elT("small", null, i.note)); li.appendChild(tx); return li;
    }));
    return { f: f, ctx: ctx };
  }
  function fmMsg(id, t) { ["fm-err", "fm-ok"].forEach(function (x) { $(x).hidden = true; }); if (t) { $(id).textContent = t; $(id).hidden = false; } }
  $("form").addEventListener("input", function () { fmMsg(); updateForm(); });
  $("form").addEventListener("change", function () { updateForm(); });
  $("fm-iupac").appendChild(Ent.iupacLookup($("fm-name"), function () { return $("fm-smiles").value; }));
  $("fm-draw").addEventListener("click", function () {
    Ent.sketcher.open({
      title: "Sketcher · new entry", smiles: $("fm-smiles").value.trim(), saveLabel: "Use this structure",
      hint: "Draw the molecule, then use it in the form.",
      onSave: function (s) { $("fm-smiles").value = s; updateForm(); return true; }
    });
  });
  $("fm-reset").addEventListener("click", function () { $("form").reset(); fmMsg(); updateForm(); });
  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var u = updateForm(), miss = RS.requiredError(u.f, u.ctx);
    if (miss) { fmMsg("fm-err", miss); return; }
    $("fm-submit").disabled = true; fmMsg();
    var p = payload(); p.access_user = (state.access && state.access.user) || ""; p.access_pass = (state.access && state.access.pass) || "";
    api.submit(p).then(function (r) {
      $("fm-submit").disabled = false; $("form").reset(); updateForm();
      fmMsg("fm-ok", "Sent for review with a score of " + r.score + " (" + r.grade + "). It will appear in the database once two curators approve it.");
      Ent.toast("Entry sent for review (score " + r.score + " · " + r.grade + ").");
    }, function (err) {
      $("fm-submit").disabled = false;
      if (err.status === 401) { lock("Your access is no longer valid. Sign in again."); return; }
      fmMsg("fm-err", err.status === 429 ? "Too many submissions from this connection. Try again in an hour."
        : err.status === 400 ? err.message : "The entry could not be sent. Try again in a moment.");
    });
  });

  /* ---------- suggesting a correction to a value in the database ---------- */
  var LONG = { quote: 1, conditions: 1, method: 1, citation: 1, evidence: 1, e_reported: 1 };
  var CHOICES = {
    origin: [["exp", "Experiment"], ["calc", "Computation"]],
    kind: [["red", "Reduction"], ["ox", "Oxidation"]],
    state: [["S0", "Ground state"], ["S1", "Excited singlet (S1)"], ["T1", "Excited triplet (T1)"]],
    excited_from: [["", "Not stated"], ["direct", "Measured directly"], ["estimated", "Estimated from E + E0,0"]],
    category: [["", "Not stated"], ["photocatalyst", "Photocatalyst"], ["substrate", "Substrate"]]
  };
  var NUMERIC = { e: 1, unc_v: 1, e00: 1, tau: 1, lmax: 1 };
  function differs(type, now, val) {
    var t = String(val).trim();
    if (NUMERIC[type]) { if (t === "" || now === "") return t !== now; return EntScore.num(t) !== Number(now); }
    if (type === "cas") return EntScore.cleanCas(t) !== now;
    if (type === "doi") return EntScore.cleanDoi(t).toLowerCase() !== now.toLowerCase();
    return t !== now.trim();
  }
  function openSuggest(d) {
    Ent.dialog("Suggest a correction · " + Ent.displayName(d), function (box) {
      box.classList.add("ed-box");
      var oldTitle = box.querySelector("h2"), head = el("div", "ed-head"), closeX = el("button", "btn small", "Close");
      closeX.type = "button"; closeX.addEventListener("click", Ent.closeDialog);
      head.appendChild(oldTitle); head.appendChild(closeX);
      var body = el("div", "ed-body");
      if (d.smiles) {
        var st = el("div", "ed-struct"), paper = el("div", "paper"), si = el("div", "sinfo"), info = Ent.molInfo(d.smiles);
        if (info) { paper.innerHTML = info.svg; si.appendChild(el("span", "formula", info.formula)); } else paper.textContent = "Structure";
        si.appendChild(el("code", "smiles", d.smiles)); st.appendChild(paper); st.appendChild(si); body.appendChild(st);
      }
      body.appendChild(el("p", "hint", "Change any fields that are wrong or missing; changed fields highlight. Two curators compare old and new values before anything changes. The value against SCE is recomputed from the reported value, its reference and the solvent."));
      var grid = el("div", "sugg-grid"), inputs = [];
      RS.SUGGEST_FIELDS.forEach(function (f) {
        var k = f[0], type = f[2], now = d[k] == null ? "" : String(d[k]), lab = el("label", "field"), inp;
        lab.appendChild(Ent.elT("span", null, f[1].replace(" (structure)", "")));
        if (CHOICES[type] || type === "ref") {
          inp = el("select");
          (type === "ref" ? RS.REFS.map(function (r) { return [r, r]; }) : CHOICES[type]).forEach(function (o) { inp.appendChild(new Option(o[1], o[0])); });
        } else if (LONG[k]) { inp = el("textarea"); inp.rows = 2; inp.maxLength = 500; }
        else { inp = el("input"); inp.type = "text"; inp.maxLength = type === "text" ? 500 : 400; }
        inp.value = now;
        if (type === "doi") inp.placeholder = "10.xxxx/…";
        var was = el("small", "was"); was.hidden = true;
        lab.appendChild(inp); lab.appendChild(was);
        if (LONG[k] || k === "smiles" || k === "name" || k === "commercial_name") lab.classList.add("wide");
        var sync = function () { var ch = differs(type, now, inp.value); lab.classList.toggle("changed", ch); was.hidden = !ch; was.textContent = "Now: " + (now === "" ? "(empty)" : now); };
        inp.addEventListener("input", sync); inp.addEventListener("change", sync);
        inputs.push({ k: k, type: type, now: now, inp: inp });
        grid.appendChild(lab);
      });
      body.appendChild(grid);
      var lc = el("label", "field", "What is wrong, and where does the correct value come from? (required)"), com = el("textarea"); com.rows = 3; com.maxLength = 1000; lc.appendChild(com); body.appendChild(lc);
      var lb = el("label", "field", "Your name or contact (optional, seen only by curators)"), by = el("input"); by.type = "text"; by.maxLength = 120; lb.appendChild(by); body.appendChild(lb);
      var hp = el("div", "hp"); hp.setAttribute("aria-hidden", "true"); var hpi = el("input"); hpi.type = "text"; hpi.tabIndex = -1; hpi.autocomplete = "off"; hp.appendChild(hpi); body.appendChild(hp);
      var foot = el("div", "ed-foot"), err = el("p", "err"), okm = el("p", "ok");
      err.hidden = true; err.setAttribute("role", "alert"); okm.hidden = true; foot.appendChild(err); foot.appendChild(okm);
      var act = el("div", "actions"), send = el("button", "btn primary", "Send the suggestion"), close = el("button", "btn", "Close");
      send.type = close.type = "button"; act.appendChild(send); act.appendChild(close); foot.appendChild(act);
      box.replaceChildren(head, body, foot);
      close.addEventListener("click", Ent.closeDialog);
      send.addEventListener("click", function () {
        var changes = {};
        inputs.forEach(function (x) { if (differs(x.type, x.now, x.inp.value)) changes[x.k] = x.inp.value; });
        if (!Object.keys(changes).length) { err.textContent = "Change at least one field."; err.hidden = false; return; }
        var chk = RS.checkSuggestion(changes);
        if (chk.error) { err.textContent = chk.error; err.hidden = false; return; }
        if (!com.value.trim()) { err.textContent = "Explain briefly what is wrong and where the correct value comes from."; err.hidden = false; com.focus(); return; }
        err.hidden = true; send.disabled = true;
        api.submit({ kind: "suggestion", redox_id: d.id, changes: chk.clean, comment: com.value, by: by.value, website: hpi.value,
          access_user: (state.access && state.access.user) || "", access_pass: (state.access && state.access.pass) || "" })
          .then(function (r) {
            if (!r || !r.suggestion) throw { status: 409 };
            okm.textContent = "Thank you. Two curators will review the " + Object.keys(chk.clean).length + " suggested change(s); the value changes only if they are approved.";
            okm.hidden = false; send.hidden = true; Ent.toast("Suggestion sent for review.");
          }).catch(function (e) {
            send.disabled = false;
            err.textContent = e.status === 429 ? "Too many submissions from this connection. Try again in an hour."
              : e.status === 401 ? "Your access is no longer valid. Reload the page and sign in again."
              : e.status === 400 ? e.message : "The suggestion could not be sent. Try again in a moment.";
            err.hidden = false;
          });
      });
    });
  }

  /* ---------- tabs, aside toggle & shortcuts ---------- */
  Array.prototype.forEach.call(document.querySelectorAll(".tab[data-view]"), function (t) {
    t.addEventListener("click", function () { go(t.getAttribute("data-view") === "submit" ? "#submit" : "#db"); });
  });
  $("pub-go-submit").addEventListener("click", function () { go("#submit"); });
  $("pub-toggle-aside").addEventListener("click", function () {
    var aside = $("pub-aside"), open = !aside.classList.contains("open");
    aside.classList.toggle("open", open); $("pub-toggle-aside").setAttribute("aria-expanded", String(open));
  });
  Ent.bindSearch(state.search, render);
  Ent.sketcher.bind();
  Ent.loadOCL(function () { state.dataVer++; render(); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.section !== "db" || state.view !== "db" || $("app-body").hidden) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault(); $("q").focus();
  });

  /* ---------- offline copy of the public values (kept on this device, cleared at sign-out) ---------- */
  var OFFLINE_KEY = "photoredbox-offline-copy";
  function saveOffline() { try { localStorage.setItem(OFFLINE_KEY, JSON.stringify({ at: new Date().toISOString(), redox: state.redox, docs: state.docs })); } catch (e) {} }
  function readOffline() { try { var c = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "null"); return c && Array.isArray(c.redox) ? c : null; } catch (e) { return null; } }
  function dropOffline() { try { localStorage.removeItem(OFFLINE_KEY); } catch (e) {} }
  function showOffline(copy) {
    var n = $("offline-note");
    if (!copy) { n.hidden = true; return; }
    n.textContent = "Offline: showing the copy saved on this device on " + new Date(copy.at).toLocaleString() + ". Submitting and suggesting need a connection.";
    n.hidden = false;
  }
  function openOffline(copy) {
    state.access = null; state.gated = false; state.isAdmin = false; state.curatorModal = false;
    $("gate").hidden = true; $("app-body").hidden = false; syncAuthUi();
    state.redox = copy.redox; state.docs = Array.isArray(copy.docs) ? copy.docs : []; state.loaded = true; state.failed = false; state.dataVer++;
    showOffline(copy); readRoute(); render();
  }
  window.addEventListener("online", function () { if (!$("offline-note").hidden) location.reload(); });

  /* ---------- access gate & curator bridge (same accounts as TrEnDB) ---------- */
  function gate(title, text, withForm, err, isCuratorModal) {
    state.curatorModal = !!isCuratorModal;
    $("app-body").hidden = true; $("gate").hidden = false;
    $("gate-title").textContent = title; $("gate-text").textContent = text; $("gate-fields").hidden = !withForm;
    $("gate-user-text").textContent = isCuratorModal ? "Curator email" : "User or curator email";
    $("gate-cancel").hidden = !isCuratorModal;
    $("gate-err").hidden = !err; $("gate-err").textContent = err || "";
    syncAuthUi();
  }
  function loginGate(err) {
    if (state.curatorModal) { gate("Curator sign-in", "Sign in with your curator email and password to unlock the admin shortcut.", true, err, true); return; }
    gate("Sign in", "PhotoreDBox is in private preview. Sign in with the preview user name and password, or with your curator email and password.", true, err, false);
  }
  function cancelCuratorGate() { state.curatorModal = false; $("gate-pass").value = ""; $("gate").hidden = true; $("app-body").hidden = false; syncAuthUi(); }
  function lock(msg) {
    saveAccess(null); api.signOut();
    state.access = null; state.isAdmin = false; state.gated = false; state.curatorModal = false;
    state.docs = []; state.redox = []; state.loaded = false; state.dataVer++; $("gate-pass").value = ""; dropOffline(); showOffline(null);
    syncAuthUi();
    if (msg) loginGate(msg); else tryAccess({ user: "", pass: "" }, false);
  }
  function openApp(a, gated, isAdmin) {
    var alreadyLoaded = state.loaded && state.curatorModal;
    state.access = a; state.gated = !!gated; state.isAdmin = !!isAdmin; state.curatorModal = false;
    $("gate").hidden = true; $("app-body").hidden = false; syncAuthUi();
    if (alreadyLoaded) { Ent.toast("Signed in as curator. You can open the admin page from the top bar."); return; }
    state.loaded = false; state.failed = false; state.failDetail = ""; readRoute(); render();
    Promise.all([api.listRedox(a, !!isAdmin), api.listPublic(a, !!isAdmin).catch(function () { return []; })]).then(function (res) {
      state.redox = res[0] || []; state.docs = res[1] || []; state.loaded = true; state.dataVer++;
      saveOffline(); showOffline(null); render();
    }, function (err) {
      var copy = readOffline();
      if (copy && !(err && err.status)) { openOffline(copy); return; }
      state.failed = true; state.failDetail = (err && err.message) || ""; state.dataVer++; render();
    });
  }
  function tryAccess(a, fromForm) {
    return api.checkAccess(a).then(function (ok) {
      if (ok === true) { if (fromForm) saveAccess(a); openApp(a, !!(a.user || a.pass), false); }
      else { if (!fromForm) saveAccess(null); loginGate(fromForm ? "Wrong user name or password." : ""); }
    }, function () {
      var copy = readOffline();
      if (copy) { openOffline(copy); return; }
      gate("Unavailable", "The database could not be reached. Check the connection and reload the page.", false, "", false);
    });
  }
  $("gate").addEventListener("submit", function (e) {
    e.preventDefault();
    var u = $("gate-user").value.trim(), p = $("gate-pass").value;
    if (!u || !p) { loginGate(state.curatorModal ? "Enter your email and password." : "Enter both the user name and the password."); return; }
    $("gate-send").disabled = true;
    if (state.curatorModal || /^\S+@\S+\.\S+$/.test(u)) {
      api.signIn(u, p).then(function () {
        return api.isAdmin().then(function (ok) {
          $("gate-send").disabled = false;
          if (ok === true) { $("gate-pass").value = ""; openApp(null, false, true); return; }
          api.signOut();
          if (state.curatorModal) { loginGate("This address is not a curator of this database."); return; }
          return tryAccess({ user: u, pass: p }, true);
        }, function () { $("gate-send").disabled = false; loginGate("Could not verify curator status. Try again."); });
      }, function (err) {
        $("gate-send").disabled = false;
        if (state.curatorModal) {
          loginGate(err && (err.status === 400 || err.status === 401) ? "Wrong email or password." : err && err.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Sign-in failed. Try again.");
          return;
        }
        tryAccess({ user: u, pass: p }, true);
      });
      return;
    }
    tryAccess({ user: u, pass: p }, true).then(function () { $("gate-send").disabled = false; });
  });
  $("gate-cancel").addEventListener("click", cancelCuratorGate);
  $("pub-signin").addEventListener("click", function () { $("gate-user").value = ""; $("gate-pass").value = ""; state.curatorModal = true; loginGate(""); $("gate-user").focus(); });
  $("lock").addEventListener("click", function (e) { e.preventDefault(); lock(""); });

  /* installable app: the site's one service worker, one level up */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("../sw.js").catch(function () {}); });
  }

  function boot() {
    if (!api.configured) { gate("Private preview", "PhotoreDBox is not open yet.", false, "", false); return; }
    api.token().then(function (t) {
      if (!t) return false;
      return api.isAdmin().then(function (ok) { if (ok === true) return true; api.signOut(); return false; }, function () { return false; });
    }).then(function (adminOk) {
      if (adminOk) { openApp(null, false, true); return; }
      return tryAccess(readAccess() || { user: "", pass: "" }, false);
    });
  }
  boot();
})();
