/* PhotoTool: tools for photoredox catalysis built on the redox potentials of PhotoreDBox.
   Tools: map (redox map of the photocatalysts), advisor (reactivity advisor), estar (excited-state
   potentials, E0,0, quenching ΔG), units (photon energy, ΔG from ΔE, photon flux).
   Adapted from RedoxDB (alebusso12), used with permission. Potentials are handled against SCE
   and shown against the reference chosen in the database filters (Ent.redoxRef). A tool's
   settings live in the address (#tools/<tool>/<data>), as in PlotEnT. */
(function (root) {
  "use strict";
  var KCAL = 23.0605;          /* kcal mol⁻¹ per eV (as score.js) */
  var HC = 1239.84;            /* eV nm */
  var GOOD = -0.05, BORDER = 0.15, SOFT_TOL = 0.5;   /* eV: feasible / borderline / tolerance for estimated steps */

  /* ================= pure maths (also loaded by tools/test-redox.mjs) ================= */

  /* Thermodynamics of one full photoredox cycle, V vs SCE throughout.
     pc: {e_ox, e_red, e_star_ox, e_star_red}; D: {name, E_ox, soft}; A: {name, E_red, soft}; key: "donor" | "acceptor"
     Reductive quenching:  PC* + D → PC•− + D•+  (ΔG1 = E_ox(D) − E*red) ; PC•− + A → PC + A•− (ΔG2 = E_red(PC) − E_red(A))
     Oxidative quenching:  PC* + A → PC•+ + A•−  (ΔG1 = E*ox − E_red(A)) ; PC•+ + D → PC + D•+ (ΔG2 = E_ox(D) − E_ox(PC)) */
  function cycles(pc, D, A, key) {
    var out = [];
    var dE = D && D.E_ox != null ? D.E_ox : null, aE = A && A.E_red != null ? A.E_red : null;
    function step(g, soft, label) { return { g: g, soft: !!soft, label: label }; }
    if (pc.e_star_red != null) {
      out.push({ mode: "reductive", steps: [
        step(dE != null ? dE - pc.e_star_red : null, D && D.soft, "PC* oxidises " + (D ? D.name : "donor")),
        step(aE != null && pc.e_red != null ? pc.e_red - aE : null, A && A.soft, "PC•− reduces " + (A ? A.name : "acceptor"))
      ] });
    }
    if (pc.e_star_ox != null) {
      out.push({ mode: "oxidative", steps: [
        step(aE != null ? pc.e_star_ox - aE : null, A && A.soft, "PC* reduces " + (A ? A.name : "acceptor")),
        step(dE != null && pc.e_ox != null ? dE - pc.e_ox : null, D && D.soft, "PC•+ oxidises " + (D ? D.name : "donor"))
      ] });
    }
    out.forEach(function (c) {
      var hard = c.steps.filter(function (s) { return s.g != null && !s.soft; }).map(function (s) { return s.g; });
      var soft = c.steps.filter(function (s) { return s.g != null && s.soft; }).map(function (s) { return s.g; });
      var known = c.steps.filter(function (s) { return s.g != null; }).length;
      c.worst = hard.length ? Math.max.apply(null, hard) : null;
      c.softWorst = soft.length ? Math.max.apply(null, soft) : null;
      c.complete = known === 2;
      /* the photochemical step (index 0) and the step on the key substrate must both be known */
      var keyIdx = key === "donor" ? (c.mode === "reductive" ? 0 : 1) : key === "acceptor" ? (c.mode === "reductive" ? 1 : 0) : 0;
      c.ok = c.steps[0].g != null && c.steps[keyIdx].g != null;
      var v = c.worst == null ? (c.softWorst != null && c.softWorst <= SOFT_TOL ? "border" : "unknown")
        : c.worst <= GOOD ? "good" : c.worst <= BORDER ? "border" : "bad";
      if (v !== "bad" && c.softWorst != null && c.softWorst > SOFT_TOL) v = "border";
      /* a photochemical step on an estimated intermediate cannot make a cycle feasible on its own */
      if (v === "good" && c.steps[0].soft) v = "border";
      if (!c.ok) v = "unknown";
      c.verdict = v;
      c.score = c.worst != null ? c.worst : (c.softWorst != null ? c.softWorst - 0.3 : 9);
    });
    return out.sort(function (a, b) { return a.score - b.score; });
  }
  var RANK = { good: 0, border: 1, bad: 2, unknown: 3 };
  /* better verdict, then a complete cycle, then a photochemical step on a real substrate, then the
     mechanism reported in the literature, then the larger driving force */
  function bestCycle(pc, D, A, reported, key) {
    var cs = cycles(pc, D, A, key).filter(function (c) { return c.ok; });
    cs.sort(function (a, b) {
      return RANK[a.verdict] - RANK[b.verdict] || ((b.complete ? 1 : 0) - (a.complete ? 1 : 0)) ||
        ((a.steps[0].soft ? 1 : 0) - (b.steps[0].soft ? 1 : 0)) ||
        ((a.mode === reported ? 0 : 1) - (b.mode === reported ? 0 : 1)) || a.score - b.score;
    });
    return cs[0] || null;
  }
  /* E*ox = E(PC•+ | PC*) = Eox − E0,0 ; E*red = E(PC* | PC•−) = Ered + E0,0 (entropy and work terms neglected) */
  function excited(eox, ered, e00) {
    var ok = function (x) { return x != null && isFinite(x); };
    return { eso: ok(eox) && ok(e00) ? eox - e00 : null, esr: ok(ered) && ok(e00) ? ered + e00 : null };
  }
  /* E0,0 (eV) from what is known: eV, kcal/mol, or a wavelength (crossing, 77 K maximum, onset, emission maximum) */
  function e00From(mode, v) {
    if (v == null || !isFinite(v) || v <= 0) return null;
    if (mode === "ev") return v;
    if (mode === "kcal") return v / KCAL;
    return HC / v;
  }
  /* Coulomb work term for two neutral partners forming an ion pair: w = −e²/(4πε₀ ε r) = −14.40/(ε r[Å]) eV */
  function coulomb(eps, r) { return eps > 0 && r > 0 ? -14.40 / (eps * r) : 0; }
  /* ΔG of photoinduced electron transfer (eV): reductive: Eox(Q) − E*red + w ; oxidative: E*ox − Ered(Q) + w */
  function quench(qox, qred, eso, esr, w) {
    w = w || 0;
    return { reductive: qox != null && esr != null ? qox - esr + w : null, oxidative: qred != null && eso != null ? eso - qred + w : null };
  }
  /* normalised absorption and emission spectra {x: nm[], y: []} -> {e00, lambda} at their crossing between the two maxima */
  function normalise(s) {
    var pts = s.x.map(function (x, i) { return [x, s.y[i]]; }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); })
      .sort(function (a, b) { return a[0] - b[0]; });
    var vis = pts.filter(function (p) { return p[0] > 300; });
    var use = vis.length > 5 ? vis : pts;
    var mx = Math.max.apply(null, use.map(function (p) { return p[1]; }));
    return pts.map(function (p) { return [p[0], p[1] / mx]; });
  }
  function crossing(abs, em) {
    if (!abs || !em) return { e00: null, msg: "Upload both spectra." };
    var a = normalise(abs), e = normalise(em);
    var absMax = a.filter(function (p) { return p[0] > 300; }).reduce(function (b, p) { return p[1] >= 0.98 ? p : b; }, a[0]);
    var emMax = e.reduce(function (b, p) { return p[1] > b[1] ? p : b; }, e[0]);
    if (emMax[0] <= absMax[0]) return { e00: null, msg: "The emission maximum must lie at a longer wavelength than the absorption maximum." };
    function interp(arr, x) {
      for (var i = 1; i < arr.length; i++) if (arr[i][0] >= x) {
        var x0 = arr[i - 1][0], y0 = arr[i - 1][1], x1 = arr[i][0], y1 = arr[i][1];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1);
      }
      return NaN;
    }
    var prev = null, found = null;
    for (var x = absMax[0]; x <= emMax[0]; x += 0.25) {
      var d = interp(a, x) - interp(e, x);
      if (prev != null && isFinite(d) && (d > 0) !== (prev > 0)) { found = x; break; }
      prev = d;
    }
    if (found == null) return { e00: null, msg: "The normalised spectra do not cross between the two maxima." };
    return { e00: HC / found, lambda: found, a: a, e: e };
  }
  /* Numeric table from an instrument export (CSV, TSV, semicolons, spaces; decimal commas; header
     lines skipped) -> {headers, cols}, using the longest block of numeric rows. */
  function parseNumericTable(text) {
    var lines = String(text || "").replace(/\r/g, "").split("\n");
    var sample = lines.slice(0, 200).join("\n");
    var nTab = (sample.match(/\t/g) || []).length, nSemi = (sample.match(/;/g) || []).length, nComma = (sample.match(/,/g) || []).length;
    var delim = nTab ? "\t" : nSemi ? ";" : null;
    if (!delim && nComma) {
      var decComma = lines.slice(0, 50).some(function (l) { return /^\s*-?\d+,\d+\s+-?\d+,\d+/.test(l); });
      delim = decComma ? null : ",";
    }
    function split(l) { return (delim ? l.split(delim) : l.trim().split(/\s+/)).map(function (s) { return s.trim(); }); }
    function toNum(s) {
      if (s === "") return NaN;
      var t = s.replace(/^"|"$/g, "");
      if (delim !== "," && /^-?\d*,\d+(e[-+]?\d+)?$/i.test(t)) t = t.replace(",", ".");
      return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? parseFloat(t) : NaN;
    }
    var best = { start: 0, len: 0, ncol: 0, header: null }, cur = null, lastHeader = null;
    lines.forEach(function (l, i) {
      if (!l.trim()) { cur = null; return; }
      var parts = split(l), nNum = parts.map(toNum).filter(function (v) { return !isNaN(v); }).length;
      if (nNum >= 2 && nNum >= parts.length - 1) {
        if (!cur || cur.ncol !== parts.length) cur = { start: i, len: 0, ncol: parts.length, header: lastHeader };
        cur.len++;
        if (cur.len > best.len) best = { start: cur.start, len: cur.len, ncol: cur.ncol, header: cur.header };
      } else { cur = null; lastHeader = parts; }
    });
    var cols = [], j;
    for (j = 0; j < best.ncol; j++) cols.push([]);
    for (var i = best.start; i < best.start + best.len; i++) split(lines[i]).forEach(function (s, k) { if (k < best.ncol) cols[k].push(toNum(s)); });
    var headers = [];
    for (j = 0; j < best.ncol; j++) headers.push((best.header && best.header[j]) || "column " + (j + 1));
    return { headers: headers, cols: cols };
  }
  /* photon energy conversions (eV <-> others) */
  var H = 6.62607015e-34, C = 2.99792458e8, NA = 6.02214076e23, QE = 1.602176634e-19;
  var KJ = 96.4853, CM = 8065.544;   /* kJ mol⁻¹ per eV ; cm⁻¹ per eV */
  function photonFlux(mW, nm) { return (mW / 1000) * (nm * 1e-9) / (H * C) / NA; }   /* einstein s⁻¹ */

  var maths = { GOOD: GOOD, BORDER: BORDER, SOFT_TOL: SOFT_TOL, KCAL: KCAL, HC: HC, cycles: cycles, bestCycle: bestCycle, excited: excited,
    e00From: e00From, coulomb: coulomb, quench: quench, crossing: crossing, parseNumericTable: parseNumericTable, photonFlux: photonFlux };
  root.EntRedoxMath = maths;
  if (!root.document || !root.Ent) return;   /* loaded by a test: maths only */

  /* ================= the section ================= */
  var Ent = root.Ent, el = Ent.el, elT = Ent.elT, RS = root.EntScore.redox;
  function K() { return root.PlotEnT.kit; }
  function ref() { return Ent.redoxRef(); }
  function toRef(vSce) { return vSce == null ? null : RS.fromSce(vSce, ref().ref, ref().solvent); }
  function fromRef(v) { return v == null || !isFinite(v) ? null : RS.toSce(v, ref().ref, ref().solvent); }
  function numIn(s) { var v = K().num(s); return isFinite(v) ? v : null; }
  function fmtV(v) { return v == null || !isFinite(v) ? "—" : Ent.fmtV(v); }
  function fmtG(v) { return v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + " eV"; }
  function vs() { return "V vs " + ref().id; }

  var REFS = {
    rehm: { a: "D. Rehm, A. Weller", t: "Kinetics of fluorescence quenching by electron and H-atom transfer", j: "Isr. J. Chem. 1970, 8, 259–271", doi: "10.1002/ijch.197000029", why: "ΔG of photoinduced electron transfer and the Coulomb term." },
    romero: { a: "N. A. Romero, D. A. Nicewicz", t: "Organic photoredox catalysis", j: "Chem. Rev. 2016, 116, 10075–10166", doi: "10.1021/acs.chemrev.6b00057", why: "Excited-state potentials from ground-state potentials and E0,0; organic photocatalysts." },
    prier: { a: "C. K. Prier, D. A. Rankic, D. W. C. MacMillan", t: "Visible light photoredox catalysis with transition metal complexes", j: "Chem. Rev. 2013, 113, 5322–5363", doi: "10.1021/cr300503r", why: "Ground- and excited-state potentials of metal photocatalysts; quenching cycles." },
    roth: { a: "H. G. Roth, N. A. Romero, D. A. Nicewicz", t: "Experimental and calculated electrochemical potentials of common organic molecules for applications to single-electron redox chemistry", j: "Synlett 2016, 27, 714–723", doi: "10.1055/s-0035-1561297", why: "Substrate potentials used by the advisor." },
    connelly: { a: "N. G. Connelly, W. E. Geiger", t: "Chemical redox agents for organometallic chemistry", j: "Chem. Rev. 1996, 96, 877–910", doi: "10.1021/cr940053x", why: "Ferrocene against SCE in common solvents, used to convert references." }
  };
  function refList(keys) {
    var box = el("section", "pe-refs"); box.appendChild(el("h3", null, "Methods and references"));
    var ol = el("ol");
    keys.forEach(function (k) {
      var r = REFS[k], li = el("li");
      li.appendChild(document.createTextNode(r.a + ". " + r.t + ". ")); li.appendChild(el("i", null, r.j)); li.appendChild(document.createTextNode(". "));
      li.appendChild(Ent.doiLink(r.doi, "doi:" + r.doi)); li.appendChild(el("span", "pe-why", " " + r.why));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    box.appendChild(el("p", "hint", "Tools and reaction library adapted from RedoxDB (alebusso12), used with permission."));
    return box;
  }

  /* ---------- one record per molecule with redox values ---------- */
  var catCache = { ver: -1, list: [] };
  function catalog(ctx) {
    if (catCache.ver === ctx.version()) return catCache.list;
    var list = [];
    Ent.groupByMolecule(ctx.docs().concat(ctx.redox())).forEach(function (items) {
      var rx = items.filter(Ent.isRedox);
      if (!rx.length) return;
      var et = items.filter(function (d) { return !Ent.isRedox(d); });
      var named = items.filter(function (d) { return d.commercial_name; })[0] || items[0];
      var first = function (k, from) { var x = (from || items).filter(function (d) { return d[k] != null && d[k] !== ""; })[0]; return x ? x[k] : null; };
      var rec = { key: Ent.moleculeKey(items), href: Ent.moleculeHref(items), title: Ent.displayName(named), smiles: rx[0].smiles,
        cls: first("cls"), category: first("category", rx), group: first("activated_group", rx), tau_ns: first("tau_ns", rx),
        uv_lmax: first("uv_lmax"), state: (rx.filter(function (d) { return d.state && d.state !== "S0"; })[0] || {}).state || null, n: rx.length };
      ["e_ox", "e_red", "e_star_ox", "e_star_red"].forEach(function (q) {
        var r = Ent.repE(rx, q); rec[q] = r ? r.mean : null; rec[q + "_calc"] = !!(r && r.origin === "calc");
      });
      var e00 = rx.map(function (d) { return d.e00_ev; }).filter(function (v) { return v != null; }).map(Number);
      rec.e00 = e00.length ? e00.reduce(function (a, b) { return a + b; }, 0) / e00.length : null;
      var ets = et.filter(function (d) { return d.origin !== "calc"; }).map(function (d) { return Number(d.et_kcal); }).filter(isFinite);
      rec.et_ev = ets.length ? Math.round(ets.reduce(function (a, b) { return a + b; }, 0) / ets.length / KCAL * 100) / 100 : null;
      list.push(rec);
    });
    list.sort(function (a, b) { return a.title.localeCompare(b.title); });
    catCache = { ver: ctx.version(), list: list };
    return list;
  }
  function isPC(m) { return m.category === "photocatalyst" || (!m.category && (m.e_star_ox != null || m.e_star_red != null)); }
  function photocatalysts(ctx) { return catalog(ctx).filter(function (m) { return isPC(m) && (m.e_star_ox != null || m.e_star_red != null); }); }
  function substrates(ctx) { return catalog(ctx).filter(function (m) { return !isPC(m) && (m.e_ox != null || m.e_red != null); }); }
  function select(options, value, empty) {
    var s = el("select");
    if (empty != null) s.appendChild(new Option(empty, ""));
    options.forEach(function (o) { var op = new Option(o[1], o[0]); s.appendChild(op); });
    s.value = value == null ? "" : value;
    return s;
  }
  function molOptions(list) { return list.map(function (m) { return [m.key, m.title]; }); }
  function byKey(list, k) { return list.filter(function (m) { return m.key === k; })[0] || null; }
  function molLink(m) { var a = el("a", null, m.title); a.href = m.href; a.title = "Open the molecule's page"; return a; }
  function verdictChip(v) {
    var t = { good: ["exp", "feasible"], border: ["warn", "borderline"], bad: ["bad", "unlikely"], unknown: ["plain", "insufficient data"] }[v] || ["plain", v];
    return el("span", "chip " + t[0], t[1]);
  }
  function marginBar(v) {
    var bar = el("div", "rx-margin");
    if (v == null) return bar;
    var s = el("span"); s.style.width = Math.min(100, Math.abs(v) * 100) + "%";
    s.className = v <= GOOD ? "good" : v <= BORDER ? "border" : "bad";
    bar.title = fmtG(v); bar.appendChild(s); return bar;
  }
  function cycleText(c) {
    var box = el("div", "hint");
    c.steps.forEach(function (s, i) {
      if (i) box.appendChild(el("br"));
      box.appendChild(document.createTextNode(s.label + ": "));
      box.appendChild(el("b", null, fmtG(s.g)));
      if (s.soft) box.appendChild(el("span", null, " (indicative)"));
    });
    return box;
  }

  /* ---------- tools list, picker and shell ---------- */
  var TOOLS = [
    { id: "map", title: "Redox map", tag: "Database values", tagCls: "pe-tag-db",
      desc: "Every photocatalyst in the database on one potential axis, from E*_ox (its excited state as a reductant) to E*_red (as an oxidant), with a substrate or a potential overlaid." },
    { id: "advisor", title: "Reactivity advisor", tag: "Database values + reaction library", tagCls: "pe-tag-db",
      desc: "From a photocatalyst, the reactions and substrates its full cycle can drive; from a reaction or a substrate, the photocatalysts ranked by the thermodynamics of both quenching pathways." },
    { id: "estar", title: "Excited-state potentials", tag: "Your data + database", tagCls: "pe-tag-you",
      desc: "E*_ox = E_ox − E_00 and E*_red = E_red + E_00 from data against any reference; E_00 from spectra, wavelengths or the molecule's triplet energy; ΔG of electron transfer to a quencher." },
    { id: "units", title: "Units & photons", tag: "Quick tools", tagCls: "pe-tag-quick",
      desc: "Photon energy in nm, eV, kcal/mol, kJ/mol and cm⁻¹; a potential difference as free energy and K; the photon flux of a light source." }
  ];
  var SKETCH = {
    map: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><line x1="190" y1="10" x2="190" y2="120" class="pe-gl"/><line x1="70" y1="30" x2="300" y2="30" class="pe-range" stroke="currentColor"/><circle cx="70" cy="30" r="6" class="pe-calcdot"/><circle cx="300" cy="30" r="6" class="pe-pt"/><line x1="110" y1="60" x2="250" y2="60" class="pe-range" stroke="currentColor"/><circle cx="110" cy="60" r="6" class="pe-calcdot"/><circle cx="250" cy="60" r="6" class="pe-pt"/><line x1="50" y1="90" x2="330" y2="90" class="pe-range" stroke="currentColor"/><circle cx="50" cy="90" r="6" class="pe-calcdot"/><circle cx="330" cy="90" r="6" class="pe-pt"/><line x1="230" y1="14" x2="230" y2="118" class="pe-sub" stroke-dasharray="4 3"/></svg>',
    advisor: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><circle cx="80" cy="65" r="26" class="pe-goodband"/><text x="80" y="70" text-anchor="middle" class="pe-label">PC*</text><path d="M110 50 L 190 30" class="pe-curve"/><path d="M110 80 L 190 100" class="pe-curve"/><rect x="200" y="14" width="150" height="30" rx="8" class="pe-band"/><rect x="200" y="86" width="150" height="30" rx="8" class="pe-goodband"/><text x="275" y="34" text-anchor="middle" class="pe-tick">substrate +e⁻</text><text x="275" y="106" text-anchor="middle" class="pe-tick">substrate −e⁻</text></svg>',
    estar: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><path d="M40 10 V112 H364" class="pe-axis" fill="none"/><line x1="60" y1="100" x2="200" y2="100" class="pe-axis"/><line x1="60" y1="30" x2="200" y2="30" class="pe-axis"/><path d="M130 98 V34" class="pe-curve"/><text x="210" y="70" class="pe-label">E₀,₀</text><line x1="240" y1="100" x2="340" y2="100" class="pe-sub" stroke-dasharray="4 3"/><line x1="240" y1="30" x2="340" y2="30" class="pe-sub" stroke-dasharray="4 3"/></svg>',
    units: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><path d="M20 70 Q 45 30 70 70 T 120 70 T 170 70 T 220 70" class="pe-curve"/><path d="M240 70 L 350 70" class="pe-axis"/><text x="295" y="58" text-anchor="middle" class="pe-label">eV · nm · kcal</text></svg>'
  };
  function refBar(onChange) {
    var bar = el("div", "rx-refbar"), sel = el("select");
    RS.DISPLAY_REFS.forEach(function (d) { sel.appendChild(new Option(d.id, d.id)); });
    sel.value = ref().id;
    sel.addEventListener("change", function () { Ent.setRedoxRef(sel.value); var f = Ent.$("f-eref"); if (f) f.value = sel.value; onChange(); });
    var l = el("label", "inline"); l.appendChild(el("span", null, "Potentials vs ")); l.appendChild(sel);
    bar.appendChild(l);
    bar.appendChild(el("span", "hint", "The same reference as the database. Values are converted from SCE."));
    return bar;
  }
  function pickerPage(rootEl) {
    var head = el("section", "pe-head");
    var h2 = el("h2", "pe-title"); h2.appendChild(document.createTextNode("Photo")); h2.appendChild(el("span", "en", "Tool")); head.appendChild(h2);
    head.appendChild(K().withSubs("p", "lede", "Tools for photoredox catalysis built on the redox potentials in the database. Everything runs in your browser; each plot downloads as SVG and can be shared as a link."));
    var grid = el("div", "pe-grid");
    TOOLS.forEach(function (t) {
      var a = el("article", "pe-tool");
      var pic = el("div", "pe-tool-pic"); pic.innerHTML = SKETCH[t.id]; a.appendChild(pic);
      a.appendChild(el("h3", null, t.title));
      a.appendChild(K().withSubs("p", null, t.desc));
      var foot = el("div", "pe-tool-foot");
      foot.appendChild(el("span", "pe-tag " + t.tagCls, t.tag));
      var open = el("a", "btn primary small", "Open"); open.href = BASE + "/" + t.id; open.setAttribute("aria-label", "Open " + t.title);
      foot.appendChild(open); a.appendChild(foot);
      grid.appendChild(a);
    });
    var note = el("aside", "pe-note");
    note.appendChild(el("h3", null, "What the tools assume"));
    note.appendChild(K().withSubs("p", null, "Excited-state potentials are E ± E_00, with entropy and work terms neglected. A molecule's value is the mean of its measured values (computed ones only when none was measured). The advisor compares free energies of single electron-transfer steps; kinetics, back electron transfer and selectivity are up to the experiment."));
    rootEl.replaceChildren(head, grid, note);
  }
  function toolShell(rootEl, tool, rerender) {
    var t = TOOLS.filter(function (x) { return x.id === tool; })[0];
    var back = el("a", "pe-back", "← All PhotoTool tools"); back.href = BASE;
    var h = el("h2", "pe-title", t.title);
    var lede = K().withSubs("p", "lede", t.desc);
    var body = el("div", "pe-body");
    rootEl.replaceChildren(back, h, lede, refBar(rerender), body);
    return body;
  }
  var BASE = "#tools";   /* the section's address: set by render (PhotoreDBox: "#tools") */
  function save(tool, st) { K().saveAt(BASE + "/", tool, st); }
  function field(label, input, hint) {
    var l = el("label", "field"), sp = el("span"); Ent.setText(sp, label); l.appendChild(sp); l.appendChild(input);
    if (hint) l.appendChild(elT("small", "hint", hint));
    return l;
  }
  function inp(v, attrs) { return K().inp(v == null ? "" : v, "text", Object.assign({ inputmode: "decimal" }, attrs || {})); }

  /* ================= 1. Redox map ================= */
  function map(rootEl, ctx, init, rerender) {
    var st = Object.assign({ cls: "", sort: "e_star_red", sub: "", E: "" }, init || {});
    var body = toolShell(rootEl, "map", rerender);
    if (K().needData(ctx, body)) return;
    var pcs = photocatalysts(ctx), subs = substrates(ctx);
    var classes = pcs.map(function (m) { return m.cls; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).sort();
    var panel = el("div", "pe-panel rx-panel-row"), out = el("div", "pe-out");
    body.classList.add("rx-body-wide");
    var cSel = select(classes.map(function (c) { return [c, c]; }), st.cls, "All classes");
    var sSel = select([["e_star_red", "E*red: strongest excited-state oxidant first"], ["e_star_ox", "E*ox: strongest excited-state reductant first"], ["name", "Name"]], st.sort);
    var bSel = select(molOptions(subs), st.sub, "No substrate");
    var eIn = inp(st.E, { placeholder: "e.g. −1.5" });
    panel.appendChild(field("Class", cSel)); panel.appendChild(field("Sort", sSel));
    panel.appendChild(field("Overlay a substrate", bSel)); panel.appendChild(field("…or a potential (" + vs() + ")", eIn));
    panel.appendChild(K().withSubs("p", "hint rx-span", "Purple: E*_ox = E(PC•+/PC*): the excited state reduces substrates whose E_red lies to its right. Green: E*_red = E(PC*/PC•−): it oxidises substrates whose E_ox lies to its left. Click a row to open the molecule."));
    body.appendChild(panel); body.appendChild(out);
    [cSel, sSel, bSel].forEach(function (x) { x.addEventListener("change", draw); });
    eIn.addEventListener("input", draw);
    draw();
    function draw() {
      st.cls = cSel.value; st.sort = sSel.value; st.sub = bSel.value; st.E = eIn.value; save("map", st);
      var list = pcs.filter(function (m) { return !st.cls || m.cls === st.cls; }).slice();
      list.sort(function (a, b) {
        if (st.sort === "name") return a.title.localeCompare(b.title);
        var x = a[st.sort], y = b[st.sort];
        if (x == null) return y == null ? 0 : 1;
        if (y == null) return -1;
        return st.sort === "e_star_ox" ? x - y : y - x;
      });
      out.replaceChildren();
      if (!list.length) { out.appendChild(el("p", "status", pcs.length ? "No photocatalyst in this class has excited-state potentials." : "No photocatalyst in the database has excited-state potentials yet.")); return; }
      var kit = K(), rowH = 22, left = 230, W = 900, top = 34, H = top + list.length * rowH + 36;
      var svg = kit.S("svg", { viewBox: "0 0 " + W + " " + H, "class": "pe-svg rx-map", role: "img", "aria-label": "Redox map of " + list.length + " photocatalysts, " + vs() });
      var x0 = Ent.REDOX_MIN, x1 = Ent.REDOX_MAX, X = function (v) { return left + (v - x0) / (x1 - x0) * (W - left - 20); };
      for (var t = x0; t <= x1; t += 0.5) {
        kit.S("line", { x1: X(t), x2: X(t), y1: top - 6, y2: H - 26, "class": "pe-gl" }, svg);
        kit.TX(svg, X(t), top - 12, (t > 0 ? "+" : t < 0 ? "−" : "") + Math.abs(t).toFixed(1), "pe-tick");
      }
      kit.TX(svg, (left + W) / 2, H - 6, "E (" + vs() + ")   ← stronger excited-state reductant · stronger excited-state oxidant →", "pe-label");
      /* the landmarks of the potential scale (Li+/Li, Ru(bpy)3 2+/+, SCE, Ru(bpy)3 3+/2+), against the chosen reference */
      Ent.redoxLandmarks(ref()).forEach(function (lm) {
        if (!isFinite(lm.v) || lm.v < x0 || lm.v > x1) return;
        kit.S("line", { x1: X(lm.v), x2: X(lm.v), y1: top - 6, y2: H - 26, "class": "rx-landmark" }, svg);
        var tl = kit.TX(svg, X(lm.v), H - 28, lm.l, "rx-landmark-t");
        kit.S("title", {}, tl).textContent = lm.name + " " + fmtV(lm.v) + " " + vs();
      });
      list.forEach(function (m, i) {
        var y = top + i * rowH + rowH / 2, a = kit.S("a", { href: m.href }, svg);
        kit.S("rect", { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: "transparent", "class": "rx-maprow" }, a);
        var label = m.title.length > 34 ? m.title.slice(0, 32) + "…" : m.title;
        kit.TX(a, left - 8, y + 4, label, "pe-tick rx-mapname", "end");
        var so = toRef(m.e_star_ox), sr = toRef(m.e_star_red);
        if (so != null && sr != null) kit.S("line", { x1: X(so), x2: X(sr), y1: y, y2: y, "class": "pe-range", stroke: "currentColor" }, a);
        if (so != null) { var c1 = kit.S("circle", { cx: X(so), cy: y, r: 5, "class": m.e_star_ox_calc ? "pe-calcdot" : "rx-ox" }, a); kit.S("title", {}, c1).textContent = m.title + " E*ox " + fmtV(so) + " " + vs(); }
        if (sr != null) { var c2 = kit.S("circle", { cx: X(sr), cy: y, r: 5, "class": m.e_star_red_calc ? "pe-calcdot" : "pe-pt" }, a); kit.S("title", {}, c2).textContent = m.title + " E*red " + fmtV(sr) + " " + vs(); }
      });
      function vline(v, text) {
        if (v == null || !isFinite(v)) return;
        kit.S("line", { x1: X(v), x2: X(v), y1: top - 6, y2: H - 26, "class": "pe-sub", "stroke-dasharray": "6 4" }, svg);
        kit.TX(svg, X(v) + 4, H - 28, text, "pe-note-t", "start");
      }
      var sub = byKey(subs, st.sub);
      if (sub) {
        if (sub.e_ox != null) vline(toRef(sub.e_ox), sub.title + " E_ox " + fmtV(toRef(sub.e_ox)));
        if (sub.e_red != null) vline(toRef(sub.e_red), sub.title + " E_red " + fmtV(toRef(sub.e_red)));
      }
      var E = numIn(st.E); if (E != null) vline(E, fmtV(E) + " V");
      var plot = el("div", "pe-plot rx-mapwrap"); plot.appendChild(svg); out.appendChild(plot);
      out.appendChild(K().actions([["Download SVG", function () { K().exportSvg(svg, "redox-map.svg"); }], K().copyLinkBtn()]));
      out.appendChild(el("p", "hint", list.length + " photocatalysts. Hollow marks are computed values; filled marks are measured."));
    }
    body.appendChild(refList(["prier", "romero"]));
  }

  /* ================= 2. Reactivity advisor ================= */
  function advisor(rootEl, ctx, init, rerender) {
    var st = Object.assign({ mode: "pc", pc: "", esr: "", eso: "", er: "", eo: "", rx: "", sub: "", dir: "ox", E: "", partner: "", avoid: true, vis: false }, init || {});
    var body = toolShell(rootEl, "advisor", rerender);
    if (K().needData(ctx, body)) return;
    var pcs = photocatalysts(ctx), subs = substrates(ctx), lib = root.EntRedoxReactions || [];
    var panel = el("div", "pe-panel"), out = el("div", "pe-out");
    body.appendChild(panel); body.appendChild(out);
    var modeSel = select([["pc", "I have a photocatalyst: what can it do?"], ["rx", "I have a reaction or a substrate: which photocatalyst?"]], st.mode);
    panel.appendChild(field("Question", modeSel));
    /* mode A */
    var a = el("div", "rx-mode");
    var pcSel = select(molOptions(pcs), st.pc, "Custom values");
    var ins = { esr: inp(st.esr), eso: inp(st.eso), er: inp(st.er), eo: inp(st.eo) };
    a.appendChild(field("Photocatalyst from the database", pcSel));
    var grid = el("div", "frow");
    grid.appendChild(field("E*_red (PC*/PC•−)", ins.esr)); grid.appendChild(field("E*_ox (PC•+/PC*)", ins.eso));
    a.appendChild(grid);
    var grid2 = el("div", "frow");
    grid2.appendChild(field("E_red (PC/PC•−)", ins.er)); grid2.appendChild(field("E_ox (PC•+/PC)", ins.eo));
    a.appendChild(grid2);
    a.appendChild(el("p", "hint", "In " + vs() + ". Missing excited-state values? Compute them with “Excited-state potentials”."));
    /* mode B */
    var b = el("div", "rx-mode");
    var rxSel = select(lib.map(function (r) { return [r.id, r.name]; }), st.rx, "Custom: define the electron transfer");
    var desc = el("div", "hint");
    var custom = el("div", "rx-custom");
    var subSel = select(molOptions(subs), st.sub, "Type its potential instead");
    var dirSel = select([["ox", "oxidised (electron donor)"], ["red", "reduced (electron acceptor)"]], st.dir);
    var eIn = inp(st.E), partSel = select(molOptions(subs), st.partner, "None or not known");
    custom.appendChild(field("Substrate to activate", subSel)); custom.appendChild(field("It must be", dirSel));
    custom.appendChild(field("Its potential (" + vs() + ")", eIn)); custom.appendChild(field("Partner that closes the cycle (optional)", partSel));
    var avoid = K().check("Penalise catalysts far stronger than needed (chemoselectivity)", st.avoid, function (v) { st.avoid = v; run(); });
    var vis = K().check("Visible-light catalysts only (absorbing at 400 nm or beyond, or unknown)", st.vis, function (v) { st.vis = v; run(); });
    b.appendChild(field("Reaction from the library", rxSel)); b.appendChild(desc); b.appendChild(custom); b.appendChild(avoid); b.appendChild(vis);
    panel.appendChild(a); panel.appendChild(b);
    panel.appendChild(K().withSubs("p", "hint", "Feasible: every electron-transfer step has ΔG ≤ " + GOOD + " eV; borderline up to +" + BORDER + " eV. Steps marked “indicative” involve estimated potentials (radical intermediates, terminal oxidants) and only downgrade a verdict beyond +" + SOFT_TOL + " eV."));

    modeSel.addEventListener("change", run);
    pcSel.addEventListener("change", function () {
      var m = byKey(pcs, pcSel.value);
      if (m) {
        var f = function (v) { var x = toRef(v); return x == null || !isFinite(x) ? "" : String(Math.round(x * 1000) / 1000); };
        ins.esr.value = f(m.e_star_red); ins.eso.value = f(m.e_star_ox); ins.er.value = f(m.e_red); ins.eo.value = f(m.e_ox);
      }
      run();
    });
    Object.keys(ins).forEach(function (k) { ins[k].addEventListener("input", run); });
    [rxSel, dirSel, partSel].forEach(function (x) { x.addEventListener("change", run); });
    eIn.addEventListener("input", run);
    subSel.addEventListener("change", function () {
      var m = byKey(subs, subSel.value);
      if (m) {
        if (m.e_ox != null && (m.e_red == null || dirSel.value === "ox")) { dirSel.value = "ox"; eIn.value = String(toRef(m.e_ox)); }
        else if (m.e_red != null) { dirSel.value = "red"; eIn.value = String(toRef(m.e_red)); }
      }
      run();
    });
    run();

    function run() {
      st.mode = modeSel.value; st.pc = pcSel.value; st.rx = rxSel.value; st.sub = subSel.value; st.dir = dirSel.value; st.E = eIn.value; st.partner = partSel.value;
      Object.keys(ins).forEach(function (k) { st[k] = ins[k].value; });
      save("advisor", st);
      a.hidden = st.mode !== "pc"; b.hidden = st.mode !== "rx";
      out.replaceChildren();
      if (st.mode === "pc") runPC(); else runRX();
    }
    function runPC() {
      var pc = { e_star_red: fromRef(numIn(ins.esr.value)), e_star_ox: fromRef(numIn(ins.eso.value)), e_red: fromRef(numIn(ins.er.value)), e_ox: fromRef(numIn(ins.eo.value)) };
      if (pc.e_star_red == null && pc.e_star_ox == null) { out.appendChild(el("p", "status", "Choose a photocatalyst or type at least one excited-state potential.")); return; }
      var rows = lib.map(function (r) { return { r: r, c: bestCycle(pc, r.donor, r.acceptor, r.reported_quenching, r.key) }; }).filter(function (x) { return x.c; })
        .sort(function (x, y) { return RANK[x.c.verdict] - RANK[y.c.verdict] || x.c.score - y.c.score; });
      var card = el("section", "pe-card"); card.appendChild(el("h3", null, "Reactions it can drive"));
      card.appendChild(K().table(["Reaction", "Best cycle", "Electron-transfer steps", "Verdict"], rows.map(function (x) {
        var name = el("div"); name.appendChild(el("b", null, x.r.name));
        var meta = el("div", "hint", x.r.family + " · "); if (x.r.doi) meta.appendChild(Ent.doiLink(x.r.doi, "doi:" + x.r.doi)); else meta.appendChild(document.createTextNode(x.r.citation || ""));
        name.appendChild(meta);
        if (x.r.pcet) name.appendChild(el("div", "hint", "Works through PCET, not plain electron transfer."));
        var mode = el("div", null, x.c.mode + " quenching"); if (x.r.reported_quenching !== x.c.mode) mode.appendChild(el("div", "hint", "reported: " + x.r.reported_quenching));
        var v = el("div"); v.appendChild(verdictChip(x.c.verdict)); v.appendChild(marginBar(x.c.worst));
        return [name, mode, cycleText(x.c), v];
      })));
      out.appendChild(card);
      var reach = [];
      subs.forEach(function (m) {
        if (m.e_ox != null && pc.e_star_red != null) reach.push({ m: m, how: "PC* oxidises it", g: m.e_ox - pc.e_star_red });
        if (m.e_red != null && pc.e_star_ox != null) reach.push({ m: m, how: "PC* reduces it", g: pc.e_star_ox - m.e_red });
        if (m.e_red != null && pc.e_red != null) reach.push({ m: m, how: "PC•− reduces it (after reductive quenching)", g: pc.e_red - m.e_red });
        if (m.e_ox != null && pc.e_ox != null) reach.push({ m: m, how: "PC•+ oxidises it (after oxidative quenching)", g: m.e_ox - pc.e_ox });
      });
      var groups = {};
      reach.filter(function (x) { return x.g <= BORDER; }).sort(function (x, y) { return x.g - y.g; }).forEach(function (x) { (groups[x.how] = groups[x.how] || []).push(x); });
      var sc = el("section", "pe-card"); sc.appendChild(el("h3", null, "Substrates in the database it can activate"));
      var hows = Object.keys(groups).sort();
      if (!hows.length) sc.appendChild(el("p", "hint", "No substrate in the database is within reach."));
      hows.forEach(function (how) {
        var d = el("details"); if (how.indexOf("PC*") === 0) d.open = true;
        d.appendChild(el("summary", null, how + " · " + groups[how].length + " substrates"));
        d.appendChild(K().table(["Substrate", "Activated group", "ΔG", "kcal/mol"], groups[how].map(function (x) {
          return [molLink(x.m), x.m.group || "", fmtG(x.g), (x.g * KCAL).toFixed(1)];
        }), 25));
        sc.appendChild(d);
      });
      out.appendChild(sc);
    }
    function runRX() {
      var r = lib.filter(function (x) { return x.id === st.rx; })[0], D = null, A = null, need = null;
      custom.hidden = !!r; desc.replaceChildren();
      if (r) {
        D = r.donor; A = r.acceptor;
        desc.appendChild(document.createTextNode(r.summary + " Key step: " + (r.key === "donor" ? "oxidise " + D.name + " (E_ox " + fmtV(toRef(D.E_ox)) + ")" : "reduce " + A.name + " (E_red " + fmtV(toRef(A.E_red)) + ")") + " " + vs() + ". Catalysts used in the original work: " + (r.typical_pc || []).join(", ") + ". "));
        if (r.doi) desc.appendChild(Ent.doiLink(r.doi, "doi:" + r.doi));
        if (r.notes) desc.appendChild(el("div", null, r.notes));
        need = { dir: r.key === "donor" ? "ox" : "red" };
      } else {
        var E = fromRef(numIn(eIn.value)), sub = byKey(subs, st.sub), partner = byKey(subs, st.partner), nm = sub ? sub.title : "substrate";
        if (E == null) { out.appendChild(el("p", "status", "Choose a reaction, or a substrate and the direction of electron transfer.")); return; }
        if (st.dir === "ox") { D = { name: nm, E_ox: E }; A = partner && partner.e_red != null ? { name: partner.title, E_red: partner.e_red } : null; }
        else { A = { name: nm, E_red: E }; D = partner && partner.e_ox != null ? { name: partner.title, E_ox: partner.e_ox } : null; }
        need = { dir: st.dir };
      }
      var rows = pcs.filter(function (pc) { return !st.vis || !(pc.uv_lmax && pc.uv_lmax < 400); }).map(function (pc) {
        return { pc: pc, c: bestCycle(pc, D, A, r ? r.reported_quenching : null, r ? r.key : (need.dir === "ox" ? "donor" : "acceptor")) };
      }).filter(function (x) { return x.c && x.c.verdict !== "unknown"; });
      rows.forEach(function (x) {
        x.score = x.c.score; x.key = x.c.steps[0].g;
        if (st.avoid && x.key != null && x.key < -0.8) x.score += (-0.8 - x.key) * 0.5;
      });
      rows.sort(function (x, y) { return RANK[x.c.verdict] - RANK[y.c.verdict] || ((y.c.complete ? 1 : 0) - (x.c.complete ? 1 : 0)) || x.score - y.score; });
      var card = el("section", "pe-card"); card.appendChild(el("h3", null, "Photocatalysts, best first"));
      if (!rows.length) { card.appendChild(el("p", "hint", "No photocatalyst in the database has the potentials needed for this analysis.")); out.appendChild(card); return; }
      var nGood = rows.filter(function (x) { return x.c.verdict === "good"; }).length, nBorder = rows.filter(function (x) { return x.c.verdict === "border"; }).length;
      card.appendChild(el("p", "hint", nGood + " feasible and " + nBorder + " borderline out of " + rows.length + " photocatalysts with data."));
      card.appendChild(K().table(["#", "Photocatalyst", "Cycle", "Electron-transfer steps", "E*_ox / E*_red", "Verdict"], rows.map(function (x, k) {
        var name = el("div"); name.appendChild(molLink(x.pc));
        var warn = [];
        if (x.pc.uv_lmax && x.pc.uv_lmax < 400) warn.push("absorbs at " + x.pc.uv_lmax + " nm (UV)");
        if (x.pc.tau_ns != null && x.pc.tau_ns < 5) warn.push("short-lived excited state (τ ≈ " + x.pc.tau_ns + " ns)");
        if (warn.length) name.appendChild(el("div", "hint rx-warn", warn.join(" · ")));
        var v = el("div"); v.appendChild(verdictChip(x.c.verdict)); v.appendChild(marginBar(x.c.worst));
        if (st.avoid && x.key != null && x.key < -0.8) v.appendChild(el("div", "hint", "much stronger than needed"));
        return [String(k + 1), name, x.c.mode, cycleText(x.c), fmtV(toRef(x.pc.e_star_ox)) + " / " + fmtV(toRef(x.pc.e_star_red)), v];
      }), 30));
      out.appendChild(card);
    }
    body.appendChild(refList(["prier", "romero", "roth"]));
  }

  /* ================= 3. Excited-state potentials ================= */
  var DIELECTRIC = [["MeCN", 37.5], ["DMF", 36.7], ["DMSO", 46.7], ["CH2Cl2", 8.93], ["MeOH", 32.7], ["H2O", 78.4], ["acetone", 20.7], ["THF", 7.58], ["DCE", 10.4], ["toluene", 2.38], ["benzene", 2.27]];
  function estar(rootEl, ctx, init, rerender) {
    var st = Object.assign({ pc: "", ref: "SCE", solvent: "MeCN", eox: "", ered: "", mode: "ev", e00: "", state: "T1", q: "", qox: "", qred: "", coul: false, eps: 37.5, r: 7 }, init || {});
    var body = toolShell(rootEl, "estar", rerender);
    if (K().needData(ctx, body)) return;
    var mols = catalog(ctx), pcs = photocatalysts(ctx), subs = substrates(ctx), spectra = { abs: null, em: null };
    var panel = el("div", "pe-panel"), out = el("div", "pe-out");
    body.appendChild(panel); body.appendChild(out);
    var pick = select(molOptions(mols), st.pc, "Your own data");
    var refSel = select(RS.REF_TABLE.filter(function (r) { return r.id !== "other" && r.id !== "Ag/Ag+"; }).map(function (r) { return [r.id, r.id]; }), st.ref);
    var solvIn = K().inp(st.solvent, "text", { placeholder: "e.g. MeCN" }), solvWrap = field("Solvent (for Fc+/Fc)", solvIn);
    var eoxIn = inp(st.eox, { placeholder: "e.g. 0.77" }), eredIn = inp(st.ered, { placeholder: "e.g. −1.33" });
    var modeSel = select([["ev", "E_00 in eV"], ["kcal", "Energy in kcal/mol (e.g. a triplet energy)"], ["cross", "λ where normalised absorption and emission cross (nm)"], ["em77", "Emission maximum at 77 K (nm)"], ["onset", "Emission onset, blue edge (nm)"], ["em", "Room-temperature emission maximum (nm), rough"], ["spectra", "Upload absorption and emission spectra"]], st.mode);
    var e00In = inp(st.e00, { placeholder: "e.g. 2.76" }), e00Wrap = field("Value", e00In);
    var absIn = el("input"), emIn = el("input"); absIn.type = emIn.type = "file"; absIn.accept = emIn.accept = ".csv,.txt,.tsv,.dat";
    var specWrap = el("div", "rx-spec"); specWrap.appendChild(field("Absorption spectrum (wavelength, absorbance)", absIn)); specWrap.appendChild(field("Emission spectrum (wavelength, intensity)", emIn));
    var stateSel = select([["S1", "S1"], ["T1", "T1"]], st.state);
    var etHint = el("p", "hint");
    panel.appendChild(field("Start from a molecule in the database (optional)", pick));
    var r1 = el("div", "frow"); r1.appendChild(field("Reference of your data", refSel)); r1.appendChild(solvWrap); panel.appendChild(r1);
    var r2 = el("div", "frow"); r2.appendChild(field("E_ox = E(PC•+/PC), V", eoxIn)); r2.appendChild(field("E_red = E(PC/PC•−), V", eredIn)); panel.appendChild(r2);
    panel.appendChild(field("How do you know E_00?", modeSel)); panel.appendChild(e00Wrap); panel.appendChild(specWrap);
    panel.appendChild(field("Reacting excited state", stateSel)); panel.appendChild(etHint);
    panel.appendChild(K().withSubs("p", "hint", "Use the E_00 of the state that reacts: long-lived triplets (Ir, Ru, Cu complexes, many TADF emitters) usually react from T_1; singlets only when their lifetime allows bimolecular quenching."));

    /* quencher */
    var qCard = el("section", "pe-card"); qCard.appendChild(el("h3", null, "Will it quench? ΔG of photoinduced electron transfer"));
    var qSel = select(molOptions(subs), st.q, "Type values");
    var qoxIn = inp(st.qox), qredIn = inp(st.qred);
    var coul = K().check("Coulomb term (Rehm–Weller)", st.coul, function (v) { st.coul = v; compute(); });
    var epsSel = select(DIELECTRIC.map(function (s) { return [String(s[1]), s[0] + " (ε = " + s[1] + ")"]; }), String(st.eps));
    var rIn = inp(st.r);
    var q1 = el("div", "frow"); q1.appendChild(field("Quencher from the database", qSel)); q1.appendChild(field("Quencher E_ox (" + vs() + ")", qoxIn)); q1.appendChild(field("Quencher E_red (" + vs() + ")", qredIn)); qCard.appendChild(q1);
    var q2 = el("div", "frow"); q2.appendChild(coul); q2.appendChild(field("Solvent", epsSel)); q2.appendChild(field("Encounter distance r (Å)", rIn)); qCard.appendChild(q2);
    var qOut = el("div"); qCard.appendChild(qOut);
    qCard.appendChild(K().withSubs("p", "hint", "ΔG(reductive) = E_ox(Q) − E*_red(PC) + w ; ΔG(oxidative) = E*_ox(PC) − E_red(Q) + w, with w = −14.40/(ε·r[Å]) eV for neutral partners forming an ion pair."));
    body.appendChild(qCard);

    pick.addEventListener("change", function () {
      var m = byKey(mols, pick.value);
      if (!m) { compute(); return; }
      refSel.value = "SCE";
      eoxIn.value = m.e_ox != null ? String(m.e_ox) : ""; eredIn.value = m.e_red != null ? String(m.e_red) : "";
      if (m.e00 != null) { modeSel.value = "ev"; e00In.value = String(Math.round(m.e00 * 100) / 100); }
      if (m.state) stateSel.value = m.state;
      compute();
    });
    qSel.addEventListener("change", function () {
      var m = byKey(subs, qSel.value);
      if (m) { qoxIn.value = m.e_ox != null ? String(toRef(m.e_ox)) : ""; qredIn.value = m.e_red != null ? String(toRef(m.e_red)) : ""; }
      compute();
    });
    [refSel, modeSel, stateSel, epsSel].forEach(function (x) { x.addEventListener("change", compute); });
    [solvIn, eoxIn, eredIn, e00In, qoxIn, qredIn, rIn].forEach(function (x) { x.addEventListener("input", compute); });
    function readSpectrum(input, k) {
      input.addEventListener("change", function () {
        var f = input.files && input.files[0]; if (!f) return;
        f.text().then(function (t) { var tab = parseNumericTable(t); spectra[k] = tab.cols.length >= 2 ? { x: tab.cols[0], y: tab.cols[1] } : null; compute(); });
      });
    }
    readSpectrum(absIn, "abs"); readSpectrum(emIn, "em");
    compute();

    function compute() {
      st.pc = pick.value; st.ref = refSel.value; st.solvent = solvIn.value; st.eox = eoxIn.value; st.ered = eredIn.value; st.mode = modeSel.value; st.e00 = e00In.value;
      st.state = stateSel.value; st.q = qSel.value; st.qox = qoxIn.value; st.qred = qredIn.value; st.eps = Number(epsSel.value); st.r = rIn.value;
      save("estar", st);
      solvWrap.hidden = st.ref !== "Fc+/Fc";
      var spec = st.mode === "spectra"; specWrap.hidden = !spec; e00Wrap.hidden = spec;
      /* the molecule's triplet energy in the database, as E0,0 of T1 */
      var m = byKey(mols, st.pc);
      etHint.replaceChildren();
      if (m && m.et_ev != null && st.state === "T1") {
        etHint.appendChild(Ent.elT("span", null, "This molecule's measured E_T in the database is " + m.et_ev.toFixed(2) + " eV. "));
        var use = el("button", "btn small", "Use it as E₀,₀"); use.type = "button";
        use.addEventListener("click", function () { modeSel.value = "ev"; e00In.value = String(m.et_ev); compute(); });
        etHint.appendChild(use);
      }
      var conv = function (v) { return v == null ? null : RS.toSce(v, st.ref, st.solvent); };
      var eox = conv(numIn(st.eox)), ered = conv(numIn(st.ered));
      var E = spec ? crossing(spectra.abs, spectra.em) : { e00: e00From(st.mode, numIn(st.e00)) };
      var x = excited(eox, ered, E.e00);
      out.replaceChildren();
      if ((numIn(st.eox) != null || numIn(st.ered) != null) && (eox == null || !isFinite(eox)) && (ered == null || !isFinite(ered))) {
        out.appendChild(el("p", "pe-warn", "This reference cannot be converted to SCE" + (st.ref === "Fc+/Fc" ? ": give the solvent (MeCN, DMF, CH2Cl2, THF or DMSO)." : ".")));
      }
      var res = el("dl", "pe-result");
      function kv(label, val, sub) { var d = el("div"); d.appendChild(Ent.elT("dt", null, label)); var dd = el("dd", null, val); if (sub) dd.appendChild(el("small", null, sub)); d.appendChild(dd); res.appendChild(d); }
      kv("E_00", E.e00 != null ? E.e00.toFixed(2) + " eV" : "—", E.e00 != null ? (E.e00 * KCAL).toFixed(1) + " kcal/mol · " + (HC / E.e00).toFixed(0) + " nm" : (E.msg || ""));
      kv("E*_ox = E(PC•+/PC*)", fmtV(toRef(x.eso)) + " V", "excited state as reductant · " + vs());
      kv("E*_red = E(PC*/PC•−)", fmtV(toRef(x.esr)) + " V", "excited state as oxidant · " + vs());
      if (st.ref !== ref().ref) kv("Ground state, " + vs(), fmtV(toRef(eox)) + " / " + fmtV(toRef(ered)), "E_ox / E_red");
      out.appendChild(res);
      var f = el("p", "hint");
      Ent.setText(f, "E*_ox = E_ox − E_00 and E*_red = E_red + E_00, with entropy and work terms neglected." + (spec && E.lambda ? " E_00 from the crossing at " + E.lambda.toFixed(1) + " nm." : ""));
      out.appendChild(f);
      if (spec && E.a) out.appendChild(spectraPlot(E));
      if (x.eso != null || x.esr != null) {
        var d = function (p) { return Math.hypot(x.eso != null && p.e_star_ox != null ? p.e_star_ox - x.eso : 0.5, x.esr != null && p.e_star_red != null ? p.e_star_red - x.esr : 0.5); };
        var near = pcs.slice().sort(function (p1, p2) { return d(p1) - d(p2); }).slice(0, 6);
        if (near.length) {
          var nc = el("section", "pe-card"); nc.appendChild(el("h3", null, "Closest photocatalysts in the database"));
          nc.appendChild(K().table(["Photocatalyst", "E*_ox", "E*_red", "E_00 (eV)"], near.map(function (p) {
            return [molLink(p), fmtV(toRef(p.e_star_ox)), fmtV(toRef(p.e_star_red)), p.e00 != null ? p.e00.toFixed(2) : "—"];
          })));
          out.appendChild(nc);
        }
      }
      var w = st.coul ? coulomb(st.eps, numIn(st.r) || 7) : 0;
      var g = quench(fromRef(numIn(st.qox)), fromRef(numIn(st.qred)), x.eso, x.esr, w);
      qOut.replaceChildren();
      if (numIn(st.qox) == null && numIn(st.qred) == null) { qOut.appendChild(el("p", "hint", "Type the quencher's potentials, or pick one, to see the driving force.")); return; }
      var verdict = function (v) { return v == null ? "" : v < -0.1 ? "favourable" : v <= 0.1 ? "near thermoneutral" : "unfavourable"; };
      qOut.appendChild(K().table(["Pathway", "ΔG", "kcal/mol", ""], [
        ["Reductive quenching: PC* + Q → PC•− + Q•+", fmtG(g.reductive), g.reductive == null ? "—" : (g.reductive * KCAL).toFixed(1), verdict(g.reductive)],
        ["Oxidative quenching: PC* + Q → PC•+ + Q•−", fmtG(g.oxidative), g.oxidative == null ? "—" : (g.oxidative * KCAL).toFixed(1), verdict(g.oxidative)]
      ]));
      if (w) qOut.appendChild(el("p", "hint", "Coulomb term w = " + w.toFixed(3) + " eV included."));
    }
    function spectraPlot(E) {
      var kit = K(), xs = E.a.concat(E.e).map(function (p) { return p[0]; });
      var lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
      var fr = kit.frame({ w: 640, h: 300, l: 54, r: 16, t: 14, b: 42, x: [lo, hi], y: [0, 1.1], xl: "Wavelength (nm)", yl: "Normalised intensity", aria: "Normalised absorption and emission spectra", clip: "rx-spec-clip" });
      kit.S("path", { d: kit.linePath(E.a.map(function (p) { return [fr.X(p[0]), fr.Y(Math.min(1.1, p[1]))]; })), "class": "pe-curve" }, fr.plot);
      kit.S("path", { d: kit.linePath(E.e.map(function (p) { return [fr.X(p[0]), fr.Y(Math.min(1.1, p[1]))]; })), "class": "pe-rate" }, fr.plot);
      kit.S("line", { x1: fr.X(E.lambda), x2: fr.X(E.lambda), y1: fr.Y(0), y2: fr.Y(1.1), "class": "pe-sub", "stroke-dasharray": "5 4" }, fr.plot);
      kit.TX(fr.svg, fr.X(E.lambda) + 4, fr.Y(1.02), "λ = " + E.lambda.toFixed(1) + " nm", "pe-note-t", "start");
      var w = el("div", "pe-plot pe-plot-sm"); w.appendChild(fr.svg); return w;
    }
    body.appendChild(refList(["romero", "rehm", "connelly"]));
  }

  /* ================= 4. Units & photons ================= */
  function units(rootEl, ctx, init, rerender) {
    var st = Object.assign({ nm: "450", dv: "0.25", n: "1", mw: "100", lnm: "450", h: "1" }, init || {});
    var body = toolShell(rootEl, "units", rerender);
    var kit = K();
    /* photon energy */
    var c1 = el("section", "pe-card"); c1.appendChild(el("h3", null, "Photon energy"));
    c1.appendChild(el("p", "hint", "Type in any field; the others follow. E (eV) = 1239.84 / λ (nm)."));
    var F = { nm: inp(st.nm), ev: inp(""), kcal: inp(""), kj: inp(""), cm: inp(""), thz: inp("") };
    var labels = { nm: "Wavelength (nm)", ev: "Energy (eV)", kcal: "kcal/mol", kj: "kJ/mol", cm: "Wavenumber (cm⁻¹)", thz: "Frequency (THz)" };
    var g1 = el("div", "frow"), g2 = el("div", "frow");
    ["nm", "ev", "kcal"].forEach(function (k) { g1.appendChild(field(labels[k], F[k])); });
    ["kj", "cm", "thz"].forEach(function (k) { g2.appendChild(field(labels[k], F[k])); });
    c1.appendChild(g1); c1.appendChild(g2);
    var colour = el("p", "hint"); c1.appendChild(colour);
    function setFrom(src) {
      var v = numIn(F[src].value); if (v == null || v <= 0) return;
      var ev = src === "nm" ? HC / v : src === "ev" ? v : src === "kcal" ? v / KCAL : src === "kj" ? v / KJ : src === "cm" ? v / CM : v * 1e12 * H / QE;
      var vals = { nm: HC / ev, ev: ev, kcal: ev * KCAL, kj: ev * KJ, cm: ev * CM, thz: ev * QE / H / 1e12 };
      Object.keys(vals).forEach(function (k) { if (k !== src) F[k].value = String(+vals[k].toPrecision(5)); });
      var nm = HC / ev;
      var col = nm < 380 ? "UV" : nm < 450 ? "violet or blue" : nm < 495 ? "blue" : nm < 570 ? "green" : nm < 590 ? "yellow" : nm < 620 ? "orange" : nm < 750 ? "red" : "near-IR";
      colour.replaceChildren();
      Ent.setText(colour, col + " light. A photocatalyst excited here gains at most " + ev.toFixed(2) + " eV of redox power: E*_ox = E_ox − E_00, E*_red = E_red + E_00.");
      st.nm = F.nm.value; save("units", st);
    }
    Object.keys(F).forEach(function (k) { F[k].addEventListener("input", function () { setFrom(k); }); });
    setFrom("nm");
    /* ΔE -> ΔG, K */
    var c2 = el("section", "pe-card"); c2.appendChild(el("h3", null, "Potential difference as free energy"));
    c2.appendChild(el("p", "hint", "ΔG = −n F ΔE. For one electron, 1 V corresponds to 1 eV = 23.06 kcal/mol = 96.49 kJ/mol."));
    var dvIn = inp(st.dv), nIn = inp(st.n), gOut = el("p", "pe-big"), kOut = el("p", "hint");
    var g3 = el("div", "frow"); g3.appendChild(field("ΔE (V)", dvIn)); g3.appendChild(field("Electrons n", nIn)); c2.appendChild(g3); c2.appendChild(gOut); c2.appendChild(kOut);
    function g() {
      var v = numIn(dvIn.value) || 0, n = numIn(nIn.value) || 1, ev = -n * v;
      gOut.textContent = "ΔG = " + ev.toFixed(3) + " eV = " + (ev * KCAL).toFixed(2) + " kcal/mol = " + (ev * KJ).toFixed(1) + " kJ/mol";
      kOut.textContent = "Equilibrium constant at 25 °C: K = exp(−ΔG/RT) = " + kit.sci(Math.exp(-ev * KJ * 1000 / (8.314462618 * 298.15)), 3);
      st.dv = dvIn.value; st.n = nIn.value; save("units", st);
    }
    [dvIn, nIn].forEach(function (x) { x.addEventListener("input", g); }); g();
    /* photon flux */
    var c3 = el("section", "pe-card"); c3.appendChild(el("h3", null, "Light source and photon flux"));
    c3.appendChild(el("p", "hint", "q = P λ / (h c N_A), in einstein per second. Use the optical power reaching the sample (measured with a power meter), not the electrical power of the lamp."));
    var mwIn = inp(st.mw), lIn = inp(st.lnm), hIn = inp(st.h), pOut = el("dl", "pe-result");
    var g4 = el("div", "frow"); g4.appendChild(field("Optical power (mW)", mwIn)); g4.appendChild(field("Wavelength (nm)", lIn)); g4.appendChild(field("Irradiation time (h)", hIn));
    c3.appendChild(g4); c3.appendChild(pOut);
    c3.appendChild(el("p", "hint", "Compare with the moles of product for an upper bound of the quantum yield; only part of the light is absorbed, so measure Φ by actinometry for real values."));
    function p() {
      var q = photonFlux(numIn(mwIn.value) || 0, numIn(lIn.value) || 450), h = numIn(hIn.value) || 0;
      pOut.replaceChildren();
      [["Photon flux", kit.sci(q, 3) + " einstein/s"], ["Photons per second", kit.sci(q * NA, 3)], ["In " + h + " h", kit.sci(q * 3600 * h * 1000, 3) + " mmol photons"]].forEach(function (r) {
        var d = el("div"); d.appendChild(el("dt", null, r[0])); d.appendChild(el("dd", null, r[1])); pOut.appendChild(d);
      });
      st.mw = mwIn.value; st.lnm = lIn.value; st.h = hIn.value; save("units", st);
    }
    [mwIn, lIn, hIn].forEach(function (x) { x.addEventListener("input", p); }); p();
    var c4 = el("section", "pe-card"); c4.appendChild(el("h3", null, "Diffusion limit and Stern–Volmer"));
    var pl = el("p", "hint", "The diffusion-limited rate constant for a solvent and Stern–Volmer analysis are in PlotEnT: ");
    var lk = el("a", null, "open the calculators"); lk.href = "#plot/calc"; pl.appendChild(lk); pl.appendChild(document.createTextNode("."));
    c4.appendChild(pl);
    body.appendChild(c1); body.appendChild(c2); body.appendChild(c3); body.appendChild(c4);
  }

  /* ---------- entry point ---------- */
  var TOOL_FN = { map: map, advisor: advisor, estar: estar, units: units };
  var current = { key: "", ver: -1, ref: "" };
  /* route: {tool, data}; ctx: {docs(), redox(), loaded(), failed(), version(), base} (base: the section's address, e.g. "#tools") */
  root.EntRedox = {
    tools: TOOLS, maths: maths, catalog: catalog,
    render: function (rootEl, route, ctx) {
      if (ctx.base) BASE = ctx.base;
      var tool = TOOL_FN[route.tool] ? route.tool : "";
      var ver = ctx.version(), r = ref().id;
      if (current.key === tool && current.ver === ver && current.ref === r && rootEl.firstChild) return;
      current = { key: tool, ver: ver, ref: r };
      if (!tool) { pickerPage(rootEl); return; }
      var again = function () { current.ver = -1; root.EntRedox.render(rootEl, { tool: tool, data: (location.hash.split("/")[2] || "") }, ctx); };
      TOOL_FN[tool](rootEl, ctx, K().decodeState(route.data), again);
    },
    reset: function () { current = { key: "", ver: -1, ref: "" }; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
