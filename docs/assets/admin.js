/* EnT-DB review page: curator sign-in with email and password, then review, edit, approve or reject. */
(function () {
  "use strict";
  var $ = Ent.$, api = Ent.api;
  var state = { docs: [], sugg: [], view: "pending", loaded: false, loadErr: "", busy: {}, drafts: {}, search: Ent.newSearch() };
  var dupCache = {};   /* pending id -> duplicates result, recomputed on every load */
  function approvedDocs() { return state.docs.filter(function (d) { return d.status === "approved"; }); }
  function pendingDocs() { return state.docs.filter(function (d) { return d.status === "pending"; }); }
  function dupOf(d) {
    if (d.status !== "pending") return null;
    if (!dupCache[d.id] || (window.OCL && !dupCache[d.id].ocl)) {
      dupCache[d.id] = Ent.duplicates(d, approvedDocs(), pendingDocs()); dupCache[d.id].ocl = !!window.OCL;
    }
    return dupCache[d.id];
  }

  function banner(t) { var m = $("adm-msg"); m.hidden = !t; m.textContent = t || ""; }
  function show(which) { $("login").hidden = which !== "login"; $("panel").hidden = which !== "panel"; $("signout").hidden = which !== "panel"; }

  function onPatch(id, patch) {
    state.busy[id] = true; render();
    return api.adminPatch(id, patch).then(function (rows) {
      delete state.busy[id];
      if (rows && rows[0]) { state.docs = state.docs.map(function (d) { return d.id === id ? rows[0] : d; }); dupCache = {}; }
      else state.busy[id] = "err";               /* no row returned: not allowed or gone */
      render(); return !!(rows && rows[0]);
    }, function (err) {
      if (err.status === 401) { signedOut("Your session ended. Sign in again."); return false; }
      state.busy[id] = "err"; render(); return false;
    });
  }

  function render() {
    var counts = { pending: state.sugg.length, approved: 0, rejected: 0 };
    state.docs.forEach(function (d) { if (counts[d.status] != null) counts[d.status]++; });
    ["pending", "approved", "rejected"].forEach(function (k) {
      $("n-" + k).textContent = counts[k]; $("tab-" + k).setAttribute("aria-selected", String(state.view === k));
    });
    var list = $("list"), status = $("status");
    if (!state.loaded) { status.hidden = false; status.textContent = state.loadErr || "Loading…"; list.replaceChildren(); drawBulk([]); return; }
    var inView = state.docs.filter(function (d) { return d.status === state.view; });
    Ent.fillClasses(inView, state.search);   /* only the classes present in this tab */
    var res = Ent.filterRows(inView, state.search);
    Ent.searchInfo(res, inView.length);
    Ent.drawList(list, res.rows, function (d) {
      return Ent.card(d, { scores: res.scores, simMode: state.search.ss.mode === "sim", dup: dupOf(d),
        admin: { busy: state.busy, drafts: state.drafts, onPatch: onPatch, approve: approve } });
    }, state.search.pager, render);
    /* corrections proposed by readers come first in the queue */
    if (state.view === "pending" && state.sugg.length) {
      var byId = {}; state.docs.forEach(function (d) { byId[d.id] = d; });
      var cards = state.sugg.map(function (sg) { return Ent.suggestionCard(sg, byId[sg.entry_id] || null, { busy: state.busy, approve: approveSuggestion, reject: rejectSuggestion }); });
      list.prepend.apply(list, cards);
    }
    drawBulk(res.err ? [] : res.rows);   /* never offer bulk approval when the search failed */
    status.hidden = res.rows.length > 0 || (state.view === "pending" && state.sugg.length > 0);
    if (!res.rows.length) {
      status.textContent = inView.length ? "No entry matches the current search and filters."
        : state.view === "pending" ? "The queue is empty." : state.view === "approved" ? "Nothing approved yet." : "Nothing rejected.";
    }
  }

  /* ---------- approving one entry: duplicates must be resolved first ---------- */
  function approve(d, note) {
    var dup = dupOf(d), now = new Date().toISOString();
    if (!dup || !dup.db.length) return onPatch(d.id, { status: "approved", decided_at: now, note: note });
    return new Promise(function (resolve) {
      Ent.dialog("Possible duplicate: " + (d.name || ""), function (box) {
        box.appendChild(Ent.el("p", null, "This molecule is already in the database. To add the new entry, the existing one must be removed first (it is overwritten). Choose the entry to overwrite:"));
        var opts = Ent.el("div", "stack");
        dup.db.forEach(function (m, i) {
          var lab = Ent.el("label", "check"), r = Ent.el("input"); r.type = "radio"; r.name = "dup-target"; r.value = m.entry.id; r.checked = i === 0;
          lab.appendChild(r);
          lab.appendChild(document.createTextNode(m.entry.name + " · " + Ent.fmt(Number(m.entry.et_kcal), 1) + " kcal/mol · " +
            (m.entry.origin === "calc" ? "computed" : "experimental") + (m.entry.doi ? " · " + m.entry.doi : "") + " (" + m.why + ")"));
          opts.appendChild(lab);
        });
        box.appendChild(opts);
        box.appendChild(Ent.el("p", "hint", "The overwritten entry moves to the Rejected tab with a note, so it can be restored. Use “Keep both” only when the two are different measurements (for example an experimental and a computed value, or two papers)."));
        var err = Ent.el("p", "err"); err.hidden = true; err.setAttribute("role", "alert"); box.appendChild(err);
        var act = Ent.el("div", "actions");
        var ow = Ent.el("button", "btn primary", "Overwrite the selected entry"), keep = Ent.el("button", "btn", "Keep both"), cancel = Ent.el("button", "btn", "Cancel");
        [ow, keep, cancel].forEach(function (b) { b.type = "button"; act.appendChild(b); });
        box.appendChild(act);
        cancel.addEventListener("click", function () { Ent.closeDialog(); resolve(false); });
        keep.addEventListener("click", function () {
          Ent.closeDialog(); onPatch(d.id, { status: "approved", decided_at: now, note: note }).then(resolve);
        });
        ow.addEventListener("click", function () {
          var pick = box.querySelector('input[name="dup-target"]:checked'); if (!pick) return;
          var old = state.docs.filter(function (x) { return x.id === pick.value; })[0];
          ow.disabled = keep.disabled = true;
          onPatch(old.id, { status: "rejected", decided_at: now, note: "Overwritten by “" + (d.name || "") + "” (" + now.slice(0, 10) + ")" + (old.note ? ". " + old.note : "") })
            .then(function (ok) {
              if (!ok) { ow.disabled = keep.disabled = false; err.textContent = "The existing entry could not be removed. Nothing was changed."; err.hidden = false; return; }
              Ent.closeDialog(); onPatch(d.id, { status: "approved", decided_at: now, note: note }).then(resolve);
            });
        });
      });
    });
  }

  /* ---------- corrections from readers ---------- */
  function approveSuggestion(sg) {
    var entry = state.docs.filter(function (d) { return d.id === sg.entry_id; })[0]; if (!entry) return;
    var patch = {}, ch = sg.changes || {};
    Object.keys(ch).forEach(function (k) {
      if (k === "uses_add") patch.uses = (Array.isArray(entry.uses) ? entry.uses : []).concat([ch[k]]);
      else if (ch[k] !== entry[k]) patch[k] = ch[k];
    });
    if ("smiles" in patch) { patch.idcode = Ent.idCode(patch.smiles); patch.smiles_checked = false; }
    if (Array.isArray(entry.score_items) && Object.keys(patch).length) {
      patch.score_items = entry.score_items.filter(function (i) { return !i.edited; })
        .concat([{ label: "Edited by a curator", got: 0, max: 0, edited: true, note: Object.keys(ch).join(", ") + " from a reader's correction on " + new Date().toLocaleDateString("en-CA") }]);
    }
    state.busy[sg.id] = true; render();
    var apply = Object.keys(patch).length ? api.adminPatch(entry.id, patch) : Promise.resolve([entry]);
    apply.then(function (rows) {
      if (!rows || !rows[0]) throw new Error("not saved");
      state.docs = state.docs.map(function (d) { return d.id === entry.id ? rows[0] : d; }); dupCache = {};
      return api.adminPatchSuggestion(sg.id, { status: "approved", decided_at: new Date().toISOString() });
    }).then(function () {
      delete state.busy[sg.id]; state.sugg = state.sugg.filter(function (x) { return x.id !== sg.id; }); render();
    }, function (err) {
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
      state.busy[sg.id] = "err"; render();
    });
  }
  function rejectSuggestion(sg) {
    state.busy[sg.id] = true; render();
    api.adminPatchSuggestion(sg.id, { status: "rejected", decided_at: new Date().toISOString() }).then(function () {
      delete state.busy[sg.id]; state.sugg = state.sugg.filter(function (x) { return x.id !== sg.id; }); render();
    }, function () { state.busy[sg.id] = "err"; render(); });
  }

  /* ---------- approve everything the current filters show (duplicates excluded) ---------- */
  var bulkIds = [], bulkArmed = false, bulkSkipped = 0;
  function drawBulk(rows) {
    var listed = state.view === "pending" ? rows : [];
    bulkIds = listed.filter(function (d) { var x = dupOf(d); return !(x && x.db.length); }).map(function (d) { return d.id; });
    bulkSkipped = listed.length - bulkIds.length;
    var n = bulkIds.length, skip = bulkSkipped ? " (" + bulkSkipped + " possible duplicates left for one-by-one review)" : "";
    $("bulk-approve").hidden = !n || bulkArmed; $("bulk-approve").textContent = "Approve all " + n + " listed" + skip;
    $("bulk-confirm").hidden = !n || !bulkArmed; $("bulk-confirm").textContent = "Confirm: approve " + n + " entries";
    $("bulk-cancel").hidden = !n || !bulkArmed;
  }
  function bulkReset() { bulkArmed = false; $("bulk-confirm").disabled = false; }
  $("bulk-approve").addEventListener("click", function () { bulkArmed = true; $("bulk-err").hidden = true; render(); });
  $("bulk-cancel").addEventListener("click", function () { bulkReset(); render(); });
  $("bulk-confirm").addEventListener("click", function () {
    var ids = bulkIds.slice(); $("bulk-confirm").disabled = true;
    api.adminPatchMany(ids, { status: "approved", decided_at: new Date().toISOString() }).then(function () {
      bulkReset(); load();
    }, function () {
      bulkReset(); $("bulk-err").textContent = "Not all entries could be approved. Refresh to see which ones went through."; $("bulk-err").hidden = false; load();
    });
  });

  /* ---------- literature batches published with the site ---------- */
  var pendingImport = [];
  function checkBatches() {
    api.batches().then(function (rows) {
      var have = {}; state.docs.forEach(function (d) { if (d.import_key) have[d.import_key] = 1; });
      pendingImport = rows.filter(function (r) { return r.import_key && !have[r.import_key]; });
      $("imp").hidden = !pendingImport.length;
      $("imp-text").textContent = pendingImport.length + " new literature entries are ready to add to the queue.";
    }, function () { $("imp").hidden = true; });   /* no batches published: nothing to offer */
  }
  $("imp-go").addEventListener("click", function () {
    var base = Date.now();
    var rows = pendingImport.map(function (r, i) {
      var o = {}; for (var k in r) o[k] = r[k];
      o.status = "pending"; o.created_at = new Date(base + i).toISOString(); o.idcode = Ent.idCode(r.smiles);
      return o;
    });
    $("imp-go").disabled = true; $("imp-text").textContent = "Importing " + rows.length + " entries…";
    api.adminImport(rows).then(function () { $("imp-go").disabled = false; $("imp").hidden = true; load(); },
      function (err) {
        $("imp-go").disabled = false;
        $("imp-text").textContent = "The import stopped: " + (err.message || "unknown error") + ". Entries already added are kept; press the button to continue.";
        load();
      });
  });

  /* Rows imported without a structure code get one as soon as the structure library is ready,
     so the server can match later submissions of the same molecule. */
  var backfilled = false;
  function backfill() {
    if (backfilled || !state.loaded || !window.OCL) return;
    backfilled = true;
    state.docs.filter(function (d) { return !d.idcode && Ent.idCode(d.smiles); })
      .reduce(function (p, d) { return p.then(function () { return api.adminPatch(d.id, { idcode: Ent.idCode(d.smiles) }).catch(function () {}); }); }, Promise.resolve());
  }

  function load() {
    state.loaded = false; state.loadErr = ""; render();
    return Promise.all([api.adminList(), api.adminSuggestions().catch(function () { return []; })]).then(function (r) {
        state.docs = r[0] || []; state.sugg = r[1] || []; dupCache = {}; state.loaded = true; render(); backfill(); checkBatches();
      },
      function (err) {
        if (err.status === 401) signedOut("Your session ended. Sign in again.");
        else { state.loadErr = "The entries could not be loaded. Use Refresh to try again."; render(); }
      });
  }
  function signedOut(msg) { Ent.editor.close(); Ent.closeDialog(); Ent.sketcher.close(); api.signOut(); show("login"); banner(msg || ""); }

  function start() {
    if (!api.configured) { show(""); banner("The backend is not configured yet, so there is nothing to review. See the setup steps in the repository README."); return; }
    api.token().then(function (t) {
      if (!t) { show("login"); return; }
      api.isAdmin().then(function (ok) {
        if (ok === true) { show("panel"); banner(""); load(); }
        else signedOut("This address is not a curator of this database.");
      }, function (err) {
        /* A rejected token ends the session; a network problem does not. */
        if (err && err.status === 401) signedOut("Your session ended. Sign in again.");
        else { show(""); banner("The server could not be reached to check your sign-in. Check the connection and reload the page."); }
      });
    });
  }

  $("login").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("login-email").value.trim(), pass = $("login-pass").value; $("login-err").hidden = true;
    if (!/^\S+@\S+\.\S+$/.test(email) || !pass) { $("login-err").textContent = "Enter your email and password."; $("login-err").hidden = false; return; }
    $("login-send").disabled = true; banner("");
    api.signIn(email, pass).then(function () {
      $("login-send").disabled = false; $("login-pass").value = ""; start();
    }, function (err) {
      $("login-send").disabled = false;
      $("login-err").textContent = err.status === 400 || err.status === 401 ? "Wrong email or password."
        : err.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Sign-in failed. Try again.";
      $("login-err").hidden = false;
    });
  });
  $("signout").addEventListener("click", function (e) { e.preventDefault(); signedOut(""); });
  $("reload").addEventListener("click", load);
  ["pending", "approved", "rejected"].forEach(function (k) {
    $("tab-" + k).addEventListener("click", function () { state.view = k; state.search.pager.shown = 0; bulkReset(); render(); });
  });
  /* Changing the search or filters disarms a pending bulk approval: it must cover what was confirmed. */
  Ent.bindSearch(state.search, function () { bulkReset(); render(); });
  Ent.sketcher.bind();
  Ent.loadOCL(function () { dupCache = {}; if (state.loaded) render(); backfill(); });
  start();
})();
