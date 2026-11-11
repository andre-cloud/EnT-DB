/* TrEnDB public page: browse approved entries, search, submit. */
(function () {
  "use strict";
  var $ = Ent.$, el = Ent.el, api = Ent.api;
  var state = { docs: [], view: "db", loaded: false, failed: false, access: null, search: Ent.newSearch() };
  var ACCESS_KEY = "entdb-access";   /* kept for the browser tab only */
  function readAccess() { try { return JSON.parse(sessionStorage.getItem(ACCESS_KEY) || "null"); } catch (e) { return null; } }
  function saveAccess(a) { try { if (a) sessionStorage.setItem(ACCESS_KEY, JSON.stringify(a)); else sessionStorage.removeItem(ACCESS_KEY); } catch (e) {} }

  function render() {
    $("n-db").textContent = state.docs.length;
    Ent.fillClasses(state.docs, state.search);
    $("tab-db").setAttribute("aria-selected", String(state.view === "db"));
    $("tab-submit").setAttribute("aria-selected", String(state.view === "submit"));
    var sub = state.view === "submit", list = $("list"), status = $("status");
    ["tools-main", "tools-filter", "ss-box", "legend", "list"].forEach(function (id) { $(id).hidden = sub; });
    $("form").hidden = !sub;
    if (sub) { status.hidden = true; updateForm(); return; }
    if (!state.loaded) {
      status.hidden = false; list.replaceChildren();
      status.textContent = state.failed ? "The database could not be loaded. Reload the page to try again." : "Loading the database…";
      return;
    }
    var res = Ent.filterRows(state.docs, state.search);
    Ent.searchInfo(res, state.docs.length);
    /* one card per molecule, carrying every value that matches the search */
    Ent.drawList(list, Ent.groupByMolecule(res.rows), function (items) {
      return Ent.moleculeCard(items, { scores: res.scores, simMode: state.search.ss.mode === "sim", onSuggest: openSuggest });
    }, state.search.pager, render);
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = state.docs.length ? "No entry matches the current search and filters."
        : "No entries have been approved yet. Use “Submit entry” to propose the first one.";
    }
  }

  /* ---------- submission form ---------- */
  var FIELDS = ["name", "cas", "cls", "smiles", "role", "et", "unit", "unc", "origin", "kind", "tech", "solvent", "temp",
                "func", "basis", "solv", "cite", "doi", "loc", "quote", "uv_lmax", "uv_eps", "uv_cond", "direct_src", "direct_nm",
                "usedoi", "usenote", "by", "website"];
  function payload() { var p = {}; FIELDS.forEach(function (k) { p[k] = $("fm-" + k).value; }); return p; }
  function context(f) {
    var ok = Ent.structureOk(f.smiles), same = null;
    if (ok) { var id = Ent.idCode(f.smiles); same = state.docs.filter(function (d) { return Ent.idCode(d.smiles) === id; }); }
    return { structureOk: ok, doiResolves: null, same: same };
  }
  function updateForm() {
    var f = EntScore.normalize(payload()), ctx = context(f);
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
        ? "Already in the database: " + known.db.map(function (m) { return m.entry.name + " (" + Ent.fmt(Number(m.entry.et_kcal), 1) + " kcal/mol, " + m.why + ")"; }).join("; ") + ". A different value (another paper or method) is welcome: it will appear beside the existing ones on the molecule's card. To fix an existing value, use “Suggest a correction” on its card."
        : "A different stereoisomer is in the database (" + known.stereo.map(function (e) { return e.name; }).join("; ") + "). Check the E/Z or R/S assignment.";
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
  $("fm-reset").addEventListener("click", function () { $("form").reset(); fmMsg(); updateForm(); });
  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var u = updateForm();
    var miss = EntScore.requiredError(u.f, u.ctx); if (miss) { fmMsg("fm-err", miss); return; }
    $("fm-submit").disabled = true; fmMsg();
    var p = payload(); p.access_user = (state.access && state.access.user) || ""; p.access_pass = (state.access && state.access.pass) || "";
    api.submit(p).then(function (r) {
      $("form").reset(); updateForm();
      fmMsg("fm-ok", "Sent for review with a score of " + r.score + " (" + r.grade + "). It will appear in the database once a curator approves it.");
    }, function (err) {
      $("fm-submit").disabled = false;
      if (err.status === 401) { lock("Your access is no longer valid. Sign in again."); return; }
      fmMsg("fm-err", err.status === 429 ? "Too many submissions from this connection. Try again in an hour."
        : err.status === 400 ? err.message : "The entry could not be sent. Try again in a moment.");
    });
  });

  /* ---------- suggesting a correction to an entry in the database ----------
     Every field is shown with its current value; the reader changes any number of them at once.
     Only the fields that differ from the entry are sent, and a curator sees them old against new. */
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
    Ent.dialog("Suggest a correction · " + (d.name || ""), function (box) {
      box.appendChild(el("p", "hint", "Change any fields that are wrong or missing — as many as you like — and leave the others as they are. Changed fields are highlighted. A curator compares old and new values before anything changes. Give papers as DOIs, not as links."));
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
        if (LONG[k] || k === "smiles" || k === "name") lab.classList.add("wide");
        var sync = function () {
          var ch = differs(type, now, inp.value);
          lab.classList.toggle("changed", ch);
          was.hidden = !ch; was.textContent = "Now: " + (now === "" ? "(empty)" : now);
        };
        inp.addEventListener("input", sync); inp.addEventListener("change", sync);
        inputs.push({ k: k, type: type, now: now, inp: inp });
        grid.appendChild(lab);
      });
      box.appendChild(grid);
      var ub = el("div", "sugg-use"), ud = el("label", "field", "Add a paper where it was used in photocatalysis (DOI, optional)"), udi = el("input");
      udi.type = "text"; udi.placeholder = "10.xxxx/…"; ud.appendChild(udi);
      var un = el("label", "field", "What it was used for"), uni = el("input"); uni.type = "text"; uni.maxLength = 300; un.appendChild(uni);
      ub.appendChild(ud); ub.appendChild(un); box.appendChild(ub);
      var lc = el("label", "field", "What is wrong, and where does the correct value come from? (required)"), com = el("textarea"); com.rows = 3; com.maxLength = 1000; lc.appendChild(com); box.appendChild(lc);
      var lb = el("label", "field", "Your name or contact (optional, seen only by curators)"), by = el("input"); by.type = "text"; by.maxLength = 120; lb.appendChild(by); box.appendChild(lb);
      var hp = el("div", "hp"); hp.setAttribute("aria-hidden", "true"); var hpi = el("input"); hpi.type = "text"; hpi.tabIndex = -1; hpi.autocomplete = "off"; hp.appendChild(hpi); box.appendChild(hp);
      var err = el("p", "err"); err.hidden = true; err.setAttribute("role", "alert"); box.appendChild(err);
      var okm = el("p", "ok"); okm.hidden = true; box.appendChild(okm);
      var act = el("div", "actions"), send = el("button", "btn primary", "Send the suggestion"), close = el("button", "btn", "Close");
      send.type = close.type = "button"; act.appendChild(send); act.appendChild(close); box.appendChild(act);
      close.addEventListener("click", Ent.closeDialog);
      send.addEventListener("click", function () {
        var changes = {};
        inputs.forEach(function (x) { if (differs(x.type, x.now, x.inp.value)) changes[x.k] = x.inp.value; });
        if (udi.value.trim() || uni.value.trim()) changes.uses_add = { doi: udi.value, note: uni.value };
        if (!Object.keys(changes).length) { err.textContent = "Change at least one field, or add a paper."; err.hidden = false; return; }
        var chk = EntScore.checkSuggestion(changes);
        if (chk.error) { err.textContent = chk.error; err.hidden = false; return; }
        if (!com.value.trim()) { err.textContent = "Explain briefly what is wrong and where the correct value comes from."; err.hidden = false; com.focus(); return; }
        err.hidden = true; send.disabled = true;
        api.submit({ kind: "suggestion", entry_id: d.id, changes: chk.clean, comment: com.value, by: by.value, website: hpi.value,
          access_user: (state.access && state.access.user) || "", access_pass: (state.access && state.access.pass) || "" })
          .then(function (r) {
            if (!r || !r.suggestion) throw { status: 409 };
            okm.textContent = "Thank you. A curator will review the " + Object.keys(chk.clean).length + " suggested change(s); the entry changes only if they are approved."; okm.hidden = false;
            send.hidden = true;
          }).catch(function (e) {
            send.disabled = false;
            /* an out-of-date server treats the suggestion as a new entry and asks for a structure */
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

  /* ---------- boot ---------- */
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { state.view = t.getAttribute("data-view"); render(); });
  });
  Ent.bindSearch(state.search, render);
  Ent.sketcher.bind();
  Ent.loadOCL(render);

  /* ---------- access gate ---------- */
  function gate(title, text, withForm, err) {
    $("app-body").hidden = true; $("lock").hidden = true; $("gate").hidden = false;
    $("gate-title").textContent = title; $("gate-text").textContent = text; $("gate-fields").hidden = !withForm;
    $("gate-err").hidden = !err; $("gate-err").textContent = err || "";
  }
  function loginGate(err) { gate("Sign in", "TrEnDB is in private preview. Enter the user name and password you were given.", true, err); }
  function lock(msg) { saveAccess(null); state.access = null; state.docs = []; state.loaded = false; $("gate-pass").value = ""; loginGate(msg || ""); }
  function openApp(a, gated) {
    state.access = a; $("gate").hidden = true; $("app-body").hidden = false; $("lock").hidden = !gated;
    state.loaded = false; state.failed = false; render();
    api.listPublic(a).then(function (rows) { state.docs = rows || []; state.loaded = true; render(); },
      function () { state.failed = true; render(); });
  }
  function tryAccess(a, fromForm) {
    return api.checkAccess(a).then(function (ok) {
      if (ok === true) { if (fromForm) saveAccess(a); openApp(a, !!(a.user || a.pass)); }
      else { if (!fromForm) saveAccess(null); loginGate(fromForm ? "Wrong user name or password." : ""); }
    }, function () { gate("Unavailable", "The database could not be reached. Reload the page to try again.", false, ""); });
  }
  $("gate").addEventListener("submit", function (e) {
    e.preventDefault();
    var a = { user: $("gate-user").value.trim(), pass: $("gate-pass").value };
    if (!a.user || !a.pass) { loginGate("Enter both the user name and the password."); return; }
    $("gate-send").disabled = true;
    tryAccess(a, true).then(function () { $("gate-send").disabled = false; });
  });
  $("lock").addEventListener("click", function (e) { e.preventDefault(); lock(""); });

  if (!api.configured) gate("Private preview", "TrEnDB is not open yet.", false, "");
  else tryAccess(readAccess() || { user: "", pass: "" }, false);
})();
