/* TrEnDB public page: browse approved entries, search, submit, and curator sign-in bridge. */
(function () {
  "use strict";
  var $ = Ent.$, el = Ent.el, api = Ent.api;
  var state = {
    docs: [], view: "db", section: "home", plotRoute: { tool: "", data: "" }, dataVer: 0, triage: "", loaded: false, failed: false, failDetail: "",
    access: null, isAdmin: false, gated: false, curatorModal: false,
    search: Ent.newSearch("received-desc"),
    slideSel: {}, slideOrder: []
  };
  var ACCESS_KEY = "entdb-access";   /* kept for the browser tab only */
  function readAccess() { try { return JSON.parse(sessionStorage.getItem(ACCESS_KEY) || "null"); } catch (e) { return null; } }
  function saveAccess(a) { try { if (a) sessionStorage.setItem(ACCESS_KEY, JSON.stringify(a)); else sessionStorage.removeItem(ACCESS_KEY); } catch (e) {} }

  Ent.initTheme("theme-toggle");

  function syncAuthUi() {
    $("go-admin").hidden = !state.isAdmin;
    var ce = $("curator-email");
    var em = state.isAdmin && api.sessionEmail ? api.sessionEmail() : "";
    ce.textContent = em || (state.isAdmin ? "Curator" : "");
    ce.hidden = !state.isAdmin;
    $("pub-signin").hidden = state.isAdmin || state.gated || !api.configured;
    $("lock").hidden = !(state.gated || state.isAdmin);
  }

  /* ---------- Quick filter pills & database summary ---------- */
  function multiValueSet(docs) {
    var set = {};
    Ent.groupByMolecule(docs).forEach(function (items) {
      if (items.length > 1) items.forEach(function (d) { set[d.id] = 1; });
    });
    return set;
  }
  var TRIAGE_PRED = {
    exp: function (d) { return d.origin !== "calc"; },
    calc: function (d) { return d.origin === "calc"; },
    donor: function (d) { return d.role === "donor" || d.role === "both"; },
    acceptor: function (d) { return d.role === "acceptor" || d.role === "both"; },
    uv: function (d) { return !!EntScore.formatUv(d); }
  };
  function updateSummaryAndPills(docs, multiSet) {
    var molGroups = Ent.groupByMolecule(docs);
    var expN = 0, calcN = 0;
    var counts = { "": docs.length, exp: 0, calc: 0, donor: 0, acceptor: 0, multi: 0, uv: 0 };
    docs.forEach(function (d) {
      if (d.origin === "calc") calcN++; else expN++;
      if (TRIAGE_PRED.exp(d)) counts.exp++;
      if (TRIAGE_PRED.calc(d)) counts.calc++;
      if (TRIAGE_PRED.donor(d)) counts.donor++;
      if (TRIAGE_PRED.acceptor(d)) counts.acceptor++;
      if (multiSet[d.id]) counts.multi++;
      if (TRIAGE_PRED.uv(d)) counts.uv++;
    });
    $("st-mols").textContent = molGroups.length;
    $("st-vals").textContent = docs.length;
    $("st-exp").textContent = expN;
    $("st-calc").textContent = calcN;

    if (state.triage && !counts[state.triage]) state.triage = "";
    Array.prototype.forEach.call($("triage-bar").querySelectorAll(".pill"), function (btn) {
      var k = btn.getAttribute("data-triage"), cnt = counts[k] || 0;
      var badge = btn.querySelector(".n"); if (badge) badge.textContent = cnt;
      btn.hidden = k !== "" && cnt === 0 && state.triage !== k;
      btn.setAttribute("aria-pressed", String(state.triage === k));
    });
  }
  $("triage-bar").addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".pill") : null;
    if (!btn) return;
    state.triage = btn.getAttribute("data-triage") || "";
    state.search.pager.shown = 0;
    render();
  });

  function syncSlideBar() {
    var bar = $("slide-bar");
    if (!bar) return;
    var n = state.slideOrder.length;
    bar.hidden = state.view === "submit" || state.section !== "db" || !n;
    if (!n) return;
    $("slide-count").textContent = n + (n === 1 ? " molecule for slide" : " molecules for slide");
    var chips = $("slide-chips");
    chips.replaceChildren();
    state.slideOrder.forEach(function (key) {
      var it = state.slideSel[key];
      if (!it) return;
      var label = Ent.slideDefaultLabel ? Ent.slideDefaultLabel(it.commercial_name || it.name) : (it.commercial_name || it.name);
      var chip = el("button", "chip slide-chip", label + " ×");
      chip.type = "button"; chip.title = "Remove from slide selection";
      chip.addEventListener("click", function () { toggleSlideItem(it); });
      chips.appendChild(chip);
    });
  }
  function toggleSlideItem(item) {
    var k = item.key;
    if (state.slideSel[k]) {
      delete state.slideSel[k];
      state.slideOrder = state.slideOrder.filter(function (x) { return x !== k; });
    } else {
      state.slideSel[k] = item;
      state.slideOrder.push(k);
    }
    syncSlideBar();
    render();
  }
  $("slide-open").addEventListener("click", function () {
    var items = state.slideOrder.map(function (k) { return state.slideSel[k]; }).filter(Boolean);
    if (items.length && Ent.slideGraphic) {
      Ent.slideGraphic.open(items, {
        onRemove: function (it) {
          delete state.slideSel[it.key];
          state.slideOrder = state.slideOrder.filter(function (x) { return x !== it.key; });
          syncSlideBar(); render();
        }
      });
    }
  });
  $("slide-clear").addEventListener("click", function () {
    state.slideSel = {}; state.slideOrder = [];
    syncSlideBar(); render();
  });

  /* ---------- sections: Home, Database, PlotEnT (the address holds where you are) ---------- */
  function readRoute() {
    var h = (location.hash || "").replace(/^#/, ""), parts = h.split("/");
    if (parts[0] === "db") { state.section = "db"; state.view = "db"; }
    else if (parts[0] === "submit") { state.section = "db"; state.view = "submit"; }
    else if (parts[0] === "mol") {
      state.section = "db"; state.view = "mol";
      var raw = parts.slice(1).join("/");
      try { state.molKey = decodeURIComponent(raw); } catch (e) { state.molKey = raw; }
    }
    else if (parts[0] === "plot") { state.section = "plot"; state.plotRoute = { tool: parts[1] || "", data: parts.slice(2).join("/") }; }
    else state.section = "home";
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else { readRoute(); render(); } }
  /* a molecule's page sits on top of the list: going back finds the list as it was, at the same height */
  window.addEventListener("hashchange", function () {
    var was = state.section === "db" ? state.view : "";
    if (was === "db") state.listScroll = window.scrollY;
    readRoute();
    if (state.view === "mol") state.cameFromList = was === "db";
    render();
    window.scrollTo(0, was === "mol" && state.section === "db" && state.view === "db" ? (state.listScroll || 0) : 0);
  });
  var plotCtx = {
    docs: function () { return state.docs; },
    loaded: function () { return state.loaded; },
    failed: function () { return state.failed; },
    version: function () { return state.dataVer; },
    searchDb: function (q) { go("#db"); $("q").value = q; state.search.q = q; render(); }
  };
  function renderSections() {
    var sec = state.section;
    Array.prototype.forEach.call(document.querySelectorAll("#sections a"), function (a) {
      if (a.getAttribute("data-sec") === sec) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    $("home-view").hidden = sec !== "home";
    $("plot-view").hidden = sec !== "plot";
    $("db-section").hidden = sec !== "db";
    if (sec === "home") {
      $("home-db-count").textContent = state.loaded
        ? state.docs.length + (state.docs.length === 1 ? " value" : " values") + " · " + Ent.groupByMolecule(state.docs).length + " molecules"
        : state.failed ? "Could not be loaded" : "Loading…";
    }
    if (sec === "plot") readRoute();   /* the tool keeps its latest settings in the address */
    if (sec === "plot") window.PlotEnT.render($("plot-view"), state.plotRoute, plotCtx);
    syncSlideBar();
    return sec === "db";
  }

  function render() {
    if (!renderSections()) return;
    $("n-db").textContent = state.docs.length;
    Ent.fillClasses(state.docs, state.search);
    var sub = state.view === "submit", mol = state.view === "mol", list = $("list"), status = $("status");
    $("tab-db").setAttribute("aria-selected", String(!sub));
    $("tab-submit").setAttribute("aria-selected", String(sub));
    $("db-view").hidden = sub || mol;
    $("pub-toggle-aside").hidden = sub || mol;
    $("form").hidden = !sub;
    $("mol-view").hidden = !mol;
    if (!mol) document.title = BASE_TITLE;
    syncSlideBar();
    if (sub) { status.hidden = true; updateForm(); return; }
    if (mol) { renderMolPage(); return; }
    if (!state.loaded) {
      updateSummaryAndPills([], {});
      status.hidden = false; list.replaceChildren();
      status.textContent = state.failed
        ? ("The database could not be loaded" + (state.failDetail ? " (" + state.failDetail + "). " : ". ") + "Reload the page to try again.")
        : "Loading the database…";
      return;
    }
    var multiSet = multiValueSet(state.docs);
    updateSummaryAndPills(state.docs, multiSet);

    var res = Ent.filterRows(state.docs, state.search);
    if (state.triage === "multi") res.rows = res.rows.filter(function (d) { return !!multiSet[d.id]; });
    else if (state.triage && TRIAGE_PRED[state.triage]) res.rows = res.rows.filter(TRIAGE_PRED[state.triage]);

    Ent.searchInfo(res, state.docs.length);
    /* one summary card per molecule, carrying every value that matches the search; it opens the molecule's page */
    Ent.drawList(list, Ent.groupByMolecule(res.rows), function (items) {
      return Ent.moleculeSummary(items, {
        scores: res.scores,
        simMode: state.search.ss.mode === "sim",
        isSlidePicked: function (key) { return !!state.slideSel[key]; },
        onSlideToggle: toggleSlideItem
      });
    }, state.search.pager, render);
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = state.docs.length ? "No entry matches the current search and filters."
        : "No entries have been approved yet. Use “Submit entry” to propose the first one.";
    }
  }

  /* ---------- a molecule's own page: the full card with every value it has in the database ---------- */
  var BASE_TITLE = document.title;
  function renderMolPage() {
    var host = $("mol-view"), back = el("button", "btn small mol-back", "← Back to database");
    back.type = "button";
    back.addEventListener("click", function () { if (state.cameFromList) history.back(); else go("#db"); });
    document.title = BASE_TITLE;
    var nodes = [back], items = state.loaded ? Ent.findMolecule(state.docs, state.molKey) : null;
    if (!state.loaded) {
      nodes.push(el("p", "status", state.failed ? "The database could not be loaded. Reload the page to try again." : "Loading the database…"));
    } else if (!items && /^id:/.test(state.molKey || "") && !window.OCL) {
      nodes.push(el("p", "status", "Loading the structure library…"));
    } else if (!items) {
      nodes.push(el("p", "status", "This molecule is not in the database. It may have been removed, or merged with another entry."));
    } else {
      var card = Ent.moleculeCard(items, {
        onSuggest: openSuggest,
        isSlidePicked: function (key) { return !!state.slideSel[key]; },
        onSlideToggle: toggleSlideItem
      });
      nodes.push(card);
      var h = card.querySelector("h2");
      document.title = (h ? h.textContent + " · " : "") + "TrEnDB";
    }
    host.replaceChildren.apply(host, nodes);
  }

  /* ---------- submission form ---------- */
  var FIELDS = ["name", "commercial_name", "cas", "cls", "smiles", "role", "et", "unit", "unc", "origin", "kind", "tech", "solvent", "temp",
                "func", "basis", "solv", "cite", "doi", "loc", "quote", "uv_lmax", "uv_eps", "uv_cond", "direct_src", "direct_nm",
                "usedoi", "usenote", "by", "website"];
  /* reactions the molecule was employed in: drawn with the reaction sketcher */
  var rxEd = Ent.reactionsEditor({
    substrate: function () { return $("fm-smiles").value.trim(); },
    name: function () { return $("fm-commercial_name").value.trim() || $("fm-name").value.trim() || "this molecule"; },
    defaultDoi: function () { return $("fm-usedoi").value.trim(); },
    defaultRole: function () { return $("fm-role").value; },
    max: EntScore.MAX_REACTIONS
  });
  $("fm-reactions").appendChild(rxEd.el);
  Ent.reactionCatalog = function () { return state.docs; };
  var lastSubstrate = "";
  function payload() { var p = {}; FIELDS.forEach(function (k) { p[k] = $("fm-" + k).value; }); p.reactions = rxEd.value(); return p; }
  function context(f) {
    var ok = Ent.structureOk(f.smiles), same = null;
    if (ok) { var id = Ent.idCode(f.smiles); same = state.docs.filter(function (d) { return Ent.idCode(d.smiles) === id; }); }
    return { structureOk: ok, doiResolves: null, same: same };
  }
  function updateForm() {
    var f = EntScore.normalize(payload()), ctx = context(f);
    if (f.smiles !== lastSubstrate) { lastSubstrate = f.smiles; rxEd.refresh(); }
    $("fm-exp").hidden = f.origin === "calc"; $("fm-calc").hidden = f.origin !== "calc";
    var info = f.smiles ? Ent.molInfo(f.smiles) : null, pv = $("fm-preview");
    if (info) { pv.innerHTML = info.svg; $("fm-formula").textContent = info.formula; }
    else { pv.textContent = !f.smiles ? "Type a SMILES or draw the structure" : window.OCL ? "SMILES could not be read" : "Drawing not available"; $("fm-formula").textContent = ""; }
    /* the molecule may already be in the database: say so before it is sent */
    var known = f.smiles || f.cas || f.name ? Ent.duplicates({ id: "__form", name: f.name, cas: f.cas, smiles: f.smiles }, state.docs, []) : null;
    var kn = $("fm-known");
    if (known && (known.db.length || known.stereo.length)) {
      kn.hidden = false;
      kn.textContent = known.db.length
        ? "Already in the database: " + known.db.map(function (m) { return Ent.displayName(m.entry) + " (" + Ent.fmt(Number(m.entry.et_kcal), 1) + " kcal/mol, " + m.why + ")"; }).join("; ") + ". A different value (another paper or method) is welcome: it will appear beside the existing ones on the molecule's card. To fix an existing value, use “Suggest a correction” on its card."
        : "A different stereoisomer is in the database (" + known.stereo.map(function (e) { return Ent.displayName(e); }).join("; ") + "). Check the E/Z or R/S assignment.";
    } else kn.hidden = true;
    var sc = EntScore.scoreEntry(f, ctx), g = EntScore.gradeOf(sc.total);
    $("fm-score").textContent = sc.total; $("fm-grade").textContent = g.label; $("fm-grade").className = "chip " + g.cls;
    var ul = $("fm-items");
    ul.replaceChildren.apply(ul, sc.items.map(function (i) {
      var li = el("li", i.got === i.max ? "full" : i.got === 0 ? "zero" : ""); li.appendChild(el("span", "pts", i.got + "/" + i.max));
      var t = Ent.elT("span", null, i.label); if (i.note) t.appendChild(Ent.elT("small", null, i.note)); li.appendChild(t); return li;
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
  $("fm-reset").addEventListener("click", function () { $("form").reset(); rxEd.reset(); fmMsg(); updateForm(); });
  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var u = updateForm();
    var miss = EntScore.requiredError(u.f, u.ctx) || rxEd.pending() || rxStructureError(u.f.reactions); if (miss) { fmMsg("fm-err", miss); return; }
    $("fm-submit").disabled = true; fmMsg();
    var p = payload(); p.access_user = (state.access && state.access.user) || ""; p.access_pass = (state.access && state.access.pass) || "";
    api.submit(p).then(function (r) {
      $("fm-submit").disabled = false;
      $("form").reset(); rxEd.reset(); updateForm();
      fmMsg("fm-ok", "Sent for review with a score of " + r.score + " (" + r.grade + "). It will appear in the database once a curator approves it.");
      Ent.toast("Entry sent for review (score " + r.score + " · " + r.grade + ").");
    }, function (err) {
      $("fm-submit").disabled = false;
      if (err.status === 401) { lock("Your access is no longer valid. Sign in again."); return; }
      fmMsg("fm-err", err.status === 429 ? "Too many submissions from this connection. Try again in an hour."
        : err.status === 400 ? err.message : "The entry could not be sent. Try again in a moment.");
    });
  });

  function rxStructureError(rx) {
    var bad = rx && rx.smiles ? rx.smiles.filter(function (s) { return Ent.structureOk(s) === false; })[0] : null;
    return bad ? "A structure in the reactions could not be read: " + bad : "";
  }

  /* ---------- suggesting a correction to an entry in the database ---------- */
  var LONG = { quote: 1, conditions: 1, method: 1, citation: 1, evidence: 1, et_type: 1 };
  function curText(d, k) {
    var v = d[k];
    if (v == null) return "";
    if (k === "direct_exc" && typeof v === "object") return EntScore.formatDirectExc(v);
    return String(v);
  }
  function differs(type, now, val) {
    var t = String(val).trim();
    if (type === "et" || type === "unc" || type === "lmax" || type === "eps") {
      if (t === "" || now === "") return t !== now;
      return EntScore.num(t) !== Number(now);
    }
    if (type === "direct_map") {
      return JSON.stringify(EntScore.parseDirectExc(t).map) !== JSON.stringify(EntScore.parseDirectExc(now).map);
    }
    if (type === "cas") return EntScore.cleanCas(t) !== now;
    if (type === "doi") return EntScore.cleanDoi(t).toLowerCase() !== now.toLowerCase();
    return t !== now.trim();
  }
  function openSuggest(d) {
    Ent.dialog("Suggest a correction · " + Ent.displayName(d), function (box) {
      box.classList.add("ed-box");
      var oldTitle = box.querySelector("h2");
      var head = el("div", "ed-head"), closeX = el("button", "btn small", "Close");
      closeX.type = "button"; closeX.addEventListener("click", Ent.closeDialog);
      head.appendChild(oldTitle); head.appendChild(closeX);

      var body = el("div", "ed-body");
      if (d.smiles) {
        var st = el("div", "ed-struct"), paper = el("div", "paper"), si = el("div", "sinfo");
        var info = Ent.molInfo(d.smiles);
        if (info) { paper.innerHTML = info.svg; si.appendChild(el("span", "formula", info.formula)); }
        else paper.textContent = "Structure";
        si.appendChild(el("code", "smiles", d.smiles));
        st.appendChild(paper); st.appendChild(si); body.appendChild(st);
      }
      body.appendChild(el("p", "hint", "Change any fields that are wrong or missing — changed fields highlight immediately. A curator compares old and new values before anything changes. Give papers as DOIs, not as links."));

      var grid = el("div", "sugg-grid"), inputs = [];
      EntScore.SUGGEST_FIELDS.forEach(function (f) {
        var k = f[0], type = f[2];
        if (type === "use") return;
        var now = curText(d, k), lab = el("label", "field"), inp;
        lab.appendChild(Ent.elT("span", null, f[1].replace(" (structure)", "")));
        if (type === "role" || type === "origin") {
          inp = el("select");
          (type === "role" ? [["acceptor", "Acceptor"], ["donor", "Donor (sensitizer)"], ["both", "Both"]] : [["exp", "Experiment"], ["calc", "Computation"]])
            .forEach(function (o) { inp.appendChild(new Option(o[1], o[0])); });
        } else if (LONG[k]) { inp = el("textarea"); inp.rows = 2; inp.maxLength = 500; }
        else { inp = el("input"); inp.type = "text"; inp.maxLength = type === "text" ? 500 : 400; }
        inp.value = now; inp.setAttribute("data-k", k);
        if (type === "cas") inp.placeholder = "e.g. 100-42-5";
        if (type === "doi") inp.placeholder = "10.xxxx/…";
        var was = el("small", "was"); was.hidden = true;
        lab.appendChild(inp); lab.appendChild(was);
        if (LONG[k] || k === "smiles" || k === "name" || k === "commercial_name") lab.classList.add("wide");
        var sync = function () {
          var ch = differs(type, now, inp.value);
          lab.classList.toggle("changed", ch);
          was.hidden = !ch; was.textContent = "Now: " + (now === "" ? "(empty)" : now);
        };
        inp.addEventListener("input", sync); inp.addEventListener("change", sync);
        inputs.push({ k: k, type: type, now: now, inp: inp });
        grid.appendChild(lab);
      });
      body.appendChild(grid);
      var ub = el("div", "sugg-use"), ud = el("label", "field", "Add a paper where it was used in photocatalysis (DOI, optional)"), udi = el("input");
      udi.type = "text"; udi.placeholder = "10.xxxx/…"; ud.appendChild(udi);
      var un = el("label", "field", "What it was used for"), uni = el("input"); uni.type = "text"; uni.maxLength = 300; un.appendChild(uni);
      ub.appendChild(ud); ub.appendChild(un); body.appendChild(ub);
      var haveRx = Array.isArray(d.reactions) ? d.reactions.length : 0;
      var rxFs = el("fieldset", "rx-host"); rxFs.appendChild(el("legend", null, "Reactions it was employed in (optional)"));
      rxFs.appendChild(el("p", "hint", "Add example reactions of this molecule from the literature. Each reaction needs the DOI of its paper before the sketcher unlocks." +
        (haveRx ? " The entry already has " + haveRx + (haveRx === 1 ? " reaction" : " reactions") + "; at most " + EntScore.MAX_REACTIONS + " in total." : "")));
      var sRx = Ent.reactionsEditor({
        substrate: function () { return d.smiles || ""; }, name: function () { return Ent.displayName(d); },
        defaultDoi: function () { return udi.value.trim(); }, defaultRole: function () { return d.role; },
        max: EntScore.MAX_REACTIONS - haveRx
      });
      rxFs.appendChild(sRx.el); body.appendChild(rxFs);
      var lc = el("label", "field", "What is wrong, and where does the correct value come from? (required when you change a value)"), com = el("textarea"); com.rows = 3; com.maxLength = 1000; lc.appendChild(com); body.appendChild(lc);
      var lb = el("label", "field", "Your name or contact (optional, seen only by curators)"), by = el("input"); by.type = "text"; by.maxLength = 120; lb.appendChild(by); body.appendChild(lb);
      var hp = el("div", "hp"); hp.setAttribute("aria-hidden", "true"); var hpi = el("input"); hpi.type = "text"; hpi.tabIndex = -1; hpi.autocomplete = "off"; hp.appendChild(hpi); body.appendChild(hp);

      var foot = el("div", "ed-foot");
      var err = el("p", "err"); err.hidden = true; err.setAttribute("role", "alert"); foot.appendChild(err);
      var okm = el("p", "ok"); okm.hidden = true; foot.appendChild(okm);
      var act = el("div", "actions"), send = el("button", "btn primary", "Send the suggestion"), close = el("button", "btn", "Close");
      send.type = close.type = "button"; act.appendChild(send); act.appendChild(close); foot.appendChild(act);
      box.replaceChildren(head, body, foot);

      close.addEventListener("click", Ent.closeDialog);
      send.addEventListener("click", function () {
        var changes = {};
        inputs.forEach(function (x) { if (differs(x.type, x.now, x.inp.value)) changes[x.k] = x.inp.value; });
        if (udi.value.trim() || uni.value.trim()) changes.uses_add = { doi: udi.value, note: uni.value };
        var rxVals = sRx.value();
        if (rxVals.length) changes.reactions_add = rxVals;
        if (!Object.keys(changes).length) { err.textContent = "Change at least one field, add a paper or add a reaction."; err.hidden = false; return; }
        var rxPend = rxVals.length ? sRx.pending() : "";
        if (rxPend) { err.textContent = rxPend; err.hidden = false; return; }
        var chk = EntScore.checkSuggestion(changes);
        if (chk.error) { err.textContent = chk.error; err.hidden = false; return; }
        if (chk.clean.reactions_add) {
          var rxBad = rxStructureError(EntScore.checkReactions(chk.clean.reactions_add, haveRx));
          if (rxBad) { err.textContent = rxBad; err.hidden = false; return; }
        }
        var onlyAdds = Object.keys(chk.clean).every(function (k) { return k === "uses_add" || k === "reactions_add"; });
        if (!com.value.trim() && !onlyAdds) { err.textContent = "Explain briefly what is wrong and where the correct value comes from."; err.hidden = false; com.focus(); return; }
        err.hidden = true; send.disabled = true;
        api.submit({ kind: "suggestion", entry_id: d.id, changes: chk.clean, comment: com.value, by: by.value, website: hpi.value,
          access_user: (state.access && state.access.user) || "", access_pass: (state.access && state.access.pass) || "" })
          .then(function (r) {
            if (!r || !r.suggestion) throw { status: 409 };
            okm.textContent = "Thank you. A curator will review the " + Object.keys(chk.clean).length + " suggested change(s); the entry changes only if they are approved."; okm.hidden = false;
            send.hidden = true;
            Ent.toast("Suggestion sent for review.");
          }).catch(function (e) {
            send.disabled = false;
            var stale = e.status === 409 || (e.status === 400 && /add the structure|smiles or draw/i.test(e.message || ""));
            err.textContent = stale ? "Corrections are not enabled on the server yet: a curator has to update the server function. Nothing was sent."
              : e.status === 429 ? "Too many submissions from this connection. Try again in an hour."
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
    aside.classList.toggle("open", open);
    $("pub-toggle-aside").setAttribute("aria-expanded", String(open));
  });
  $("f-reset").addEventListener("click", function () { state.triage = ""; });
  Ent.bindSearch(state.search, render);
  Ent.sketcher.bind();
  Ent.loadOCL(function () { state.dataVer++; render(); });   /* structures can be drawn now */

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.curatorModal && !$("gate").hidden) { cancelCuratorGate(); return; }
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.section !== "db" || state.view !== "db" || $("app-body").hidden) return;
    var ed = $("ed"), sk = $("sk");
    if ((ed && !ed.hidden) || (sk && !sk.hidden)) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault(); $("q").focus();
  });

  /* ---------- offline copy of the public values (kept on this device, cleared at sign-out) ---------- */
  var OFFLINE_KEY = "trendb-offline-copy";
  function saveOffline(rows) {
    try { localStorage.setItem(OFFLINE_KEY, JSON.stringify({ at: new Date().toISOString(), rows: rows })); } catch (e) { /* full or blocked: no offline copy */ }
  }
  function readOffline() {
    try { var c = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "null"); return c && Array.isArray(c.rows) ? c : null; } catch (e) { return null; }
  }
  function dropOffline() { try { localStorage.removeItem(OFFLINE_KEY); } catch (e) {} }
  function showOffline(copy) {
    var n = $("offline-note");
    if (!copy) { n.hidden = true; return; }
    n.textContent = "Offline: showing the copy saved on this device on " + new Date(copy.at).toLocaleString() + ". Submitting and suggesting need a connection.";
    n.hidden = false;
  }
  /* no connection, but this device has a copy from an earlier signed-in visit */
  function openOffline(copy) {
    state.access = null; state.gated = false; state.isAdmin = false; state.curatorModal = false;
    $("gate").hidden = true; $("app-body").hidden = false;
    syncAuthUi();
    state.docs = copy.rows; state.loaded = true; state.failed = false; state.dataVer++;
    showOffline(copy); readRoute(); render();
  }
  window.addEventListener("online", function () { if (!$("offline-note").hidden) location.reload(); });

  /* ---------- unified access gate & curator bridge ---------- */
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
    if (state.curatorModal) {
      gate("Curator sign-in", "Sign in with your curator email and password to unlock the admin shortcut.", true, err, true);
      return;
    }
    gate("Sign in", "TrEnDB is in private preview. Sign in with the preview user name and password, or with your curator email and password.", true, err, false);
  }
  function cancelCuratorGate() {
    state.curatorModal = false; $("gate-pass").value = "";
    $("gate").hidden = true; $("app-body").hidden = false;
    syncAuthUi();
  }
  function lock(msg) {
    saveAccess(null); api.signOut();
    state.access = null; state.isAdmin = false; state.gated = false; state.curatorModal = false;
    state.docs = []; state.loaded = false; state.dataVer++; $("gate-pass").value = ""; dropOffline(); showOffline(null);
    syncAuthUi();
    if (msg) loginGate(msg);
    else tryAccess({ user: "", pass: "" }, false);
  }
  function openApp(a, gated, isAdmin) {
    var alreadyLoaded = state.loaded && state.curatorModal;
    state.access = a; state.gated = !!gated; state.isAdmin = !!isAdmin; state.curatorModal = false;
    $("gate").hidden = true; $("app-body").hidden = false;
    syncAuthUi();
    if (alreadyLoaded) {
      Ent.toast("Signed in as curator. You can open the admin page from the top bar.");
      return;
    }
    state.loaded = false; state.failed = false; state.failDetail = ""; readRoute(); render();
    api.listPublic(a, !!isAdmin).then(function (rows) { state.docs = rows || []; state.loaded = true; state.dataVer++; saveOffline(state.docs); showOffline(null); render(); },
      function (err) {
        if (window.console && console.error) console.error("listPublic failed:", err);
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
    if (!u || !p) {
      loginGate(state.curatorModal ? "Enter your email and password." : "Enter both the user name and the password.");
      return;
    }
    $("gate-send").disabled = true;
    var looksEmail = /^\S+@\S+\.\S+$/.test(u);
    if (state.curatorModal || looksEmail) {
      api.signIn(u, p).then(function () {
        return api.isAdmin().then(function (ok) {
          $("gate-send").disabled = false;
          if (ok === true) { $("gate-pass").value = ""; openApp(null, false, true); return; }
          api.signOut();
          if (state.curatorModal) { loginGate("This address is not a curator of this database."); return; }
          return tryAccess({ user: u, pass: p }, true);
        }, function () {
          $("gate-send").disabled = false;
          loginGate("Could not verify curator status. Try again.");
        });
      }, function (err) {
        $("gate-send").disabled = false;
        if (state.curatorModal) {
          loginGate(err && (err.status === 400 || err.status === 401) ? "Wrong email or password."
            : err && err.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Sign-in failed. Try again.");
          return;
        }
        tryAccess({ user: u, pass: p }, true);
      });
      return;
    }
    tryAccess({ user: u, pass: p }, true).then(function () { $("gate-send").disabled = false; });
  });
  $("gate-cancel").addEventListener("click", cancelCuratorGate);
  $("pub-signin").addEventListener("click", function () {
    $("gate-user").value = ""; $("gate-pass").value = "";
    state.curatorModal = true;
    loginGate("");
    $("gate-user").focus();
  });
  $("lock").addEventListener("click", function (e) { e.preventDefault(); lock(""); });

  /* ---------- install as an app ---------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () { /* the site works without it */ }); });
  }
  var installEvt = null, INSTALL_HIDE = "trendb-install-hidden";
  function standalone() { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; }
  function installHidden() { try { return localStorage.getItem(INSTALL_HIDE) === "1"; } catch (e) { return false; } }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function syncInstall() {
    var box = $("install");
    if (standalone() || installHidden()) { box.hidden = true; return; }
    if (installEvt) {
      $("install-btn").hidden = false; box.hidden = false;
    } else if (isIOS()) {
      $("install-btn").hidden = true;
      $("install-how").replaceChildren();
      $("install-how").appendChild(document.createTextNode("On iPhone or iPad: tap Share "));
      var sh = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sh.setAttribute("width", "16"); sh.setAttribute("height", "16"); sh.setAttribute("viewBox", "0 0 24 24"); sh.setAttribute("aria-label", "(the square with an arrow)"); sh.setAttribute("role", "img");
      sh.innerHTML = '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v9h14v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      $("install-how").appendChild(sh);
      $("install-how").appendChild(document.createTextNode(", then “Add to Home Screen”. It opens full-screen like an app and updates itself."));
      box.hidden = false;
    } else box.hidden = true;
  }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); installEvt = e; syncInstall(); });
  window.addEventListener("appinstalled", function () { installEvt = null; syncInstall(); Ent.toast("TrEnDB is installed. Find it with your other apps."); });
  $("install-btn").addEventListener("click", function () {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt.userChoice.then(function () { installEvt = null; syncInstall(); });
  });
  $("install-close").addEventListener("click", function () { try { localStorage.setItem(INSTALL_HIDE, "1"); } catch (e) {} syncInstall(); });
  syncInstall();

  function boot() {
    if (!api.configured) { gate("Private preview", "TrEnDB is not open yet.", false, "", false); return; }
    api.token().then(function (t) {
      if (!t) return false;
      return api.isAdmin().then(function (ok) {
        if (ok === true) return true;
        api.signOut(); return false;
      }, function () { return false; });
    }).then(function (adminOk) {
      if (adminOk) { openApp(null, false, true); return; }
      return tryAccess(readAccess() || { user: "", pass: "" }, false);
    });
  }
  boot();
})();
