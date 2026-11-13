/* PlotEnT: plots and calculators for triplet energy transfer, built on the database.
   Everything runs in the browser; nothing typed here is stored. A tool's settings live in the
   address (#plot/<tool>/<data>), so a plot can be shared as a link.
   Tools: finder (photocatalyst finder), sandros (Sandros fit), pss (E/Z photostationary state),
   calc (Stern–Volmer, diffusion limit, E_T by class). */
(function () {
  "use strict";
  var el = Ent.el, elT = Ent.elT;
  var R_KCAL = 1.987204e-3;            /* kcal mol⁻¹ K⁻¹ */
  var R_J = 8.314462618;               /* J mol⁻¹ K⁻¹ */
  var NS = "http://www.w3.org/2000/svg";

  /* ---------- references (every DOI checked against doi.org) ---------- */
  var REFS = {
    sandros: { a: "K. Sandros", t: "Transfer of triplet state energy in fluid solutions. III. Reversible energy transfer", j: "Acta Chem. Scand. 1964, 18, 2355–2374", doi: "10.3891/acta.chem.scand.18-2355", why: "The Sandros equation: k_q as a function of the donor–acceptor triplet energy gap." },
    herk: { a: "W. G. Herkstroeter, A. A. Lamola, G. S. Hammond", t: "Mechanisms of photochemical reactions in solution. XXVIII. Values of triplet excitation energies of selected sensitizers", j: "J. Am. Chem. Soc. 1964, 86, 4537–4540", doi: "10.1021/ja01075a005", why: "Triplet energies from quenching rates across a series of donors." },
    hammond: { a: "G. S. Hammond, J. Saltiel, A. A. Lamola, N. J. Turro, J. S. Bradshaw, D. O. Cowan, R. C. Counsell, V. Vogt, C. Dalton", t: "Mechanisms of photochemical reactions in solution. XXII. Photochemical cis–trans isomerization", j: "J. Am. Chem. Soc. 1964, 86, 3197–3217", doi: "10.1021/ja01070a002", why: "Photostationary states of sensitized cis–trans isomerization against sensitizer triplet energy." },
    balzani: { a: "V. Balzani, F. Bolletta, F. Scandola", t: "Vertical and “nonvertical” energy transfer processes. A general classical treatment", j: "J. Am. Chem. Soc. 1980, 102, 2152–2163", doi: "10.1021/ja00527a002", why: "Why some acceptors give shallower curves than Sandros predicts (non-vertical transfer)." },
    gilmour: { a: "J. J. Molloy, J. B. Metternich, C. G. Daniliuc, A. J. B. Watson, R. Gilmour", t: "Contra-thermodynamic, photocatalytic E→Z isomerization of styrenyl boron species", j: "Angew. Chem. Int. Ed. 2018, 57, 3168–3172", doi: "10.1002/anie.201800286", why: "A modern example of selective E→Z isomerization by energy transfer." },
    glorius: { a: "F. Strieth-Kalthoff, M. J. James, M. Teders, L. Pitzer, F. Glorius", t: "Energy transfer catalysis mediated by visible light: principles, applications, directions", j: "Chem. Soc. Rev. 2018, 47, 7190–7202", doi: "10.1039/C8CS00054A", why: "Review of energy-transfer catalysis and how photocatalysts are chosen." },
    lakowicz: { a: "J. R. Lakowicz", t: "Quenching of fluorescence, in Principles of Fluorescence Spectroscopy, 3rd ed.", j: "Springer, 2006, ch. 8", doi: "10.1007/978-0-387-46312-4_8", why: "Stern–Volmer analysis; dynamic versus static quenching." },
    debye: { a: "P. Debye", t: "Reaction rates in ionic solutions", j: "Trans. Electrochem. Soc. 1942, 82, 265–272", doi: "10.1149/1.3071413", why: "The diffusion-limited rate constant k_diff = 8RT/3η." },
    montalti: { a: "M. Montalti, A. Credi, L. Prodi, M. T. Gandolfi", t: "Handbook of Photochemistry, 3rd ed.", j: "CRC Press, 2006", doi: "10.1201/9781420015195", why: "Tables of triplet energies, solvent viscosities and diffusion rate constants." }
  };
  function refList(keys) {
    var box = el("section", "pe-refs"); box.appendChild(el("h3", null, "Methods and references"));
    var ol = el("ol");
    keys.forEach(function (k) {
      var r = REFS[k], li = el("li");
      li.appendChild(document.createTextNode(r.a + ". " + r.t + ". "));
      li.appendChild(el("i", null, r.j)); li.appendChild(document.createTextNode(". "));
      li.appendChild(Ent.doiLink(r.doi, "doi:" + r.doi));
      li.appendChild(withSubs("span", "pe-why", " " + r.why));
      ol.appendChild(li);
    });
    box.appendChild(ol); return box;
  }

  /* ---------- numbers ---------- */
  var SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻" };
  function sup(n) { return String(n).split("").map(function (c) { return SUP[c] || c; }).join(""); }
  function sci(v, digits) {
    if (!isFinite(v)) return "–";
    if (v === 0) return "0";
    var e = Math.floor(Math.log10(Math.abs(v))), m = v / Math.pow(10, e);
    if (e >= -2 && e <= 3) return v.toPrecision(digits || 3).replace(/\.?0+$/, function (z) { return z.indexOf(".") >= 0 ? "" : z; });
    var ms = m.toFixed((digits || 3) - 1);
    if (Math.abs(parseFloat(ms)) >= 10) { e += 1; ms = (m / 10).toFixed((digits || 3) - 1); }
    return ms + " × 10" + sup(e);
  }
  function fx(v, d) { return isFinite(v) ? v.toFixed(d == null ? 1 : d) : "–"; }
  /* "2.3e9", "2.3E+09", "2,3e9", "2.3x10^9", "2.3×10^9", "2.3 · 10^9" */
  function num(s) {
    s = String(s == null ? "" : s).trim().replace(/\s+/g, "");
    if (!s) return NaN;
    s = s.replace(/[×x·*]10\^?([+-−]?\d+)/i, "e$1").replace("−", "-");
    if (s.indexOf(",") >= 0 && s.indexOf(".") < 0) s = s.replace(",", ".");
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
  }
  function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }
  function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; }
  /* representative E_T of a molecule: experimental values first, else computed */
  function repET(m, expOnly) {
    var vals = m.etExp.length ? m.etExp : (expOnly ? [] : m.etCalc);
    if (!vals.length) return null;
    return { v: mean(vals), lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals), origin: m.etExp.length ? "exp" : "calc", n: vals.length };
  }
  function sandrosRel(gap, T, b) { return 1 / (1 + Math.exp(-gap / ((b || 1) * R_KCAL * T))); }

  /* ---------- SVG plotting ---------- */
  function S(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function TX(parent, x, y, str, cls, anchor) {
    var t = S("text", { x: x, y: y, "class": cls || "pe-tick", "text-anchor": anchor || "middle" }, parent);
    /* "E_T" -> E with a subscript T */
    var re = /([A-Za-zτλ])_(\w+)/g, last = 0, m;
    while ((m = re.exec(str))) {
      t.appendChild(document.createTextNode(str.slice(last, m.index) + m[1]));
      var sb = S("tspan", { "baseline-shift": "sub", "font-size": "0.75em" }, t); sb.textContent = m[2];
      var back = S("tspan", { "baseline-shift": "0" }, t); back.textContent = "\u200b";
      last = re.lastIndex;
    }
    t.appendChild(document.createTextNode(str.slice(last)));
    return t;
  }
  function niceTicks(min, max, n) {
    var span = max - min || 1, step = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var out = [];
    for (var v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  /* o: {w,h,l,r,t,b,x:[a,b],y:[a,b],xl,yl,ylog,y2:[a,b],y2l,aria} -> {svg,X,Y,Y2,plot} */
  function frame(o) {
    var svg = S("svg", { viewBox: "0 0 " + o.w + " " + o.h, "class": "pe-svg", role: "img", "aria-label": o.aria, preserveAspectRatio: "xMidYMid meet" });
    var title = S("title", {}, svg); title.textContent = o.aria;
    var pw = o.w - o.l - o.r, ph = o.h - o.t - o.b;
    function X(v) { return o.l + (v - o.x[0]) / (o.x[1] - o.x[0]) * pw; }
    function Y(v) { return o.t + ph - (v - o.y[0]) / (o.y[1] - o.y[0]) * ph; }
    function Y2(v) { return o.y2 ? o.t + ph - (v - o.y2[0]) / (o.y2[1] - o.y2[0]) * ph : 0; }
    var grid = S("g", { "class": "pe-gridlines" }, svg);
    niceTicks(o.x[0], o.x[1], o.xn || 7).forEach(function (v) {
      S("line", { x1: X(v), x2: X(v), y1: o.t, y2: o.t + ph, "class": "pe-gl" }, grid);
      TX(svg, X(v), o.t + ph + 18, String(v), "pe-tick");
    });
    if (o.ylog) {
      for (var p = Math.ceil(o.y[0]); p <= Math.floor(o.y[1]); p++) {
        S("line", { x1: o.l, x2: o.l + pw, y1: Y(p), y2: Y(p), "class": "pe-gl" }, grid);
        var t = TX(svg, o.l - 8, Y(p) + 4, "10", "pe-tick", "end");
        var sp = S("tspan", { "baseline-shift": "super", "font-size": "9" }, t); sp.textContent = String(p);
      }
    } else {
      niceTicks(o.y[0], o.y[1], o.yn || 5).forEach(function (v) {
        S("line", { x1: o.l, x2: o.l + pw, y1: Y(v), y2: Y(v), "class": "pe-gl" }, grid);
        TX(svg, o.l - 8, Y(v) + 4, String(v), "pe-tick", "end");
      });
    }
    if (o.y2) niceTicks(o.y2[0], o.y2[1], 5).forEach(function (v) { TX(svg, o.l + pw + 8, Y2(v) + 4, String(v), "pe-tick pe-tick2", "start"); });
    S("path", { d: "M" + o.l + " " + o.t + " V" + (o.t + ph) + " H" + (o.l + pw), "class": "pe-axis", fill: "none" }, svg);
    if (o.y2) S("line", { x1: o.l + pw, x2: o.l + pw, y1: o.t, y2: o.t + ph, "class": "pe-axis" }, svg);
    TX(svg, o.l + pw / 2, o.h - 6, o.xl, "pe-label");
    var yl = TX(svg, 0, 0, o.yl, "pe-label"); yl.setAttribute("transform", "translate(14 " + (o.t + ph / 2) + ") rotate(-90)");
    if (o.y2l) { var y2l = TX(svg, 0, 0, o.y2l, "pe-label pe-tick2"); y2l.setAttribute("transform", "translate(" + (o.w - 10) + " " + (o.t + ph / 2) + ") rotate(90)"); }
    var plot = S("g", {}, svg);
    S("clipPath", { id: o.clip }, svg).appendChild(S("rect", { x: o.l, y: o.t - 4, width: pw, height: ph + 8 }));
    plot.setAttribute("clip-path", "url(#" + o.clip + ")");
    return { svg: svg, X: X, Y: Y, Y2: Y2, plot: plot, pw: pw, ph: ph };
  }
  function linePath(pts) { return pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" "); }

  /* ---------- downloads & sharing ---------- */
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  /* the SVG with the theme's colours written in, so it looks the same outside the site */
  function exportSvg(svg, name) {
    var copy = svg.cloneNode(true), src = svg.querySelectorAll("*"), dst = copy.querySelectorAll("*");
    var props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "fill-opacity", "font-family", "font-size", "font-weight"];
    for (var i = 0; i < src.length; i++) {
      var cs = getComputedStyle(src[i]), st = props.map(function (p) { return p + ":" + cs.getPropertyValue(p); }).join(";");
      dst[i].setAttribute("style", st);
    }
    copy.setAttribute("xmlns", NS);
    var bg = document.createElementNS(NS, "rect"); var vb = svg.viewBox.baseVal;
    bg.setAttribute("width", vb.width); bg.setAttribute("height", vb.height);
    bg.setAttribute("fill", getComputedStyle(document.body).getPropertyValue("--surface") || "#fff");
    copy.insertBefore(bg, copy.firstChild);
    download(name, '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(copy), "image/svg+xml");
  }
  function csv(rows) {
    return rows.map(function (r) { return r.map(function (c) { c = c == null ? "" : String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(","); }).join("\n") + "\n";
  }
  function encodeState(o) { try { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); } catch (e) { return ""; } }
  function decodeState(s) {
    if (!s) return null;
    try { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch (e) { return null; }
  }
  var saveTimer = null;
  function saveState(tool, st) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var h = "#plot/" + tool + "/" + encodeState(st);
      if (location.hash !== h) history.replaceState(null, "", h);
    }, 300);
  }
  function actions(buttons) {
    var a = el("div", "actions pe-actions");
    buttons.forEach(function (b) {
      var x = el("button", "btn small", b[0]); x.type = "button"; x.addEventListener("click", b[1]); a.appendChild(x);
    });
    return a;
  }
  function copyLinkBtn() {
    return ["Copy link to this plot", function () {
      var u = location.href;
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { Ent.toast("Link copied. It holds the settings and data of this plot."); },
        function () { window.prompt("Copy this link:", u); });
    }];
  }

  /* ---------- small UI pieces ---------- */
  function field(label, input, hint) {
    var l = el("label", "field"), lt = el("span"); lt.appendChild(subscriptT(label)); l.appendChild(lt); l.appendChild(input);
    if (hint) l.appendChild(withSubs("small", "hint", hint));
    return l;
  }
  function inp(value, type, attrs) {
    var i = el("input"); i.type = type || "text"; i.value = value == null ? "" : value;
    for (var k in (attrs || {})) i.setAttribute(k, attrs[k]);
    return i;
  }
  function check(label, on, onChange) {
    var l = el("label", "pe-check"), c = el("input"); c.type = "checkbox"; c.checked = !!on;
    c.addEventListener("change", function () { onChange(c.checked); });
    l.appendChild(c); l.appendChild(document.createTextNode(" " + label)); return l;
  }
  function etText(r) {
    if (!r) return "–";
    var s = fx(r.v) + (r.n > 1 && r.hi - r.lo >= 0.05 ? " (" + fx(r.lo) + "–" + fx(r.hi) + ")" : "");
    return s + (r.origin === "calc" ? " calc." : "");
  }
  /* search box over the molecules of the database. o: {label, prefer, docs(), onPick(m), placeholder} */
  function molPicker(o) {
    var box = el("div", "pe-picker"), q = inp("", "search", { placeholder: o.placeholder || "Name, CAS number, class or SMILES", autocomplete: "off", spellcheck: "false" });
    var lab = field(o.label, q); box.appendChild(lab);
    var res = el("div", "pe-picker-res"); res.hidden = true; res.setAttribute("role", "listbox"); box.appendChild(res);
    function run() {
      res.replaceChildren();
      var list = Ent.searchCatalog(q.value, o.prefer, o.docs(), 8);
      if (!q.value.trim()) { res.hidden = true; return; }
      res.hidden = false;
      if (!list.length) { res.appendChild(el("p", "hint", "Nothing in the database matches.")); return; }
      list.forEach(function (m) {
        var b = el("button", "rx-result"); b.type = "button"; b.setAttribute("role", "option");
        b.appendChild(Ent.molBox(m.smiles, 70, 50));
        var t = el("span", "rx-result-txt"); t.appendChild(elT("strong", null, m.title));
        var r = repET(m, false);
        t.appendChild(el("small", "rx-meta", (m.donor && m.acceptor ? "donor and acceptor" : m.donor ? "donor" : "acceptor") + (r ? " · E_T " + etText(r) + " kcal/mol" : " · no E_T")));
        b.appendChild(t);
        b.addEventListener("click", function () { q.value = ""; res.hidden = true; o.onPick(m); });
        res.appendChild(b);
      });
    }
    q.addEventListener("input", run);
    q.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); var f = res.querySelector(".rx-result"); if (f) f.click(); }
      if (e.key === "Escape") { res.hidden = true; }
    });
    return box;
  }
  function findMol(docs, smiles) {
    if (!smiles) return null;
    var all = Ent.catalogMolecules(docs);
    for (var i = 0; i < all.length; i++) if (all[i].smiles === smiles) return all[i];
    return null;
  }
  function selectedChip(m, r, onClear) {
    var c = el("div", "pe-selected");
    c.appendChild(Ent.molBox(m.smiles, 80, 56));
    var t = el("div", "rx-result-txt"); t.appendChild(elT("strong", null, m.title));
    t.appendChild(el("small", null, r ? "E_T " + etText(r) + " kcal/mol" : "No triplet energy in the database: type one."));
    c.appendChild(t);
    var x = el("button", "btn tiny", "Change"); x.type = "button"; x.addEventListener("click", onClear); c.appendChild(x);
    return c;
  }

  /* ---------- the tool list ---------- */
  var TOOLS = [
    { id: "finder", title: "Photocatalyst finder", tag: "Uses database values only", tagCls: "pe-tag-db",
      desc: "Pick a substrate and see every donor in the database on one triplet-energy axis: downhill, within ±3 kcal/mol, or uphill, with the relative rate each should give according to the Sandros equation." },
    { id: "sandros", title: "Sandros fit", tag: "Your k_q data + database E_T", tagCls: "pe-tag-you",
      desc: "Enter the quenching rate constants (k_q) of a series of donors, picked from the database, to extrapolate the acceptor’s triplet energy with error bars. A slope shallower than ideal flags non-vertical energy transfer." },
    { id: "pss", title: "E/Z photostationary state", tag: "Database values + optional decay ratio", tagCls: "pe-tag-db",
      desc: "From the triplet energies of both isomers, predict the Z/E ratio across donor energies (the Hammond–Saltiel plot) and see which photocatalysts in the database fall in the window that should give the best ratio." },
    { id: "calc", title: "Calculators", tag: "Quick tools", tagCls: "pe-tag-quick",
      desc: "Stern–Volmer analysis (K_SV and k_q from I₀/I or τ₀/τ), the diffusion limit from the solvent’s viscosity to compare against, and the spread of triplet energies by compound class." }
  ];
  var SKETCH = {
    finder: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><line x1="20" y1="70" x2="360" y2="70" class="pe-axis"/><rect x="168" y="22" width="44" height="96" class="pe-band"/><line x1="190" y1="18" x2="190" y2="120" class="pe-sub" stroke-dasharray="4 3"/><circle cx="60" cy="70" r="7" class="pe-up"/><circle cx="104" cy="70" r="7" class="pe-up"/><circle cx="150" cy="70" r="7" class="pe-up"/><circle cx="182" cy="70" r="7" class="pe-near"/><circle cx="204" cy="70" r="7" class="pe-near"/><circle cx="236" cy="70" r="7" class="pe-down"/><circle cx="266" cy="70" r="7" class="pe-down"/><circle cx="300" cy="70" r="7" class="pe-down"/><circle cx="334" cy="70" r="7" class="pe-down"/><path d="M20 58 C 140 58, 170 40, 210 30 S 300 26, 360 26" class="pe-curve"/></svg>',
    sandros: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><path d="M40 10 V112 H364" class="pe-axis" fill="none"/><path d="M44 104 C 140 104, 170 100, 200 62 S 250 26, 360 24" class="pe-curve"/><line x1="200" y1="14" x2="200" y2="112" class="pe-sub" stroke-dasharray="4 3"/><circle cx="70" cy="102" r="4.5" class="pe-pt"/><circle cx="120" cy="99" r="4.5" class="pe-pt"/><circle cx="168" cy="88" r="4.5" class="pe-pt"/><circle cx="196" cy="66" r="4.5" class="pe-pt"/><circle cx="222" cy="44" r="4.5" class="pe-pt"/><circle cx="262" cy="30" r="4.5" class="pe-pt"/><circle cx="320" cy="26" r="4.5" class="pe-pt"/></svg>',
    pss: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><path d="M40 10 V112 H364" class="pe-axis" fill="none"/><rect x="150" y="12" width="90" height="100" class="pe-goodband"/><path d="M44 92 C 110 92, 140 30, 195 30 S 270 80, 360 84" class="pe-curve"/><circle cx="98" cy="74" r="4.5" class="pe-pt"/><circle cx="184" cy="32" r="4.5" class="pe-pt"/><circle cx="214" cy="36" r="4.5" class="pe-pt"/><circle cx="300" cy="80" r="4.5" class="pe-pt"/></svg>',
    calc: '<svg viewBox="0 0 380 130" class="pe-sketch" aria-hidden="true"><path d="M60 10 V112 H330" class="pe-axis" fill="none"/><line x1="62" y1="104" x2="320" y2="20" class="pe-curve"/><circle cx="90" cy="95" r="4.5" class="pe-pt"/><circle cx="150" cy="76" r="4.5" class="pe-pt"/><circle cx="210" cy="56" r="4.5" class="pe-pt"/><circle cx="270" cy="37" r="4.5" class="pe-pt"/></svg>'
  };
  function subscriptT(s) {
    /* "E_T" and "k_q" style labels -> text with <sub> */
    var frag = document.createDocumentFragment(), re = /([A-Za-zτλ])_(\w+|SV)/g, last = 0, m;
    while ((m = re.exec(s))) {
      frag.appendChild(document.createTextNode(s.slice(last, m.index) + m[1]));
      frag.appendChild(el("sub", null, m[2])); last = re.lastIndex;
    }
    frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  }
  function withSubs(tag, cls, s) { var e = el(tag, cls); e.appendChild(subscriptT(s)); return e; }

  function pickerPage(root) {
    var head = el("section", "pe-head");
    var h = el("h2", "pe-title"); h.appendChild(document.createTextNode("Plot")); h.appendChild(el("span", "en", "EnT")); head.appendChild(h);
    head.appendChild(el("p", "lede", "Plots and calculators for triplet energy transfer, built on the values in the database. Everything runs in your browser and nothing you type is stored; each plot downloads as SVG or CSV and can be shared as a link."));
    var grid = el("div", "pe-grid");
    TOOLS.forEach(function (t) {
      var a = el("article", "pe-tool");
      var pic = el("div", "pe-tool-pic"); pic.innerHTML = SKETCH[t.id]; a.appendChild(pic);
      a.appendChild(el("h3", null, t.title));
      a.appendChild(withSubs("p", null, t.desc));
      var foot = el("div", "pe-tool-foot");
      foot.appendChild(withSubs("span", "pe-tag " + t.tagCls, t.tag));
      var open = el("a", "btn primary small", "Open"); open.href = "#plot/" + t.id; open.setAttribute("aria-label", "Open " + t.title);
      foot.appendChild(open); a.appendChild(foot);
      grid.appendChild(a);
    });
    var note = el("aside", "pe-note");
    note.appendChild(el("h3", null, "What the models assume"));
    note.appendChild(withSubs("p", null, "Sandros assumes vertical energy transfer and the same diffusion rate for every pair. Experimental E_T values are used first; when a molecule has several, their spread is shown as a range. Predictions are a guide for choosing experiments, not a substitute for them."));
    root.replaceChildren(head, grid, note);
  }
  function toolShell(root, tool, intro) {
    var t = TOOLS.filter(function (x) { return x.id === tool; })[0];
    var back = el("a", "pe-back", "← All PlotEnT tools"); back.href = "#plot";
    var h = el("h2", "pe-title", t.title);
    var lede = withSubs("p", "lede", intro || t.desc);
    var body = el("div", "pe-body");
    root.replaceChildren(back, h, lede, body);
    return body;
  }
  function needData(ctx, body) {
    if (ctx.loaded()) return false;
    body.appendChild(el("p", "status", ctx.failed && ctx.failed() ? "The database could not be loaded. Reload the page to try again." : "Loading the database…"));
    return true;
  }

  /* =====================================================================
     1. Photocatalyst finder
     ===================================================================== */
  function finder(root, ctx, init) {
    var st = Object.assign({ sub: "", et: "", T: 298, win: 3, donors: true, exp: false, sort: "above" }, init || {});
    var body = toolShell(root, "finder");
    if (needData(ctx, body)) return;
    var docs = ctx.docs();
    var left = el("div", "pe-panel");
    var subBox = el("div"); left.appendChild(subBox);
    var etIn = inp(st.et, "text", { inputmode: "decimal", placeholder: "e.g. 61.5" });
    left.appendChild(field("…or type the substrate’s E_T (kcal/mol)", etIn, "A typed value is used instead of the database value."));
    var opts = el("div", "frow");
    var tIn = inp(st.T, "number", { min: "150", max: "500", step: "1" }), wIn = inp(st.win, "number", { min: "0.5", max: "10", step: "0.5" });
    opts.appendChild(field("Temperature (K)", tIn)); opts.appendChild(field("Window (± kcal/mol)", wIn));
    left.appendChild(opts);
    left.appendChild(check("Donors only", st.donors, function (v) { st.donors = v; update(); }));
    left.appendChild(check("Experimental values only", st.exp, function (v) { st.exp = v; update(); }));
    var out = el("div", "pe-out");
    body.appendChild(left); body.appendChild(out);
    body.appendChild(refList(["sandros", "herk", "glorius", "montalti"]));

    function drawSub() {
      subBox.replaceChildren();
      var m = findMol(docs, st.sub);
      if (m) subBox.appendChild(selectedChip(m, repET(m, st.exp), function () { st.sub = ""; drawSub(); update(); }));
      else subBox.appendChild(molPicker({ label: "Substrate (acceptor) from the database", prefer: "acceptor", docs: function () { return docs; },
        onPick: function (pm) { st.sub = pm.smiles; drawSub(); update(); } }));
    }
    etIn.addEventListener("input", function () { st.et = etIn.value; update(); });
    tIn.addEventListener("input", function () { st.T = num(tIn.value) || 298; update(); });
    wIn.addEventListener("input", function () { st.win = num(wIn.value) || 3; update(); });

    function update() {
      saveState("finder", st);
      out.replaceChildren();
      var subM = findMol(docs, st.sub), typed = num(st.et);
      var Ea = isFinite(typed) ? typed : (subM && repET(subM, st.exp) ? repET(subM, st.exp).v : NaN);
      if (!isFinite(Ea)) { out.appendChild(withSubs("p", "status", "Choose a substrate from the database or type its E_T to see the donors.")); return; }
      var T = st.T, win = st.win;
      var donors = Ent.catalogMolecules(docs).filter(function (m) { return (!st.donors || m.donor) && (!subM || m.smiles !== subM.smiles); })
        .map(function (m) { var r = repET(m, st.exp); return r ? { m: m, r: r, d: r.v - Ea, rel: sandrosRel(r.v - Ea, T) } : null; })
        .filter(Boolean);
      if (!donors.length) { out.appendChild(el("p", "status", "No donors with a triplet energy match these settings.")); return; }
      donors.forEach(function (x) { x.cat = x.d >= win ? "down" : x.d <= -win ? "up" : "near"; });
      var xs = donors.map(function (x) { return x.r.v; }).concat([Ea]);
      var x0 = Math.floor(Math.min.apply(null, xs) - 3), x1 = Math.ceil(Math.max.apply(null, xs) + 3);
      var f = frame({ w: 760, h: 380, l: 64, r: 20, t: 22, b: 48, x: [x0, x1], y: [0, 1.05], xl: "Donor triplet energy E_T (kcal/mol)", yl: "Predicted k_q / k_diff (Sandros)",
        aria: "Donors of the database placed on the Sandros curve for a substrate with E_T " + fx(Ea) + " kcal/mol", clip: "pe-clip-f" });
      S("rect", { x: f.X(Ea - win), y: f.Y(1.05), width: f.X(Ea + win) - f.X(Ea - win), height: f.Y(0) - f.Y(1.05), "class": "pe-band" }, f.plot);
      S("line", { x1: f.X(Ea), x2: f.X(Ea), y1: f.Y(1.05), y2: f.Y(0), "class": "pe-sub", "stroke-dasharray": "5 4" }, f.plot);
      TX(f.svg, f.X(Ea) + 6, f.Y(1.0) + 2, "substrate " + fx(Ea), "pe-note-t", "start");
      var pts = []; for (var i = 0; i <= 240; i++) { var v = x0 + (x1 - x0) * i / 240; pts.push([f.X(v), f.Y(sandrosRel(v - Ea, T))]); }
      S("path", { d: linePath(pts), "class": "pe-curve" }, f.plot);
      donors.forEach(function (x) {
        if (x.r.hi - x.r.lo >= 0.05) S("line", { x1: f.X(x.r.lo), x2: f.X(x.r.hi), y1: f.Y(x.rel), y2: f.Y(x.rel), "class": "pe-range pe-" + x.cat }, f.plot);
        var c = S("circle", { cx: f.X(x.r.v), cy: f.Y(x.rel), r: 5.5, "class": "pe-dot pe-" + x.cat + (x.r.origin === "calc" ? " pe-hollow" : "") }, f.plot);
        var tt = S("title", {}, c); tt.textContent = x.m.title + ": E_T " + etText(x.r) + " kcal/mol, ΔE_T " + (x.d >= 0 ? "+" : "") + fx(x.d) + ", k_q/k_diff " + x.rel.toFixed(2);
      });
      var plotBox = el("div", "pe-plot"); plotBox.appendChild(f.svg); out.appendChild(plotBox);
      var counts = { down: 0, near: 0, up: 0 }; donors.forEach(function (x) { counts[x.cat]++; });
      var leg = el("div", "pe-legend");
      [["down", "Downhill (ΔE_T ≥ +" + win + ")"], ["near", "Within ±" + win + " (reversible)"], ["up", "Uphill (ΔE_T ≤ −" + win + ")"]].forEach(function (c) {
        var s = el("span", "pe-key"); s.appendChild(el("i", "pe-sw pe-" + c[0])); s.appendChild(subscriptT(c[1] + ": " + counts[c[0]])); leg.appendChild(s);
      });
      var hk = el("span", "pe-key"); hk.appendChild(el("i", "pe-sw pe-hollow")); hk.appendChild(document.createTextNode("hollow = computed value")); leg.appendChild(hk);
      out.appendChild(leg);

      var sorted = donors.slice().sort(function (a, b) {
        if (st.sort === "high") return b.r.v - a.r.v;
        var ua = a.d >= 0, ub = b.d >= 0;
        if (ua !== ub) return ua ? -1 : 1;
        return ua ? a.d - b.d : b.d - a.d;
      });
      var sortSel = el("select"); [["above", "Closest above the substrate first"], ["high", "Highest E_T first"]].forEach(function (o) {
        var op = el("option", null, o[1]); op.value = o[0]; op.selected = st.sort === o[0]; sortSel.appendChild(op);
      });
      sortSel.addEventListener("change", function () { st.sort = sortSel.value; update(); });
      var bar = el("div", "pe-tablebar"); bar.appendChild(field("Order", sortSel));
      bar.appendChild(actions([
        ["Download SVG", function () { exportSvg(f.svg, "plotent-finder.svg"); }],
        ["Download CSV", function () {
          download("plotent-finder.csv", csv([["molecule", "E_T_kcal", "origin", "dE_T_kcal", "kq_over_kdiff", "uv_lmax_nm", "class"]].concat(sorted.map(function (x) {
            return [x.m.title, x.r.v.toFixed(2), x.r.origin, x.d.toFixed(2), x.rel.toFixed(4), x.m.uv || "", x.m.cls];
          }))), "text/csv");
        }],
        copyLinkBtn()
      ]));
      out.appendChild(bar);
      out.appendChild(table(["Molecule", "E_T (kcal/mol)", "ΔE_T", "k_q / k_diff", "λ_max (nm)", "Class"], sorted.map(function (x) {
        var name = el("button", "pe-link", x.m.title); name.type = "button"; name.title = "Show it in the database";
        name.addEventListener("click", function () { ctx.searchDb(x.m.title); });
        var cat = el("span", "pe-catdot pe-" + x.cat); cat.setAttribute("aria-hidden", "true");
        var nm = el("span"); nm.appendChild(cat); nm.appendChild(name);
        return [nm, etText(x.r), (x.d >= 0 ? "+" : "") + fx(x.d), x.rel.toFixed(2), x.m.uv ? String(Math.round(x.m.uv)) : "–", x.m.cls || "–"];
      }), 40));
    }
    drawSub(); update();
  }
  function table(head, rows, limit) {
    var wrap = el("div", "pe-tablewrap"), t = el("table", "pe-table"), tr = el("tr");
    head.forEach(function (h) { var th = el("th"); th.appendChild(subscriptT(h)); tr.appendChild(th); });
    var thead = el("thead"); thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody"); t.appendChild(tb);
    function fill(n) {
      tb.replaceChildren();
      rows.slice(0, n).forEach(function (r) {
        var row = el("tr");
        r.forEach(function (c) { var td = el("td"); if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? "" : String(c); row.appendChild(td); });
        tb.appendChild(row);
      });
    }
    fill(limit || rows.length); wrap.appendChild(t);
    if (limit && rows.length > limit) {
      var more = el("button", "btn small", "Show all " + rows.length); more.type = "button";
      more.addEventListener("click", function () { fill(rows.length); more.remove(); });
      wrap.appendChild(more);
    }
    return wrap;
  }

  /* =====================================================================
     2. Sandros fit
     ===================================================================== */
  /* model: log10 kq = log10 kd − log10(1 + exp(−(Ed − Ea)/(b R T))); p = [log10 kd, Ea, b] */
  function sandrosLog(p, Ed, T) { return p[0] - Math.log10(1 + Math.exp(-(Ed - p[1]) / (p[2] * R_KCAL * T))); }
  function solve(A, bvec) {
    var n = bvec.length, M = A.map(function (r, i) { return r.concat([bvec[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c; for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-14) return null;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      for (r = 0; r < n; r++) if (r !== c) { var f = M[r][c] / M[c][c]; for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map(function (r, i) { return r[n] / r[i]; });
  }
  function invert(A) {
    var n = A.length, out = [];
    for (var i = 0; i < n; i++) { var e = []; for (var j = 0; j < n; j++) e.push(i === j ? 1 : 0); var col = solve(A, e); if (!col) return null; out.push(col); }
    return A.map(function (_, i) { return out.map(function (c) { return c[i]; }); });
  }
  /* pts [{x: Ed, y: log10 kq}], free: indices of the parameters that are fitted */
  function fitSandros(pts, T, opt) {
    var ys = pts.map(function (q) { return q.y; }), xs = pts.map(function (q) { return q.x; });
    var lkd = opt.kdFix ? Math.log10(opt.kdFix) : Math.max.apply(null, ys) + 0.05;
    /* start: linearise ln(kd/kq − 1) = −(Ed − Ea)/(bRT) on the points below the plateau */
    var Ea0 = median(xs), b0 = 1, lin = pts.filter(function (q) { return q.y < lkd - 0.02; }).map(function (q) {
      return { x: q.x, z: Math.log(Math.pow(10, lkd - q.y) - 1) };
    });
    if (lin.length >= 2) {
      var mx = mean(lin.map(function (q) { return q.x; })), mz = mean(lin.map(function (q) { return q.z; }));
      var sxx = lin.reduce(function (s, q) { return s + (q.x - mx) * (q.x - mx); }, 0), sxz = lin.reduce(function (s, q) { return s + (q.x - mx) * (q.z - mz); }, 0);
      if (sxx > 0 && sxz < 0) {
        var m = sxz / sxx, c = mz - m * mx;
        Ea0 = -c / m; if (opt.bFree) b0 = Math.min(5, Math.max(0.3, -1 / (m * R_KCAL * T)));
      }
    }
    var p = [lkd, Ea0, b0], free = [];
    if (!opt.kdFix) free.push(0); free.push(1); if (opt.bFree) free.push(2);
    function resid(pp) { return pts.map(function (q) { return q.y - sandrosLog(pp, q.x, T); }); }
    function ssr(pp) { return resid(pp).reduce(function (s, r) { return s + r * r; }, 0); }
    function jac(pp) {
      return pts.map(function (q) {
        return free.map(function (k) {
          var h = k === 2 ? 1e-4 : 1e-5, a = pp.slice(), b = pp.slice(); a[k] += h; b[k] -= h;
          return (sandrosLog(a, q.x, T) - sandrosLog(b, q.x, T)) / (2 * h);
        });
      });
    }
    var lam = 1e-3, cur = ssr(p);
    for (var it = 0; it < 200; it++) {
      var J = jac(p), r = resid(p), n = free.length;
      var JtJ = [], Jtr = [];
      for (var i = 0; i < n; i++) { JtJ.push([]); Jtr.push(0); for (var j = 0; j < n; j++) JtJ[i].push(0); }
      J.forEach(function (row, k) { for (var i = 0; i < n; i++) { Jtr[i] += row[i] * r[k]; for (var j = 0; j < n; j++) JtJ[i][j] += row[i] * row[j]; } });
      var A = JtJ.map(function (row, i) { return row.map(function (v, j) { return i === j ? v * (1 + lam) + 1e-12 : v; }); });
      var step = solve(A, Jtr);
      if (!step) break;
      var trial = p.slice(); free.forEach(function (k, i) { trial[k] += step[i]; });
      if (trial[2] <= 0.05) trial[2] = 0.05;
      var nss = ssr(trial);
      if (nss < cur) {
        var done = Math.abs(cur - nss) < 1e-12 * (1 + cur);
        p = trial; cur = nss; lam = Math.max(lam / 3, 1e-9);
        if (done) break;
      } else { lam *= 4; if (lam > 1e8) break; }
    }
    var dof = pts.length - free.length, cov = null, err = [NaN, NaN, NaN];
    if (dof > 0) {
      var J2 = jac(p), n2 = free.length, M = [];
      for (var a = 0; a < n2; a++) { M.push([]); for (var b2 = 0; b2 < n2; b2++) M[a].push(0); }
      J2.forEach(function (row) { for (var a = 0; a < n2; a++) for (var b2 = 0; b2 < n2; b2++) M[a][b2] += row[a] * row[b2]; });
      cov = invert(M);
      if (cov) { var s2 = cur / dof; free.forEach(function (k, i) { err[k] = Math.sqrt(Math.max(0, cov[i][i] * s2)); }); }
    }
    return { p: p, err: err, rms: Math.sqrt(cur / pts.length), dof: dof, n: pts.length, nfree: free.length };
  }

  function sandros(root, ctx, init) {
    var st = Object.assign({ rows: [], T: 298, bFree: false, kdFix: "", acc: "" }, init || {});
    if (!Array.isArray(st.rows)) st.rows = [];
    var body = toolShell(root, "sandros");
    if (needData(ctx, body)) return;
    var docs = ctx.docs();
    var left = el("div", "pe-panel");
    var accIn = inp(st.acc, "text", { placeholder: "e.g. (E)-stilbene" });
    left.appendChild(field("Acceptor (label for the plot, optional)", accIn));
    left.appendChild(molPicker({ label: "Add a donor from the database", prefer: "donor", docs: function () { return docs; },
      onPick: function (m) { var r = repET(m, false); st.rows.push({ name: m.title, et: r ? r.v.toFixed(1) : "", kq: "" }); drawRows(); update(); } }));
    var rowsBox = el("div", "pe-rows"); left.appendChild(rowsBox);
    var addRow = el("button", "btn small", "+ Add an empty row"); addRow.type = "button";
    addRow.addEventListener("click", function () { st.rows.push({ name: "", et: "", kq: "" }); drawRows(); });
    left.appendChild(addRow);
    var paste = el("details", "pe-paste"); paste.appendChild(el("summary", null, "Paste data from a spreadsheet"));
    var ta = el("textarea"); ta.rows = 4; ta.placeholder = "One donor per line: name, E_T (kcal/mol), k_q (M⁻¹ s⁻¹)\nThioxanthone, 63.4, 6.1e9\nBenzophenone; 69.0; 8.0e9";
    var pb = el("button", "btn small", "Add these rows"); pb.type = "button";
    pb.addEventListener("click", function () {
      var added = 0;
      ta.value.split(/\n/).forEach(function (line) {
        var c = line.split(/[\t;,]\s*(?=[^,;\t]*$)|[\t;]|,(?=\s*[-+.\d])/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ""; });
        if (c.length < 2) return;
        var kq = c[c.length - 1], et = c[c.length - 2], name = c.slice(0, -2).join(" ");
        if (!isFinite(num(et)) || !isFinite(num(kq))) return;
        st.rows.push({ name: name, et: et, kq: kq }); added++;
      });
      if (added) { ta.value = ""; drawRows(); update(); Ent.toast(added + (added === 1 ? " row added." : " rows added.")); }
      else Ent.toast("No line could be read. Use: name, E_T, k_q.");
    });
    paste.appendChild(ta); paste.appendChild(pb); left.appendChild(paste);
    var opts = el("div", "frow");
    var tIn = inp(st.T, "number", { min: "150", max: "500", step: "1" }), kdIn = inp(st.kdFix, "text", { placeholder: "fitted", inputmode: "decimal" });
    opts.appendChild(field("Temperature (K)", tIn)); opts.appendChild(field("Fix k_diff (M⁻¹ s⁻¹)", kdIn, "Leave empty to fit it."));
    left.appendChild(opts);
    left.appendChild(check("Free slope factor (detects non-vertical transfer)", st.bFree, function (v) { st.bFree = v; update(); }));
    var out = el("div", "pe-out");
    body.appendChild(left); body.appendChild(out);
    body.appendChild(sandrosTips());
    body.appendChild(refList(["sandros", "herk", "balzani", "lakowicz", "montalti"]));

    accIn.addEventListener("input", function () { st.acc = accIn.value; update(); });
    tIn.addEventListener("input", function () { st.T = num(tIn.value) || 298; update(); });
    kdIn.addEventListener("input", function () { st.kdFix = kdIn.value; update(); });

    function drawRows() {
      rowsBox.replaceChildren();
      if (!st.rows.length) { rowsBox.appendChild(el("p", "hint", "No donors yet. Add them from the database, as empty rows, or paste them.")); return; }
      var head = el("div", "pe-row pe-row-head");
      ["Donor", "E_T (kcal/mol)", "k_q (M⁻¹ s⁻¹)", ""].forEach(function (h) { head.appendChild(withSubs("span", null, h)); });
      rowsBox.appendChild(head);
      st.rows.forEach(function (r, i) {
        var row = el("div", "pe-row");
        var n = inp(r.name, "text", { "aria-label": "Donor " + (i + 1) + " name" }),
            e = inp(r.et, "text", { inputmode: "decimal", "aria-label": "Donor " + (i + 1) + " triplet energy" }),
            k = inp(r.kq, "text", { inputmode: "decimal", placeholder: "e.g. 2.3e9", "aria-label": "Donor " + (i + 1) + " quenching rate constant" });
        n.addEventListener("input", function () { r.name = n.value; update(); });
        e.addEventListener("input", function () { r.et = e.value; e.classList.toggle("bad", e.value !== "" && !isFinite(num(e.value))); update(); });
        k.addEventListener("input", function () { r.kq = k.value; k.classList.toggle("bad", k.value !== "" && !(num(k.value) > 0)); update(); });
        var x = el("button", "btn tiny", "×"); x.type = "button"; x.setAttribute("aria-label", "Remove donor " + (i + 1));
        x.addEventListener("click", function () { st.rows.splice(i, 1); drawRows(); update(); });
        row.appendChild(n); row.appendChild(e); row.appendChild(k); row.appendChild(x);
        rowsBox.appendChild(row);
      });
    }

    function update() {
      saveState("sandros", st);
      out.replaceChildren();
      var T = st.T, kdFix = num(st.kdFix);
      var pts = st.rows.map(function (r) { var x = num(r.et), k = num(r.kq); return isFinite(x) && k > 0 ? { x: x, y: Math.log10(k), name: r.name } : null; }).filter(Boolean);
      var need = (isFinite(kdFix) && kdFix > 0 ? 1 : 2) + (st.bFree ? 1 : 0);
      if (pts.length < need) {
        out.appendChild(withSubs("p", "status", "Enter E_T and k_q for at least " + (need + 1) + " donors (" + need + " to fit, one more for error bars)."));
        return;
      }
      var fit = fitSandros(pts, T, { bFree: st.bFree, kdFix: isFinite(kdFix) && kdFix > 0 ? kdFix : null });
      var p = fit.p, Ea = p[1];
      var xs = pts.map(function (q) { return q.x; }).concat([Ea]);
      var x0 = Math.floor(Math.min.apply(null, xs) - 4), x1 = Math.ceil(Math.max.apply(null, xs) + 4);
      var ys = pts.map(function (q) { return q.y; }).concat([p[0]]);
      var curveMin = sandrosLog(p, x0, T);
      var y0 = Math.floor(Math.min(Math.min.apply(null, ys), Math.max(curveMin, Math.min.apply(null, ys) - 2)) - 0.3), y1 = Math.ceil(Math.max.apply(null, ys) + 0.4);
      var f = frame({ w: 760, h: 400, l: 64, r: 20, t: 22, b: 48, x: [x0, x1], y: [y0, y1], ylog: true,
        xl: "Donor triplet energy E_T (kcal/mol)", yl: "k_q (M⁻¹ s⁻¹)", aria: "Sandros fit of quenching rate constants against donor triplet energy" + (st.acc ? " for " + st.acc : ""), clip: "pe-clip-s" });
      if (isFinite(fit.err[1])) S("rect", { x: f.X(Ea - fit.err[1]), y: f.Y(y1), width: Math.max(1, f.X(Ea + fit.err[1]) - f.X(Ea - fit.err[1])), height: f.Y(y0) - f.Y(y1), "class": "pe-band" }, f.plot);
      S("line", { x1: f.X(Ea), x2: f.X(Ea), y1: f.Y(y1), y2: f.Y(y0), "class": "pe-sub", "stroke-dasharray": "5 4" }, f.plot);
      S("line", { x1: f.X(x0), x2: f.X(x1), y1: f.Y(p[0]), y2: f.Y(p[0]), "class": "pe-plateau", "stroke-dasharray": "2 4" }, f.plot);
      TX(f.svg, f.X(x1) - 4, f.Y(p[0]) - 6, "k_diff", "pe-note-t", "end");
      TX(f.svg, f.X(Ea) + 6, f.Y(y0) - 8, "E_T(A) " + fx(Ea), "pe-note-t", "start");
      var pts2 = []; for (var i = 0; i <= 240; i++) { var v = x0 + (x1 - x0) * i / 240; pts2.push([f.X(v), f.Y(sandrosLog(p, v, T))]); }
      S("path", { d: linePath(pts2), "class": "pe-curve" }, f.plot);
      pts.forEach(function (q) {
        var c = S("circle", { cx: f.X(q.x), cy: f.Y(q.y), r: 5.5, "class": "pe-dot pe-pt" }, f.plot);
        S("title", {}, c).textContent = (q.name || "donor") + ": E_T " + fx(q.x) + ", k_q " + sci(Math.pow(10, q.y), 2);
      });
      var plotBox = el("div", "pe-plot"); plotBox.appendChild(f.svg); out.appendChild(plotBox);

      var res = el("dl", "pe-result");
      function item(k, v, note) { var d = el("div"); d.appendChild(withSubs("dt", null, k)); var dd = el("dd", null, v); if (note) dd.appendChild(el("small", null, note)); d.appendChild(dd); res.appendChild(d); }
      item("E_T of the acceptor" + (st.acc ? " (" + st.acc + ")" : ""), fx(Ea) + (isFinite(fit.err[1]) ? " ± " + fx(fit.err[1]) : "") + " kcal/mol", isFinite(fit.err[1]) ? "±1σ from the fit" : "add a point for error bars");
      item("k_diff", sci(Math.pow(10, p[0]), 2) + " M⁻¹ s⁻¹", isFinite(kdFix) && kdFix > 0 ? "fixed" : (isFinite(fit.err[0]) ? "log₁₀ ± " + fit.err[0].toFixed(2) : ""));
      if (st.bFree) item("Slope factor", p[2].toFixed(2) + (isFinite(fit.err[2]) ? " ± " + fit.err[2].toFixed(2) : ""), "1 = ideal Sandros behaviour");
      item("Fit quality", "rms " + fit.rms.toFixed(2) + " log units", fit.n + " points, " + fit.nfree + " fitted parameters");
      out.appendChild(res);

      var warn = [];
      var nearCount = pts.filter(function (q) { return Math.abs(q.x - Ea) <= 4; }).length;
      if (nearCount < 2) warn.push("Fewer than two donors lie within ±4 kcal/mol of the fitted E_T: the extrapolation rests on the tails of the curve. Add donors close to it.");
      if (Ea < Math.min.apply(null, pts.map(function (q) { return q.x; })) || Ea > Math.max.apply(null, pts.map(function (q) { return q.x; })))
        warn.push("The fitted E_T lies outside the range of donor energies used: treat it as an extrapolation.");
      if (st.bFree && p[2] > 1.3) warn.push("The slope factor is above 1.3: the curve is shallower than Sandros predicts, as for non-vertical acceptors (Balzani et al., 1980). The fitted E_T is then an operational value, not the spectroscopic one.");
      if (fit.rms > 0.25) warn.push("The points scatter more than 0.25 log units around the curve. Check for donors that also quench by electron transfer, or for static quenching.");
      if (warn.length) { var w = el("ul", "pe-warn"); warn.forEach(function (t) { w.appendChild(withSubs("li", null, t)); }); out.appendChild(w); }

      out.appendChild(actions([
        ["Download SVG", function () { exportSvg(f.svg, "plotent-sandros.svg"); }],
        ["Download CSV", function () {
          download("plotent-sandros.csv", csv([["donor", "E_T_kcal", "kq_M-1s-1", "kq_fit_M-1s-1"]].concat(pts.map(function (q) {
            return [q.name, q.x, Math.pow(10, q.y).toExponential(3), Math.pow(10, sandrosLog(p, q.x, T)).toExponential(3)];
          })).concat([[], ["E_T(A)_kcal", Ea.toFixed(2), "sigma", isFinite(fit.err[1]) ? fit.err[1].toFixed(2) : ""], ["kdiff", Math.pow(10, p[0]).toExponential(3)], ["slope_factor", p[2].toFixed(3)], ["T_K", T]])), "text/csv");
        }],
        copyLinkBtn()
      ]));
    }
    drawRows(); update();
  }
  function sandrosTips() {
    var d = el("details", "pe-tips"); d.open = true;
    d.appendChild(withSubs("summary", null, "How to measure k_q for a reliable Sandros extrapolation"));
    var ul = el("ul");
    [
      "Prefer time-resolved data: follow the donor’s triplet decay by laser flash photolysis at several acceptor concentrations; the slope of k_obs against [Q] is k_q. Lifetime data (τ₀/τ) also tell dynamic from static quenching, which steady-state intensities cannot.",
      "Remove oxygen thoroughly (three or more freeze–pump–thaw cycles, or long argon sparging): O₂ quenches triplets at about 10⁹–10¹⁰ M⁻¹ s⁻¹ and flattens every point.",
      "Use at least four or five acceptor concentrations that quench 10–80 % of the triplets, and check that the Stern–Volmer plot is linear.",
      "Excite only the donor: the acceptor must not absorb at the excitation wavelength, and correct for inner-filter effects if it absorbs nearby.",
      "Measure all donors in the same solvent and at the same temperature, since k_diff depends on viscosity. Report the temperature and enter it above.",
      "Choose donors that span about ±10 kcal/mol around the expected E_T, with at least two or three in the steep part of the curve; the plateau points fix k_diff.",
      "Take donor E_T values of the same kind (phosphorescence 0–0 energies, ideally in a similar solvent). Mixing them with computed vertical values blurs the fit.",
      "Leave out donors that could quench by electron transfer instead (check their excited-state redox potentials against the acceptor) or that form exciplexes.",
      "If the slope stays shallow even with good data, the acceptor is probably non-vertical (twisting alkenes, strained rings): free the slope factor and read the fitted E_T as an operational value.",
      "Repeat each k_q at least twice; the fit works in log units, so a 20 % error weighs the same at 10⁷ and at 10¹⁰ M⁻¹ s⁻¹."
    ].forEach(function (t) { ul.appendChild(withSubs("li", null, t)); });
    d.appendChild(ul); return d;
  }

  /* =====================================================================
     3. E/Z photostationary state (Hammond–Saltiel)
     ===================================================================== */
  function pss(root, ctx, init) {
    var st = Object.assign({ subE: "", subZ: "", eE: "", eZ: "", beta: 0.5, bE: 1, bZ: 1, T: 298, exp: false, minRate: 0.01 }, init || {});
    var body = toolShell(root, "pss");
    if (needData(ctx, body)) return;
    var docs = ctx.docs();
    var left = el("div", "pe-panel");
    var eBox = el("div"), zBox = el("div");
    var eIn = inp(st.eE, "text", { inputmode: "decimal", placeholder: "from the database" }), zIn = inp(st.eZ, "text", { inputmode: "decimal", placeholder: "from the database" });
    left.appendChild(eBox); left.appendChild(field("E_T of the E isomer (kcal/mol, overrides the database)", eIn));
    left.appendChild(zBox); left.appendChild(field("E_T of the Z isomer (kcal/mol, overrides the database)", zIn));
    var o1 = el("div", "frow");
    var bIn = inp(st.beta, "number", { min: "0.01", max: "0.99", step: "0.01" }), tIn = inp(st.T, "number", { min: "150", max: "500", step: "1" });
    o1.appendChild(field("Fraction of triplets decaying to Z", bIn, "0.5 if unknown (one twisted triplet)")); o1.appendChild(field("Temperature (K)", tIn));
    left.appendChild(o1);
    var o2 = el("div", "frow");
    var beIn = inp(st.bE, "number", { min: "0.3", max: "5", step: "0.1" }), bzIn = inp(st.bZ, "number", { min: "0.3", max: "5", step: "0.1" });
    o2.appendChild(field("Slope factor, E", beIn)); o2.appendChild(field("Slope factor, Z", bzIn, "Above 1 for a non-vertical isomer"));
    left.appendChild(o2);
    left.appendChild(check("Experimental values only", st.exp, function (v) { st.exp = v; drawPick(); update(); }));
    var out = el("div", "pe-out");
    body.appendChild(left); body.appendChild(out);
    var note = el("details", "pe-tips");
    note.appendChild(el("summary", null, "How the prediction works"));
    note.appendChild(withSubs("p", null, "Both isomers are excited by the same donor at Sandros rates k_E and k_Z (same k_diff). If a fraction β of the triplets relaxes to Z, the photostationary ratio is Z/E = (k_E / k_Z) · β / (1 − β). Donors far below both isomers give the highest ratio but excite slowly, so the plot also shows the relative rate of exciting the E isomer; the table hides donors slower than the limit you set. Direct absorption by the alkene, side reactions and different k_diff values are not included."));
    body.appendChild(note);
    body.appendChild(refList(["hammond", "sandros", "balzani", "gilmour", "glorius"]));

    function pickBox(box, key, label) {
      box.replaceChildren();
      var m = findMol(docs, st[key]);
      if (m) box.appendChild(selectedChip(m, repET(m, st.exp), function () { st[key] = ""; drawPick(); update(); }));
      else box.appendChild(molPicker({ label: label, prefer: "acceptor", docs: function () { return docs; }, onPick: function (pm) { st[key] = pm.smiles; drawPick(); update(); } }));
    }
    function drawPick() { pickBox(eBox, "subE", "E isomer from the database"); pickBox(zBox, "subZ", "Z isomer from the database"); }
    [[eIn, "eE"], [zIn, "eZ"]].forEach(function (p) { p[0].addEventListener("input", function () { st[p[1]] = p[0].value; update(); }); });
    [[bIn, "beta", 0.5], [tIn, "T", 298], [beIn, "bE", 1], [bzIn, "bZ", 1]].forEach(function (p) {
      p[0].addEventListener("input", function () { var v = num(p[0].value); st[p[1]] = isFinite(v) && v > 0 ? v : p[2]; update(); });
    });
    function isoET(key, typedKey) {
      var t = num(st[typedKey]); if (isFinite(t)) return t;
      var m = findMol(docs, st[key]), r = m ? repET(m, st.exp) : null;
      return r ? r.v : NaN;
    }
    function update() {
      saveState("pss", st);
      out.replaceChildren();
      var EE = isoET("subE", "eE"), EZ = isoET("subZ", "eZ"), T = st.T, beta = Math.min(0.99, Math.max(0.01, st.beta));
      if (!isFinite(EE) || !isFinite(EZ)) { out.appendChild(withSubs("p", "status", "Choose both isomers from the database or type their E_T values.")); return; }
      function ratio(Ed) {
        var kE = sandrosRel(Ed - EE, T, st.bE), kZ = sandrosRel(Ed - EZ, T, st.bZ);
        return { r: (kE / kZ) * beta / (1 - beta), kE: kE };
      }
      var lo = Math.min(EE, EZ), hi = Math.max(EE, EZ);
      var donors = Ent.catalogMolecules(docs).filter(function (m) { return m.donor && m.smiles !== st.subE && m.smiles !== st.subZ; })
        .map(function (m) { var r = repET(m, st.exp); if (!r) return null; var q = ratio(r.v); return { m: m, r: r, ratio: q.r, kE: q.kE }; }).filter(Boolean);
      var xsAll = donors.map(function (x) { return x.r.v; }).concat([lo - 12, hi + 12]);
      var x0 = Math.floor(Math.min.apply(null, xsAll)), x1 = Math.ceil(Math.max.apply(null, xsAll));
      var curve = []; for (var i = 0; i <= 240; i++) { var v = x0 + (x1 - x0) * i / 240; var q = ratio(v); curve.push({ x: v, y: Math.log10(q.r), k: q.kE }); }
      var yv = curve.map(function (c) { return c.y; });
      var y0 = Math.floor(Math.min.apply(null, yv) - 0.2), y1 = Math.ceil(Math.max.apply(null, yv) + 0.2);
      if (y1 - y0 < 2) { y0 -= 1; y1 += 1; }
      var f = frame({ w: 760, h: 400, l: 64, r: 64, t: 22, b: 48, x: [x0, x1], y: [y0, y1], ylog: true, y2: [0, 1], y2l: "relative rate of exciting E",
        xl: "Donor triplet energy E_T (kcal/mol)", yl: "Predicted Z / E at the photostationary state",
        aria: "Predicted Z to E ratio against donor triplet energy, for E_T(E) " + fx(EE) + " and E_T(Z) " + fx(EZ) + " kcal/mol", clip: "pe-clip-p" });
      [[EE, "E_T(E)"], [EZ, "E_T(Z)"]].forEach(function (m) {
        S("line", { x1: f.X(m[0]), x2: f.X(m[0]), y1: f.Y(y1), y2: f.Y(y0), "class": "pe-sub", "stroke-dasharray": "5 4" }, f.plot);
        TX(f.svg, f.X(m[0]) + 4, f.Y(y1) + 14, m[1] + " " + fx(m[0]), "pe-note-t", "start");
      });
      S("path", { d: linePath(curve.map(function (c) { return [f.X(c.x), f.Y2(c.k)]; })), "class": "pe-rate", "stroke-dasharray": "6 4" }, f.plot);
      S("path", { d: linePath(curve.map(function (c) { return [f.X(c.x), f.Y(c.y)]; })), "class": "pe-curve" }, f.plot);
      donors.forEach(function (x) {
        var slow = x.kE < st.minRate;
        var c = S("circle", { cx: f.X(x.r.v), cy: f.Y(Math.log10(x.ratio)), r: 5, "class": "pe-dot pe-pt" + (slow ? " pe-faded" : "") + (x.r.origin === "calc" ? " pe-hollow" : "") }, f.plot);
        S("title", {}, c).textContent = x.m.title + ": E_T " + etText(x.r) + ", Z/E " + sci(x.ratio, 2) + ", relative rate " + x.kE.toFixed(3);
      });
      var plotBox = el("div", "pe-plot"); plotBox.appendChild(f.svg); out.appendChild(plotBox);
      var leg = el("div", "pe-legend");
      [["pe-swline", "Z/E (left axis)"], ["pe-swdash", "relative rate of exciting E (right axis)"], ["pe-sw pe-pt", "photocatalysts in the database"], ["pe-sw pe-pt pe-faded", "slower than the limit below"]].forEach(function (c) {
        var s = el("span", "pe-key"); s.appendChild(el("i", c[0])); s.appendChild(document.createTextNode(c[1])); leg.appendChild(s);
      });
      out.appendChild(leg);

      var limIn = inp(st.minRate, "number", { min: "0", max: "1", step: "0.01" });
      limIn.addEventListener("change", function () { var v = num(limIn.value); st.minRate = isFinite(v) && v >= 0 ? v : 0.01; update(); });
      var fast = donors.filter(function (x) { return x.kE >= st.minRate; }).sort(function (a, b) { return b.ratio - a.ratio; });
      var bar = el("div", "pe-tablebar");
      bar.appendChild(field("Hide donors slower than (relative rate)", limIn));
      bar.appendChild(actions([
        ["Download SVG", function () { exportSvg(f.svg, "plotent-pss.svg"); }],
        ["Download CSV", function () {
          download("plotent-pss.csv", csv([["donor", "E_T_kcal", "origin", "Z_over_E", "percent_Z", "rel_rate_E"]].concat(donors.slice().sort(function (a, b) { return b.ratio - a.ratio; }).map(function (x) {
            return [x.m.title, x.r.v.toFixed(2), x.r.origin, x.ratio.toPrecision(4), (100 * x.ratio / (1 + x.ratio)).toFixed(1), x.kE.toFixed(4)];
          }))), "text/csv");
        }],
        copyLinkBtn()
      ]));
      out.appendChild(bar);
      if (!fast.length) out.appendChild(el("p", "status", "No photocatalyst in the database is fast enough with this limit."));
      else out.appendChild(table(["Photocatalyst", "E_T (kcal/mol)", "Z/E", "% Z", "Relative rate"], fast.map(function (x) {
        var name = el("button", "pe-link", x.m.title); name.type = "button"; name.addEventListener("click", function () { ctx.searchDb(x.m.title); });
        return [name, etText(x.r), sci(x.ratio, 2), (100 * x.ratio / (1 + x.ratio)).toFixed(1), x.kE.toFixed(3)];
      }), 15));
    }
    drawPick(); update();
  }

  /* =====================================================================
     4. Calculators
     ===================================================================== */
  /* viscosities at 25 °C, mPa·s (approximate, from standard tables; editable) */
  var SOLVENTS = [
    ["Acetonitrile", 0.34], ["Acetone", 0.31], ["Benzene", 0.60], ["Chloroform", 0.54], ["Cyclohexane", 0.89],
    ["Dichloromethane", 0.41], ["1,2-Dichloroethane", 0.78], ["Diethyl ether", 0.22], ["DMF", 0.79], ["DMSO", 1.99],
    ["1,4-Dioxane", 1.18], ["Ethanol", 1.07], ["Ethyl acetate", 0.42], ["Hexane", 0.30], ["Methanol", 0.54],
    ["2-Propanol", 2.04], ["THF", 0.46], ["Toluene", 0.56], ["Water", 0.89]
  ];
  function kdiff(etaMPa, T) { return 8 * R_J * T / (3 * etaMPa * 1e-3) * 1e3; }   /* M⁻¹ s⁻¹ */

  function calc(root, ctx, init) {
    var st = Object.assign({ mode: "I", tau: "", tauU: "us", q: [], fixed: true, solvent: "Acetonitrile", eta: 0.34, T: 298, cmpKq: "", role: "", exp: false }, init || {});
    if (!Array.isArray(st.q)) st.q = [];
    var body = toolShell(root, "calc", "Small tools for quenching experiments: Stern–Volmer analysis, the diffusion limit for a solvent, and how triplet energies spread across compound classes.");
    var save = function () { saveState("calc", st); };

    /* -- diffusion limit (first: the Stern–Volmer result is compared with it) -- */
    var dCard = el("section", "pe-card"); dCard.appendChild(el("h3", null, "Diffusion limit"));
    dCard.appendChild(withSubs("p", "hint", "k_diff = 8RT / 3η for neutral molecules of similar size (Debye). Triplet–triplet energy transfer that is strongly downhill usually runs close to it."));
    var sSel = el("select"); SOLVENTS.forEach(function (s) { var o = el("option", null, s[0] + " (" + s[1].toFixed(2) + " mPa·s)"); o.value = s[0]; o.selected = s[0] === st.solvent; sSel.appendChild(o); });
    var other = el("option", null, "Other (type the viscosity)"); other.value = ""; other.selected = !st.solvent; sSel.appendChild(other);
    var etaIn = inp(st.eta, "text", { inputmode: "decimal" }), tIn = inp(st.T, "number", { min: "150", max: "500", step: "1" });
    var dRow = el("div", "frow"); dRow.appendChild(field("Solvent", sSel)); dRow.appendChild(field("Viscosity η (mPa·s)", etaIn, "Values at 25 °C; edit for other temperatures.")); dRow.appendChild(field("Temperature (K)", tIn));
    dCard.appendChild(dRow);
    var dOut = el("p", "pe-big"); dCard.appendChild(dOut);
    var cmpIn = inp(st.cmpKq, "text", { inputmode: "decimal", placeholder: "e.g. 3.2e9" });
    dCard.appendChild(field("Compare a measured k_q (M⁻¹ s⁻¹, optional)", cmpIn));
    var cmpOut = el("p", "hint"); dCard.appendChild(cmpOut);
    sSel.addEventListener("change", function () {
      st.solvent = sSel.value;
      var s = SOLVENTS.filter(function (x) { return x[0] === st.solvent; })[0];
      if (s) { st.eta = s[1]; etaIn.value = s[1]; }
      updD(); updSV();
    });
    etaIn.addEventListener("input", function () { var v = num(etaIn.value); if (v > 0) st.eta = v; updD(); updSV(); });
    tIn.addEventListener("input", function () { var v = num(tIn.value); if (v > 0) st.T = v; updD(); updSV(); });
    cmpIn.addEventListener("input", function () { st.cmpKq = cmpIn.value; updD(); });
    function kd() { return kdiff(st.eta, st.T); }
    function updD() {
      save();
      dOut.replaceChildren(); dOut.appendChild(subscriptT("k_diff ≈ " + sci(kd(), 2) + " M⁻¹ s⁻¹"));
      var k = num(st.cmpKq);
      cmpOut.textContent = k > 0 ? "k_q / k_diff = " + (k / kd()).toFixed(2) + (k > 1.5 * kd() ? ": above the diffusion limit; check concentrations, static quenching or long-range transfer." : k / kd() > 0.5 ? ": close to diffusion control (strongly downhill transfer)." : ": below diffusion control (endergonic, non-vertical, or slowed by another step).") : "";
    }

    /* -- Stern–Volmer -- */
    var sCard = el("section", "pe-card"); sCard.appendChild(el("h3", null, "Stern–Volmer analysis"));
    var mSel = el("select"); [["I", "Intensities: I₀/I"], ["tau", "Lifetimes: τ₀/τ"]].forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; op.selected = st.mode === o[0]; mSel.appendChild(op); });
    var tauIn = inp(st.tau, "text", { inputmode: "decimal", placeholder: "e.g. 2.5" });
    var uSel = el("select"); [["ns", "ns"], ["us", "µs"], ["ms", "ms"]].forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; op.selected = st.tauU === o[0]; uSel.appendChild(op); });
    var sRow = el("div", "frow"); sRow.appendChild(field("Data", mSel)); sRow.appendChild(field("τ₀ of the donor without quencher", tauIn)); sRow.appendChild(field("Unit", uSel));
    sCard.appendChild(sRow);
    var qTa = el("textarea"); qTa.rows = 5; qTa.placeholder = "[Q] in M, then I₀/I (or τ₀/τ), one pair per line:\n0.001, 1.42\n0.002, 1.83\n0.004, 2.71";
    qTa.value = st.q.map(function (r) { return r.join(", "); }).join("\n");
    sCard.appendChild(field("Quencher concentration and ratio", qTa));
    sCard.appendChild(check("Line through (0, 1)", st.fixed, function (v) { st.fixed = v; updSV(); }));
    var svOut = el("div", "pe-out"); sCard.appendChild(svOut);
    mSel.addEventListener("change", function () { st.mode = mSel.value; updSV(); });
    tauIn.addEventListener("input", function () { st.tau = tauIn.value; updSV(); });
    uSel.addEventListener("change", function () { st.tauU = uSel.value; updSV(); });
    qTa.addEventListener("input", function () {
      st.q = qTa.value.split(/\n/).map(function (l) { var c = l.split(/[\s,;\t]+/).filter(Boolean); return c.length >= 2 ? [c[0], c[1]] : null; }).filter(Boolean);
      updSV();
    });
    function updSV() {
      save();
      svOut.replaceChildren();
      var pts = st.q.map(function (r) { var x = num(r[0]), y = num(r[1]); return isFinite(x) && isFinite(y) && x >= 0 ? { x: x, y: y } : null; }).filter(Boolean);
      if (pts.length < 2) { svOut.appendChild(el("p", "hint", "Enter at least two concentrations with their ratios.")); return; }
      var K, b = 1, sK = NaN, r2;
      if (st.fixed) {
        var sxx = 0, sxy = 0; pts.forEach(function (p) { sxx += p.x * p.x; sxy += p.x * (p.y - 1); });
        K = sxy / sxx;
        var ss = pts.reduce(function (s, p) { var e = p.y - 1 - K * p.x; return s + e * e; }, 0);
        if (pts.length > 1) sK = Math.sqrt(ss / (pts.length - 1) / sxx);
      } else {
        var mx = mean(pts.map(function (p) { return p.x; })), my = mean(pts.map(function (p) { return p.y; }));
        var Sxx = 0, Sxy = 0; pts.forEach(function (p) { Sxx += (p.x - mx) * (p.x - mx); Sxy += (p.x - mx) * (p.y - my); });
        K = Sxy / Sxx; b = my - K * mx;
        var ss2 = pts.reduce(function (s, p) { var e = p.y - b - K * p.x; return s + e * e; }, 0);
        if (pts.length > 2) sK = Math.sqrt(ss2 / (pts.length - 2) / Sxx);
      }
      var my2 = mean(pts.map(function (p) { return p.y; })), sst = pts.reduce(function (s, p) { return s + (p.y - my2) * (p.y - my2); }, 0);
      var sse = pts.reduce(function (s, p) { var e = p.y - b - K * p.x; return s + e * e; }, 0);
      r2 = sst > 0 ? 1 - sse / sst : 1;
      var xmax = Math.max.apply(null, pts.map(function (p) { return p.x; })) * 1.1, ymax = Math.max(Math.max.apply(null, pts.map(function (p) { return p.y; })), b + K * xmax) * 1.08;
      var f = frame({ w: 640, h: 300, l: 60, r: 20, t: 18, b: 46, x: [0, xmax], y: [Math.min(0.9, b - 0.1), ymax], xl: "[Q] (M)", yl: st.mode === "tau" ? "τ₀ / τ" : "I₀ / I",
        aria: "Stern–Volmer plot with K_SV " + sci(K, 3) + " per molar", clip: "pe-clip-sv", xn: 5 });
      S("line", { x1: f.X(0), y1: f.Y(b), x2: f.X(xmax), y2: f.Y(b + K * xmax), "class": "pe-curve" }, f.plot);
      pts.forEach(function (p) { S("circle", { cx: f.X(p.x), cy: f.Y(p.y), r: 5, "class": "pe-dot pe-pt" }, f.plot); });
      var pb = el("div", "pe-plot pe-plot-sm"); pb.appendChild(f.svg); svOut.appendChild(pb);
      var res = el("dl", "pe-result");
      function item(k, v, n) { var d = el("div"); d.appendChild(withSubs("dt", null, k)); var dd = el("dd"); dd.appendChild(subscriptT(v)); if (n) dd.appendChild(withSubs("small", null, n)); d.appendChild(dd); res.appendChild(d); }
      item("K_SV", sci(K, 3) + (isFinite(sK) ? " ± " + sci(sK, 2) : "") + " M⁻¹", "R² = " + r2.toFixed(3) + (st.fixed ? "" : ", intercept " + b.toFixed(2)));
      var tau = num(st.tau) * ({ ns: 1e-9, us: 1e-6, ms: 1e-3 })[st.tauU];
      if (tau > 0) {
        var kq = K / tau;
        item("k_q = K_SV / τ₀", sci(kq, 2) + " M⁻¹ s⁻¹", "k_q / k_diff = " + (kq / kd()).toFixed(2) + " (" + (SOLVENTS.some(function (s) { return s[0] === st.solvent; }) ? st.solvent : "η " + st.eta + " mPa·s") + ", " + st.T + " K)");
      } else item("k_q", "enter τ₀ above", "");
      svOut.appendChild(res);
      var w = [];
      if (pts.length >= 4) {
        var resid = pts.slice().sort(function (a, c) { return a.x - c.x; }).map(function (p) { return p.y - b - K * p.x; });
        var n3 = Math.max(1, Math.floor(resid.length / 3));
        var ends = mean(resid.slice(0, n3).concat(resid.slice(-n3))), mid = mean(resid.slice(n3, resid.length - n3).length ? resid.slice(n3, resid.length - n3) : [0]);
        if (ends - mid > 0.03 * ymax) w.push("Upward curvature: static and dynamic quenching together, or a second quenching path. Lifetime data (τ₀/τ) isolate the dynamic part.");
        if (mid - ends > 0.03 * ymax) w.push("Downward curvature: part of the emission may not be accessible to the quencher, or the quencher absorbs (inner filter).");
      }
      if (st.mode === "I") w.push("Steady-state intensities include static quenching; k_q from τ₀/τ is the safer value for energy transfer.");
      var ul = el("ul", "pe-warn"); w.forEach(function (t) { ul.appendChild(withSubs("li", null, t)); }); if (w.length) svOut.appendChild(ul);
      svOut.appendChild(actions([["Download SVG", function () { exportSvg(f.svg, "plotent-stern-volmer.svg"); }], copyLinkBtn()]));
    }

    /* -- E_T by class -- */
    var cCard = el("section", "pe-card"); cCard.appendChild(withSubs("h3", null, "E_T by compound class"));
    var cOpts = el("div", "frow");
    var rSel = el("select"); [["", "Donors and acceptors"], ["donor", "Donors"], ["acceptor", "Acceptors"]].forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; op.selected = st.role === o[0]; rSel.appendChild(op); });
    cOpts.appendChild(field("Show", rSel)); cCard.appendChild(cOpts);
    cCard.appendChild(check("Experimental values only", st.exp, function (v) { st.exp = v; updC(); }));
    var cOut = el("div", "pe-out"); cCard.appendChild(cOut);
    rSel.addEventListener("change", function () { st.role = rSel.value; updC(); });
    function updC() {
      save();
      cOut.replaceChildren();
      if (!ctx.loaded()) { cOut.appendChild(el("p", "status", "Loading the database…")); return; }
      var by = {};
      ctx.docs().forEach(function (d) {
        var v = Number(d.et_kcal); if (d.et_kcal == null || isNaN(v)) return;
        if (st.exp && d.origin !== "exp") return;
        if (st.role && !(d.role === st.role || d.role === "both")) return;
        var c = d.cls || "Unclassified"; (by[c] = by[c] || []).push({ v: v, o: d.origin, n: d.commercial_name || d.name });
      });
      var classes = Object.keys(by).sort(function (a, b) { return median(by[a].map(function (x) { return x.v; })) - median(by[b].map(function (x) { return x.v; })); });
      if (!classes.length) { cOut.appendChild(el("p", "status", "No values match.")); return; }
      var all = []; classes.forEach(function (c) { by[c].forEach(function (x) { all.push(x.v); }); });
      var x0 = Math.floor(Math.min.apply(null, all) - 2), x1 = Math.ceil(Math.max.apply(null, all) + 2);
      var rowH = 26, top = 16, h = top + classes.length * rowH + 50, l = 170;
      var f = frame({ w: 760, h: h, l: l, r: 20, t: top, b: 46, x: [x0, x1], y: [0, classes.length], yn: 1, xl: "Triplet energy E_T (kcal/mol)", yl: "",
        aria: "Triplet energies by compound class", clip: "pe-clip-c" });
      Array.prototype.forEach.call(f.svg.querySelectorAll(".pe-tick"), function (t) { if (t.getAttribute("text-anchor") === "end") t.remove(); });
      classes.forEach(function (c, i) {
        var yc = top + (classes.length - i - 0.5) * rowH;
        var lab = TX(f.svg, l - 8, yc + 4, c.length > 24 ? c.slice(0, 23) + "…" : c, "pe-tick", "end"); S("title", {}, lab).textContent = c + " (" + by[c].length + ")";
        var med = median(by[c].map(function (x) { return x.v; }));
        S("line", { x1: f.X(med), x2: f.X(med), y1: yc - 9, y2: yc + 9, "class": "pe-median" }, f.plot);
        by[c].forEach(function (x, k) {
          var jit = ((k * 37) % 9 - 4) * 1.2;
          var dot = S("circle", { cx: f.X(x.v), cy: yc + jit, r: 4, "class": "pe-dot " + (x.o === "calc" ? "pe-calcdot" : "pe-pt") }, f.plot);
          S("title", {}, dot).textContent = x.n + ": " + fx(x.v) + " kcal/mol (" + (x.o === "calc" ? "computed" : "experimental") + ")";
        });
      });
      var pb = el("div", "pe-plot"); pb.appendChild(f.svg); cOut.appendChild(pb);
      var leg = el("div", "pe-legend");
      [["pe-sw pe-pt", "experimental"], ["pe-sw pe-calcdot", "computed"], ["pe-swline pe-medkey", "median"]].forEach(function (c) { var s = el("span", "pe-key"); s.appendChild(el("i", c[0])); s.appendChild(document.createTextNode(c[1])); leg.appendChild(s); });
      cOut.appendChild(leg);
      cOut.appendChild(actions([["Download SVG", function () { exportSvg(f.svg, "plotent-et-by-class.svg"); }]]));
    }

    body.appendChild(sCard); body.appendChild(dCard); body.appendChild(cCard);
    body.appendChild(refList(["lakowicz", "debye", "montalti"]));
    updD(); updSV(); updC();
  }

  /* ---------- entry point ---------- */
  var TOOL_FN = { finder: finder, sandros: sandros, pss: pss, calc: calc };
  var current = { key: "", ver: -1 };
  /* route: {tool, data}; ctx: {docs(), loaded(), failed(), searchDb(q), version()} */
  window.PlotEnT = {
    tools: TOOLS,
    render: function (root, route, ctx) {
      var tool = TOOL_FN[route.tool] ? route.tool : "";
      var key = tool, ver = ctx.version();
      if (current.key === key && current.ver === ver && root.firstChild) return;   /* already showing; keeps what is being typed */
      current = { key: key, ver: ver };
      if (!tool) { pickerPage(root); return; }
      TOOL_FN[tool](root, ctx, decodeState(route.data));
    },
    reset: function () { current = { key: "", ver: -1 }; },
    /* exposed for tests */
    _fitSandros: fitSandros, _sandrosLog: sandrosLog, _kdiff: kdiff, _num: num
  };
})();
