/* TrEnDB review page: curator sign-in with email and password, then review, edit, approve or reject. */
(function () {
  "use strict";
  var $ = Ent.$, api = Ent.api;
  var state = { docs: [], sugg: [], view: "pending", loaded: false, loadErr: "", busy: {}, drafts: {}, selected: {}, search: Ent.newSearch("review") };
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
    $("up-pick").disabled = !state.loaded;
    if (!state.loaded) { status.hidden = false; status.textContent = state.loadErr || "Loading…"; list.replaceChildren(); drawBulk([]); return; }
    var inView = state.docs.filter(function (d) { return d.status === state.view; });
    Ent.fillClasses(inView, state.search);   /* only the classes present in this tab */
    var res = Ent.filterRows(inView, state.search);
    if (state.view === "pending" && state.search.sort === "review") res.rows = clusterDuplicates(res.rows);
    Ent.searchInfo(res, inView.length);
    Ent.drawList(list, res.rows, function (d) {
      return Ent.card(d, { scores: res.scores, simMode: state.search.ss.mode === "sim", dup: dupOf(d),
        admin: { busy: state.busy, drafts: state.drafts, onPatch: onPatch, approve: approve,
                 selected: state.selected, onSelect: onSelect, onDelete: confirmDelete } });
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

  /* Review order: rows arrive sorted by score; entries that duplicate each other (the same value
     in the queue) are pulled together at the position of the best-scored one, best first. */
  function clusterDuplicates(rows) {
    var inList = {}, parent = {};
    rows.forEach(function (d) { inList[d.id] = 1; parent[d.id] = d.id; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    rows.forEach(function (d) {
      var dup = dupOf(d); if (!dup) return;
      dup.queueSame.forEach(function (m) { if (inList[m.entry.id]) { var a = find(d.id), b = find(m.entry.id); if (a !== b) parent[b] = a; } });
    });
    var groups = {}, order = [];
    rows.forEach(function (d) { var r = find(d.id); if (!groups[r]) { groups[r] = []; order.push(r); } groups[r].push(d); });
    return order.reduce(function (out, r) { return out.concat(groups[r]); }, []);
  }

  /* ---------- approving one entry: duplicates must be resolved first ---------- */
  function approve(d, note) {
    var dup = dupOf(d), now = new Date().toISOString();
    /* a different value for a known molecule is simply added: it appears beside the others on the molecule's card */
    if (!dup || !dup.dbSame.length) return onPatch(d.id, { status: "approved", decided_at: now, note: note });
    return new Promise(function (resolve) {
      Ent.dialog("Possible duplicate: " + (d.name || ""), function (box) {
        box.appendChild(Ent.el("p", null, "The same value for this molecule is already in the database. To add the new entry, the existing one is overwritten. Choose the entry to overwrite:"));
        var opts = Ent.el("div", "stack");
        dup.dbSame.forEach(function (m, i) {
          var lab = Ent.el("label", "check"), r = Ent.el("input"); r.type = "radio"; r.name = "dup-target"; r.value = m.entry.id; r.checked = i === 0;
          lab.appendChild(r);
          lab.appendChild(document.createTextNode(m.entry.name + " · " + Ent.fmt(Number(m.entry.et_kcal), 1) + " kcal/mol · " +
            (m.entry.origin === "calc" ? "computed" : "experimental") + (m.entry.doi ? " · " + m.entry.doi : "") + " (" + m.why + ")"));
          opts.appendChild(lab);
        });
        box.appendChild(opts);
        box.appendChild(Ent.el("p", "hint", "The overwritten entry moves to the Rejected tab with a note, so it can be restored. Use “Keep both” only if they are in fact different data; both values then appear on the same molecule card."));
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
  /* ---------- selection: approve, reject, re-queue or delete several entries at once ---------- */
  var listed = [];   /* entries shown under the current tab, search and filters */
  function onSelect(id, on) { if (on) state.selected[id] = true; else delete state.selected[id]; drawSel(); }
  function selectedDocs() {
    var byId = {}; state.docs.forEach(function (d) { byId[d.id] = d; });
    return Object.keys(state.selected).map(function (id) { return byId[id]; })
      .filter(function (d) { return d && d.status === state.view; });
  }
  function drawBulk(rows) { listed = rows || []; drawSel(); }
  function drawSel() {
    var sel = selectedDocs(), n = sel.length, v = state.view;
    $("sel-n").textContent = n + " selected";
    $("sel-all").hidden = !listed.length; $("sel-all").textContent = "Select all " + listed.length + " listed";
    $("sel-none").hidden = !n;
    $("sel-approve").hidden = !n || v === "approved";
    $("sel-reject").hidden = !n || v === "rejected";
    $("sel-queue").hidden = !n || v === "pending";
    $("sel-delete").hidden = !n || v !== "rejected";
    $("selbar").hidden = !state.loaded || (!listed.length && !n);
  }
  function clearSel() { state.selected = {}; }
  $("sel-all").addEventListener("click", function () { listed.forEach(function (d) { state.selected[d.id] = true; }); render(); });
  $("sel-none").addEventListener("click", function () { clearSel(); render(); });
  function bulkError(t) { $("bulk-err").textContent = t; $("bulk-err").hidden = false; }
  function runPatch(docs, patch, verb) {
    $("bulk-err").hidden = true;
    var ids = docs.map(function (d) { return d.id; });
    return api.adminPatchMany(ids, patch).then(function (n) {
      clearSel(); if (n < ids.length) bulkError((ids.length - n) + " of " + ids.length + " entries could not be " + verb + ".");
      load();
    }, function () { bulkError("Not all entries could be " + verb + ". Refresh to see which ones went through."); load(); });
  }
  function askThen(title, text, label, cls, go) {
    Ent.dialog(title, function (box) {
      box.appendChild(Ent.el("p", null, text));
      var act = Ent.el("div", "actions"), ok = Ent.el("button", "btn " + cls, label), no = Ent.el("button", "btn", "Cancel");
      ok.type = no.type = "button"; act.appendChild(ok); act.appendChild(no); box.appendChild(act);
      no.addEventListener("click", Ent.closeDialog);
      ok.addEventListener("click", function () { ok.disabled = true; Ent.closeDialog(); go(); });
      setTimeout(function () { no.focus(); }, 0);
    });
  }
  $("sel-approve").addEventListener("click", function () {
    var sel = selectedDocs();
    /* the same value already in the database (yellow) must be resolved one by one */
    var ok = sel.filter(function (d) { var x = dupOf(d); return !(x && x.flag); }), skipped = sel.length - ok.length;
    if (!ok.length) { bulkError("All selected entries are possible duplicates: approve them one by one."); return; }
    askThen("Approve " + ok.length + " entries?", "They become public at once." + (skipped ? " " + skipped + " possible duplicates (yellow) are left selected for one-by-one review." : ""),
      "Approve " + ok.length, "primary", function () {
        var now = new Date().toISOString();
        runPatch(ok, { status: "approved", decided_at: now }, "approved").then(function () {
          sel.filter(function (d) { return ok.indexOf(d) < 0; }).forEach(function (d) { state.selected[d.id] = true; }); render();
        });
      });
  });
  $("sel-reject").addEventListener("click", function () {
    var sel = selectedDocs();
    askThen("Reject " + sel.length + " entries?", "They move to the Rejected tab, where they can be restored or deleted.", "Reject " + sel.length, "reject",
      function () { runPatch(sel, { status: "rejected", decided_at: new Date().toISOString() }, "rejected"); });
  });
  $("sel-queue").addEventListener("click", function () {
    var sel = selectedDocs();
    runPatch(sel, { status: "pending", decided_at: null }, "moved back to the queue");
  });
  $("sel-delete").addEventListener("click", function () { confirmDelete(selectedDocs()); });
  /* Permanent deletion: only rejected entries, always after a confirmation that says it cannot be undone. */
  function confirmDelete(docs) {
    docs = docs.filter(function (d) { return d.status === "rejected"; });
    if (!docs.length) return;
    var what = docs.length === 1 ? "“" + (docs[0].name || "this entry") + "”" : docs.length + " rejected entries";
    askThen("Delete " + what + " permanently?", (docs.length === 1 ? "This removes it" : "This removes them") + " from the database for good, together with any corrections suggested for " + (docs.length === 1 ? "it" : "them") + ". It cannot be undone.",
      "Delete permanently", "danger primary", function () {
        $("bulk-err").hidden = true;
        api.adminDeleteMany(docs.map(function (d) { return d.id; })).then(function (n) {
          docs.forEach(function (d) { delete state.selected[d.id]; });
          if (n < docs.length) bulkError((docs.length - n) + " of " + docs.length + " entries could not be deleted.");
          load();
        }, function (e) {
          if (e && e.status === 401) { signedOut("Your session ended. Sign in again."); return; }
          bulkError("The entries could not be deleted. Try again."); load();
        });
      });
  }

  /* ---------- literature batches published with the site + manual JSON upload ---------- */
  var UPLOAD_KEYS = [
    "import_key", "name", "cas", "smiles", "idcode", "smiles_checked", "structure_note",
    "cls", "role", "origin", "et_kcal", "et_unc", "et_reported", "et_type", "method",
    "conditions", "citation", "doi", "location", "quote", "evidence", "verify_level",
    "verify_note", "uv_lmax", "uv_eps", "uv_cond", "direct_exc", "source_kind",
    "score", "score_items", "uses", "status", "created_at"
  ];
  function toImportRows(list) {
    var base = Date.now();
    return list.map(function (r, i) {
      var o = {};
      UPLOAD_KEYS.forEach(function (k) { o[k] = r[k] !== undefined ? r[k] : null; });
      o.smiles_checked = !!r.smiles_checked;
      o.role = (r.role === "acceptor" || r.role === "donor" || r.role === "both") ? r.role : "acceptor";
      o.origin = r.origin === "calc" ? "calc" : "exp";
      o.source_kind = r.source_kind || "literature";
      o.status = "pending";
      o.created_at = new Date(base + i).toISOString();
      o.idcode = Ent.idCode(r.smiles) || r.idcode || null;
      return o;
    });
  }

  var pendingImport = [];
  function checkBatches() {
    api.batches().then(function (rows) {
      var have = {}; state.docs.forEach(function (d) { if (d.import_key) have[d.import_key] = 1; });
      pendingImport = rows.filter(function (r) { return r.import_key && !have[r.import_key]; });
      batchRows = rows;
      drawNames();
      $("imp").hidden = !pendingImport.length;
      $("imp-text").textContent = pendingImport.length + " new literature entries are ready to add to the queue.";
    }, function () { $("imp").hidden = true; });   /* no batches published: nothing to offer */
  }
  $("imp-go").addEventListener("click", function () {
    var rows = toImportRows(pendingImport);
    $("imp-go").disabled = true; $("imp-text").textContent = "Importing " + rows.length + " entries…";
    api.adminImport(rows).then(function () { $("imp-go").disabled = false; $("imp").hidden = true; load(); },
      function (err) {
        $("imp-go").disabled = false;
        $("imp-text").textContent = "The import stopped: " + (err.message || "unknown error") + ". Entries already added are kept; press the button to continue.";
        load();
      });
  });

  var uploadRows = [];
  function resetUpload(msg, isErr) {
    uploadRows = [];
    $("up-file").value = "";
    $("up-go").hidden = true; $("up-go").disabled = false;
    $("up-clear").hidden = true;
    $("up-err").hidden = !isErr; $("up-err").textContent = isErr ? msg : "";
    $("up-info").textContent = (!isErr && msg) ? msg : "Import a batch JSON generated by trendb-extract directly into the review queue.";
  }
  function parseAndValidateUpload(raw, fileName) {
    if (!Array.isArray(raw) || !raw.length) return { err: "The JSON file must be a non-empty array of entry objects." };
    var slug = String(fileName || "upload").replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "upload";
    var have = {}; state.docs.forEach(function (d) { if (d.import_key) have[d.import_key] = 1; });
    var valid = [], skipped = 0, usedKeys = {};
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) return { err: "Row " + (i + 1) + " is not an object." };
      var tag = r.import_key || ("row " + (i + 1));
      var keys = Object.keys(r);
      for (var ki = 0; ki < keys.length; ki++) {
        var v = r[keys[ki]];
        if (typeof v === "string" && /https?:\/\//i.test(v)) return { err: tag + " (" + keys[ki] + "): contains a web link; only DOIs are allowed." };
      }
      var name = String(r.name || "").trim(), smi = String(r.smiles || "").trim();
      if (!name) return { err: tag + ": name is required." };
      if (!smi) return { err: tag + ": smiles is required." };
      if (Ent.structureOk(smi) === false) return { err: tag + ": SMILES could not be read." };
      var et = Number(r.et_kcal);
      if (!isFinite(et) || et <= 0 || et > EntScore.ET_MAX) return { err: tag + ": et_kcal must be between 0 and " + EntScore.ET_MAX + "." };
      if (r.origin !== "exp" && r.origin !== "calc") return { err: tag + ": origin must be \"exp\" or \"calc\"." };
      var doi = r.doi ? EntScore.cleanDoi(r.doi) : null;
      if (doi && !EntScore.isDoi(doi)) return { err: tag + ": \"" + r.doi + "\" is not a valid DOI." };
      var cas = r.cas ? EntScore.cleanCas(r.cas) : null;
      if (cas && !EntScore.casValid(cas)) return { err: tag + ": \"" + r.cas + "\" is not a valid CAS number." };
      if (r.uv_lmax != null && (!(typeof r.uv_lmax === "number" && Math.floor(r.uv_lmax) === r.uv_lmax && r.uv_lmax >= 100 && r.uv_lmax <= 1500))) {
        return { err: tag + ": uv_lmax must be an integer between 100 and 1500." };
      }
      if (r.uv_eps != null && (!(typeof r.uv_eps === "number" && Math.floor(r.uv_eps) === r.uv_eps && r.uv_eps >= 0))) {
        return { err: tag + ": uv_eps must be a non-negative integer." };
      }
      if (r.direct_exc != null) {
        if (typeof r.direct_exc !== "object" || Array.isArray(r.direct_exc)) return { err: tag + ": direct_exc must be an object." };
        var dkeys = Object.keys(r.direct_exc);
        for (var di = 0; di < dkeys.length; di++) {
          var dv = r.direct_exc[dkeys[di]];
          if (!dkeys[di].trim() || typeof dv !== "number" || Math.floor(dv) !== dv || dv < 100 || dv > 1500) {
            return { err: tag + ": direct_exc values must be integers between 100 and 1500." };
          }
        }
      }
      var ik = r.import_key ? String(r.import_key).trim() : ("json:" + slug + ":" + (i + 1));
      if (have[ik] || usedKeys[ik]) { skipped++; continue; }
      usedKeys[ik] = 1;
      var copy = {}; for (var rk in r) copy[rk] = r[rk];
      copy.import_key = ik; copy.name = name.slice(0, 200); copy.smiles = smi;
      copy.doi = doi; copy.cas = cas;
      if (copy.score == null) {
        var norm = EntScore.normalize({
          name: copy.name, cas: cas || "", cls: copy.cls || "", smiles: smi, role: copy.role,
          et: et, unit: "kcal", unc: copy.et_unc, origin: copy.origin, kind: copy.et_type,
          tech: copy.origin === "calc" ? "" : (copy.method || ""), solvent: copy.conditions || "",
          cite: copy.citation || "", doi: doi || "", loc: copy.location || "", quote: copy.quote || "",
          uv_lmax: copy.uv_lmax, uv_eps: copy.uv_eps, uv_cond: copy.uv_cond || "", direct_exc: copy.direct_exc
        });
        var sc = EntScore.scoreEntry(norm, { structureOk: Ent.structureOk(smi), doiResolves: null, same: [] });
        copy.score = sc.total; copy.score_items = sc.items;
      }
      valid.push(copy);
    }
    return { rows: valid, skipped: skipped };
  }
  $("up-pick").addEventListener("click", function () { $("up-file").click(); });
  $("up-clear").addEventListener("click", function () { resetUpload(); });
  $("up-file").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(function (txt) {
      var parsed;
      try { parsed = JSON.parse(txt); } catch (err) { resetUpload("Could not parse JSON: " + err.message, true); return; }
      var res = parseAndValidateUpload(parsed, file.name);
      if (res.err) { resetUpload(res.err, true); return; }
      uploadRows = res.rows;
      $("up-err").hidden = true; $("up-err").textContent = "";
      $("up-clear").hidden = false;
      if (!uploadRows.length) {
        $("up-go").hidden = true;
        $("up-info").textContent = file.name + ": all " + res.skipped + " entries are already in the database.";
        return;
      }
      $("up-go").hidden = false;
      $("up-go").textContent = "Import " + uploadRows.length + (uploadRows.length === 1 ? " entry" : " entries");
      $("up-info").textContent = file.name + ": " + uploadRows.length + " ready to import" +
        (res.skipped ? " (" + res.skipped + " already in the database skipped)" : "") + ".";
    }, function () { resetUpload("Could not read the selected file.", true); });
  });
  $("up-go").addEventListener("click", function () {
    if (!uploadRows.length) return;
    var rows = toImportRows(uploadRows);
    $("up-go").disabled = true; $("up-pick").disabled = true;
    $("up-info").textContent = "Importing " + rows.length + " entries…";
    api.adminImport(rows).then(function () {
      $("up-pick").disabled = false;
      resetUpload("Imported " + rows.length + (rows.length === 1 ? " entry" : " entries") + " into the review queue.");
      load();
    }, function (err) {
      $("up-go").disabled = false; $("up-pick").disabled = false;
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
      $("up-err").hidden = false;
      $("up-err").textContent = "The import stopped: " + (err.message || "unknown error") + ". Entries already added are kept; try again.";
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

  /* ---------- IUPAC names ----------
     Entry names are IUPAC names only. The literature batches carry them (checked by hand where PubChem
     has none): entries whose structure is in a batch take that name in one go; the others can be
     looked up on PubChem, one request at a time. */
  var nameMap = {}, batchRows = [], nameRun = null, nameTried = {};
  function buildNames() { nameMap = {}; batchRows.forEach(function (r) { if (r.smiles && r.name) nameMap[nameKey(r.smiles)] = r.name; }); }
  /* the same structure written as a different SMILES still matches (structure code, when the library is loaded) */
  function nameKey(smi) { return (window.OCL && Ent.idCode(smi)) || smi; }
  function nameOf(d) { return d.smiles ? nameMap[nameKey(d.smiles)] : ""; }
  function nameFix() { return state.docs.filter(function (d) { var n = nameOf(d); return n && d.name !== n; }); }
  function namePc() { return state.docs.filter(function (d) { return d.smiles && !nameOf(d) && !nameTried[d.id]; }); }
  function drawNames(msg) {
    if (nameRun) return;
    buildNames();
    var a = nameFix().length, b = namePc().length;
    $("iupac").hidden = !a && !b && !msg;
    $("iupac-go").hidden = !a; $("iupac-pc").hidden = !b; $("iupac-stop").hidden = true;
    $("iupac-text").textContent = (msg ? msg + " " : "") +
      (a ? a + (a === 1 ? " entry has" : " entries have") + " a name that is not the IUPAC name of its structure. " : "") +
      (b ? b + " other " + (b === 1 ? "entry" : "entries") + " (not from a literature batch) can be checked against PubChem." : "");
  }
  $("iupac-go").addEventListener("click", function () {
    var byName = {}; nameFix().forEach(function (d) { var n = nameOf(d); (byName[n] = byName[n] || []).push(d.id); });
    var names = Object.keys(byName), done = 0, fail = 0;
    $("iupac-go").disabled = true; nameRun = {};
    names.reduce(function (p, n) {
      return p.then(function () {
        $("iupac-text").textContent = "Renaming… " + done + " / " + names.length + " structures";
        return api.adminPatchMany(byName[n], { name: n }).then(function () { done++; }, function (e) { fail++; if (e && e.status === 401) throw e; });
      });
    }, Promise.resolve()).then(function () {
      nameRun = null; $("iupac-go").disabled = false;
      load().then(function () { drawNames(fail ? fail + " structures could not be renamed; try again." : "Names updated."); });
    }, function () { nameRun = null; $("iupac-go").disabled = false; signedOut("Your session ended. Sign in again."); });
  });
  $("iupac-pc").addEventListener("click", function () {
    var todo = namePc(), run = nameRun = { stop: false, set: 0, same: 0, miss: 0, fail: 0, inRow: 0 };
    $("iupac-go").hidden = $("iupac-pc").hidden = true; $("iupac-stop").hidden = false; $("iupac-stop").disabled = false;
    function finish(why) {
      nameRun = null; render();
      drawNames(why + " Renamed " + run.set + ", already IUPAC " + run.same + ", not on PubChem " + run.miss + (run.fail ? ", failed " + run.fail : "") +
        (run.miss ? ". Entries PubChem does not know need their IUPAC name written in the editor." : "."));
    }
    (function step(i) {
      if (run.stop) return finish("Stopped.");
      if (i >= todo.length) return finish("Done.");
      if (run.inRow >= 5) return finish("Stopped after five errors in a row.");
      $("iupac-text").textContent = "Checking " + (i + 1) + " / " + todo.length + " on PubChem…";
      var d = todo[i], wait = 250;
      Ent.lookupIupac(d.smiles).then(function (n) {
        run.inRow = 0; nameTried[d.id] = 1;
        if (!n) { run.miss++; return; }
        if (n === d.name) { run.same++; return; }
        return api.adminPatch(d.id, { name: n }).then(function (rows) {
          if (rows && rows[0]) { state.docs = state.docs.map(function (x) { return x.id === d.id ? rows[0] : x; }); run.set++; } else run.fail++;
        });
      }).catch(function (err) {
        if (err && err.status === 401) { run.stop = true; signedOut("Your session ended. Sign in again."); return; }
        run.fail++; run.inRow++; wait = 2000;
      }).then(function () { setTimeout(function () { step(i + 1); }, wait); });
    })(0);
  });
  $("iupac-stop").addEventListener("click", function () { if (nameRun) { nameRun.stop = true; $("iupac-stop").disabled = true; } });

  /* ---------- CAS numbers looked up on PubChem ---------- */
  /* One request at a time with a pause, under PubChem's limit of 5 per second.
     Entries PubChem has no CAS number for are skipped for the rest of this visit. */
  var casRun = null, casMiss = {};
  function casTodo() { return state.docs.filter(function (d) { return !d.cas && d.smiles && !casMiss[d.id]; }); }
  function drawCas() {
    if (casRun) return;
    var n = casTodo().length;
    $("cas").hidden = !n; $("cas-go").hidden = false; $("cas-stop").hidden = true;
    $("cas-text").textContent = n + (n === 1 ? " entry has" : " entries have") + " no CAS number. PubChem can fill the ones it knows; check doubtful ones in the editor.";
  }
  $("cas-go").addEventListener("click", function () {
    var todo = casTodo(), run = casRun = { stop: false, out: false, found: 0, miss: 0, fail: 0, inRow: 0 };
    $("cas-go").hidden = true; $("cas-stop").hidden = false; $("cas-stop").disabled = false;
    function finish(why) {
      casRun = null;
      if (run.out) return;   /* signed out meanwhile: the panel is gone */
      dupCache = {}; render(); drawCas();   /* new CAS numbers change which entries are duplicates */
      var left = casTodo().length;
      $("cas").hidden = false; $("cas-go").hidden = !left;
      $("cas-text").textContent = why + " Filled " + run.found + ", not on PubChem " + run.miss + (run.fail ? ", failed " + run.fail : "") + "."
        + (left ? " " + left + " can still be tried." : "");
    }
    (function step(i) {
      if (run.stop) return finish("Stopped.");
      if (i >= todo.length) return finish("Done.");
      if (run.inRow >= 5) return finish("Stopped after five errors in a row (PubChem or the database did not answer).");
      $("cas-text").textContent = "Looking up " + (i + 1) + " / " + todo.length + " · filled " + run.found + " · not on PubChem " + run.miss + (run.fail ? " · failed " + run.fail : "");
      var d = todo[i], wait = 250;
      Ent.lookupCas(d.smiles).then(function (list) {
        run.inRow = 0;
        if (!list.length) { casMiss[d.id] = 1; run.miss++; return; }
        return api.adminPatch(d.id, { cas: list[0] }).then(function (rows) {
          if (rows && rows[0]) { state.docs = state.docs.map(function (x) { return x.id === d.id ? rows[0] : x; }); run.found++; }
          else run.fail++;
        });
      }).catch(function (err) {
        if (err && err.status === 401) { run.stop = run.out = true; signedOut("Your session ended. Sign in again."); return; }
        run.fail++; run.inRow++; wait = 2000;   /* PubChem busy or offline, or the save failed: back off */
      }).then(function () { setTimeout(function () { step(i + 1); }, wait); });
    })(0);
  });
  $("cas-stop").addEventListener("click", function () { if (casRun) { casRun.stop = true; $("cas-stop").disabled = true; } });

  function load() {
    state.loaded = false; state.loadErr = ""; render();
    return Promise.all([api.adminList(), api.adminSuggestions().catch(function () { return []; })]).then(function (r) {
        state.docs = r[0] || []; state.sugg = r[1] || []; dupCache = {}; state.loaded = true; render(); backfill(); checkBatches(); drawCas();
      },
      function (err) {
        if (err.status === 401) signedOut("Your session ended. Sign in again.");
        else { state.loadErr = "The entries could not be loaded. Use Refresh to try again."; render(); }
      });
  }
  function signedOut(msg) { if (casRun) casRun.stop = casRun.out = true; if (nameRun) nameRun.stop = true; $("cas").hidden = true; $("iupac").hidden = true; $("imp").hidden = true; resetUpload(); Ent.editor.close(); Ent.closeDialog(); Ent.sketcher.close(); api.signOut(); show("login"); banner(msg || ""); }

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
    $("tab-" + k).addEventListener("click", function () { state.view = k; state.search.pager.shown = 0; clearSel(); render(); });
  });
  /* Changing the search or filters disarms a pending bulk approval: it must cover what was confirmed. */
  Ent.bindSearch(state.search, function () { render(); });
  Ent.sketcher.bind();
  Ent.loadOCL(function () { dupCache = {}; if (state.loaded) { render(); drawNames(); } backfill(); });
  start();
})();
