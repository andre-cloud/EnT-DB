/* EnT-DB review page: curator sign-in with email and password, then review, edit, approve or reject. */
(function () {
  "use strict";
  var $ = Ent.$, api = Ent.api;
  var state = { docs: [], view: "pending", loaded: false, loadErr: "", busy: {}, drafts: {}, search: Ent.newSearch() };

  function banner(t) { var m = $("adm-msg"); m.hidden = !t; m.textContent = t || ""; }
  function show(which) { $("login").hidden = which !== "login"; $("panel").hidden = which !== "panel"; $("signout").hidden = which !== "panel"; }

  function onPatch(id, patch) {
    state.busy[id] = true; render();
    return api.adminPatch(id, patch).then(function (rows) {
      delete state.busy[id];
      if (rows && rows[0]) state.docs = state.docs.map(function (d) { return d.id === id ? rows[0] : d; });
      else state.busy[id] = "err";               /* no row returned: not allowed or gone */
      render(); return !!(rows && rows[0]);
    }, function (err) {
      if (err.status === 401) { signedOut("Your session ended. Sign in again."); return false; }
      state.busy[id] = "err"; render(); return false;
    });
  }

  function render() {
    var counts = { pending: 0, approved: 0, rejected: 0 };
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
      return Ent.card(d, { scores: res.scores, simMode: state.search.ss.mode === "sim",
        admin: { busy: state.busy, drafts: state.drafts, onPatch: onPatch } });
    }, state.search.pager, render);
    drawBulk(res.err ? [] : res.rows);   /* never offer bulk approval when the search failed */
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = inView.length ? "No entry matches the current search and filters."
        : state.view === "pending" ? "The queue is empty." : state.view === "approved" ? "Nothing approved yet." : "Nothing rejected.";
    }
  }

  /* ---------- approve everything the current filters show ---------- */
  var bulkIds = [], bulkArmed = false;
  function drawBulk(rows) {
    bulkIds = state.view === "pending" ? rows.map(function (d) { return d.id; }) : [];
    var n = bulkIds.length;
    $("bulk-approve").hidden = !n || bulkArmed; $("bulk-approve").textContent = "Approve all " + n + " listed";
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
    return api.adminList().then(function (rows) { state.docs = rows || []; state.loaded = true; render(); backfill(); checkBatches(); },
      function (err) {
        if (err.status === 401) signedOut("Your session ended. Sign in again.");
        else { state.loadErr = "The entries could not be loaded. Use Refresh to try again."; render(); }
      });
  }
  function signedOut(msg) { Ent.editor.close(); Ent.sketcher.close(); api.signOut(); show("login"); banner(msg || ""); }

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
  Ent.loadOCL(function () { if (state.loaded) render(); backfill(); });
  start();
})();
