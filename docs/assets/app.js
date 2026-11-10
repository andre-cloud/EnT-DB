/* EnT-DB public page: browse approved entries, search, submit. */
(function () {
  "use strict";
  var $ = Ent.$, el = Ent.el, api = Ent.api;
  var state = { docs: [], view: "db", loaded: false, failed: false, search: Ent.newSearch() };

  function render() {
    $("n-db").textContent = state.docs.length;
    $("tab-db").setAttribute("aria-selected", String(state.view === "db"));
    $("tab-submit").setAttribute("aria-selected", String(state.view === "submit"));
    var sub = state.view === "submit", list = $("list"), status = $("status");
    ["tools-main", "ss-box", "legend", "list"].forEach(function (id) { $(id).hidden = sub; });
    $("form").hidden = !sub;
    if (sub) { status.hidden = true; updateForm(); return; }
    if (!state.loaded) {
      status.hidden = false; list.replaceChildren();
      status.textContent = state.failed ? "The database could not be loaded. Reload the page to try again." : "Loading the database…";
      return;
    }
    var res = Ent.filterRows(state.docs, state.search);
    Ent.searchInfo(res, state.docs.length);
    list.replaceChildren.apply(list, res.rows.map(function (d) {
      return Ent.card(d, { scores: res.scores, simMode: state.search.ss.mode === "sim" });
    }));
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = state.docs.length ? "No entry matches the current search and filters."
        : "No entries have been approved yet. Use “Submit entry” to propose the first one.";
    }
  }

  /* ---------- submission form ---------- */
  var FIELDS = ["name", "cls", "smiles", "role", "et", "unit", "unc", "origin", "kind", "tech", "solvent", "temp",
                "func", "basis", "solv", "cite", "doi", "loc", "quote", "uv", "direct", "by", "website"];
  function payload() { var p = {}; FIELDS.forEach(function (k) { p[k] = $("fm-" + k).value; }); return p; }
  function context(f) {
    var ok = Ent.structureOk(f.smiles), same = null;
    if (ok) { var id = Ent.idCode(f.smiles); same = state.docs.filter(function (d) { return Ent.idCode(d.smiles) === id; }); }
    return { structureOk: ok, doiResolves: null, same: same };
  }
  function updateForm() {
    var f = EntScore.normalize(payload()), ctx = context(f);
    $("fm-exp").hidden = f.origin === "calc"; $("fm-calc").hidden = f.origin !== "calc";
    $("fm-closed").hidden = api.configured;
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
    $("fm-submit").disabled = !api.configured;
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
    if (!api.configured) { fmMsg("fm-err", "Submissions are not open yet."); return; }
    var miss = EntScore.requiredError(u.f, u.ctx); if (miss) { fmMsg("fm-err", miss); return; }
    $("fm-submit").disabled = true; fmMsg();
    api.submit(payload()).then(function (r) {
      $("form").reset(); updateForm();
      fmMsg("fm-ok", "Sent for review with a score of " + r.score + " (" + r.grade + "). It will appear in the database once a curator approves it.");
    }, function (err) {
      $("fm-submit").disabled = false;
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
  render();
  api.listPublic().then(function (rows) { state.docs = rows || []; state.loaded = true; render(); },
    function () { state.failed = true; render(); });
})();
