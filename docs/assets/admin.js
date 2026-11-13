/* TrEnDB review page: curator sign-in, triage queue, batch/PubChem tools, editor & undoable review. */
(function () {
  "use strict";
  var $ = Ent.$, el = Ent.el, elT = Ent.elT, api = Ent.api;
  var state = {
    docs: [], sugg: [], view: "pending", triage: "",
    loaded: false, refreshing: false, loadErr: "", lastSync: null,
    busy: {}, drafts: {}, selected: {}, activeId: "",
    search: Ent.newSearch("review")
  };
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
  function show(which) {
    $("login").hidden = which !== "login";
    $("panel").hidden = which !== "panel";
    $("signout").hidden = which !== "panel";
    $("kb-help-btn").hidden = which !== "panel";
    var ce = $("curator-email");
    if (which === "panel") {
      var em = api.sessionEmail ? api.sessionEmail() : "";
      ce.textContent = em; ce.hidden = !em;
    } else {
      ce.textContent = ""; ce.hidden = true;
    }
  }

  Ent.initTheme("theme-toggle");
  var toast = Ent.toast;

  /* ---------- Tool log & enrichment helpers ---------- */
  function docsById() {
    var byId = {};
    state.docs.forEach(function (d) { byId[d.id] = d; });
    return byId;
  }

  var toolLogs = [];
  function addToolLog(msg) {
    var stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    toolLogs.unshift(stamp + " · " + msg);
    if (toolLogs.length > 50) toolLogs.length = 50;
    drawToolLog();
  }
  function drawToolLog() {
    var wrap = $("tool-log-wrap"), ul = $("tool-log");
    wrap.hidden = !toolLogs.length;
    $("tool-log-count").textContent = toolLogs.length;
    ul.replaceChildren.apply(ul, toolLogs.map(function (t) { return el("li", null, t); }));
  }
  $("tool-log-clear").addEventListener("click", function () { toolLogs = []; drawToolLog(); });

  function updateToolsBadge() {
    var n = (pendingImport.length ? 1 : 0) + (smiFix().length ? 1 : 0) + ((nameFix().length || namePc().length) ? 1 : 0) + (casTodo().length ? 1 : 0) + (commTodo().length ? 1 : 0);
    var b = $("n-tools"); b.textContent = n; b.hidden = !n;
  }

  function applyUpdatedRows(rows) {
    var byUp = {};
    (rows || []).forEach(function (r) { byUp[r.id] = r; });
    state.docs = state.docs.map(function (d) { return byUp[d.id] || d; });
    dupCache = {};
    return byUp;
  }

  function onPatch(id, patch) {
    state.busy[id] = true; render();
    return api.adminPatch(id, patch).then(function (rows) {
      delete state.busy[id];
      if (rows && rows[0]) {
        applyUpdatedRows(rows);
        if ("smiles" in patch) { delete casMiss[id]; delete nameTried[id]; }
        if ("cas" in patch) delete commMiss[id];
      }
      else state.busy[id] = "err";               /* no row returned: not allowed or gone */
      render(); drawCas(); drawComm(); drawSmiSync(); drawNames(); drawEnrichIssues(); return !!(rows && rows[0]);
    }, function (err) {
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return false; }
      state.busy[id] = "err"; render(); return false;
    });
  }

  function myEmail() { return (api.sessionEmail ? api.sessionEmail() : "").trim().toLowerCase(); }

  /* ---------- Triage pills & suggestion filtering ---------- */
  function enrichIssueDocIds() {
    var map = {};
    enrichIssues.forEach(function (it) { it.docIds.forEach(function (id) { map[id] = 1; }); });
    return map;
  }
  var TRIAGE_PRED = {
    need2: function (d) { var ap = Ent.approvalState(d, myEmail()); return d.status === "pending" && ap.count === 1 && !ap.byMe; },
    wait2: function (d) { var ap = Ent.approvalState(d, myEmail()); return d.status === "pending" && ap.byMe; },
    dup: function (d) { var x = dupOf(d); return !!(x && x.flag); },
    unchecked: function (d) { return !d.smiles_checked; },
    nocas: function (d) { return !d.cas; },
    verify: function (d) { return d.verify_level === "abstract" || d.verify_level === "secondaria"; },
    form: function (d) { return d.source_kind === "form"; },
    low: function (d) { return d.score != null && Number(d.score) < 50; },
    enrich: function (d) { return !!enrichIssueDocIds()[d.id]; }
  };
  function updateTriageBar(inView) {
    var counts = { "": inView.length, sugg: state.view === "pending" ? state.sugg.length : 0, need2: 0, wait2: 0, dup: 0, unchecked: 0, nocas: 0, verify: 0, form: 0, low: 0, enrich: 0 };
    inView.forEach(function (d) {
      Object.keys(TRIAGE_PRED).forEach(function (k) { if (TRIAGE_PRED[k](d)) counts[k]++; });
    });
    if (state.triage && state.triage !== "" && !counts[state.triage]) state.triage = "";
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

  function filterSuggestions(byId) {
    if (state.view !== "pending" || !state.sugg.length) return [];
    if (state.triage && state.triage !== "sugg") return [];
    var st = state.search, q = st.q.trim().toLowerCase();
    var out = state.sugg.filter(function (sg) {
      var entry = byId[sg.entry_id] || null;
      if (st.origin && (!entry || entry.origin !== st.origin)) return false;
      if (st.cas && (!entry || String(entry.cas || "").indexOf(st.cas) !== 0)) return false;
      if (st.role && (!entry || (entry.role !== st.role && entry.role !== "both"))) return false;
      if (st.cls && (!entry || (entry.cls || "") !== st.cls)) return false;
      if (q) {
        var hay = [entry && entry.name, entry && entry.cas, entry && entry.smiles, entry && entry.doi, sg.comment, sg.submitted_by, JSON.stringify(sg.changes || {})]
          .filter(Boolean).join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    if (st.sort === "received-desc") {
      out.sort(function (a, b) { return (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0); });
    }
    return out;
  }

  function setFocusCard(id, scrollIntoView, blockPos) {
    state.activeId = id || "";
    Array.prototype.forEach.call($("list").children, function (node) {
      if (!node.getAttribute) return;
      var hit = node.getAttribute("data-id") === state.activeId;
      node.classList.toggle("kb-focus", hit);
      if (hit && scrollIntoView && node.scrollIntoView) node.scrollIntoView({ block: blockPos || "nearest", behavior: "smooth" });
    });
  }

  function visibleRowsForView() {
    var inView = state.docs.filter(function (d) { return d.status === state.view; });
    var res = Ent.filterRows(inView, state.search);
    var rows = state.triage === "sugg" ? [] : (state.triage && TRIAGE_PRED[state.triage] ? res.rows.filter(TRIAGE_PRED[state.triage]) : res.rows);
    if (state.view === "pending" && state.search.sort === "review") rows = clusterDuplicates(rows).rows;
    return rows;
  }

  function resetFiltersForJump() {
    var fresh = Ent.newSearch(state.search.defSort);
    ["q", "cas", "origin", "role", "cls", "etmin", "etmax", "sort"].forEach(function (k) { state.search[k] = fresh[k]; });
    state.search.ss.smiles = ""; state.search.ss.mode = fresh.ss.mode; state.search.ss.thr = fresh.ss.thr;
    ["q", "f-cas", "f-origin", "f-role", "f-cls", "f-etmin", "f-etmax", "ss-smiles"].forEach(function (id) { $(id).value = ""; });
    $("f-sort").value = state.search.sort; $("ss-mode").value = state.search.ss.mode;
    $("ss-thr").value = String(state.search.ss.thr); $("ss-thr").hidden = true;
    state.triage = "";
  }

  function focusIssueCard(docId) {
    var doc = docsById()[docId];
    if (!doc) { toast("This entry is no longer in the database."); drawEnrichIssues(); return; }
    if (state.view !== doc.status) {
      state.view = doc.status; state.triage = ""; state.search.pager.shown = 0; clearSel();
    }
    var rows = visibleRowsForView();
    var idx = -1;
    rows.forEach(function (r, i) { if (r.id === doc.id) idx = i; });
    if (idx < 0) {
      if (state.triage) { state.triage = ""; rows = visibleRowsForView(); rows.forEach(function (r, i) { if (r.id === doc.id) idx = i; }); }
      if (idx < 0) { resetFiltersForJump(); rows = visibleRowsForView(); rows.forEach(function (r, i) { if (r.id === doc.id) idx = i; }); }
    }
    if (idx >= 0) {
      var minShown = Math.ceil((idx + 1) / 50) * 50;
      if ((state.search.pager.shown || 50) < minShown) state.search.pager.shown = minShown;
    }
    render();
    setFocusCard(doc.id, true, "center");
  }

  var lastOrderIds = [];
  function syncActiveAfterRender(rows) {
    var nextIds = rows.map(function (d) { return d.id; });
    if (state.activeId && nextIds.indexOf(state.activeId) < 0) {
      var oldIdx = lastOrderIds.indexOf(state.activeId), picked = "";
      if (oldIdx >= 0) {
        var inNext = {}; nextIds.forEach(function (id) { inNext[id] = 1; });
        for (var i = oldIdx + 1; i < lastOrderIds.length; i++) if (inNext[lastOrderIds[i]]) { picked = lastOrderIds[i]; break; }
        if (!picked) for (var j = oldIdx - 1; j >= 0; j--) if (inNext[lastOrderIds[j]]) { picked = lastOrderIds[j]; break; }
      }
      state.activeId = picked;
    }
    lastOrderIds = nextIds;
  }

  function render() {
    var counts = { pending: state.sugg.length, approved: 0, rejected: 0 };
    state.docs.forEach(function (d) { if (counts[d.status] != null) counts[d.status]++; });
    ["pending", "approved", "rejected"].forEach(function (k) {
      $("n-" + k).textContent = counts[k]; $("tab-" + k).setAttribute("aria-selected", String(state.view === k));
    });
    var list = $("list"), status = $("status"), rel = $("reload");
    rel.disabled = state.refreshing;
    rel.textContent = state.refreshing ? "Refreshing…" : "Refresh";
    $("last-sync").textContent = state.lastSync ? ("Synced " + state.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : "";
    $("up-pick").disabled = !state.loaded;
    if ($("pdf-pick")) $("pdf-pick").disabled = !state.loaded || pdfBusy;
    if (!state.loaded) { status.hidden = false; status.textContent = state.loadErr || "Loading…"; list.replaceChildren(); drawBulk([]); return; }

    var inView = state.docs.filter(function (d) { return d.status === state.view; });
    Ent.fillClasses(inView, state.search);   /* only the classes present in this tab */
    updateTriageBar(inView);

    var res = Ent.filterRows(inView, state.search);
    if (state.triage === "sugg") res.rows = [];
    else if (state.triage && TRIAGE_PRED[state.triage]) res.rows = res.rows.filter(TRIAGE_PRED[state.triage]);

    var clusterTags = {};
    if (state.view === "pending" && state.search.sort === "review") {
      var cl = clusterDuplicates(res.rows);
      res.rows = cl.rows;
      clusterTags = cl.tags;
    }
    syncActiveAfterRender(res.rows);

    var byId = docsById();
    var shownSugg = res.err ? [] : filterSuggestions(byId);

    Ent.searchInfo(res, inView.length);
    if (!res.err && shownSugg.length) {
      var info = $("ss-info");
      info.textContent = shownSugg.length + " correction" + (shownSugg.length === 1 ? "" : "s") +
        (res.rows.length ? " + " + res.rows.length + " of " + inView.length + " entries" : "") + " shown.";
    }

    Ent.drawList(list, res.rows, function (d) {
      return Ent.card(d, {
        scores: res.scores, simMode: state.search.ss.mode === "sim", dup: dupOf(d),
        clusterTag: clusterTags[d.id] || "",
        admin: {
          email: myEmail(), busy: state.busy, drafts: state.drafts, activeId: state.activeId,
          onFocusCard: function (id) { setFocusCard(id, false); },
          onPatch: onPatch, approve: approve, reject: reject, revoke: revoke,
          selected: state.selected, onSelect: onSelect, onDelete: confirmDelete
        }
      });
    }, state.search.pager, render);

    if (shownSugg.length) {
      var cards = shownSugg.map(function (sg) {
        return Ent.suggestionCard(sg, byId[sg.entry_id] || null, {
          email: myEmail(), busy: state.busy, approve: approveSuggestion, revoke: revokeSuggestion, reject: rejectSuggestion, edit: editSuggestion
        });
      });
      list.prepend.apply(list, cards);
    }

    drawBulk(res.err ? [] : res.rows);   /* never offer bulk approval when the search failed */
    status.hidden = res.rows.length > 0 || shownSugg.length > 0;
    if (!res.rows.length && !shownSugg.length) {
      status.textContent = (inView.length || state.sugg.length) ? "No entry matches the current search and filters."
        : state.view === "pending" ? "The queue is empty." : state.view === "approved" ? "Nothing approved yet." : "Nothing rejected.";
    }
    if (enrichIssues.length) drawEnrichIssues();
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
    var out = [], tags = {}, gNum = 0;
    order.forEach(function (r) {
      var grp = groups[r];
      if (grp.length > 1) { gNum++; tags[grp[0].id] = "Queue duplicate group #" + gNum + " · " + grp.length + " entries"; }
      out = out.concat(grp);
    });
    return { rows: out, tags: tags };
  }

  /* ---------- approving / rejecting single entries with Undo ---------- */
  function undoEntry(id, prev, extraRestore) {
    var tasks = [onPatch(id, prev)];
    if (extraRestore) tasks.push(onPatch(extraRestore.id, extraRestore.patch));
    return Promise.all(tasks).then(function (okList) {
      if (okList.every(Boolean)) toast("Restored previous status.");
      else toast("Could not undo completely; check the Rejected/Approved tab.");
    });
  }

  function reject(d, note) {
    var prev = { status: d.status, decided_at: d.decided_at || null, note: d.note || null };
    return onPatch(d.id, { status: "rejected", decided_at: new Date().toISOString(), note: note }).then(function (ok) {
      if (ok && prev.status === "pending") {
        toast("Rejected “" + Ent.displayName(d) + "”", { actionLabel: "Undo", onAction: function () { return undoEntry(d.id, prev); } });
      }
      return ok;
    });
  }

  function buildDupComparison(d, existing) {
    var tbl = el("table", "cmp"), thead = el("thead"), hr = el("tr");
    ["Field", "Queue (new)", "Database (existing)"].forEach(function (x) { hr.appendChild(el("th", null, x)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tbody = el("tbody");
    var rows = [
      ["IUPAC name", d.name || "—", existing.name || "—"],
      ["E_T (kcal/mol)", Ent.fmt(Number(d.et_kcal), 1) + (d.et_unc ? " ± " + d.et_unc : ""), Ent.fmt(Number(existing.et_kcal), 1) + (existing.et_unc ? " ± " + existing.et_unc : "")],
      ["Origin", d.origin === "calc" ? "Computed" : "Experimental", existing.origin === "calc" ? "Computed" : "Experimental"],
      ["Value type", d.et_type || "—", existing.et_type || "—"],
      ["Method", d.method || "—", existing.method || "—"],
      ["Conditions", d.conditions || "—", existing.conditions || "—"],
      ["DOI", d.doi || "—", existing.doi || "—"],
      ["Citation", d.citation || "—", existing.citation || "—"],
      ["Verbatim", d.quote || "—", existing.quote || "—"],
      ["Score", d.score != null ? String(d.score) : "—", existing.score != null ? String(existing.score) : "—"]
    ];
    if (d.commercial_name || existing.commercial_name) {
      rows.unshift(["Commercial name", d.commercial_name || "—", existing.commercial_name || "—"]);
    }
    rows.forEach(function (r) {
      var tr = el("tr", r[1] !== r[2] ? "differs" : null);
      tr.appendChild(elT("th", null, r[0]));
      tr.appendChild(el("td", null, r[1]));
      tr.appendChild(el("td", null, r[2]));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    return tbl;
  }

  function runApproveSingle(d, note) {
    state.busy[d.id] = true; render();
    return api.adminApprove(d.id, note).then(function (rows) {
      delete state.busy[d.id];
      if (rows && rows[0]) applyUpdatedRows(rows);
      else state.busy[d.id] = "err";
      render(); drawCas(); drawComm(); drawSmiSync(); drawNames(); drawEnrichIssues();
      return (rows && rows[0]) || null;
    }, function (err) {
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return null; }
      state.busy[d.id] = "err"; render(); return null;
    });
  }

  function revoke(d, note) {
    var prevNote = d.note || null;
    state.busy[d.id] = true; render();
    return api.adminRevokeApproval(d.id, note === undefined ? prevNote : note).then(function (rows) {
      delete state.busy[d.id];
      var updated = rows && rows[0];
      if (updated) {
        applyUpdatedRows(rows);
        if (d.status === "approved" && updated.status === "pending") {
          toast("Removed your verification; “" + Ent.displayName(d) + "” moved back to queue (1/2)");
        } else {
          toast("Withdrew your verification for “" + Ent.displayName(d) + "”");
        }
      } else {
        state.busy[d.id] = "err";
      }
      render(); drawCas(); drawComm(); drawSmiSync(); drawNames(); drawEnrichIssues();
      return !!updated;
    }, function (err) {
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return false; }
      state.busy[d.id] = "err"; render(); return false;
    });
  }

  function approve(d, note) {
    var ap = Ent.approvalState(d, myEmail());
    if (d.status === "pending" && ap.byMe) {
      toast("You already verified “" + Ent.displayName(d) + "”. A second curator must approve it.");
      return Promise.resolve(false);
    }
    var willFinalize = d.status === "pending" && ap.byOthers.length >= 1;
    var prev = { status: d.status, decided_at: d.decided_at || null, note: d.note || null };
    if (!willFinalize) {
      return runApproveSingle(d, note).then(function (updated) {
        if (!updated) return false;
        if (prev.status === "rejected") {
          toast("Moved “" + Ent.displayName(d) + "” back to queue with your verification (1/2)", {
            actionLabel: "Undo", onAction: function () { return undoEntry(d.id, prev); }
          });
        } else {
          toast("Verified “" + Ent.displayName(d) + "” (1/2) — awaiting a second curator", {
            actionLabel: "Undo", onAction: function () { return revoke(d, prev.note); }
          });
        }
        return true;
      });
    }

    var dup = dupOf(d), now = new Date().toISOString();
    if (!dup || !dup.dbSame.length) {
      return runApproveSingle(d, note).then(function (updated) {
        if (!updated) return false;
        if (updated.status === "approved") {
          toast("Approved “" + Ent.displayName(d) + "” (2/2)", {
            actionLabel: "Undo", onAction: function () { return revoke(d, prev.note); }
          });
        } else {
          toast("Verified “" + Ent.displayName(d) + "” (1/2) — awaiting a second curator");
        }
        return true;
      });
    }
    return new Promise(function (resolve) {
      Ent.dialog("Possible duplicate: " + Ent.displayName(d), function (box) {
        box.appendChild(el("p", null, "The same value for this molecule is already in the database. Compare the fields and choose which entry to keep:"));
        var opts = el("div", "stack"), cmpWrap = el("div", "diff-table-wrap");
        function drawCmp(entry) { cmpWrap.replaceChildren(buildDupComparison(d, entry)); }
        dup.dbSame.forEach(function (m, i) {
          var lab = el("label", "check"), r = el("input"); r.type = "radio"; r.name = "dup-target"; r.value = m.entry.id; r.checked = i === 0;
          r.addEventListener("change", function () { if (r.checked) drawCmp(m.entry); });
          lab.appendChild(r);
          lab.appendChild(document.createTextNode(Ent.displayName(m.entry) + " · " + Ent.fmt(Number(m.entry.et_kcal), 1) + " kcal/mol · " +
            (m.entry.origin === "calc" ? "computed" : "experimental") + (m.entry.doi ? " · " + m.entry.doi : "") + " (" + m.why + ")"));
          opts.appendChild(lab);
        });
        box.appendChild(opts);
        drawCmp(dup.dbSame[0].entry);
        box.appendChild(cmpWrap);
        box.appendChild(el("p", "hint", "The overwritten entry moves to the Rejected tab with a note, so it can be restored. Use “Keep both” only if they represent distinct data."));
        var err = el("p", "err"); err.hidden = true; err.setAttribute("role", "alert"); box.appendChild(err);
        var act = el("div", "actions");
        var ow = el("button", "btn primary", "Overwrite the selected entry"), keep = el("button", "btn", "Keep both"), cancel = el("button", "btn", "Cancel");
        [ow, keep, cancel].forEach(function (b) { b.type = "button"; act.appendChild(b); });
        box.appendChild(act);
        cancel.addEventListener("click", function () { Ent.closeDialog(); resolve(false); });
        keep.addEventListener("click", function () {
          Ent.closeDialog();
          runApproveSingle(d, note).then(function (updated) {
            if (updated && updated.status === "approved") {
              toast("Approved (2/2, kept both)", { actionLabel: "Undo", onAction: function () { return revoke(d, prev.note); } });
            }
            resolve(!!updated);
          });
        });
        ow.addEventListener("click", function () {
          var pick = box.querySelector('input[name="dup-target"]:checked'); if (!pick) return;
          var old = state.docs.filter(function (x) { return x.id === pick.value; })[0];
          ow.disabled = keep.disabled = true;
          onPatch(old.id, { status: "rejected", decided_at: now, note: "Overwritten by “" + (d.name || "") + "” (" + now.slice(0, 10) + ")" + (old.note ? ". " + old.note : "") })
            .then(function (ok) {
              if (!ok) { ow.disabled = keep.disabled = false; err.textContent = "The existing entry could not be removed. Nothing was changed."; err.hidden = false; return; }
              Ent.closeDialog();
              runApproveSingle(d, note).then(function (updated) {
                if (updated && updated.status === "approved") {
                  toast("Approved (2/2) & overwrote duplicate", {
                    actionLabel: "Undo",
                    onAction: function () {
                      return Promise.all([
                        api.adminRevokeApproval(d.id, prev.note),
                        api.adminApprove(old.id, old.note || null)
                      ]).then(function (res) {
                        var r1 = res[0] && res[0][0], r2 = res[1] && res[1][0];
                        if (r1) applyUpdatedRows([r1]);
                        if (r2) applyUpdatedRows([r2]);
                        render();
                        toast("Reverted approval; overwritten entry moved to queue (1/2) for re-verification.");
                      }, function () {
                        toast("Could not undo completely; refresh to verify status.");
                      });
                    }
                  });
                }
                resolve(!!updated);
              });
            });
        });
      });
    });
  }

  /* ---------- corrections from readers ---------- */
  function suggestionPatchForEntry(sg, entry) {
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
    return patch;
  }

  function replaceSuggestionRow(row) {
    state.sugg = state.sugg.map(function (x) { return x.id === row.id ? row : x; });
  }

  function approveSuggestion(sg, note) {
    var entry = state.docs.filter(function (d) { return d.id === sg.entry_id; })[0]; if (!entry) return;
    var ap = Ent.approvalState(sg, myEmail());
    if (ap.byMe) {
      toast("You already verified this correction; a second curator must approve it.");
      return;
    }
    state.busy[sg.id] = true; render();
    api.adminApproveSuggestion(sg.id, note).then(function (sRows) {
      var updatedSg = sRows && sRows[0];
      if (!updatedSg) throw new Error("not saved");
      if (updatedSg.status !== "approved") {
        delete state.busy[sg.id];
        replaceSuggestionRow(updatedSg);
        render();
        toast("Verified correction (1/2) — awaiting a second curator");
        return;
      }
      var patch = suggestionPatchForEntry(updatedSg, entry);
      var apply = Object.keys(patch).length ? api.adminPatch(entry.id, patch) : Promise.resolve([entry]);
      return apply.then(function (rows) {
        if (!rows || !rows[0]) throw new Error("not saved");
        state.docs = state.docs.map(function (d) { return d.id === entry.id ? rows[0] : d; }); dupCache = {};
        delete state.busy[sg.id];
        state.sugg = state.sugg.filter(function (x) { return x.id !== sg.id; });
        render();
        toast("Approved (2/2) & applied correction to “" + (entry.name || "entry") + "”");
      }, function (err) {
        return api.adminRevokeSuggestionApproval(sg.id, sg.note || null).catch(function () { return null; }).then(function (revRows) {
          if (revRows && revRows[0]) replaceSuggestionRow(revRows[0]);
          throw err;
        });
      });
    }).catch(function (err) {
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
      state.busy[sg.id] = "err"; render();
    });
  }

  function revokeSuggestion(sg, note) {
    state.busy[sg.id] = true; render();
    api.adminRevokeSuggestionApproval(sg.id, note === undefined ? (sg.note || null) : note).then(function (rows) {
      delete state.busy[sg.id];
      if (rows && rows[0]) {
        replaceSuggestionRow(rows[0]);
        toast("Withdrew your verification for this correction");
      } else {
        state.busy[sg.id] = "err";
      }
      render();
    }, function (err) {
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
      state.busy[sg.id] = "err"; render();
    });
  }

  function buildSuggestionChanges(sg, entry, patch) {
    var next = {};
    Object.keys(patch || {}).forEach(function (k) {
      if (k === "score_items" || k === "idcode" || k === "smiles_checked") return;
      next[k] = patch[k];
    });
    var orig = sg.changes || {};
    if (orig.uses_add && Array.isArray(next.uses)) {
      var expectedUses = (Array.isArray(entry.uses) ? entry.uses : []).concat([orig.uses_add]);
      if (JSON.stringify(next.uses) === JSON.stringify(expectedUses)) {
        delete next.uses;
        next.uses_add = orig.uses_add;
      }
    }
    return next;
  }

  function samePlainObject(a, b) {
    var ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
    if (ka.length !== kb.length) return false;
    return ka.every(function (k, i) { return k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]); });
  }

  function editSuggestion(sg, entry, note) {
    var ap = Ent.approvalState(sg, myEmail());
    var bannerText = ap.count >= 1
      ? "Saving modified values resets prior verifications to 1/2 (verified by you). If you leave the proposed changes unchanged, your verification will be recorded directly."
      : "Saving changes updates the proposed correction and records your 1/2 verification; a second curator must confirm before it is applied.";
    Ent.editor.open(entry, function (patch) {
      var newChanges = buildSuggestionChanges(sg, entry, patch);
      if (!Object.keys(newChanges).length) {
        toast("No changes remain relative to the current entry. Reject the correction instead.");
        return false;
      }
      if (samePlainObject(newChanges, sg.changes || {})) {
        approveSuggestion(sg, note);
        return true;
      }
      return api.adminPatchSuggestion(sg.id, { changes: newChanges, note: note || null }).then(function (rows) {
        if (!rows || !rows[0]) return false;
        return api.adminApproveSuggestion(sg.id, note || null).then(function (sRows) {
          if (sRows && sRows[0]) replaceSuggestionRow(sRows[0]);
          else replaceSuggestionRow(rows[0]);
          render();
          toast("Saved edited correction (1/2) — awaiting a second curator");
          return true;
        });
      }, function (err) {
        if (err && err.status === 401) signedOut("Your session ended. Sign in again.");
        return false;
      });
    }, { title: "Edit & verify correction · " + (entry.name || ""), saveLabel: "Save & verify correction", banner: bannerText, overrides: sg.changes || {} });
  }

  function rejectSuggestion(sg, note) {
    var prevSugg = sg;
    state.busy[sg.id] = true; render();
    api.adminPatchSuggestion(sg.id, { status: "rejected", decided_at: new Date().toISOString(), note: note || null }).then(function () {
      delete state.busy[sg.id]; state.sugg = state.sugg.filter(function (x) { return x.id !== sg.id; }); render();
      toast("Correction rejected", {
        actionLabel: "Undo",
        onAction: function () {
          return api.adminPatchSuggestion(prevSugg.id, { status: "pending", decided_at: null, note: prevSugg.note || null }).then(function (rows) {
            state.sugg.unshift((rows && rows[0]) || prevSugg);
            render();
          }, function () { toast("Could not undo rejection."); });
        }
      });
    }, function () { state.busy[sg.id] = "err"; render(); });
  }

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
    var sel = selectedDocs(), n = sel.length, v = state.view, me = myEmail();
    var shownLimit = state.search.pager.shown || 50;
    var dupSkip = v === "pending" ? sel.filter(function (d) { var x = dupOf(d); return x && x.flag; }).length : 0;
    var mineSkip = v === "pending" ? sel.filter(function (d) { return Ent.approvalState(d, me).byMe; }).length : 0;
    var notes = [];
    if (dupSkip) notes.push(dupSkip + " duplicate" + (dupSkip === 1 ? "" : "s"));
    if (mineSkip) notes.push(mineSkip + " already verified by you");
    $("sel-n").textContent = n + " selected" + (notes.length ? " (" + notes.join(", ") + ")" : "");
    var splitVisible = listed.length > shownLimit;
    $("sel-visible").hidden = !splitVisible;
    if (splitVisible) $("sel-visible").textContent = "Select " + shownLimit + " visible";
    $("sel-all").hidden = !listed.length;
    $("sel-all").textContent = "Select all " + listed.length + " listed";
    $("sel-none").hidden = !n;
    if ($("sel-slide")) $("sel-slide").hidden = !n || !Ent.slideGraphic;
    var approveBtn = $("sel-approve");
    approveBtn.hidden = !n || v === "approved";
    if (!approveBtn.hidden) {
      if (v === "rejected") approveBtn.textContent = "Verify selected (1/2)";
      else {
        var actionable = sel.filter(function (d) {
          var x = dupOf(d);
          return !(x && x.flag) && !Ent.approvalState(d, me).byMe;
        });
        var n2 = actionable.filter(function (d) { return Ent.approvalState(d, me).byOthers.length >= 1; }).length;
        var n1 = actionable.length - n2;
        approveBtn.textContent = (n2 > 0 && n1 === 0) ? "Approve selected (2/2)"
          : (n1 > 0 && n2 === 0) ? "Verify selected (1/2)"
          : "Verify / Approve selected";
      }
    }
    $("sel-reject").hidden = !n || v === "rejected";
    $("sel-queue").hidden = !n || v === "pending";
    $("sel-delete").hidden = !n || v !== "rejected";
    $("selbar").hidden = !state.loaded || (!listed.length && !n);
  }
  function clearSel() { state.selected = {}; }
  $("sel-visible").addEventListener("click", function () {
    var shownLimit = state.search.pager.shown || 50;
    listed.slice(0, shownLimit).forEach(function (d) { state.selected[d.id] = true; });
    render();
  });
  $("sel-all").addEventListener("click", function () { listed.forEach(function (d) { state.selected[d.id] = true; }); render(); });
  $("sel-none").addEventListener("click", function () { clearSel(); render(); });
  if ($("sel-slide")) $("sel-slide").addEventListener("click", function () {
    var sel = selectedDocs();
    if (!sel.length || !Ent.slideGraphic) return;
    var items = Ent.groupByMolecule(sel).map(Ent.slideItemFromGroup);
    Ent.slideGraphic.open(items);
  });
  function bulkError(t) { $("bulk-err").textContent = t; $("bulk-err").hidden = !t; }
  function runPatch(docs, patch, verb) {
    bulkError("");
    var ids = docs.map(function (d) { return d.id; });
    return api.adminPatchMany(ids, patch).then(function (n) {
      clearSel();
      if (n < ids.length) bulkError((ids.length - n) + " of " + ids.length + " entries could not be " + verb + ".");
      else toast(n + " " + (n === 1 ? "entry " : "entries ") + verb + ".");
      return load({ silent: true });
    }, function () { bulkError("Not all entries could be " + verb + ". Refresh to see which ones went through."); return load({ silent: true }); });
  }
  function askThen(title, text, label, cls, go) {
    Ent.dialog(title, function (box) {
      box.appendChild(el("p", null, text));
      var act = el("div", "actions"), ok = el("button", "btn " + cls, label), no = el("button", "btn", "Cancel");
      ok.type = no.type = "button"; act.appendChild(ok); act.appendChild(no); box.appendChild(act);
      no.addEventListener("click", Ent.closeDialog);
      ok.addEventListener("click", function () { ok.disabled = true; Ent.closeDialog(); go(); });
      setTimeout(function () { no.focus(); }, 0);
    });
  }
  $("sel-approve").addEventListener("click", function () {
    var sel = selectedDocs(), me = myEmail();
    if (state.view === "rejected") {
      askThen("Move " + sel.length + (sel.length === 1 ? " entry" : " entries") + " back to queue with 1/2 verification?",
        "They will receive your 1st verification (1/2) and wait in the queue for a second curator.",
        "Verify " + sel.length + " (1/2)", "primary", function () {
          bulkError("");
          var ids = sel.map(function (d) { return d.id; });
          api.adminApproveMany(ids).then(function (rows) {
            clearSel();
            if (!rows || rows.length < ids.length) bulkError((ids.length - (rows ? rows.length : 0)) + " of " + ids.length + " entries could not be verified.");
            else toast("Moved " + rows.length + (rows.length === 1 ? " entry" : " entries") + " to queue with your verification (1/2).");
            return load({ silent: true });
          }, function (err) {
            if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
            bulkError("Not all entries could be verified. Refresh to see which ones went through.");
            return load({ silent: true });
          });
        });
      return;
    }
    /* the same value already in the database (yellow) must be resolved one by one; entries already verified by me cannot be verified twice */
    var dupSkipped = [], mineSkipped = [], ok = [];
    sel.forEach(function (d) {
      var x = dupOf(d);
      if (x && x.flag) { dupSkipped.push(d); return; }
      if (Ent.approvalState(d, me).byMe) { mineSkipped.push(d); return; }
      ok.push(d);
    });
    if (!ok.length) {
      var reasons = [];
      if (dupSkipped.length) reasons.push("possible duplicates must be approved one by one");
      if (mineSkipped.length) reasons.push("entries you already verified require a second curator");
      bulkError("Nothing to verify here: " + reasons.join("; ") + ".");
      return;
    }
    var willPublish = ok.filter(function (d) { return Ent.approvalState(d, me).byOthers.length >= 1; }).length;
    var willStage1 = ok.length - willPublish;
    var parts = [];
    if (willPublish) parts.push(willPublish + (willPublish === 1 ? " entry already has 1 verification and will be approved and published immediately" : " entries already have 1 verification and will be approved and published immediately"));
    if (willStage1) parts.push(willStage1 + (willStage1 === 1 ? " entry will receive your 1st verification (1/2) and wait for a second curator" : " entries will receive your 1st verification (1/2) and wait for a second curator"));
    if (dupSkipped.length) parts.push(dupSkipped.length + " possible duplicate" + (dupSkipped.length === 1 ? "" : "s") + " (yellow) will stay selected for one-by-one review");
    if (mineSkipped.length) parts.push(mineSkipped.length + " already verified by you will be skipped");
    var title = willPublish && !willStage1 ? ("Approve " + willPublish + (willPublish === 1 ? " entry" : " entries") + " (2/2)?")
      : (!willPublish ? ("Verify " + willStage1 + (willStage1 === 1 ? " entry" : " entries") + " (1/2)?") : ("Verify / Approve " + ok.length + " entries?"));
    var btnLbl = willPublish && !willStage1 ? ("Approve " + ok.length + " (2/2)")
      : (!willPublish ? ("Verify " + ok.length + " (1/2)") : ("Verify / Approve " + ok.length));
    askThen(title, parts.join(". ") + ".", btnLbl, "primary", function () {
      bulkError("");
      var ids = ok.map(function (d) { return d.id; });
      api.adminApproveMany(ids).then(function (rows) {
        clearSel();
        dupSkipped.forEach(function (d) { state.selected[d.id] = true; });
        var updated = rows || [];
        var pubN = updated.filter(function (r) { return r.status === "approved"; }).length;
        var st1N = updated.length - pubN;
        if (updated.length < ids.length) {
          bulkError((ids.length - updated.length) + " of " + ids.length + " entries could not be verified.");
        } else {
          var tparts = [];
          if (pubN) tparts.push("approved " + pubN + " (2/2)");
          if (st1N) tparts.push("verified " + st1N + " (1/2)");
          toast(tparts.join("; ") + ".");
        }
        return load({ silent: true });
      }, function (err) {
        if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
        bulkError("Not all entries could be verified. Refresh to see which ones went through.");
        return load({ silent: true });
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
  function confirmDelete(docs) {
    docs = docs.filter(function (d) { return d.status === "rejected"; });
    if (!docs.length) return;
    var what = docs.length === 1 ? "“" + (docs[0].name || "this entry") + "”" : docs.length + " rejected entries";
    askThen("Delete " + what + " permanently?", (docs.length === 1 ? "This removes it" : "This removes them") + " from the database for good, together with any corrections suggested for " + (docs.length === 1 ? "it" : "them") + ". It cannot be undone.",
      "Delete permanently", "danger primary", function () {
        bulkError("");
        api.adminDeleteMany(docs.map(function (d) { return d.id; })).then(function (n) {
          docs.forEach(function (d) { delete state.selected[d.id]; });
          if (n < docs.length) bulkError((docs.length - n) + " of " + docs.length + " entries could not be deleted.");
          else toast("Deleted " + n + (n === 1 ? " entry." : " entries."));
          load({ silent: true });
        }, function (e) {
          if (e && e.status === 401) { signedOut("Your session ended. Sign in again."); return; }
          bulkError("The entries could not be deleted. Try again."); load({ silent: true });
        });
      });
  }

  /* ---------- literature batches published with the site + manual JSON upload ---------- */
  var UPLOAD_KEYS = [
    "import_key", "name", "commercial_name", "cas", "smiles", "idcode", "smiles_checked", "structure_note",
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

  var pendingImport = [], lastBatchesPromise = Promise.resolve();
  function checkBatches() {
    lastBatchesPromise = api.batches().then(function (rows) {
      var have = {}; state.docs.forEach(function (d) { if (d.import_key) have[d.import_key] = 1; });
      pendingImport = rows.filter(function (r) { return r.import_key && !have[r.import_key]; });
      batchRows = rows;
      drawSmiSync();
      drawNames();
      $("imp").hidden = !pendingImport.length;
      $("imp-text").textContent = pendingImport.length + " new literature entries are ready to add to the queue.";
      updateToolsBadge();
    }, function () { $("imp").hidden = true; updateToolsBadge(); });
    return lastBatchesPromise;
  }
  $("imp-go").addEventListener("click", function () {
    var rows = toImportRows(pendingImport);
    $("imp-go").disabled = true; $("imp-text").textContent = "Importing " + rows.length + " entries…";
    api.adminImport(rows).then(function () {
      $("imp-go").disabled = false; $("imp").hidden = true;
      addToolLog("Imported " + rows.length + " literature batch entries.");
      toast("Imported " + rows.length + " literature entries.");
      load({ silent: true });
    }, function (err) {
      $("imp-go").disabled = false;
      $("imp-text").textContent = "The import stopped: " + (err.message || "unknown error") + ". Entries already added are kept; press the button to continue.";
      load({ silent: true });
    });
  });

  var uploadRows = [], uploadReport = null;
  var ROLES = ["acceptor", "donor", "both"];
  /* columns the database fills by itself: harmless in a re-uploaded export, but never imported */
  var SERVER_KEYS = ["id", "decided_at", "updated_at"];
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function editDist(a, b) {
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  function nearestKey(k) {
    function norm(x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ""); }
    var a = norm(k), best = null, bestD = 99;
    UPLOAD_KEYS.forEach(function (u) {
      var d = editDist(a, norm(u));
      if (d < bestD) { bestD = d; best = u; }
    });
    return bestD <= (a.length <= 4 ? 1 : 2) ? best : null;
  }
  function showUploadErrors(errs) {
    var box = $("up-err");
    box.replaceChildren();
    if (!errs || !errs.length) { box.hidden = true; return; }
    box.hidden = false;
    if (errs.length === 1) { box.textContent = errs[0]; return; }
    var ul = el("ul", "err-list");
    errs.forEach(function (msg) { ul.appendChild(el("li", null, msg)); });
    box.appendChild(ul);
  }
  function rowList(rows) {
    var shown = rows.slice(0, 8).join(", ");
    return (rows.length === 1 ? "row " : "rows ") + shown + (rows.length > 8 ? " and " + (rows.length - 8) + " more" : "");
  }
  function discardedJson() {
    /* the original entries plus _row/_errors, so the file can be fixed and dropped again as it is */
    return uploadReport.rejected.map(function (x) {
      var o = { _row: x.row, _errors: x.reasons };
      if (x.entry && typeof x.entry === "object" && !Array.isArray(x.entry)) {
        Object.keys(x.entry).forEach(function (k) { if (k.charAt(0) !== "_") o[k] = x.entry[k]; });
      } else o._value = x.entry === undefined ? null : x.entry;
      return o;
    });
  }
  function downloadDiscarded() {
    if (!uploadReport || !uploadReport.rejected.length) return;
    var blob = new Blob([JSON.stringify(discardedJson(), null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = uploadReport.slug + ".discarded.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function drawUploadReport() {
    var box = $("up-report");
    box.replaceChildren();
    var rep = uploadReport;
    if (!rep || (!rep.rejected.length && !rep.warnings.length)) { box.hidden = true; return; }
    box.hidden = false;
    if (rep.rejected.length) {
      var sec = el("div", "up-sec bad");
      var head = el("div", "tool-head");
      head.appendChild(el("strong", null, plural(rep.rejected.length, "row", "rows") + " discarded"));
      var dl = el("button", "btn small", "Download discarded (JSON)");
      dl.type = "button"; dl.addEventListener("click", downloadDiscarded);
      head.appendChild(dl); sec.appendChild(head);
      var ul = el("ul", "up-list");
      rep.rejected.forEach(function (x) {
        var li = el("li");
        li.appendChild(el("strong", null, "Row " + x.row + (x.label ? " · " + x.label : "")));
        var why = el("ul", "err-list");
        x.reasons.forEach(function (m) { why.appendChild(el("li", null, m)); });
        li.appendChild(why); ul.appendChild(li);
      });
      sec.appendChild(ul); box.appendChild(sec);
    }
    if (rep.warnings.length) {
      var ws = el("div", "up-sec warn");
      ws.appendChild(el("strong", null, plural(rep.warnings.length, "warning", "warnings")));
      var wl = el("ul", "up-list");
      rep.warnings.forEach(function (w) {
        wl.appendChild(el("li", null, w.msg + (w.rows.length ? " (" + rowList(w.rows) + ")" : "")));
      });
      ws.appendChild(wl); box.appendChild(ws);
    }
  }
  function resetUpload(msg, errs) {
    uploadRows = []; uploadReport = null;
    $("up-file").value = "";
    $("up-go").hidden = true; $("up-go").disabled = false;
    $("up-clear").hidden = true;
    drawUploadReport();
    showUploadErrors(Array.isArray(errs) ? errs : (errs ? [errs] : []));
    $("up-info").textContent = (!errs && msg) ? msg : "Import entries directly into the review queue.";
  }
  function isInt(v) { return typeof v === "number" && Math.floor(v) === v; }
  /* Every problem of one entry; an empty list means the entry can be imported. */
  function entryErrors(r) {
    var errs = [];
    Object.keys(r).forEach(function (k) {
      if (typeof r[k] === "string" && /https?:\/\//i.test(r[k])) errs.push(k + " contains a web link; only DOIs are allowed.");
    });
    var smi = String(r.smiles || "").trim();
    if (!String(r.name || "").trim()) errs.push("name is required.");
    if (!smi) errs.push("smiles is required.");
    else if (Ent.structureOk(smi) === false) errs.push("SMILES could not be read.");
    var et = Number(r.et_kcal);
    if (r.et_kcal == null || r.et_kcal === "" || !isFinite(et) || et <= 0 || et > EntScore.ET_MAX) {
      errs.push("et_kcal must be a number above 0 and up to " + EntScore.ET_MAX + ".");
    }
    if (r.origin !== "exp" && r.origin !== "calc") errs.push("origin must be \"exp\" or \"calc\".");
    if (r.doi && !EntScore.isDoi(EntScore.cleanDoi(r.doi))) errs.push("\"" + r.doi + "\" is not a valid DOI.");
    if (r.cas && !EntScore.casValid(EntScore.cleanCas(r.cas))) errs.push("\"" + r.cas + "\" is not a valid CAS number.");
    if (r.uv_lmax != null && !(isInt(r.uv_lmax) && r.uv_lmax >= 100 && r.uv_lmax <= 1500)) errs.push("uv_lmax must be an integer between 100 and 1500.");
    if (r.uv_eps != null && !(isInt(r.uv_eps) && r.uv_eps >= 0)) errs.push("uv_eps must be a non-negative integer.");
    if (r.direct_exc != null) {
      if (typeof r.direct_exc !== "object" || Array.isArray(r.direct_exc)) errs.push("direct_exc must be an object.");
      else if (Object.keys(r.direct_exc).some(function (k) {
        var dv = r.direct_exc[k];
        return !k.trim() || !isInt(dv) || dv < 100 || dv > 1500;
      })) errs.push("direct_exc values must be integers between 100 and 1500.");
    }
    return errs;
  }
  function parseAndValidateUpload(raw, fileName) {
    if (!Array.isArray(raw) || !raw.length) return { fatal: "The JSON file must be a non-empty array of entry objects." };
    var slug = String(fileName || "upload").replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "upload";
    var have = {}; state.docs.forEach(function (d) { if (d.import_key) have[d.import_key] = 1; });
    var valid = [], rejected = [], skipped = 0, usedKeys = {}, warnMap = {}, warnings = [];
    function warn(msg, rowNo) {
      if (!warnMap[msg]) { warnMap[msg] = { msg: msg, rows: [] }; warnings.push(warnMap[msg]); }
      if (rowNo) warnMap[msg].rows.push(rowNo);
    }
    if (!window.OCL) warn("The structure library has not loaded, so SMILES were not checked. Reload the page and drop the file again to check them.");
    raw.forEach(function (r, i) {
      var rowNo = i + 1;
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        rejected.push({ row: rowNo, label: "", reasons: ["The row is not an entry object."], entry: r });
        return;
      }
      var label = String(r.import_key || r.name || "").trim().slice(0, 80);
      var errs = entryErrors(r);
      var ik = r.import_key ? String(r.import_key).trim() : ("json:" + slug + ":" + rowNo);
      if (usedKeys[ik]) errs.push("import_key \"" + ik + "\" is already used by row " + usedKeys[ik] + " of this file.");
      if (errs.length) { rejected.push({ row: rowNo, label: label, reasons: errs, entry: r }); return; }
      usedKeys[ik] = rowNo;
      if (have[ik]) { skipped++; return; }
      /* warnings only for rows that go in: what is dropped or changed on the way */
      Object.keys(r).forEach(function (k) {
        if (UPLOAD_KEYS.indexOf(k) >= 0 || k.charAt(0) === "_") return;
        if (SERVER_KEYS.indexOf(k) >= 0) { warn("Field \"" + k + "\" is set by the database and is ignored.", rowNo); return; }
        var near = nearestKey(k);
        warn("Unknown field \"" + k + "\" is ignored" + (near ? "; did you mean \"" + near + "\"?" : "."), rowNo);
      });
      if (r.role == null || r.role === "") warn("role is missing; imported as \"acceptor\".", rowNo);
      else if (ROLES.indexOf(r.role) < 0) warn("role \"" + String(r.role).slice(0, 40) + "\" is not acceptor, donor or both; imported as \"acceptor\".", rowNo);
      var name = String(r.name).trim(), smi = String(r.smiles).trim(), et = Number(r.et_kcal);
      var doi = r.doi ? EntScore.cleanDoi(r.doi) : null, cas = r.cas ? EntScore.cleanCas(r.cas) : null;
      var copy = {}; for (var rk in r) copy[rk] = r[rk];
      copy.import_key = ik; copy.name = name.slice(0, 200);
      copy.commercial_name = r.commercial_name ? String(r.commercial_name).trim().slice(0, 200) || null : null;
      copy.smiles = smi; copy.doi = doi; copy.cas = cas;
      if (copy.score == null) {
        var norm = EntScore.normalize({
          name: copy.name, commercial_name: copy.commercial_name || "", cas: cas || "", cls: copy.cls || "", smiles: smi, role: copy.role,
          et: et, unit: "kcal", unc: copy.et_unc, origin: copy.origin, kind: copy.et_type,
          tech: copy.origin === "calc" ? "" : (copy.method || ""), solvent: copy.conditions || "",
          cite: copy.citation || "", doi: doi || "", loc: copy.location || "", quote: copy.quote || "",
          uv_lmax: copy.uv_lmax, uv_eps: copy.uv_eps, uv_cond: copy.uv_cond || "", direct_exc: copy.direct_exc
        });
        var sc = EntScore.scoreEntry(norm, { structureOk: Ent.structureOk(smi), doiResolves: null, same: [] });
        copy.score = sc.total; copy.score_items = sc.items;
      }
      valid.push(copy);
    });
    return { rows: valid, rejected: rejected, warnings: warnings, skipped: skipped, total: raw.length, slug: slug };
  }
  function uploadSummary(name, res) {
    var parts = [plural(res.rows.length, "row", "rows") + " ready to import"];
    if (res.rejected.length) parts.push(res.rejected.length + " discarded");
    if (res.skipped) parts.push(res.skipped + " already in the database");
    return name + ": " + plural(res.total, "row", "rows") + " · " + parts.join(" · ") + ".";
  }
  function handleUploadFile(file) {
    if (!file) return;
    if (!state.loaded) {
      resetUpload(null, ["The queue is still loading, so the file was not read. Drop it again in a moment."]);
      return;
    }
    file.text().then(function (txt) {
      var parsed;
      try { parsed = JSON.parse(txt); } catch (err) { resetUpload(null, ["Could not parse JSON: " + err.message]); return; }
      var res = parseAndValidateUpload(parsed, file.name);
      if (res.fatal) { resetUpload(null, [res.fatal]); return; }
      uploadRows = res.rows;
      uploadReport = { rejected: res.rejected, warnings: res.warnings, slug: res.slug };
      showUploadErrors([]);
      drawUploadReport();
      $("up-file").value = "";
      $("up-clear").hidden = false;
      $("up-go").hidden = !uploadRows.length; $("up-go").disabled = false;
      $("up-go").textContent = "Import " + plural(uploadRows.length, "entry", "entries");
      $("up-info").textContent = uploadSummary(file.name, res);
    }, function () { resetUpload(null, ["Could not read the selected file."]); });
  }
  $("up-pick").addEventListener("click", function () { $("up-file").click(); });
  $("up-clear").addEventListener("click", function () { resetUpload(); });
  $("up-file").addEventListener("change", function (e) { handleUploadFile(e.target.files && e.target.files[0]); });
  var upDrop = $("up-drop");
  ["dragenter", "dragover"].forEach(function (ev) {
    upDrop.addEventListener(ev, function (e) { e.preventDefault(); upDrop.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    upDrop.addEventListener(ev, function (e) { e.preventDefault(); upDrop.classList.remove("dragover"); });
  });
  upDrop.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleUploadFile(f);
  });
  $("up-go").addEventListener("click", function () {
    if (!uploadRows.length) return;
    var rows = toImportRows(uploadRows);
    $("up-go").disabled = true; $("up-pick").disabled = true;
    $("up-info").textContent = "Importing " + rows.length + " entries…";
    api.adminImport(rows).then(function () {
      $("up-pick").disabled = false;
      var left = uploadReport && uploadReport.rejected.length;
      /* the discarded rows stay listed (and downloadable) until Clear or the next file */
      uploadRows = []; $("up-go").hidden = true; $("up-go").disabled = false;
      if (uploadReport) { uploadReport.warnings = []; drawUploadReport(); }
      $("up-clear").hidden = !left;
      $("up-info").textContent = "Imported " + plural(rows.length, "entry", "entries") + " into the review queue." +
        (left ? " " + plural(left, "discarded row is", "discarded rows are") + " still listed below." : "");
      addToolLog("Uploaded " + rows.length + " JSON entries" + (left ? " (" + left + " discarded)" : "") + ".");
      toast("Imported " + rows.length + (rows.length === 1 ? " entry." : " entries."));
      load({ silent: true });
    }, function (err) {
      $("up-go").disabled = false; $("up-pick").disabled = false;
      if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
      showUploadErrors(["The import stopped: " + (err.message || "unknown error") + ". Entries already added are kept; try again."]);
      load({ silent: true });
    });
  });

  /* ---------- Upload PDF of articles -> batch JSON ---------- */
  var pdfFiles = [], pdfResult = null, pdfBusy = false, pdfModalReturn = null, pdfAbort = null;
  function downloadJsonFile(data, filename) {
    var blob = new Blob([JSON.stringify(data, null, 1) + "\n"], { type: "application/json" });
    var a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function drawPdfResult() {
    var box = $("pdf-result");
    if (!pdfResult) { box.hidden = true; return; }
    var readyN = pdfResult.readyRows.length;
    var unresN = pdfResult.reviewItems.length;
    var dupN = pdfResult.skippedDuplicates.length;
    var fileCount = pdfResult.fileReports.length;
    var parts = [
      plural(fileCount, "PDF", "PDFs") + " processed",
      plural(readyN, "ready entry", "ready entries")
    ];
    if (unresN) parts.push(unresN + " unresolved");
    if (dupN) parts.push(dupN + " duplicate" + (dupN === 1 ? "" : "s") + " skipped");
    var failedN = pdfResult.fileReports.filter(function (r) { return r.error; }).length;
    parts[0] = plural(fileCount - failedN, "PDF", "PDFs") + " processed";
    if (failedN) parts.push(failedN + " could not be read");
    var summary = parts.join(" · ") + "." + (pdfResult.cancelled ? " Cancelled before the end: results are partial." : "");
    if (pdfResult.memoHidden || pdfResult.memoResolved) {
      summary += " From your earlier review: " + [
        pdfResult.memoResolved ? plural(pdfResult.memoResolved, "value", "values") + " resolved with a structure you gave before" : "",
        pdfResult.memoHidden ? plural(pdfResult.memoHidden, "value", "values") + " you dismissed before left out" : ""
      ].filter(Boolean).join(", ") + ".";
    }
    $("pdf-summary").textContent = summary;
    var ul = $("pdf-files");
    ul.replaceChildren();
    pdfResult.fileReports.forEach(function (r) {
      var warns = r.warnings || [];
      var li = el("li", r.error ? "bad" : (warns.length ? "warn" : ""));
      li.appendChild(el("strong", null, r.file));
      if (r.error) {
        li.appendChild(el("span", "pdf-file-note", r.error));
      } else {
        var bits = [r.pages + " page" + (r.pages === 1 ? "" : "s"), r.ready + " ready", r.review + " unresolved"];
        if (r.duplicates) bits.push(r.duplicates + " duplicate" + (r.duplicates === 1 ? "" : "s"));
        if (!r.extracted) bits.push("no triplet energy found");
        li.appendChild(el("span", "pdf-file-note", bits.join(" · ")));
        if (r.isSi) li.appendChild(el("span", "pdf-file-note", r.pairedWith
          ? "Supporting Information of " + r.pairedWith + " (matched by " + r.matchedBy + ")"
          : "Supporting Information with no matching paper"));
        if (r.ocrPages && r.ocrPages.length) li.appendChild(el("span", "pdf-file-note",
          "OCR used on page" + (r.ocrPages.length === 1 ? " " : "s ") + r.ocrPages.join(", ") + ": check those values against the PDF"));
        if (!r.doi) li.appendChild(el("span", "pdf-file-note", "No DOI found: entries will need one before approval"));
        warns.forEach(function (w) { li.appendChild(el("span", "pdf-file-note", w)); });
      }
      ul.appendChild(li);
    });
    $("pdf-load-up").hidden = !readyN;
    $("pdf-load-up").disabled = pdfBusy;
    $("pdf-load-up").textContent = "Import " + readyN + " into queue";
    $("pdf-dl-json").hidden = !readyN;
    $("pdf-review-open").hidden = !unresN;
    $("pdf-review-open").textContent = "Fix unresolved (" + unresN + ")…";
    box.hidden = false;
  }
  function resetPdfUpload(msg, err) {
    pdfFiles = []; pdfResult = null; pdfBusy = false;
    if ($("pdf-file")) $("pdf-file").value = "";
    if ($("pdf-prog")) $("pdf-prog").hidden = true;
    if ($("pdf-go")) { $("pdf-go").hidden = true; $("pdf-go").disabled = false; }
    if ($("pdf-clear")) { $("pdf-clear").hidden = true; $("pdf-clear").disabled = false; $("pdf-clear").textContent = "Clear"; }
    if ($("pdf-err")) { $("pdf-err").textContent = err || ""; $("pdf-err").hidden = !err; }
    if ($("pdf-result")) $("pdf-result").hidden = true;
    if ($("pdf-info")) $("pdf-info").textContent = msg || "Generates a trendb-extract JSON you can download or load straight into the queue.";
    closePdfModal();
  }
  function handlePdfFiles(fileList) {
    if (pdfBusy) return;
    var all = Array.prototype.slice.call(fileList || []), seenPdf = {};
    var list = all.filter(function (f) {
      if (!f || !(/\.pdf$/i.test(f.name || "") || f.type === "application/pdf")) return false;
      var k = f.name + "|" + f.size;
      if (seenPdf[k]) return false;
      seenPdf[k] = 1;
      return true;
    });
    if (!list.length) {
      resetPdfUpload(null, "Select one or more .pdf files.");
      return;
    }
    if (!state.loaded) {
      resetPdfUpload(null, "The database is still loading; drop the PDF(s) again in a moment.");
      return;
    }
    pdfFiles = list;
    pdfResult = null;
    $("pdf-err").hidden = true;
    $("pdf-result").hidden = true;
    $("pdf-prog").hidden = true;
    $("pdf-go").hidden = false; $("pdf-go").disabled = false;
    $("pdf-go").textContent = "Extract JSON (" + plural(list.length, "PDF", "PDFs") + ")";
    $("pdf-clear").hidden = false;
    $("pdf-info").textContent = "Ready: " + list.map(function (f) { return f.name; }).join(", ");
  }
  function openPdfModal() {
    if (!pdfResult || !pdfResult.reviewItems.length) return;
    pdfModalReturn = document.activeElement;
    $("pdf-modal").hidden = false;
    Ent.syncModalOpen();
    drawPdfModal();
  }
  function closePdfModal() {
    var m = $("pdf-modal");
    if (!m || m.hidden) return;
    m.hidden = true;
    Ent.syncModalOpen();
    if (pdfModalReturn && pdfModalReturn.focus) pdfModalReturn.focus();
    pdfModalReturn = null;
  }
  /* ---------- Curator decisions on PDF candidates, remembered in this browser ---------- */
  var PDF_MEMO_KEY = "trendb.pdfReview.v1";
  function readPdfMemo() {
    try {
      var m = JSON.parse(localStorage.getItem(PDF_MEMO_KEY) || "null");
      if (m && m.names && m.dismissed) return m;
    } catch (e) {}
    return { names: {}, dismissed: {} };
  }
  function writePdfMemo(m) { try { localStorage.setItem(PDF_MEMO_KEY, JSON.stringify(m)); } catch (e) {} }
  function pdfSource(cand) { return String(cand.doi || cand.pdf_file || "").toLowerCase(); }
  function pdfPlainName(cand) {
    var n = String(cand.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    return n === "(unnamed candidate)" ? "" : n;
  }
  // A written name means the same compound in any paper; a label ("3a", "C2") only in its own paper.
  function memoNameKey(cand) {
    var n = pdfPlainName(cand);
    if (!n) return "";
    return (EntPdf.isAnonymousLabel && EntPdf.isAnonymousLabel(n) ? pdfSource(cand) + "|" : "") + n;
  }
  function memoValueKey(cand) {
    return [pdfSource(cand), pdfPlainName(cand), Number(cand.et_kcal).toFixed(1), cand.origin === "calc" ? "calc" : "exp"].join("|");
  }
  function rememberDismissed(cands) {
    var m = readPdfMemo();
    cands.forEach(function (c) { m.dismissed[memoValueKey(c)] = Date.now(); });
    writePdfMemo(m);
  }
  function rememberStructure(paperName, cand, smiles, cas, iupac) {
    var k = memoNameKey({ name: paperName, doi: cand.doi, pdf_file: cand.pdf_file });
    if (!k) return;
    var m = readPdfMemo();
    m.names[k] = { smiles: smiles, cas: cas || null, iupac: iupac || null, ts: Date.now() };
    writePdfMemo(m);
  }
  /* Apply earlier decisions to a fresh extraction: dismissed values stay out, names whose
     structure the curator already gave become ready rows. */
  function applyPdfMemo(res) {
    var m = readPdfMemo(), keep = [], toResolve = [], hidden = 0;
    res.reviewItems.forEach(function (it) {
      if (m.dismissed[memoValueKey(it.cand)]) { hidden++; return; }
      var k = memoNameKey(it.cand), known = k && m.names[k];
      if (known && known.smiles && Ent.structureOk(known.smiles) !== false) toResolve.push({ it: it, known: known });
      else keep.push(it);
    });
    res.reviewItems = keep;
    return toResolve.reduce(function (p, x) {
      return p.then(function () {
        var paperName = x.it.cand.name;
        return res.resolveCandidate(x.it.cand, x.known.smiles, x.known.cas, x.known.iupac || paperName).then(function (row) {
          row.structure_note = "Paper name: " + paperName + ". Structure entered earlier by a curator for this name; verify against paper.";
          res.readyRows.push(row);
        }, function () { res.reviewItems.push(x.it); });
      });
    }, Promise.resolve()).then(function () {
      res.memoHidden = hidden;
      res.memoResolved = toResolve.length;
      return res;
    });
  }

  /* One card per compound: the values of the same name in the same PDF share one structure. */
  function pdfReviewGroups(items) {
    var groups = [], byKey = {};
    items.forEach(function (it) {
      var n = pdfPlainName(it.cand);
      var k = n ? (it.cand.pdf_file || "") + "|" + n : null;
      if (k && byKey[k]) { byKey[k].items.push(it); return; }
      var g = { items: [it] };
      if (k) byKey[k] = g;
      groups.push(g);
    });
    return groups;
  }
  function removeReviewItems(list) {
    pdfResult.reviewItems = pdfResult.reviewItems.filter(function (it) { return list.indexOf(it) < 0; });
    drawPdfResult();
    if (!pdfResult.reviewItems.length) closePdfModal();
    else drawPdfModal();
  }

  function drawPdfModal() {
    var ul = $("pdf-modal-list"), empty = $("pdf-modal-empty"), items = (pdfResult && pdfResult.reviewItems) || [];
    var groups = pdfReviewGroups(items);
    $("pdf-modal-meta").textContent = plural(items.length, "unresolved value", "unresolved values") +
      (groups.length !== items.length ? " in " + plural(groups.length, "card", "cards") : "") +
      " · " + (pdfResult ? plural(pdfResult.readyRows.length, "ready row", "ready rows") : "");
    empty.hidden = items.length > 0;
    ul.replaceChildren.apply(ul, groups.map(function (g) {
      var it = g.items[0], cand = it.cand;
      g.items.forEach(function (o) {
        if (!it.draftSmiles && o.draftSmiles) { it.draftSmiles = o.draftSmiles; it.note = it.note || o.note; }
        if (it.draftName == null && o.draftName != null) it.draftName = o.draftName;
      });
      var li = el("li", "ei-card pdf-unres-card");
      var infoCol = el("div", "ei-col-info");
      var thumb = el("div", "ei-thumb");
      var drawThumb = function (smi) {
        var minfo = smi ? Ent.molInfo(smi) : null;
        if (minfo) thumb.innerHTML = minfo.svg;
        else thumb.textContent = smi ? (window.OCL ? "Invalid SMILES" : "No preview") : "No SMILES";
      };
      drawThumb(it.draftSmiles || "");
      infoCol.appendChild(thumb);

      var meta = el("div", "ei-meta pdf-unres-meta");
      var head = el("div", "ei-head");
      head.appendChild(el("strong", "ei-name", cand.name || "(unnamed)"));
      var badges = el("span", "ei-badges");
      if (g.items.length === 1) {
        badges.appendChild(el("span", "ei-status", Ent.fmt(Number(cand.et_kcal), 1) + " kcal/mol"));
        badges.appendChild(el("span", "ei-tool", cand.origin === "calc" ? "Computed" : "Experimental"));
        if (cand.location) badges.appendChild(el("span", "ei-status", cand.location));
      } else {
        badges.appendChild(el("span", "ei-tool", plural(g.items.length, "value", "values") + " · one structure for all"));
      }
      head.appendChild(badges);
      meta.appendChild(head);
      meta.appendChild(el("div", "ei-reason", it.reason));
      if (g.items.length === 1) {
        if (cand.quote) meta.appendChild(el("div", "pdf-unres-quote", cand.quote));
        if (cand.evidence) meta.appendChild(el("div", "hint", cand.evidence));
      } else {
        var vl = el("ul", "pdf-unres-values");
        g.items.forEach(function (o) {
          var row = el("li");
          row.appendChild(el("strong", null, Ent.fmt(Number(o.cand.et_kcal), 1) + " kcal/mol"));
          row.appendChild(document.createTextNode(" · " + (o.cand.origin === "calc" ? "Computed" : "Experimental") +
            (o.cand.location ? " · " + o.cand.location : "") + (o.cand.quote ? " · “" + o.cand.quote + "”" : "")));
          var x = el("button", "btn small reject", "Drop"); x.type = "button";
          x.title = "Drop only this value";
          x.addEventListener("click", function () { rememberDismissed([o.cand]); removeReviewItems([o]); });
          row.appendChild(document.createTextNode(" "));
          row.appendChild(x);
          vl.appendChild(row);
        });
        meta.appendChild(vl);
      }
      if (cand.doi) meta.appendChild(el("div", "hint mono", "DOI: " + cand.doi));
      infoCol.appendChild(meta);
      li.appendChild(infoCol);

      var fixCol = el("div", "ei-col-fix");
      var nameRow = el("div", "ei-fix-row");
      var nameInp = el("input"); nameInp.type = "text"; nameInp.className = "grow";
      nameInp.placeholder = "Compound or IUPAC name";
      nameInp.value = it.draftName != null ? it.draftName : (cand.name === "(unnamed candidate)" ? "" : (cand.name || ""));
      nameInp.addEventListener("input", function () { it.draftName = nameInp.value; });
      var lookupBtn = el("button", "btn small", "Lookup SMILES"); lookupBtn.type = "button";
      nameRow.appendChild(nameInp); nameRow.appendChild(lookupBtn);
      fixCol.appendChild(nameRow);

      var smiRow = el("div", "ei-fix-row");
      var smiInp = el("input"); smiInp.type = "text"; smiInp.className = "mono grow";
      smiInp.placeholder = "Enter SMILES or use Sketcher…";
      smiInp.value = it.draftSmiles || "";
      smiInp.addEventListener("input", function () { it.draftSmiles = smiInp.value; drawThumb(smiInp.value.trim()); });
      var skBtn = el("button", "btn small", "Sketcher…"); skBtn.type = "button";
      var addBtn = el("button", "btn small primary", g.items.length > 1 ? "Add all to JSON" : "Add to JSON"); addBtn.type = "button";
      var dropBtn = el("button", "btn small reject", g.items.length > 1 ? "Dismiss all" : "Dismiss"); dropBtn.type = "button";
      smiRow.appendChild(smiInp); smiRow.appendChild(skBtn); smiRow.appendChild(addBtn); smiRow.appendChild(dropBtn);
      fixCol.appendChild(smiRow);

      var noteEl = el("div", "ei-note " + (it.noteIsErr ? "err" : "hint"), it.note || "");
      noteEl.hidden = !it.note;
      fixCol.appendChild(noteEl);
      li.appendChild(fixCol);

      lookupBtn.addEventListener("click", function () {
        var q = nameInp.value.trim();
        if (!q) { it.note = "Enter a compound name or CAS first."; it.noteIsErr = true; drawPdfModal(); return; }
        lookupBtn.disabled = true;
        EntPdf.lookupSmilesByName(q).then(function (found) {
          if (found || !EntPdf.lookupSmilesOpsin) return { smiles: found, from: "PubChem" };
          return EntPdf.lookupSmilesOpsin(q).then(function (o) { return { smiles: o, from: "OPSIN (name parser)" }; });
        }).then(function (r) {
          lookupBtn.disabled = false;
          if (!r.smiles) { it.note = "Not found on PubChem or by OPSIN; draw it in Sketcher."; it.noteIsErr = true; drawPdfModal(); return; }
          it.draftSmiles = r.smiles;
          it.note = "Found SMILES with " + r.from + " — verify preview and click Add to JSON.";
          it.noteIsErr = false;
          drawPdfModal();
        }, function () {
          lookupBtn.disabled = false;
          it.note = "Lookup failed."; it.noteIsErr = true; drawPdfModal();
        });
      });

      skBtn.addEventListener("click", function () {
        Ent.sketcher.open({
          title: "Sketcher · " + (nameInp.value.trim() || cand.name || "Structure"),
          smiles: smiInp.value.trim(),
          saveLabel: "Use structure",
          hint: "Draw the structure or paste SMILES, then click Use structure.",
          onSave: function (s) {
            it.draftSmiles = s;
            it.note = "Structure set — click Add to JSON.";
            it.noteIsErr = false;
            drawPdfModal();
            return true;
          }
        });
      });

      addBtn.addEventListener("click", function () {
        var smi = smiInp.value.trim();
        if (!smi || Ent.structureOk(smi) === false) {
          it.note = "Enter a valid SMILES first."; it.noteIsErr = true; drawPdfModal(); return;
        }
        var paperName = cand.name || "";
        var newName = (nameInp.value.trim() || cand.name || "").slice(0, 200);
        addBtn.disabled = true; dropBtn.disabled = true;
        Promise.all([
          Ent.lookupIupac ? Ent.lookupIupac(smi).catch(function () { return ""; }) : Promise.resolve(""),
          Ent.lookupCas ? Ent.lookupCas(smi).catch(function () { return []; }) : Promise.resolve([])
        ]).then(function (metaRes) {
          var cas = (metaRes[1] && metaRes[1][0]) || null, iupac = metaRes[0] || newName;
          rememberStructure(paperName, cand, smi, cas, iupac);
          return g.items.reduce(function (p, o) {
            return p.then(function (rows) {
              o.cand.name = newName;
              return pdfResult.resolveCandidate(o.cand, smi, cas, iupac).then(function (row) { rows.push(row); return rows; });
            });
          }, Promise.resolve([]));
        }).then(function (rows) {
          rows.forEach(function (row) { pdfResult.readyRows.push(row); });
          removeReviewItems(g.items);
          toast("Added " + plural(rows.length, "entry", "entries") + " for “" + ((rows[0] && rows[0].name) || newName) + "” to batch JSON.");
        }, function () {
          addBtn.disabled = false; dropBtn.disabled = false;
          it.note = "Could not build entry row."; it.noteIsErr = true; drawPdfModal();
        });
      });
      dropBtn.addEventListener("click", function () {
        rememberDismissed(g.items.map(function (o) { return o.cand; }));
        removeReviewItems(g.items);
      });
      return li;
    }));
  }

  if ($("pdf-pick")) {
    $("pdf-pick").addEventListener("click", function () { $("pdf-file").click(); });
    $("pdf-clear").addEventListener("click", function () {
      if (pdfBusy && pdfAbort) {
        pdfAbort.aborted = true;
        $("pdf-clear").disabled = true;
        $("pdf-info").textContent = "Cancelling after the current page…";
        return;
      }
      resetPdfUpload();
    });
    $("pdf-file").addEventListener("change", function (e) { handlePdfFiles(e.target.files); });
    var pdfDrop = $("pdf-drop");
    ["dragenter", "dragover"].forEach(function (ev) {
      pdfDrop.addEventListener(ev, function (e) { e.preventDefault(); pdfDrop.classList.add("dragover"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      pdfDrop.addEventListener(ev, function (e) { e.preventDefault(); pdfDrop.classList.remove("dragover"); });
    });
    pdfDrop.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handlePdfFiles(e.dataTransfer.files);
    });
    $("pdf-go").addEventListener("click", function () {
      if (!pdfFiles.length || !window.EntPdf) return;
      pdfBusy = true;
      pdfAbort = { aborted: false };
      $("pdf-go").disabled = true; $("pdf-pick").disabled = true;
      $("pdf-clear").disabled = false; $("pdf-clear").textContent = "Cancel";
      $("pdf-err").hidden = true; $("pdf-result").hidden = true;
      var prog = $("pdf-prog"); prog.hidden = false; prog.max = Math.max(1, pdfFiles.length); prog.value = 0;
      EntPdf.extractFromPdfFiles(pdfFiles, {
        refEntries: state.docs.concat(batchRows),
        doiOverride: $("pdf-doi").value.trim() || null,
        defaultRole: $("pdf-role").value || "acceptor",
        defaultCls: $("pdf-cls").value.trim() || null,
        ocr: !$("pdf-ocr") || $("pdf-ocr").checked,
        ocrImages: !!($("pdf-ocr-img") && $("pdf-ocr-img").checked),
        signal: pdfAbort,
        onStatus: function (msg, fi, tot) {
          $("pdf-info").textContent = msg;
          prog.max = Math.max(1, tot || 1);
          prog.value = Math.min(prog.max, fi || 0);
        }
      }).then(function (res) {
        return applyPdfMemo(res);
      }).then(function (res) {
        pdfBusy = false; pdfResult = res;
        prog.value = prog.max; prog.hidden = true;
        $("pdf-pick").disabled = false; $("pdf-clear").disabled = false; $("pdf-go").disabled = false;
        $("pdf-clear").textContent = "Clear";
        $("pdf-info").textContent = res.cancelled ? "Extraction cancelled." : "Extraction complete.";
        drawPdfResult();
        addToolLog("PDF extraction (" + res.fileReports.length + " file" + (res.fileReports.length === 1 ? "" : "s") + "): " +
          res.readyRows.length + " ready, " + res.reviewItems.length + " unresolved, " + res.skippedDuplicates.length + " duplicates skipped.");
        if (!res.readyRows.length && !res.reviewItems.length) {
          var bad = res.fileReports.filter(function (r) { return r.error; }).length;
          $("pdf-err").textContent = res.cancelled ? "Cancelled before any value was extracted."
            : bad === res.fileReports.length ? "None of the selected PDFs could be read; see the reason next to each file."
            : "No triplet energy values could be extracted from the selected PDF(s).";
          $("pdf-err").hidden = false;
        } else {
          toast("Extracted " + plural(res.readyRows.length, "entry", "entries") + " from PDF.");
        }
      }, function (err) {
        pdfBusy = false; prog.hidden = true;
        $("pdf-pick").disabled = false; $("pdf-clear").disabled = false; $("pdf-go").disabled = false;
        $("pdf-clear").textContent = "Clear";
        $("pdf-info").textContent = "PDF extraction failed.";
        $("pdf-err").textContent = (err && err.message) || "Could not read PDF.";
        $("pdf-err").hidden = false;
      });
    });
    $("pdf-dl-json").addEventListener("click", function () {
      if (!pdfResult || !pdfResult.readyRows.length) return;
      downloadJsonFile(pdfResult.readyRows, pdfResult.slug + ".batch.json");
    });
    $("pdf-load-up").addEventListener("click", function () {
      if (!pdfResult || !pdfResult.readyRows.length) return;
      var res = parseAndValidateUpload(pdfResult.readyRows, pdfResult.slug + ".batch.json");
      if (res.fatal || !res.rows.length) {
        $("pdf-err").textContent = res.fatal || "All extracted entries are already in the database.";
        $("pdf-err").hidden = false;
        return;
      }
      var rows = toImportRows(res.rows);
      pdfBusy = true; $("pdf-load-up").disabled = true; $("pdf-pick").disabled = true;
      $("pdf-info").textContent = "Importing " + rows.length + " extracted entries…";
      api.adminImport(rows).then(function () {
        pdfBusy = false; $("pdf-pick").disabled = false;
        addToolLog("Imported " + rows.length + " PDF-extracted entries into the queue.");
        toast("Imported " + rows.length + (rows.length === 1 ? " entry" : " entries") + " into the queue.");
        pdfResult.readyRows = [];
        drawPdfResult();
        $("pdf-info").textContent = "Imported " + plural(rows.length, "entry", "entries") + " into the review queue.";
        load({ silent: true });
      }, function (err) {
        pdfBusy = false; $("pdf-load-up").disabled = false; $("pdf-pick").disabled = false;
        if (err && err.status === 401) { signedOut("Your session ended. Sign in again."); return; }
        $("pdf-err").textContent = "Import failed: " + ((err && err.message) || "unknown error");
        $("pdf-err").hidden = false;
        load({ silent: true });
      });
    });
    $("pdf-review-open").addEventListener("click", openPdfModal);
    $("pdf-modal-close").addEventListener("click", closePdfModal);
    $("pdf-modal").addEventListener("click", function (e) { if (e.target === $("pdf-modal")) closePdfModal(); });
    $("pdf-modal-dl").addEventListener("click", function () {
      if (!pdfResult || !pdfResult.reviewItems.length) return;
      downloadJsonFile(pdfResult.reviewItems.map(function (it) { return it.cand; }), pdfResult.slug + ".needs_review.json");
    });
  }

  /* Backfill OpenChemLib structure codes silently once OCL loads. */
  var backfilled = false;
  function backfill() {
    if (backfilled || !state.loaded || !window.OCL) return;
    backfilled = true;
    state.docs.filter(function (d) { return !d.idcode && Ent.idCode(d.smiles); })
      .reduce(function (p, d) { return p.then(function () { return api.adminPatch(d.id, { idcode: Ent.idCode(d.smiles) }).catch(function () {}); }); }, Promise.resolve());
  }

  /* ---------- Scope-aware IUPAC names & CAS enrichment ---------- */
  function scopedDocs() {
    return $("enrich-scope").value === "pending" ? pendingDocs() : state.docs;
  }
  $("enrich-scope").addEventListener("change", function () { drawSmiSync(); drawNames(); drawCas(); drawComm(); });

  var STATUS_LABEL = { pending: "Queue", approved: "Approved", rejected: "Rejected" };
  var enrichIssues = [], eiModalFilter = "all", eiModalTool = "", eiModalQuery = "", eiReturn = null;
  function errText(err, fallback) {
    var msg = err && err.message ? String(err.message) : "";
    return msg || fallback;
  }
  function groupDocsByMol(docs) {
    var map = {}, order = [];
    docs.forEach(function (d) {
      var key = nameKey(d.smiles) || ("id:" + d.id);
      if (!map[key]) { map[key] = { key: key, smiles: d.smiles || "", docs: [] }; order.push(map[key]); }
      map[key].docs.push(d);
    });
    return order;
  }
  function groupDocsByCas(docs) {
    var map = {}, order = [];
    docs.forEach(function (d) {
      var cas = EntScore.cleanCas(d.cas || "");
      var key = cas ? ("cas:" + cas) : ("id:" + d.id);
      if (!map[key]) { map[key] = { key: key, cas: cas, smiles: d.smiles || "", docs: [] }; order.push(map[key]); }
      map[key].docs.push(d);
    });
    return order;
  }
  function issueGroup(docs, tool, kind, reason, molKey) {
    var d0 = docs[0] || {};
    var origNames = {};
    docs.forEach(function (d) { origNames[d.id] = d.name || ""; });
    return {
      molKey: molKey || nameKey(d0.smiles) || ("id:" + d0.id),
      docIds: docs.map(function (d) { return d.id; }),
      origNames: origNames,
      name: d0.name || "(unnamed)",
      commercialName: d0.commercial_name ? String(d0.commercial_name).trim() : "",
      cas: d0.cas ? String(d0.cas).trim() : "",
      smiles: d0.smiles || "",
      tool: tool,
      kind: kind,
      reason: reason,
      draftFix: null,
      draftQuery: tool === "Commercial name"
        ? ((d0.cas && String(d0.cas).trim()) || d0.name || "")
        : ((d0.commercial_name && String(d0.commercial_name).trim()) || d0.name || ""),
      candidates: [],
      note: "",
      busy: false
    };
  }
  function pruneResolvedIssues() {
    var byId = docsById();
    enrichIssues = enrichIssues.filter(function (it) {
      var liveDocs = [];
      it.docIds.forEach(function (id) {
        var live = byId[id];
        if (!live) return;
        if (it.tool === "CAS" && live.cas) return;
        if (it.tool === "Commercial name" && live.commercial_name && String(live.commercial_name).trim()) return;
        if (it.tool === "Batch IUPAC" && (!nameOf(live) || live.name === nameOf(live))) return;
        if (it.tool === "IUPAC" && live.name !== it.origNames[id]) return;
        liveDocs.push(live);
      });
      if (!liveDocs.length) return false;
      it.docIds = liveDocs.map(function (d) { return d.id; });
      it.name = liveDocs[0].name || "(unnamed)";
      it.commercialName = liveDocs[0].commercial_name ? String(liveDocs[0].commercial_name).trim() : "";
      it.cas = liveDocs[0].cas ? String(liveDocs[0].cas).trim() : "";
      it.smiles = liveDocs[0].smiles || "";
      if (!it.draftQuery) it.draftQuery = it.tool === "Commercial name" ? (it.cas || it.name) : (it.commercialName || it.name);
      return true;
    });
  }
  function mergeToolIssues(tool, attemptedIds, newGroups) {
    var remaining = [];
    enrichIssues.forEach(function (it) {
      if (it.tool !== tool) { remaining.push(it); return; }
      var leftIds = it.docIds.filter(function (id) { return !attemptedIds[id]; });
      if (leftIds.length) {
        it.docIds = leftIds;
        remaining.push(it);
      }
    });
    var byMol = {};
    remaining.forEach(function (it) { if (it.tool === tool) byMol[it.molKey] = it; });
    var fresh = [];
    newGroups.forEach(function (g) {
      var ex = byMol[g.molKey];
      if (ex) {
        var seen = {}; ex.docIds.forEach(function (id) { seen[id] = 1; });
        g.docIds.forEach(function (id) { if (!seen[id]) { ex.docIds.push(id); ex.origNames[id] = g.origNames[id]; } });
        ex.kind = g.kind; ex.reason = g.reason; ex.note = "";
      } else {
        fresh.push(g);
      }
    });
    var sorted = fresh.sort(function (a, b) {
      return (a.kind === "fail" ? 0 : 1) - (b.kind === "fail" ? 0 : 1);
    });
    enrichIssues = sorted.concat(remaining);
    render();
    drawEnrichIssues();
  }
  function patchGroupDocs(ids, patch) {
    return api.adminPatchManyRows(ids, patch).then(function (rows) {
      var byUp = applyUpdatedRows(rows);
      if ("smiles" in patch) {
        Object.keys(byUp).forEach(function (id) { delete casMiss[id]; delete nameTried[id]; });
      }
      if ("cas" in patch) {
        Object.keys(byUp).forEach(function (id) { delete commMiss[id]; });
      }
      render(); drawCas(); drawComm(); drawSmiSync(); drawNames(); drawEnrichIssues();
      return rows;
    }, function (err) {
      if (err && err.status === 401) signedOut("Your session ended. Sign in again.");
      throw err;
    });
  }
  function openEnrichModal() {
    if (!enrichIssues.length) return;
    eiReturn = document.activeElement;
    $("ei-modal").hidden = false;
    Ent.syncModalOpen();
    drawEnrichModal();
    $("ei-modal-q").focus();
  }
  function closeEnrichModal() {
    var m = $("ei-modal");
    if (!m || m.hidden) return;
    m.hidden = true;
    Ent.syncModalOpen();
    if (eiReturn && eiReturn.focus) eiReturn.focus();
    eiReturn = null;
  }
  function drawEnrichIssues() {
    pruneResolvedIssues();
    var bar = $("enrich-issues-bar");
    var nFail = 0, nMiss = 0, totalEntries = 0;
    enrichIssues.forEach(function (it) {
      if (it.kind === "fail") nFail++; else nMiss++;
      totalEntries += it.docIds.length;
    });
    bar.hidden = !enrichIssues.length;
    $("enrich-issues-count").textContent = enrichIssues.length;
    var parts = [];
    if (nFail) parts.push(nFail + " failed");
    if (nMiss) parts.push(nMiss + " not found on PubChem");
    $("enrich-issues-summary").textContent = parts.join(" · ") +
      (totalEntries > enrichIssues.length ? " (" + totalEntries + " entries)" : (totalEntries === 1 ? " (1 entry)" : " (" + totalEntries + " entries)"));
    syncEnrichEmpty();
    if (!$("ei-modal").hidden) {
      if (!enrichIssues.length) closeEnrichModal();
      else drawEnrichModal();
    }
  }
  function buildIssueCard(it) {
    var byId = docsById();
    var liveDocs = it.docIds.map(function (id) { return byId[id]; }).filter(Boolean);
    var d0 = liveDocs[0] || { id: it.docIds[0], name: it.name, smiles: it.smiles, status: "pending" };
    var li = el("li", "ei-card " + (it.kind === "fail" ? "ei-fail" : "ei-miss"));

    /* Left column: structure preview, name, badges, reason & copyable SMILES */
    var infoCol = el("div", "ei-col-info");
    var thumb = el("div", "ei-thumb");
    var minfo = it.smiles ? Ent.molInfo(it.smiles) : null;
    if (minfo) thumb.innerHTML = minfo.svg;
    else thumb.textContent = window.OCL ? "Invalid SMILES" : "No preview";
    infoCol.appendChild(thumb);

    var meta = el("div", "ei-meta");
    var head = el("div", "ei-head");
    var titleBox = el("div", "card-title");
    var dispTitle = it.commercialName || it.name;
    var nm = el("strong", "ei-name", dispTitle); nm.title = dispTitle;
    titleBox.appendChild(nm);
    if (it.commercialName && it.name && it.commercialName.toLowerCase() !== it.name.toLowerCase()) {
      var subIupac = el("p", "iupac-sub", it.name); subIupac.title = "IUPAC name";
      titleBox.appendChild(subIupac);
    }
    head.appendChild(titleBox);
    var badges = el("span", "ei-badges");
    badges.appendChild(el("span", "ei-badge " + (it.kind === "fail" ? "fail" : "miss"), it.kind === "fail" ? "Failed" : "Not found"));
    badges.appendChild(el("span", "ei-tool", it.tool));
    if (liveDocs.length > 1) badges.appendChild(el("span", "ei-status", liveDocs.length + " entries"));
    var stSeen = {};
    liveDocs.forEach(function (d) { stSeen[d.status] = (stSeen[d.status] || 0) + 1; });
    Object.keys(stSeen).forEach(function (s) {
      var lbl = (STATUS_LABEL[s] || s) + (liveDocs.length > 1 && Object.keys(stSeen).length > 1 ? " ×" + stSeen[s] : "");
      badges.appendChild(el("span", "ei-status", lbl));
    });
    head.appendChild(badges);
    meta.appendChild(head);
    meta.appendChild(el("div", "ei-reason", it.reason));

    var smiRow = el("div", "copy-row ei-smiles-row");
    var smiCode = el("code", "smiles", it.smiles || "—");
    if (it.smiles) smiCode.title = it.smiles;
    smiRow.appendChild(smiCode);
    if (it.smiles) {
      var copySmi = el("button", "btn tiny", "Copy"); copySmi.type = "button";
      copySmi.setAttribute("aria-label", "Copy SMILES");
      copySmi.addEventListener("click", function () { Ent.copyText(it.smiles, copySmi); });
      smiRow.appendChild(copySmi);
    }
    meta.appendChild(smiRow);
    infoCol.appendChild(meta);
    li.appendChild(infoCol);

    /* Right column: inline fix + PubChem lookup helpers + structure/card links */
    var fixCol = el("div", "ei-col-fix");
    var isCas = it.tool === "CAS", isComm = it.tool === "Commercial name";
    var suggestedBatch = it.tool === "Batch IUPAC" ? (nameOf(d0) || "") : "";
    var fixRow = el("div", "ei-fix-row");
    var fixInp = el("input");
    fixInp.type = "text";
    fixInp.className = isCas ? "mono grow" : "grow";
    fixInp.placeholder = isCas ? "Enter CAS (e.g. 100-42-5)" : isComm ? "Enter commercial name" : "Enter IUPAC name";
    fixInp.setAttribute("aria-label", (isCas ? "CAS number" : isComm ? "Commercial name" : "IUPAC name") + " for " + it.name);
    fixInp.value = it.draftFix != null ? it.draftFix : (suggestedBatch || ((isCas || isComm) ? "" : it.name));
    fixInp.disabled = it.busy;
    fixInp.addEventListener("input", function () { it.draftFix = fixInp.value; });

    var saveLabel = liveDocs.length > 1 ? ("Save (" + liveDocs.length + ")") : "Save";
    var saveBtn = el("button", "btn small primary", saveLabel);
    saveBtn.type = "button"; saveBtn.disabled = it.busy;
    fixRow.appendChild(fixInp); fixRow.appendChild(saveBtn);
    fixCol.appendChild(fixRow);

    var lookupRow = el("div", "ei-lookup-row");
    var qInp = el("input");
    qInp.type = "text"; qInp.className = "grow";
    qInp.placeholder = isComm ? "CAS or compound name for PubChem…" : "Compound name for PubChem…";
    qInp.setAttribute("aria-label", (isComm ? "CAS or name to search on PubChem for " : "Name to search on PubChem for ") + it.name);
    qInp.value = it.draftQuery; qInp.disabled = it.busy;
    qInp.addEventListener("input", function () { it.draftQuery = qInp.value; });

    var byNameBtn = el("button", "btn small", isComm ? "Synonyms" : "By name"); byNameBtn.type = "button"; byNameBtn.disabled = it.busy;
    lookupRow.appendChild(qInp); lookupRow.appendChild(byNameBtn);
    var retryBtn = null;
    if (isComm && it.cas) {
      retryBtn = el("button", "btn small", "Retry CAS"); retryBtn.type = "button"; retryBtn.disabled = it.busy;
      lookupRow.appendChild(retryBtn);
    } else if (it.smiles) {
      retryBtn = el("button", "btn small", "Retry SMILES"); retryBtn.type = "button"; retryBtn.disabled = it.busy;
      lookupRow.appendChild(retryBtn);
    }
    fixCol.appendChild(lookupRow);

    if ((isCas || isComm) && it.candidates && it.candidates.length > 1) {
      var candRow = el("div", "ei-candidates");
      candRow.appendChild(el("span", "hint", "Matches:"));
      it.candidates.forEach(function (candVal) {
        var cb = el("button", "btn tiny", candVal); cb.type = "button"; cb.disabled = it.busy;
        cb.addEventListener("click", function () { it.draftFix = candVal; fixInp.value = candVal; fixInp.focus(); });
        candRow.appendChild(cb);
      });
      fixCol.appendChild(candRow);
    }

    var noteEl = el("div", "ei-note" + (it.noteIsErr ? " err" : " hint"), it.note || "");
    noteEl.hidden = !it.note;
    fixCol.appendChild(noteEl);

    var linksRow = el("div", "ei-card-links");
    var fixSmiBtn = el("button", "btn tiny", "Fix SMILES" + (liveDocs.length > 1 ? " (" + liveDocs.length + ")" : ""));
    fixSmiBtn.type = "button"; fixSmiBtn.disabled = it.busy;
    fixSmiBtn.addEventListener("click", function () {
      Ent.sketcher.open({
        title: "Sketcher · " + it.name + (liveDocs.length > 1 ? " (" + liveDocs.length + " entries)" : ""),
        smiles: it.smiles || "",
        saveLabel: liveDocs.length > 1 ? ("Save to " + liveDocs.length + " entries") : "Save structure",
        hint: "Edit the drawing or SMILES, then save. Saving marks the structure as verified.",
        onSave: function (newSmi) {
          var ids = liveDocs.map(function (d) { return d.id; });
          return patchGroupDocs(ids, { smiles: newSmi, idcode: Ent.idCode(newSmi), smiles_checked: true }).then(function (rows) {
            if (!rows || !rows.length) return false;
            it.smiles = newSmi; it.molKey = nameKey(newSmi) || it.molKey;
            it.note = "Structure updated — click Retry SMILES to query PubChem again."; it.noteIsErr = false;
            drawEnrichIssues();
            return true;
          }, function () { return false; });
        }
      });
    });

    var edBtn = el("button", "btn tiny", "Full editor"); edBtn.type = "button"; edBtn.disabled = it.busy;
    edBtn.addEventListener("click", function () {
      var cur = docsById()[d0.id];
      if (!cur) { toast("This entry is no longer in the database."); drawEnrichIssues(); return; }
      Ent.editor.open(cur, function (patch) { return onPatch(cur.id, patch); });
    });

    var showBtn = el("button", "btn tiny", "Show card"); showBtn.type = "button"; showBtn.disabled = it.busy;
    showBtn.addEventListener("click", function () { closeEnrichModal(); focusIssueCard(d0.id); });

    linksRow.appendChild(fixSmiBtn); linksRow.appendChild(edBtn); linksRow.appendChild(showBtn);
    fixCol.appendChild(linksRow);
    li.appendChild(fixCol);

    function rerenderThisCard() {
      var fresh = buildIssueCard(it);
      if (li.parentNode) {
        li.parentNode.replaceChild(fresh, li);
        li = fresh;
      }
    }

    function runLookup(promise, sourceLabel) {
      it.busy = true; it.note = "Asking PubChem…"; it.noteIsErr = false;
      rerenderThisCard();
      var isRetry = sourceLabel === "SMILES" || sourceLabel === "CAS";
      promise.then(function (res) {
        it.busy = false;
        if (isCas || isComm) {
          var vals = (res.values && res.values.length) ? res.values
            : (res.value ? [res.value].concat(res.synonyms || []) : []);
          if (vals.length) {
            it.draftFix = vals[0];
            it.candidates = vals.slice(0, 5);
            it.note = "Found via " + sourceLabel + " — verify before saving.";
            it.noteIsErr = false;
          } else {
            it.candidates = [];
            it.note = res.reason || "Not found on PubChem.";
            it.noteIsErr = res.code === "bad_input";
            if (isRetry) { it.reason = it.note; it.kind = res.code === "bad_input" ? "fail" : "miss"; }
          }
        } else {
          if (res.value) {
            it.draftFix = res.value;
            it.note = "Found via " + sourceLabel + " — verify before saving.";
            it.noteIsErr = false;
          } else {
            it.note = res.reason || "Not found on PubChem.";
            it.noteIsErr = res.code === "bad_input";
            if (isRetry) { it.reason = it.note; it.kind = res.code === "bad_input" ? "fail" : "miss"; }
          }
        }
        if (isRetry) drawEnrichIssues();
        else rerenderThisCard();
      }, function (err) {
        it.busy = false;
        it.note = errText(err, "PubChem could not be reached."); it.noteIsErr = true;
        rerenderThisCard();
      });
    }

    byNameBtn.addEventListener("click", function () {
      var q = qInp.value.trim();
      it.draftQuery = q;
      if (!q) { it.note = isComm ? "Enter a CAS number or name to search." : "Enter a compound name to search."; it.noteIsErr = true; rerenderThisCard(); return; }
      runLookup(isCas ? Ent.lookupCasByName(q) : isComm ? Ent.lookupCommercialSynonyms(q) : Ent.lookupIupacByName(q), isComm ? "PubChem" : "name");
    });
    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        if (isComm && it.cas) runLookup(Ent.lookupCommercialNameDetailed(it.cas), "CAS");
        else runLookup(isCas ? Ent.lookupCasDetailed(it.smiles) : isComm ? Ent.lookupCommercialSynonyms(it.smiles, "smiles") : Ent.lookupIupacDetailed(it.smiles), "SMILES");
      });
    }

    saveBtn.addEventListener("click", function () {
      var raw = fixInp.value.trim(), patch;
      if (isCas) {
        var cleaned = EntScore.cleanCas(raw);
        if (!cleaned) { it.note = "Enter a CAS number first."; it.noteIsErr = true; rerenderThisCard(); return; }
        if (!EntScore.casValid(cleaned)) { it.note = "“" + cleaned + "” is not a valid CAS number."; it.noteIsErr = true; rerenderThisCard(); return; }
        patch = { cas: cleaned };
      } else if (isComm) {
        if (!raw) { it.note = "Enter a commercial name first."; it.noteIsErr = true; rerenderThisCard(); return; }
        patch = { commercial_name: raw.slice(0, 200) };
      } else {
        if (!raw) { it.note = "The IUPAC name cannot be empty."; it.noteIsErr = true; rerenderThisCard(); return; }
        patch = { name: raw };
      }
      it.busy = true; it.note = "Saving…"; it.noteIsErr = false;
      rerenderThisCard();
      var ids = liveDocs.map(function (d) { return d.id; });
      patchGroupDocs(ids, patch).then(function (rows) {
        it.busy = false;
        if (!rows || !rows.length) { it.note = "Database did not save the update."; it.noteIsErr = true; rerenderThisCard(); return; }
        toast("Updated " + rows.length + (rows.length === 1 ? " entry" : " entries") + " for “" + it.name + "”.");
      }, function (err) {
        it.busy = false;
        it.note = errText(err, "Could not save. Try again."); it.noteIsErr = true;
        rerenderThisCard();
      });
    });

    fixInp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); } });
    qInp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); byNameBtn.click(); } });

    return li;
  }
  function drawEnrichModalList() {
    var ul = $("ei-modal-list"), empty = $("ei-modal-empty");
    var q = eiModalQuery.trim().toLowerCase();
    var shown = enrichIssues.filter(function (it) {
      if (eiModalFilter !== "all" && it.kind !== eiModalFilter) return false;
      if (eiModalTool && it.tool !== eiModalTool) return false;
      if (q) {
        var hay = [it.name, it.commercialName, it.smiles, it.reason, it.tool].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    empty.hidden = shown.length > 0;
    ul.replaceChildren.apply(ul, shown.map(buildIssueCard));
  }
  function drawEnrichModal() {
    var nFail = 0, nMiss = 0, totalEntries = 0, tools = {};
    enrichIssues.forEach(function (it) {
      if (it.kind === "fail") nFail++; else nMiss++;
      totalEntries += it.docIds.length;
      tools[it.tool] = 1;
    });
    if ((eiModalFilter === "fail" && !nFail) || (eiModalFilter === "miss" && !nMiss)) eiModalFilter = "all";
    var toolKeys = Object.keys(tools);
    if (eiModalTool && !tools[eiModalTool]) eiModalTool = "";
    $("ei-modal-meta").textContent = enrichIssues.length + (enrichIssues.length === 1 ? " molecule" : " molecules") +
      " · " + totalEntries + (totalEntries === 1 ? " entry" : " entries");
    var filtersBox = $("ei-modal-filters");
    Array.prototype.forEach.call(filtersBox.querySelectorAll("button"), function (b) {
      var k = b.getAttribute("data-ei-filter");
      var cnt = k === "all" ? enrichIssues.length : k === "fail" ? nFail : nMiss;
      b.textContent = (k === "all" ? "All" : k === "fail" ? "Failed" : "Not found") + " (" + cnt + ")";
      b.hidden = k !== "all" && cnt === 0;
      b.setAttribute("aria-pressed", String(k === eiModalFilter));
    });
    var toolSel = $("ei-modal-tool");
    toolSel.hidden = toolKeys.length <= 1;
    toolSel.value = eiModalTool;
    drawEnrichModalList();
  }
  $("enrich-review-open").addEventListener("click", openEnrichModal);
  $("ei-modal-close").addEventListener("click", closeEnrichModal);
  $("ei-modal").addEventListener("click", function (e) { if (e.target === $("ei-modal")) closeEnrichModal(); });
  $("ei-modal-q").addEventListener("input", function (e) { eiModalQuery = e.target.value; drawEnrichModalList(); });
  $("ei-modal-filters").addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("button[data-ei-filter]") : null;
    if (!btn) return;
    eiModalFilter = btn.getAttribute("data-ei-filter") || "all";
    drawEnrichModal();
  });
  $("ei-modal-tool").addEventListener("change", function (e) { eiModalTool = e.target.value; drawEnrichModalList(); });
  function clearEnrichIssues() {
    enrichIssues = []; eiModalFilter = "all"; eiModalTool = ""; eiModalQuery = "";
    $("ei-modal-q").value = "";
    closeEnrichModal();
    render();
    drawEnrichIssues();
  }
  $("enrich-issues-clear").addEventListener("click", clearEnrichIssues);
  $("ei-modal-clear").addEventListener("click", clearEnrichIssues);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var ed = $("ed"), sk = $("sk"), ei = $("ei-modal"), pm = $("pdf-modal");
    if ((ed && !ed.hidden) || (sk && !sk.hidden)) return;
    if (pm && !pm.hidden) { closePdfModal(); return; }
    if (ei && !ei.hidden) closeEnrichModal();
  });

  var batchByKey = {}, nameMap = {}, batchRows = [], nameRun = null, nameTried = {};
  function buildNames() {
    batchByKey = {}; nameMap = {};
    batchRows.forEach(function (r) {
      if (r.import_key) batchByKey[r.import_key] = r;
      if (r.smiles && r.name) nameMap[nameKey(r.smiles)] = r.name;
    });
  }
  function smiFix() {
    buildNames();
    return scopedDocs().filter(function (d) {
      var br = d.import_key && batchByKey[d.import_key];
      return br && br.smiles && d.smiles !== br.smiles;
    });
  }
  function drawSmiSync(msg) {
    var todo = smiFix(), box = $("smi-sync");
    if (!box) return;
    box.hidden = !todo.length && !msg;
    $("smi-sync-go").hidden = !todo.length;
    $("smi-sync-text").textContent = (msg ? msg + " " : "") +
      (todo.length ? todo.length + (todo.length === 1 ? " entry has" : " entries have") + " updated SMILES (coordinated metal complexes) in the literature batch." : "");
    syncEnrichEmpty();
  }
  $("smi-sync-go").addEventListener("click", function () {
    var todo = smiFix(); if (!todo.length) return;
    $("smi-sync-go").disabled = true;
    $("smi-sync-text").textContent = "Updating " + todo.length + " structures…";
    var okN = 0, failN = 0;
    todo.reduce(function (p, d) {
      return p.then(function () {
        var br = batchByKey[d.import_key];
        var patch = { smiles: br.smiles, idcode: Ent.idCode(br.smiles) || br.idcode || null };
        if (br.structure_note) patch.structure_note = br.structure_note;
        return api.adminPatch(d.id, patch).then(function (rows) {
          if (rows && rows[0]) { state.docs = state.docs.map(function (x) { return x.id === d.id ? rows[0] : x; }); okN++; }
          else failN++;
        }, function (e) { if (e && e.status === 401) throw e; failN++; });
      });
    }, Promise.resolve()).then(function () {
      $("smi-sync-go").disabled = false; dupCache = {}; render();
      var summary = "Updated " + okN + " SMILES" + (failN ? ", " + failN + " failed" : "") + ".";
      addToolLog("Batch SMILES sync: " + summary);
      toast(summary);
      drawSmiSync(summary);
    }, function () { $("smi-sync-go").disabled = false; signedOut("Your session ended. Sign in again."); });
  });
  function nameKey(smi) { return (window.OCL && Ent.idCode(smi)) || smi; }
  function nameOf(d) { return d.smiles ? nameMap[nameKey(d.smiles)] : ""; }
  function nameFix() { return scopedDocs().filter(function (d) { var n = nameOf(d); return n && d.name !== n; }); }
  function namePc() { return scopedDocs().filter(function (d) { return d.smiles && !nameOf(d) && !nameTried[d.id]; }); }
  function syncEnrichEmpty() {
    $("enrich-empty").hidden = !$("smi-sync").hidden || !$("iupac").hidden || !$("cas").hidden || !$("comm").hidden || enrichIssues.length > 0;
    updateToolsBadge();
  }
  function drawNames(msg) {
    if (nameRun) return;
    buildNames();
    var a = nameFix().length, b = namePc().length;
    $("iupac").hidden = !a && !b && !msg;
    $("iupac-go").hidden = !a; $("iupac-pc").hidden = !b; $("iupac-stop").hidden = true;
    $("iupac-prog").hidden = true;
    $("iupac-text").textContent = (msg ? msg + " " : "") +
      (a ? a + (a === 1 ? " entry has" : " entries have") + " a name that differs from the literature batch IUPAC name. " : "") +
      (b ? b + " other " + (b === 1 ? "entry" : "entries") + " can be checked against PubChem." : "");
    syncEnrichEmpty();
  }
  $("iupac-go").addEventListener("click", function () {
    var byDocs = {}; nameFix().forEach(function (d) { var n = nameOf(d); (byDocs[n] = byDocs[n] || []).push(d); });
    var names = Object.keys(byDocs), done = 0, fail = 0;
    var attemptedIds = {}, partialTarget = {}, failedDocs = [], failReasons = {};
    $("iupac-go").disabled = true; nameRun = {};
    var prog = $("iupac-prog"); prog.max = Math.max(1, names.length); prog.value = 0; prog.hidden = false;
    names.reduce(function (p, n) {
      return p.then(function () {
        $("iupac-text").textContent = "Renaming… " + done + " / " + names.length + " structures";
        var docs = byDocs[n];
        docs.forEach(function (d) { attemptedIds[d.id] = 1; });
        return api.adminPatchMany(docs.map(function (d) { return d.id; }), { name: n }).then(function (updated) {
          if (updated === 0) {
            fail++;
            docs.forEach(function (d) { failedDocs.push(d); failReasons[d.id] = "Database did not update this entry"; });
          } else if (updated < docs.length) {
            fail++;
            docs.forEach(function (d) { partialTarget[d.id] = n; });
          } else done++;
          prog.value = done + fail;
        }, function (e) {
          if (e && e.status === 401) throw e;
          fail++; prog.value = done + fail;
          var msg = errText(e, "Database update failed");
          docs.forEach(function (d) { failedDocs.push(d); failReasons[d.id] = msg; });
        });
      });
    }, Promise.resolve()).then(function () {
      nameRun = null; $("iupac-go").disabled = false; prog.hidden = true;
      load({ silent: true }).then(function () { return lastBatchesPromise; }).then(function () {
        var byId = docsById(), seenFail = {};
        failedDocs.forEach(function (d) { seenFail[d.id] = 1; });
        Object.keys(partialTarget).forEach(function (id) {
          var live = byId[id];
          if (live && live.name !== partialTarget[id] && !seenFail[id]) {
            failedDocs.push(live); failReasons[id] = "Database did not update this entry";
          }
        });
        var issues = groupDocsByMol(failedDocs).map(function (g) {
          return issueGroup(g.docs, "Batch IUPAC", "fail", failReasons[g.docs[0].id] || "Database update failed", g.key);
        });
        mergeToolIssues("Batch IUPAC", attemptedIds, issues);
        addToolLog("Batch IUPAC rename: " + done + " structures updated" + (fail ? ", " + fail + " failed" : "") + ".");
        drawNames(fail ? fail + " structures could not be renamed; review in Needs attention below." : "Names updated.");
        if (issues.length) toast(issues.length + (issues.length === 1 ? " molecule" : " molecules") + " could not be renamed.", { actionLabel: "Review & fix", onAction: openEnrichModal });
      });
    }, function () { nameRun = null; $("iupac-go").disabled = false; prog.hidden = true; signedOut("Your session ended. Sign in again."); });
  });

  function runPubchemEnrich(cfg) {
    var groups = (cfg.groupBy || groupDocsByMol)(cfg.todo);
    var run = { stop: false, out: false, okEntries: 0, sameEntries: 0, missMol: 0, failMol: 0, inRow: 0, issues: [], attemptedIds: {} };
    cfg.setRun(run);
    cfg.onStart(groups);
    function finish(why) {
      cfg.setRun(null);
      if (run.out) return;
      cfg.onFinish(why, run, groups);
    }
    (function step(i) {
      if (run.stop) return finish("Stopped.");
      if (i >= groups.length) return finish("Done.");
      if (run.inRow >= 5) return finish("Stopped after five errors in a row.");
      cfg.onStep(i, groups.length, run);
      var g = groups[i], wait = 250;
      g.docs.forEach(function (d) { run.attemptedIds[d.id] = 1; });
      cfg.lookup(cfg.groupBy ? g : g.smiles).then(function (res) {
        return cfg.handleResult(g, res, run);
      }).catch(function (err) {
        if (err && err.status === 401) { run.stop = run.out = true; signedOut("Your session ended. Sign in again."); return; }
        run.failMol++; run.inRow++; wait = 2000;
        run.issues.push(issueGroup(g.docs, cfg.tool, "fail", errText(err, "PubChem or database error"), g.key));
      }).then(function () { setTimeout(function () { step(i + 1); }, wait); });
    })(0);
  }

  function saveEnrichDocs(docs, patch, run, tool, failMsg, molKey, onSaved) {
    return api.adminPatchManyRows(docs.map(function (d) { return d.id; }), patch).then(function (rows) {
      var byUp = applyUpdatedRows(rows);
      var missed = [];
      docs.forEach(function (d) {
        if (byUp[d.id]) { run.okEntries++; if (onSaved) onSaved(d); }
        else missed.push(d);
      });
      if (missed.length) {
        run.failMol++; run.inRow++;
        run.issues.push(issueGroup(missed, tool, "fail", failMsg, molKey));
      } else run.inRow = 0;
    });
  }

  $("iupac-pc").addEventListener("click", function () {
    runPubchemEnrich({
      tool: "IUPAC",
      todo: namePc(),
      setRun: function (r) { nameRun = r; },
      onStart: function (groups) {
        $("iupac-go").hidden = $("iupac-pc").hidden = true; $("iupac-stop").hidden = false; $("iupac-stop").disabled = false;
        var prog = $("iupac-prog"); prog.max = Math.max(1, groups.length); prog.value = 0; prog.hidden = false;
      },
      onStep: function (i, total, run) {
        $("iupac-prog").value = i;
        $("iupac-text").textContent = "Checking " + (i + 1) + " / " + total + " molecules · renamed " + run.okEntries + " · not on PubChem " + run.missMol + (run.failMol ? " · failed " + run.failMol : "");
      },
      lookup: function (smi) { return Ent.lookupIupacDetailed(smi); },
      handleResult: function (g, res, run) {
        if (res.code === "bad_input" || res.code === "no_smiles") {
          run.inRow = 0; g.docs.forEach(function (d) { nameTried[d.id] = 1; }); run.failMol++;
          run.issues.push(issueGroup(g.docs, "IUPAC", "fail", res.reason, g.key));
          return;
        }
        if (!res.value) {
          run.inRow = 0; g.docs.forEach(function (d) { nameTried[d.id] = 1; }); run.missMol++;
          run.issues.push(issueGroup(g.docs, "IUPAC", "miss", res.reason, g.key));
          return;
        }
        var same = g.docs.filter(function (d) { return d.name === res.value; });
        var need = g.docs.filter(function (d) { return d.name !== res.value; });
        same.forEach(function (d) { nameTried[d.id] = 1; });
        run.sameEntries += same.length;
        if (!need.length) { run.inRow = 0; return; }
        return saveEnrichDocs(need, { name: res.value }, run, "IUPAC", "Database did not save the updated name", g.key, function (d) {
          nameTried[d.id] = 1;
        });
      },
      onFinish: function (why, run) {
        $("iupac-prog").hidden = true;
        mergeToolIssues("IUPAC", run.attemptedIds, run.issues);
        var summary = why + " Renamed " + run.okEntries + ", already IUPAC " + run.sameEntries + ", not on PubChem " + run.missMol + (run.failMol ? ", failed " + run.failMol : "") + ".";
        addToolLog("PubChem IUPAC: " + summary);
        drawNames(summary + (run.issues.length ? " Review them in Needs attention below." : ""));
        if (run.issues.length) toast(run.issues.length + (run.issues.length === 1 ? " molecule" : " molecules") + " need manual IUPAC review.", { actionLabel: "Review & fix", onAction: openEnrichModal });
      }
    });
  });
  $("iupac-stop").addEventListener("click", function () { if (nameRun) { nameRun.stop = true; $("iupac-stop").disabled = true; } });

  var casRun = null, casMiss = {};
  function casTodo() { return scopedDocs().filter(function (d) { return !d.cas && d.smiles && !casMiss[d.id]; }); }
  function drawCas() {
    if (casRun) return;
    var n = casTodo().length;
    $("cas").hidden = !n; $("cas-go").hidden = false; $("cas-stop").hidden = true;
    $("cas-prog").hidden = true;
    $("cas-text").textContent = n + (n === 1 ? " entry has" : " entries have") + " no CAS number. PubChem can fill the ones it knows; check doubtful ones in the editor.";
    syncEnrichEmpty();
  }
  $("cas-go").addEventListener("click", function () {
    runPubchemEnrich({
      tool: "CAS",
      todo: casTodo(),
      setRun: function (r) { casRun = r; },
      onStart: function (groups) {
        $("cas-go").hidden = true; $("cas-stop").hidden = false; $("cas-stop").disabled = false;
        var prog = $("cas-prog"); prog.max = Math.max(1, groups.length); prog.value = 0; prog.hidden = false;
      },
      onStep: function (i, total, run) {
        $("cas-prog").value = i;
        $("cas-text").textContent = "Looking up " + (i + 1) + " / " + total + " molecules · filled " + run.okEntries + " · not on PubChem " + run.missMol + (run.failMol ? " · failed " + run.failMol : "");
      },
      lookup: function (smi) { return Ent.lookupCasDetailed(smi); },
      handleResult: function (g, res, run) {
        if (res.code === "bad_input" || res.code === "no_smiles") {
          run.inRow = 0; g.docs.forEach(function (d) { casMiss[d.id] = 1; }); run.failMol++;
          run.issues.push(issueGroup(g.docs, "CAS", "fail", res.reason, g.key));
          return;
        }
        if (!res.values.length) {
          run.inRow = 0; g.docs.forEach(function (d) { casMiss[d.id] = 1; }); run.missMol++;
          run.issues.push(issueGroup(g.docs, "CAS", "miss", res.reason, g.key));
          return;
        }
        return saveEnrichDocs(g.docs, { cas: res.values[0] }, run, "CAS", "Database did not save the CAS number", g.key, function (d) {
          delete commMiss[d.id];
        });
      },
      onFinish: function (why, run) {
        $("cas-prog").hidden = true;
        dupCache = {};
        mergeToolIssues("CAS", run.attemptedIds, run.issues);
        drawCas();
        drawComm();
        var left = casTodo().length;
        var summary = why + " Filled " + run.okEntries + " entries, not on PubChem " + run.missMol + (run.failMol ? ", failed " + run.failMol : "") + " molecules.";
        addToolLog("PubChem CAS: " + summary);
        $("cas").hidden = false; $("cas-go").hidden = !left;
        $("cas-text").textContent = summary + (left ? " " + left + " can still be tried." : "");
        syncEnrichEmpty();
        if (run.issues.length) toast(run.issues.length + (run.issues.length === 1 ? " molecule" : " molecules") + " failed or not on PubChem.", { actionLabel: "Review & fix", onAction: openEnrichModal });
      }
    });
  });
  $("cas-stop").addEventListener("click", function () { if (casRun) { casRun.stop = true; $("cas-stop").disabled = true; } });

  var commRun = null, commMiss = {};
  function commTodo() {
    return scopedDocs().filter(function (d) { return !String(d.commercial_name || "").trim() && d.cas && !commMiss[d.id]; });
  }
  function drawComm() {
    if (commRun) return;
    var n = commTodo().length;
    $("comm").hidden = !n; $("comm-go").hidden = false; $("comm-stop").hidden = true;
    $("comm-prog").hidden = true;
    $("comm-text").textContent = n + (n === 1 ? " entry has" : " entries have") + " a CAS number but no commercial name. PubChem can look up the common name from CAS.";
    syncEnrichEmpty();
  }
  $("comm-go").addEventListener("click", function () {
    runPubchemEnrich({
      tool: "Commercial name",
      todo: commTodo(),
      groupBy: groupDocsByCas,
      setRun: function (r) { commRun = r; },
      onStart: function (groups) {
        $("comm-go").hidden = true; $("comm-stop").hidden = false; $("comm-stop").disabled = false;
        var prog = $("comm-prog"); prog.max = Math.max(1, groups.length); prog.value = 0; prog.hidden = false;
      },
      onStep: function (i, total, run) {
        $("comm-prog").value = i;
        $("comm-text").textContent = "Looking up " + (i + 1) + " / " + total + " CAS numbers · filled " + run.okEntries + " · not on PubChem " + run.missMol + (run.failMol ? " · failed " + run.failMol : "");
      },
      lookup: function (g) { return Ent.lookupCommercialNameDetailed(g.cas); },
      handleResult: function (g, res, run) {
        if (res.code === "bad_input" || res.code === "no_cas") {
          run.inRow = 0; g.docs.forEach(function (d) { commMiss[d.id] = 1; }); run.failMol++;
          run.issues.push(issueGroup(g.docs, "Commercial name", "fail", res.reason, g.key));
          return;
        }
        if (!res.value) {
          run.inRow = 0; g.docs.forEach(function (d) { commMiss[d.id] = 1; }); run.missMol++;
          run.issues.push(issueGroup(g.docs, "Commercial name", "miss", res.reason, g.key));
          return;
        }
        return saveEnrichDocs(g.docs, { commercial_name: res.value }, run, "Commercial name", "Database did not save the commercial name", g.key);
      },
      onFinish: function (why, run) {
        $("comm-prog").hidden = true;
        mergeToolIssues("Commercial name", run.attemptedIds, run.issues);
        drawComm();
        var left = commTodo().length;
        var summary = why + " Filled " + run.okEntries + " entries, not on PubChem " + run.missMol + (run.failMol ? ", failed " + run.failMol : "") + " CAS numbers.";
        addToolLog("PubChem Commercial name: " + summary);
        $("comm").hidden = false; $("comm-go").hidden = !left;
        $("comm-text").textContent = summary + (left ? " " + left + " can still be tried." : "");
        syncEnrichEmpty();
        if (run.issues.length) toast(run.issues.length + (run.issues.length === 1 ? " molecule" : " molecules") + " failed or not on PubChem.", { actionLabel: "Review & fix", onAction: openEnrichModal });
      }
    });
  });
  $("comm-stop").addEventListener("click", function () { if (commRun) { commRun.stop = true; $("comm-stop").disabled = true; } });

  /* ---------- Load, Auth & Drawer ---------- */
  function load(opts) {
    opts = opts || {};
    var silent = !!(opts.silent && state.loaded);
    if (!silent) state.loaded = false;
    state.refreshing = true; state.loadErr = "";
    render();
    return Promise.all([api.adminList(), api.adminSuggestions().catch(function () { return []; })]).then(function (r) {
      state.docs = r[0] || []; state.sugg = r[1] || [];
      dupCache = {}; state.loaded = true; state.refreshing = false; state.lastSync = new Date();
      render(); backfill(); checkBatches(); drawCas(); drawComm(); drawEnrichIssues();
    }, function (err) {
      state.refreshing = false;
      if (err && err.status === 401) signedOut("Your session ended. Sign in again.");
      else {
        if (!silent) state.loadErr = "The entries could not be loaded. Use Refresh to try again.";
        else toast("Refresh failed. Check your connection.");
        render();
      }
    });
  }
  function signedOut(msg) {
    if (casRun) casRun.stop = casRun.out = true;
    if (commRun) commRun.stop = commRun.out = true;
    if (nameRun) nameRun.stop = true;
    enrichIssues = []; eiModalFilter = "all"; eiModalTool = ""; eiModalQuery = "";
    nameTried = {}; casMiss = {}; commMiss = {}; toolLogs = [];
    closeEnrichModal(); drawEnrichIssues(); drawToolLog();
    $("cas").hidden = true; $("comm").hidden = true; $("iupac").hidden = true; $("smi-sync").hidden = true; $("imp").hidden = true;
    $("tools-aside").classList.remove("open");
    $("toggle-tools").setAttribute("aria-expanded", "false");
    state.activeId = ""; state.triage = "";
    resetUpload(); resetPdfUpload(); Ent.editor.close(); Ent.closeDialog(); Ent.sketcher.close(); api.signOut(); show("login"); banner(msg || "");
  }

  function start() {
    if (!api.configured) { show(""); banner("The backend is not configured yet, so there is nothing to review. See the setup steps in the repository README."); return; }
    api.token().then(function (t) {
      if (!t) { show("login"); return; }
      api.isAdmin().then(function (ok) {
        if (ok === true) { show("panel"); banner(""); load(); }
        else signedOut("This address is not a curator of this database.");
      }, function (err) {
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
  $("reload").addEventListener("click", function () { load({ silent: true }); });
  $("toggle-tools").addEventListener("click", function () {
    var aside = $("tools-aside"), open = !aside.classList.contains("open");
    aside.classList.toggle("open", open);
    $("toggle-tools").setAttribute("aria-expanded", String(open));
  });
  ["pending", "approved", "rejected"].forEach(function (k) {
    $("tab-" + k).addEventListener("click", function () {
      state.view = k; state.triage = ""; state.activeId = ""; state.search.pager.shown = 0; clearSel(); render();
    });
  });

  /* ---------- Keyboard shortcuts (when no input/modal is active) ---------- */
  function showShortcuts() {
    Ent.dialog("Keyboard shortcuts", function (box) {
      var grid = el("div", "kb-grid");
      [
        ["J / K", "Move focus to next / previous card"],
        ["E", "Open structured editor on focused card"],
        ["S", "Open sketcher on focused card"],
        ["V", "Toggle Structure verified on focused card"],
        ["X", "Select / deselect focused card"],
        ["A", "Verify / approve focused card"],
        ["R", "Reject focused card"],
        ["?", "Show this shortcuts reference"],
        ["Esc", "Close active dialog or sketcher"]
      ].forEach(function (pair) {
        grid.appendChild(el("kbd", null, pair[0]));
        grid.appendChild(el("span", null, pair[1]));
      });
      box.appendChild(grid);
      var act = el("div", "actions"), ok = el("button", "btn primary", "Close");
      ok.type = "button"; ok.addEventListener("click", Ent.closeDialog);
      act.appendChild(ok); box.appendChild(act);
    });
  }
  $("kb-help-btn").addEventListener("click", showShortcuts);
  document.addEventListener("keydown", function (e) {
    if ($("panel").hidden || !state.loaded) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var ed = $("ed"), sk = $("sk"), ei = $("ei-modal"), pm = $("pdf-modal");
    if ((ed && !ed.hidden) || (sk && !sk.hidden) || (ei && !ei.hidden) || (pm && !pm.hidden)) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (document.activeElement && document.activeElement.isContentEditable)) return;

    var key = e.key;
    if (key === "?") { e.preventDefault(); showShortcuts(); return; }
    var cards = Array.prototype.filter.call($("list").children, function (c) { return c.hasAttribute && c.hasAttribute("data-id"); });
    if (!cards.length) return;
    var idx = -1;
    cards.forEach(function (c, i) { if (c.getAttribute("data-id") === state.activeId) idx = i; });
    if (key === "j" || key === "J") {
      e.preventDefault();
      var next = cards[Math.min(cards.length - 1, idx + 1)];
      setFocusCard(next.getAttribute("data-id"), true);
      return;
    }
    if (key === "k" || key === "K") {
      e.preventDefault();
      var prev = cards[idx <= 0 ? 0 : idx - 1];
      setFocusCard(prev.getAttribute("data-id"), true);
      return;
    }
    var cur = idx >= 0 ? cards[idx] : null;
    if (!cur) return;
    var lk = key.toLowerCase();
    if (lk === "x") { e.preventDefault(); var sb = cur.querySelector(".selpick input"); if (sb) sb.click(); }
    else if (lk === "v") { e.preventDefault(); var vb = $("chk-" + cur.getAttribute("data-id")); if (vb) vb.click(); }
    else if (lk === "s") { e.preventDefault(); Array.prototype.forEach.call(cur.querySelectorAll("button"), function (b) { if (b.textContent === "Open in sketcher") b.click(); }); }
    else if (lk === "e") { e.preventDefault(); Array.prototype.forEach.call(cur.querySelectorAll("button"), function (b) { if (b.textContent === "Edit entry") b.click(); }); }
    else if (lk === "a") {
      e.preventDefault();
      var ab = cur.querySelector('button[data-act="approve"]');
      if (ab) {
        if (ab.disabled) toast("You already verified this entry; a second curator must approve it.");
        else ab.click();
      }
    }
    else if (lk === "r") {
      e.preventDefault();
      var rb = cur.querySelector('button[data-act="reject"]');
      if (rb) rb.click();
    }
  });

  $("f-reset").addEventListener("click", function () { state.triage = ""; });
  Ent.bindSearch(state.search, function () { render(); });
  Ent.sketcher.bind();
  Ent.loadOCL(function () { dupCache = {}; if (state.loaded) { render(); drawSmiSync(); drawNames(); } backfill(); });
  start();
})();
