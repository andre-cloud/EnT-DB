/* EnT-DB review page: curator sign-in by one-time link, then approve or reject. */
(function () {
  "use strict";
  var $ = Ent.$, api = Ent.api;
  var state = { docs: [], view: "pending", loaded: false, busy: {}, drafts: {}, search: Ent.newSearch() };

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
    if (!state.loaded) { status.hidden = false; status.textContent = "Loading…"; list.replaceChildren(); return; }
    var inView = state.docs.filter(function (d) { return d.status === state.view; });
    var res = Ent.filterRows(inView, state.search);
    Ent.searchInfo(res, inView.length);
    list.replaceChildren.apply(list, res.rows.map(function (d) {
      return Ent.card(d, { scores: res.scores, simMode: state.search.ss.mode === "sim",
        admin: { busy: state.busy, drafts: state.drafts, onPatch: onPatch } });
    }));
    status.hidden = res.rows.length > 0;
    if (!res.rows.length) {
      status.textContent = inView.length ? "No entry matches the current search and filters."
        : state.view === "pending" ? "The queue is empty." : state.view === "approved" ? "Nothing approved yet." : "Nothing rejected.";
    }
  }

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
    state.loaded = false; render();
    return api.adminList().then(function (rows) { state.docs = rows || []; state.loaded = true; render(); backfill(); },
      function (err) { if (err.status === 401) signedOut("Your session ended. Sign in again."); else { $("status").textContent = "The entries could not be loaded. Use Refresh to try again."; } });
  }
  function signedOut(msg) { api.signOut(); show("login"); banner(msg || ""); }

  function start() {
    if (!api.configured) { show(""); banner("The backend is not configured yet, so there is nothing to review. See the setup steps in the repository README."); return; }
    var hashErr = api.consumeHash();
    api.token().then(function (t) {
      if (!t) { show("login"); if (hashErr) banner("Sign-in failed: " + hashErr); return; }
      api.isAdmin().then(function (ok) {
        if (ok === true) { show("panel"); banner(""); load(); }
        else signedOut("This address is not a curator of this database.");
      }, function () { signedOut("Sign-in could not be verified. Try again."); });
    });
  }

  $("login").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("login-email").value.trim(); $("login-ok").hidden = true; $("login-err").hidden = true;
    if (!/^\S+@\S+\.\S+$/.test(email)) { $("login-err").textContent = "Enter a valid email address."; $("login-err").hidden = false; return; }
    $("login-send").disabled = true;
    api.sendLink(email, location.origin + location.pathname).then(function () {
      $("login-send").disabled = false;
      $("login-ok").textContent = "Check your inbox for the sign-in link, then open it on this device."; $("login-ok").hidden = false;
    }, function (err) {
      $("login-send").disabled = false;
      $("login-err").textContent = err.status === 429 ? "Too many sign-in emails. Wait a few minutes and try again." : "The link could not be sent. Try again.";
      $("login-err").hidden = false;
    });
  });
  $("signout").addEventListener("click", function (e) { e.preventDefault(); signedOut(""); });
  $("reload").addEventListener("click", load);
  ["pending", "approved", "rejected"].forEach(function (k) {
    $("tab-" + k).addEventListener("click", function () { state.view = k; render(); });
  });
  Ent.bindSearch(state.search, render);
  Ent.sketcher.bind();
  Ent.loadOCL(function () { if (state.loaded) render(); backfill(); });
  start();
})();
