/* TrEnDB reactions: the reactions a molecule was employed in.
   - Ent.reactionScheme / Ent.reactionBlock draw one reaction (reactants → products, the
     photocatalyst above the arrow, the conditions below it).
   - Ent.reactionsEditor is the sketcher used in the submission form, in "Suggest a correction"
     and on the review page. It unlocks only once the paper's DOI is valid and known to doi.org.
   - Ent.reactionsSection is the collapsed "Reactions it was employed in" line on a card.
   Data shape (checked by EntScore.checkReaction, here and on the server):
   {doi, role: "donor"|"acceptor", as_product: true (acceptor made by the reaction, optional),
    reactants: [smiles], products: [smiles], catalyst: smiles|null,
    loading, wavelength (nm), temperature, solvent, description (≤ 50 words)}
   The entry's own molecule is never stored in a reaction: as a donor it is the photocatalyst,
   as an acceptor it is the first reactant, or the first product when as_product is set
   (e.g. the Z isomer formed in an E/Z isomerisation). */
(function () {
  "use strict";
  var el = Ent.el, elT = Ent.elT;

  /* ---------- drawing ---------- */
  var svgCache = {};
  function molBox(smiles, w, h, label) {
    var box = el("div", "rx-mol");
    var key = w + "x" + h + "|" + smiles, svg = svgCache[key];
    if (svg === undefined) {
      svg = null;
      var m = Ent.molOf ? Ent.molOf(smiles) : null;
      if (m) {
        try {
          var r = Ent.renderStructure ? Ent.renderStructure(m, { cssThemed: true, width: w, height: h }) : null;
          svg = r ? r.svg : m.toSVG(w, h, undefined, { suppressChiralText: true, suppressESR: true, suppressCIPParity: true, noStereoProblem: true });
        } catch (e) { svg = null; }
      }
      if (window.OCL) svgCache[key] = svg;   /* not cached before the chemistry library has loaded */
    }
    if (svg) box.innerHTML = svg;
    else box.appendChild(el("code", "rx-smi", smiles || "?"));
    if (label) box.appendChild(el("span", "rx-tag", label));
    return box;
  }
  function plus() { return el("span", "rx-plus", "+"); }
  function condText(rx) {
    var parts = [];
    if (rx.wavelength != null && rx.wavelength !== "") parts.push("λ = " + String(rx.wavelength).replace(/\s*nm\s*$/i, "") + " nm");
    if (rx.temperature) parts.push(rx.temperature);
    if (rx.solvent) parts.push(rx.solvent);
    return parts.join(", ");
  }
  /* rx: reaction, substrate: SMILES of the entry's molecule */
  Ent.reactionScheme = function (rx, substrate) {
    var s = el("div", "rx-scheme");
    var left = el("div", "rx-side"), right = el("div", "rx-side");
    var reactants = (rx.reactants || []).slice();
    var items = [];
    var asProduct = rx.role === "acceptor" && rx.as_product === true;
    if (rx.role === "acceptor" && !asProduct) items.push(molBox(substrate, 150, 105, "this molecule"));
    reactants.forEach(function (smi) { items.push(molBox(smi, 150, 105)); });
    if (!items.length) items.push(el("span", "rx-empty", "reactants"));
    items.forEach(function (it, i) { if (i) left.appendChild(plus()); left.appendChild(it); });
    var prods = (rx.products || []).map(function (smi) { return molBox(smi, 150, 105); });
    if (asProduct) prods.unshift(molBox(substrate, 150, 105, "this molecule"));
    if (!prods.length) prods.push(el("span", "rx-empty", "products"));
    prods.forEach(function (it, i) { if (i) right.appendChild(plus()); right.appendChild(it); });

    var arrow = el("div", "rx-arrow"), above = el("div", "rx-above"), below = el("div", "rx-below");
    var cat = rx.role === "donor" ? substrate : rx.catalyst;
    if (cat) above.appendChild(molBox(cat, 110, 80, rx.role === "donor" ? "this molecule" : ""));
    else above.appendChild(el("span", "rx-empty", "photocatalyst"));
    if (rx.loading) above.appendChild(el("span", "rx-cond", rx.loading));
    var line = el("div", "rx-line"); line.setAttribute("aria-hidden", "true");
    below.textContent = condText(rx);
    arrow.appendChild(above); arrow.appendChild(line); arrow.appendChild(below);
    s.appendChild(left); s.appendChild(arrow); s.appendChild(right);
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", "Reaction: " + (rx.role === "donor" ? "this molecule is the photocatalyst" : asProduct ? "this molecule is the product" : "this molecule is a reactant") + (condText(rx) ? ", " + condText(rx) : ""));
    return s;
  };
  /* scheme + description + source; extra: optional element appended (e.g. curator buttons) */
  Ent.reactionBlock = function (rx, substrate, extra, n) {
    var b = el("div", "rx-block");
    var head = el("div", "rx-head");
    head.appendChild(el("span", "chip " + (rx.role === "donor" ? "rx-donor" : "rx-acceptor"), rx.role === "donor" ? "Donor (photocatalyst)" : rx.as_product === true ? "Acceptor (product)" : "Acceptor (substrate)"));
    if (n) head.insertBefore(el("strong", null, "Reaction " + n), head.firstChild);
    if (rx.doi) head.appendChild(Ent.doiLink(rx.doi, "doi:" + EntScore.cleanDoi(rx.doi)));
    b.appendChild(head);
    var wrap = el("div", "rx-scroll"); wrap.appendChild(Ent.reactionScheme(rx, substrate)); b.appendChild(wrap);
    if (rx.description) b.appendChild(elT("p", "rx-desc", rx.description));
    if (extra) b.appendChild(extra);
    return b;
  };

  /* list: [{rx, substrate}] */
  Ent.reactionsDialog = function (title, list) {
    Ent.dialog(title, function (box) {
      box.classList.add("ed-box", "rx-dialog");
      var oldTitle = box.querySelector("h2");
      var head = el("div", "ed-head"), closeX = el("button", "btn small", "Close");
      closeX.type = "button"; closeX.addEventListener("click", Ent.closeDialog);
      head.appendChild(oldTitle); head.appendChild(closeX);
      var body = el("div", "ed-body");
      list.forEach(function (it, i) { body.appendChild(Ent.reactionBlock(it.rx, it.substrate, null, list.length > 1 ? i + 1 : 0)); });
      box.replaceChildren(head, body);
    });
  };
  /* The collapsed line at the bottom of a card: nothing is drawn until it is clicked. */
  Ent.reactionsSection = function (list, name) {
    if (!list.length) return null;
    var wrap = el("div", "rx-section");
    var b = el("button", "btn small rx-open", "Reactions it was employed in (" + list.length + ")");
    b.type = "button"; b.setAttribute("aria-haspopup", "dialog");
    b.addEventListener("click", function () { Ent.reactionsDialog("Reactions it was employed in · " + name, list); });
    wrap.appendChild(b);
    return wrap;
  };

  /* ---------- DOI check (format, then doi.org) ---------- */
  var doiSeen = {};
  /* -> Promise<true|false|null>; null when doi.org could not be asked */
  Ent.doiExists = function (doi) {
    var k = doi.toLowerCase();
    if (k in doiSeen) return Promise.resolve(doiSeen[k]);
    return fetch("https://doi.org/api/handles/" + encodeURIComponent(doi)).then(function (r) {
      if (r.status === 404) return (doiSeen[k] = false);
      if (!r.ok) return null;
      return r.json().then(function (b) { return (doiSeen[k] = !!(b && b.responseCode === 1)); });
    }).catch(function () { return null; });
  };

  /* ---------- editor ---------- */
  function slotChip(smiles, onEdit, onRemove, label) {
    var c = el("div", "rx-chip");
    var view = el("button", "rx-chip-view"); view.type = "button"; view.title = "Edit this structure";
    view.appendChild(molBox(smiles, 110, 78, label));
    view.addEventListener("click", onEdit);
    c.appendChild(view);
    var x = el("button", "rx-chip-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Remove this structure");
    x.addEventListener("click", onRemove);
    c.appendChild(x);
    return c;
  }
  function fixedChip(smiles, label) {
    var c = el("div", "rx-chip fixed"); c.appendChild(molBox(smiles, 110, 78, label)); return c;
  }

  /* ---------- picking a molecule from the database ----------
     The page sets Ent.reactionCatalog to a function returning the entries it shows
     (the public page: the database; the review page: approved entries). */
  Ent.reactionCatalog = Ent.reactionCatalog || function () { return []; };
  /* One record per molecule (CAS, else structure); also used by PlotEnT. docs: optional list, else the page's catalogue. */
  function catalogMolecules(list) {
    var docs = (list || Ent.reactionCatalog() || []).filter(function (d) { return d && d.smiles; });
    var groups = Ent.groupByMolecule ? Ent.groupByMolecule(docs) : docs.map(function (d) { return [d]; });
    return groups.map(function (items) {
      var d = items[0], roles = {};
      items.forEach(function (x) { roles[x.role || "acceptor"] = 1; });
      var name = items.map(function (x) { return (x.commercial_name || "").trim(); }).filter(Boolean)[0] || "";
      var iupac = items.map(function (x) { return (x.name || "").trim(); }).filter(Boolean)[0] || "";
      var vals = items.map(function (x) { return Number(x.et_kcal); }).filter(function (v) { return !isNaN(v); });
      function etOf(origin) {
        return items.filter(function (x) { return x.origin === origin && x.et_kcal != null && !isNaN(Number(x.et_kcal)); })
          .map(function (x) { return Number(x.et_kcal); });
      }
      var uv = items.map(function (x) { return Number(x.uv_lmax); }).filter(function (v) { return v > 0; })[0] || null;
      return {
        items: items, etExp: etOf("exp"), etCalc: etOf("calc"), cls: (items.map(function (x) { return x.cls; }).filter(Boolean)[0] || ""),
        uv: uv, both: !!roles.both,
        smiles: d.smiles, title: name || iupac || d.smiles, sub: name ? iupac : "",
        donor: !!(roles.donor || roles.both), acceptor: !!(roles.acceptor || roles.both),
        et: vals.length ? vals : null,
        hay: items.map(function (x) { return [x.commercial_name, x.name, x.cas, x.cls, x.smiles].join(" "); }).join(" ").toLowerCase()
      };
    });
  }
  function searchCatalog(q, prefer, list, limit) {
    var toks = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return [];
    return catalogMolecules(list).filter(function (m) {
      return toks.every(function (t) { return m.hay.indexOf(t) >= 0; });
    }).map(function (m) {
      var t = m.title.toLowerCase(), score = 0;
      if (t === toks.join(" ")) score += 100; else if (t.indexOf(toks[0]) === 0) score += 50;
      if (prefer && m[prefer]) score += 20;
      return { m: m, score: score - t.length / 100 };
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, limit || 8).map(function (x) { return x.m; });
  }
  Ent.catalogMolecules = catalogMolecules;
  Ent.searchCatalog = searchCatalog;
  Ent.molBox = molBox;
  /* A small search panel. prefer: "donor" | "acceptor" (listed first); onPick(smiles) */
  function dbPicker(what, prefer, onPick, onClose) {
    var box = el("div", "rx-picker");
    var lab = el("label", "field", "Search the database for the " + what), q = el("input");
    q.type = "search"; q.placeholder = "Name, CAS number, class or SMILES"; q.autocomplete = "off"; q.spellcheck = false;
    lab.appendChild(q); box.appendChild(lab);
    var res = el("div", "rx-results"); res.setAttribute("role", "listbox"); box.appendChild(res);
    var close = el("button", "btn tiny", "Close search"); close.type = "button"; close.addEventListener("click", onClose);
    var foot = el("div", "actions"); foot.appendChild(close); box.appendChild(foot);
    function run() {
      res.replaceChildren();
      var list = searchCatalog(q.value, prefer);
      if (!q.value.trim()) { res.appendChild(el("p", "hint", "Type a few letters: " + (prefer === "donor" ? "photocatalysts (donors)" : "acceptors") + " are listed first.")); return; }
      if (!list.length) { res.appendChild(el("p", "hint", "Nothing in the database matches. Draw it instead.")); return; }
      list.forEach(function (m) {
        var b = el("button", "rx-result"); b.type = "button"; b.setAttribute("role", "option");
        b.appendChild(molBox(m.smiles, 80, 56));
        var txt = el("span", "rx-result-txt");
        txt.appendChild(elT("strong", null, m.title));
        if (m.sub) txt.appendChild(elT("small", null, m.sub));
        var meta = [];
        if (m.donor && m.acceptor) meta.push("donor and acceptor"); else meta.push(m.donor ? "donor" : "acceptor");
        if (m.et) meta.push("E_T " + (m.et.length > 1 ? Math.min.apply(null, m.et).toFixed(1) + "–" + Math.max.apply(null, m.et).toFixed(1) : m.et[0].toFixed(1)) + " kcal/mol");
        txt.appendChild(el("small", "rx-meta", meta.join(" · ")));
        b.appendChild(txt);
        b.addEventListener("click", function () { onPick(m.smiles); });
        res.appendChild(b);
      });
    }
    q.addEventListener("input", run);
    q.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); var first = res.querySelector(".rx-result"); if (first) first.click(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    });
    run();
    setTimeout(function () { q.focus(); }, 0);
    return box;
  }

  /* One reaction card. opts: {substrate(): smiles, name(): string, defaultDoi(): string, onChange(), onRemove(), number} */
  function reactionCard(init, opts) {
    var rx = {
      doi: (init && init.doi) || "", role: (init && init.role) || "acceptor", as_product: !!(init && init.as_product === true),
      reactants: ((init && init.reactants) || []).slice(), products: ((init && init.products) || []).slice(),
      catalyst: (init && init.catalyst) || "", loading: (init && init.loading) || "",
      wavelength: init && init.wavelength != null ? String(init.wavelength) : "", temperature: (init && init.temperature) || "",
      solvent: (init && init.solvent) || "", description: (init && init.description) || ""
    };
    var doiState = { ok: false, value: "" };
    var card = el("div", "rx-card");
    var top = el("div", "rx-card-top"), title = el("strong", null, "Reaction");
    var rm = el("button", "btn tiny", "Remove reaction"); rm.type = "button";
    rm.addEventListener("click", function () { if (opts.onRemove) opts.onRemove(api); });
    top.appendChild(title); if (opts.onRemove) top.appendChild(rm); card.appendChild(top);

    var doiLab = el("label", "field", "DOI of the paper with this reaction (required first)"), doiIn = el("input");
    doiIn.type = "text"; doiIn.className = "mono"; doiIn.placeholder = "10.xxxx/…"; doiIn.spellcheck = false; doiIn.autocomplete = "off";
    doiIn.value = rx.doi || (opts.defaultDoi ? opts.defaultDoi() : "");
    var doiMsg = el("small", "rx-doi-msg"); doiMsg.setAttribute("aria-live", "polite");
    doiLab.appendChild(doiIn); doiLab.appendChild(doiMsg); card.appendChild(doiLab);

    var lock = el("p", "rx-lock", "Enter the DOI of the paper first: the sketcher unlocks once the DOI is valid.");
    card.appendChild(lock);
    var panel = el("div", "rx-panel"); card.appendChild(panel);

    /* role switch */
    var roleBox = el("div", "rx-role"); roleBox.setAttribute("role", "radiogroup");
    var roleTitle = el("span", "rx-role-title"); roleBox.appendChild(roleTitle);
    var roleInputs = {}, roleName = "rx-role-" + Math.random().toString(36).slice(2);
    [["donor", "Donor: the photocatalyst above the arrow"], ["acceptor", "Acceptor: receives the energy (a reactant, or the product if ticked below)"]].forEach(function (o) {
      var l = el("label", "rx-role-opt"), r = el("input");
      r.type = "radio"; r.name = roleName; r.value = o[0]; r.checked = rx.role === o[0];
      r.addEventListener("change", function () { if (r.checked) { rx.role = o[0]; draw(); changed(); } });
      roleInputs[o[0]] = r;
      l.appendChild(r); l.appendChild(document.createTextNode(" " + o[1])); roleBox.appendChild(l);
    });
    /* acceptor only: the molecule may be what the reaction makes instead of what it starts from */
    var prodLab = el("label", "rx-role-opt rx-as-product"), prodBox = el("input");
    prodBox.type = "checkbox"; prodBox.checked = rx.as_product;
    prodBox.addEventListener("change", function () { rx.as_product = prodBox.checked; draw(); changed(); });
    prodLab.appendChild(prodBox);
    prodLab.appendChild(document.createTextNode(" The molecule is the product of this reaction (e.g. the isomer formed in an E/Z isomerisation)"));
    roleBox.appendChild(prodLab);
    panel.appendChild(roleBox);

    var slots = el("div", "rx-slots"); panel.appendChild(slots);
    var cond = el("div", "frow rx-conds"), condIn = {};
    [["loading", "Catalyst loading", "e.g. 5 mol%", 40], ["wavelength", "Wavelength (nm)", "e.g. 450", 8], ["temperature", "Temperature", "e.g. 25 °C or rt", 40], ["solvent", "Solvent", "e.g. MeCN", 80]].forEach(function (f) {
      var l = el("label", "field", f[1]), i = el("input"); i.type = "text"; i.placeholder = f[2]; i.maxLength = f[3]; i.value = rx[f[0]];
      if (f[0] === "wavelength") i.inputMode = "numeric";
      i.addEventListener("input", function () { rx[f[0]] = i.value; drawPreview(); changed(); });
      condIn[f[0]] = i; l.appendChild(i); cond.appendChild(l);
    });
    panel.appendChild(cond);
    var prevWrap = el("div", "rx-preview"); prevWrap.appendChild(el("span", "hint", "Preview")); var prev = el("div", "rx-scroll"); prevWrap.appendChild(prev);
    panel.appendChild(prevWrap);
    var dLab = el("label", "field", "Short description (optional, at most " + EntScore.RX_WORDS + " words)"), dIn = el("textarea");
    dIn.rows = 2; dIn.maxLength = 400; dIn.value = rx.description; dIn.placeholder = "e.g. E→Z isomerisation of the styrene; 92% yield, 95:5 Z/E.";
    var dCount = el("small", "rx-count");
    dIn.addEventListener("input", function () { rx.description = dIn.value; countWords(); changed(); });
    dLab.appendChild(dIn); dLab.appendChild(dCount); panel.appendChild(dLab);

    function countWords() {
      var n = EntScore.wordCount(dIn.value);
      dCount.textContent = n + " / " + EntScore.RX_WORDS + " words";
      dCount.classList.toggle("over", n > EntScore.RX_WORDS);
    }
    function changed() { if (opts.onChange) opts.onChange(); }
    function sketch(title, smiles, onSave) {
      Ent.sketcher.open({ title: title, smiles: smiles || "", saveLabel: "Use in the reaction", hint: "Draw the structure or paste its SMILES.", onSave: function (s) { onSave(s); draw(); changed(); return true; } });
    }
    var openPanel = "";   /* which helper panel is open: "db-reactant", "db-catalyst" or "copy" */
    function togglePanel(name) { openPanel = openPanel === name ? "" : name; draw(); }
    function picked(fn) { return function (s) { fn(s); openPanel = ""; draw(); changed(); }; }
    function dbButton(what, name) {
      var b = el("button", "btn small rx-add", "Search database"); b.type = "button";
      b.title = "Pick the " + what + " from the molecules already in the database";
      b.setAttribute("aria-expanded", String(openPanel === name));
      b.addEventListener("click", function () { togglePanel(name); });
      return b;
    }
    /* Products: start from a copy of chosen reactants, so atoms already present need not be redrawn. */
    function copyPanel(onCopy) {
      var box = el("div", "rx-picker rx-copy");
      box.appendChild(el("p", "hint", "Choose the reactants whose atoms end up in the product. They open together in the sketcher: join or edit them into the product."));
      var sources = [];
      if (rx.role === "acceptor" && !rx.as_product) sources.push({ smiles: opts.substrate(), label: "this molecule" });
      rx.reactants.forEach(function (smi, i) { sources.push({ smiles: smi, label: "reactant " + (i + 1) }); });
      sources = sources.filter(function (x) { return x.smiles; });
      var chosen = {};
      var row = el("div", "rx-chips");
      if (!sources.length) row.appendChild(el("span", "hint", "Draw or pick the reactants first."));
      var go = el("button", "btn small primary", "Copy into the sketcher"); go.type = "button"; go.disabled = true;
      sources.forEach(function (src, i) {
        var b = el("button", "rx-chip rx-pickable"); b.type = "button"; b.setAttribute("aria-pressed", "false");
        b.appendChild(molBox(src.smiles, 110, 78, src.label));
        b.addEventListener("click", function () {
          chosen[i] = !chosen[i]; b.setAttribute("aria-pressed", String(!!chosen[i])); b.classList.toggle("on", !!chosen[i]);
          go.disabled = !Object.keys(chosen).some(function (k) { return chosen[k]; });
        });
        row.appendChild(b);
      });
      box.appendChild(row);
      var close = el("button", "btn tiny", "Cancel"); close.type = "button"; close.addEventListener("click", function () { togglePanel("copy"); });
      go.addEventListener("click", function () {
        var smi = sources.filter(function (x, i) { return chosen[i]; }).map(function (x) { return x.smiles; }).join(".");
        onCopy(smi);
      });
      var act = el("div", "actions"); act.appendChild(go); act.appendChild(close); box.appendChild(act);
      return box;
    }
    function slot(label, list, max, what) {
      var box = el("div", "rx-slot"); box.appendChild(el("span", "rx-slot-title", label));
      var row = el("div", "rx-chips");
      if (what === "reactant" && rx.role === "acceptor" && !rx.as_product) row.appendChild(fixedChip(opts.substrate(), "this molecule"));
      if (what === "product" && rx.role === "acceptor" && rx.as_product) row.appendChild(fixedChip(opts.substrate(), "this molecule"));
      list.forEach(function (smi, i) {
        row.appendChild(slotChip(smi,
          function () { sketch("Sketcher · " + what, smi, function (s) { list[i] = s; }); },
          function () { list.splice(i, 1); draw(); changed(); }));
      });
      if (list.length < max) {
        var add = el("button", "btn small rx-add", "+ Draw " + what); add.type = "button";
        add.addEventListener("click", function () { sketch("Sketcher · new " + what, "", function (s) { list.push(s); }); });
        row.appendChild(add);
        if (what === "reactant") row.appendChild(dbButton("reactant", "db-reactant"));
        if (what === "product") {
          var cp = el("button", "btn small rx-add", "Copy from reactants"); cp.type = "button";
          cp.title = "Start the product from a copy of one or more reactants";
          cp.setAttribute("aria-expanded", String(openPanel === "copy"));
          cp.addEventListener("click", function () { togglePanel("copy"); });
          row.appendChild(cp);
        }
      }
      box.appendChild(row);
      if (list.length < max && what === "reactant" && openPanel === "db-reactant")
        box.appendChild(dbPicker("reactant", "acceptor", picked(function (s) { list.push(s); }), function () { togglePanel("db-reactant"); }));
      if (list.length < max && what === "product" && openPanel === "copy")
        box.appendChild(copyPanel(function (smi) {
          openPanel = "";
          sketch("Sketcher · new product (from reactants)", smi, function (s) { list.push(s); });
          draw();
        }));
      return box;
    }
    function catSlot() {
      var box = el("div", "rx-slot rx-cat"); box.appendChild(el("span", "rx-slot-title", "Photocatalyst (above the arrow)"));
      var row = el("div", "rx-chips");
      if (rx.role === "donor") row.appendChild(fixedChip(opts.substrate(), "this molecule"));
      else if (rx.catalyst) row.appendChild(slotChip(rx.catalyst,
        function () { sketch("Sketcher · photocatalyst", rx.catalyst, function (s) { rx.catalyst = s; }); },
        function () { rx.catalyst = ""; draw(); changed(); }));
      else {
        var add = el("button", "btn small rx-add", "+ Draw photocatalyst"); add.type = "button";
        add.addEventListener("click", function () { sketch("Sketcher · photocatalyst", "", function (s) { rx.catalyst = s; }); });
        row.appendChild(add);
        row.appendChild(dbButton("photocatalyst", "db-catalyst"));
      }
      box.appendChild(row);
      if (rx.role === "acceptor" && !rx.catalyst && openPanel === "db-catalyst")
        box.appendChild(dbPicker("photocatalyst", "donor", picked(function (s) { rx.catalyst = s; }), function () { togglePanel("db-catalyst"); }));
      return box;
    }
    function drawPreview() { prev.replaceChildren(Ent.reactionScheme(value(), opts.substrate())); }
    function draw() {
      roleTitle.textContent = "Role of " + (opts.name ? opts.name() : "this molecule") + " in this reaction:";
      prodLab.hidden = rx.role !== "acceptor";
      slots.replaceChildren(
        slot("Reactants", rx.reactants, EntScore.MAX_RX_MOLS, "reactant"),
        catSlot(),
        slot("Products", rx.products, EntScore.MAX_RX_MOLS, "product"));
      drawPreview();
    }
    function setLocked(locked) {
      panel.hidden = locked; lock.hidden = !locked;
      card.classList.toggle("locked", locked);
    }
    var doiTimer = null;
    function checkDoi() {
      var raw = doiIn.value.trim(), doi = EntScore.cleanDoi(raw);
      doiState.value = doi; clearTimeout(doiTimer);
      doiMsg.className = "rx-doi-msg";
      if (!raw) { doiState.ok = false; doiMsg.textContent = ""; setLocked(true); return; }
      if (!EntScore.isDoi(doi)) {
        doiState.ok = false; setLocked(true);
        doiMsg.textContent = "This is not a DOI. Give it like 10.1021/jacs.0c05069, not as a link."; doiMsg.classList.add("bad"); return;
      }
      doiMsg.textContent = "Checking the DOI…";
      doiTimer = setTimeout(function () {
        Ent.doiExists(doi).then(function (found) {
          if (EntScore.cleanDoi(doiIn.value.trim()) !== doi) return;
          if (found === false) {
            doiState.ok = false; setLocked(true);
            doiMsg.textContent = "doi.org does not know this DOI. Check it for typos."; doiMsg.classList.add("bad"); return;
          }
          doiState.ok = true; setLocked(false);
          doiMsg.textContent = found ? "✓ DOI found" : "The DOI could not be checked now; the server will check it when you send.";
          doiMsg.classList.add(found ? "good" : "warn");
        });
      }, 400);
    }
    doiIn.addEventListener("input", function () { rx.doi = doiIn.value; checkDoi(); changed(); });

    function value() {
      var out = { doi: EntScore.cleanDoi(doiIn.value.trim()), role: rx.role, reactants: rx.reactants.slice(), products: rx.products.slice(),
        catalyst: rx.role === "acceptor" ? (rx.catalyst || null) : null, loading: rx.loading.trim(), wavelength: rx.wavelength.trim(),
        temperature: rx.temperature.trim(), solvent: rx.solvent.trim(), description: rx.description.trim() };
      if (rx.role === "acceptor" && rx.as_product) out.as_product = true;
      return out;
    }
    var api = {
      el: card, value: value,
      doiOk: function () { return doiState.ok; },
      empty: function () {
        var v = value();
        return !v.reactants.length && !v.products.length && !v.catalyst && !v.loading && !v.wavelength && !v.temperature && !v.solvent && !v.description;
      },
      setNumber: function (n) { title.textContent = "Reaction " + n; },
      refresh: draw
    };
    countWords(); draw(); checkDoi();
    return api;
  }

  /* opts: {substrate(), name(), defaultDoi(), defaultRole(), initial: [reactions], max, onChange(), addLabel} */
  Ent.reactionsEditor = function (opts) {
    var wrap = el("div", "rx-editor"), list = el("div", "rx-list"), cards = [];
    var foot = el("div", "actions rx-foot"), add = el("button", "btn small", opts.addLabel || "+ Add a reaction"), info = el("span", "hint");
    add.type = "button"; foot.appendChild(add); foot.appendChild(info);
    wrap.appendChild(list); wrap.appendChild(foot);
    var max = opts.max == null ? EntScore.MAX_REACTIONS : Math.max(0, opts.max);
    function changed() { if (opts.onChange) opts.onChange(); }
    function sync() {
      cards.forEach(function (c, i) { c.setNumber(i + 1); });
      add.disabled = cards.length >= max;
      info.textContent = max <= 0 ? "This entry already has " + EntScore.MAX_REACTIONS + " reactions, the maximum."
        : cards.length >= max ? "Limit reached: at most " + EntScore.MAX_REACTIONS + " reactions per entry."
        : (cards.length ? cards.length + " of " + max + (max === EntScore.MAX_REACTIONS ? "" : " still available") + " (at most " + EntScore.MAX_REACTIONS + " per entry)" : "Up to " + max + (max === 1 ? " reaction" : " reactions") + " (" + EntScore.MAX_REACTIONS + " per entry).");
    }
    function addCard(init) {
      if (cards.length >= max) return;
      var role = init && init.role ? init.role : (opts.defaultRole && opts.defaultRole() === "donor" ? "donor" : "acceptor");
      var c = reactionCard(Object.assign({}, init || {}, { role: role }), {
        substrate: opts.substrate, name: opts.name, defaultDoi: opts.defaultDoi, onChange: changed,
        onRemove: function (me) { cards = cards.filter(function (x) { return x !== me; }); me.el.remove(); sync(); changed(); }
      });
      cards.push(c); list.appendChild(c.el); sync();
      return c;
    }
    add.addEventListener("click", function () { var c = addCard(null); if (c) { changed(); var i = c.el.querySelector("input"); if (i) i.focus(); } });
    (opts.initial || []).forEach(function (r) { addCard(r); });
    sync();
    return {
      el: wrap,
      count: function () { return cards.length; },
      /* the non-empty reactions; DOI-less but filled cards are returned too, so the check reports them */
      value: function () { return cards.filter(function (c) { return !c.empty() || c.value().doi; }).map(function (c) { return c.value(); }); },
      /* -> message when a card's DOI is not accepted yet, else "" */
      pending: function () {
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].empty() && !cards[i].value().doi) continue;
          if (!cards[i].doiOk()) return "Reaction " + (i + 1) + ": enter a valid DOI of the paper first (it must be known to doi.org).";
        }
        return "";
      },
      reset: function () { cards.forEach(function (c) { c.el.remove(); }); cards = []; sync(); },
      refresh: function () { cards.forEach(function (c) { c.refresh(); }); }
    };
  };

  /* One reaction in a dialog, for curators. onSave(cleanReaction) -> Promise<bool>|bool */
  Ent.editReactionDialog = function (rx, substrate, name, onSave) {
    Ent.dialog("Edit reaction · " + name, function (box) {
      box.classList.add("ed-box");
      var oldTitle = box.querySelector("h2");
      var head = el("div", "ed-head"), closeX = el("button", "btn small", "Close");
      closeX.type = "button"; closeX.addEventListener("click", Ent.closeDialog);
      head.appendChild(oldTitle); head.appendChild(closeX);
      var body = el("div", "ed-body");
      var ed = Ent.reactionsEditor({ substrate: function () { return substrate; }, name: function () { return name; }, initial: [rx], max: 1 });
      ed.el.querySelector(".rx-foot").hidden = true;
      var rmb = ed.el.querySelector(".rx-card-top .btn"); if (rmb) rmb.hidden = true;
      body.appendChild(ed.el);
      var foot = el("div", "ed-foot"), err = el("p", "err"); err.hidden = true; err.setAttribute("role", "alert");
      var act = el("div", "actions"), save = el("button", "btn primary", "Save reaction"), cancel = el("button", "btn", "Cancel");
      save.type = cancel.type = "button"; act.appendChild(save); act.appendChild(cancel); foot.appendChild(err); foot.appendChild(act);
      box.replaceChildren(head, body, foot);
      cancel.addEventListener("click", Ent.closeDialog);
      save.addEventListener("click", function () {
        var p = ed.pending(); if (p) { err.textContent = p; err.hidden = false; return; }
        var c = EntScore.checkReaction(ed.value()[0] || {}, 0);
        if (c.error) { err.textContent = c.error; err.hidden = false; return; }
        if (Ent.structureOk) {
          var bad = c.clean.reactants.concat(c.clean.products, c.clean.catalyst ? [c.clean.catalyst] : []).filter(function (s) { return Ent.structureOk(s) === false; })[0];
          if (bad) { err.textContent = "A structure could not be read: " + bad; err.hidden = false; return; }
        }
        save.disabled = true; err.hidden = true;
        Promise.resolve(onSave(c.clean)).then(function (ok) {
          save.disabled = false;
          if (ok) Ent.closeDialog(); else { err.textContent = "Could not save. Try again."; err.hidden = false; }
        });
      });
    });
  };

  /* Curator list: each reaction with Edit and Delete. h: {substrate, name, list, save(newList) -> Promise<bool>, busy} */
  Ent.reactionsAdminList = function (h) {
    if (!h.list || !h.list.length) return null;
    var wrap = el("details", "rx-admin");
    var sum = el("summary", null, "Reactions it was employed in (" + h.list.length + ")" + (h.label ? " · " + h.label : ""));
    wrap.appendChild(sum);
    if (h.open) wrap.open = true;
    h.list.forEach(function (rx, i) {
      var act = el("div", "actions");
      var eb = el("button", "btn tiny", "Edit"), db = el("button", "btn tiny danger", "Delete");
      eb.type = db.type = "button"; eb.disabled = db.disabled = !!h.busy;
      eb.addEventListener("click", function () {
        Ent.editReactionDialog(rx, h.substrate, h.name, function (clean) {
          var next = h.list.slice(); next[i] = clean; return h.save(next);
        });
      });
      var armed = false;
      db.addEventListener("click", function () {
        if (!armed) { armed = true; db.textContent = "Click again to delete"; setTimeout(function () { armed = false; db.textContent = "Delete"; }, 4000); return; }
        db.disabled = true;
        var next = h.list.slice(); next.splice(i, 1); Promise.resolve(h.save(next)).then(function (ok) { if (!ok) db.disabled = false; });
      });
      act.appendChild(eb); act.appendChild(db);
      wrap.appendChild(Ent.reactionBlock(rx, h.substrate, act, h.list.length > 1 ? i + 1 : 0));
    });
    return wrap;
  };
})();
