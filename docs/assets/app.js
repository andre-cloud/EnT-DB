/* EnT-DB public page: browse approved entries, search, submit. */
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
    Ent.drawList(list, res.rows, function (d) {
      return Ent.card(d, { scores: res.scores, simMode: state.search.ss.mode === "sim" });
    }, state.search.pager, render);
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = state.docs.length ? "No entry matches the current search and filters."
        : "No entries have been approved yet. Use “Submit entry” to propose the first one.";
    }
  }

  /* ---------- submission form ---------- */
  var FIELDS = ["name", "cls", "smiles", "role", "et", "unit", "unc", "origin", "kind", "tech", "solvent", "temp",
                "func", "basis", "solv", "cite", "doi", "loc", "quote", "uv", "direct", "usedoi", "usenote", "by", "website"];
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
    var sc = EntScore.scoreEntry(f, ctx), g = EntScore.gradeOf(sc.total);
    $("fm-score").textContent = sc.total; $("fm-grade").textContent = g.label; $("fm-grade").className = "chip " + g.cls;
    var ul = $("fm-items");
    ul.replaceChildren.apply(ul, sc.items.map(function (i) {
      var li = el("li", i.got === i.max ? "full" : i.got === 0 ? "zero" : ""); li.appendChild(el("span", "pts", i.got + "/" + i.max));
      var t = el("span", null, i.label); if (i.note) t.appendChild(el("small", null, i.note)); li.appendChild(t); return li;
    }));
    return { f: f, ctx: ctx };
  }
  function fmMsg(id, t) { ["fm-err", "fm-ok"].forEach(function (x) { $(x).hidden = true; }); if (t) { $(id).textContent = t; $(id).hidden = false; } }

  $("form").addEventListener("input", function () { fmMsg(); updateForm(); });
  $("form").addEventListener("change", function () { updateForm(); });
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
  function loginGate(err) { gate("Sign in", "EnT-DB is in private preview. Enter the user name and password you were given.", true, err); }
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

  if (!api.configured) gate("Private preview", "EnT-DB is not open yet.", false, "");
  else tryAccess(readAccess() || { user: "", pass: "" }, false);
})();
