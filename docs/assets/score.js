/* TrEnDB scoring and normalisation.
 * One file, two homes: the browser loads it for the live preview, and the
 * same text is embedded in supabase/functions/submit/index.ts, where the
 * score that counts is computed. Edit here, then run tools/build-function.mjs. */
(function (root) {
  "use strict";

  var KCAL_PER_EV = 23.0605, KJ_PER_KCAL = 4.184;

  function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max || 500); }
  /* A whole number only: "62abc" is not 62. A decimal comma is accepted ("2,69"). */
  var NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : NaN;
    var t = String(v == null ? "" : v).trim();
    if (t.indexOf(",") >= 0 && t.indexOf(".") < 0) t = t.replace(",", ".");
    if (!NUM_RE.test(t)) return NaN;
    var n = parseFloat(t); return isFinite(n) ? n : NaN;
  }
  var ET_MAX = 200;   /* kcal/mol; anything above is a typing or unit error, never stored */
  function round1(x) { return Math.round(x * 10) / 10; }
  function pick(v, allowed, fallback) { return allowed.indexOf(v) >= 0 ? v : fallback; }

  /* Sources are stored as DOIs only, never as links. A pasted link (doi.org, a publisher page,
     a library proxy) is reduced to the DOI inside it; a link without a DOI is left as typed, so
     the DOI check rejects it. */
  var DOI_RE = /^10\.\d{4,9}\/[^\s"<>]+$/;
  function cleanDoi(v) {
    var t = str(v, 300).replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) {
      var m = t.match(/10\.\d{4,9}\/[^\s?#"<>]+/);
      if (m) { t = m[0]; try { t = decodeURIComponent(t); } catch (e) {} }
    }
    return t.replace(/[.,;)\]]+$/, "").slice(0, 200);
  }
  function isDoi(v) { return DOI_RE.test(String(v || "")); }

  /* CAS registry numbers: 2–7 digits, 2 digits, check digit. "50000" style input without
     hyphens is accepted and formatted. The check digit is verified. */
  var CAS_RE = /^(\d{2,7})-(\d{2})-(\d)$/;
  function cleanCas(v) {
    var t = str(v, 30).replace(/\s+/g, "").replace(/[‐-―−]/g, "-");
    if (/^\d{5,10}$/.test(t)) t = t.slice(0, -3) + "-" + t.slice(-3, -1) + "-" + t.slice(-1);
    return t;
  }
  function casValid(v) {
    var m = CAS_RE.exec(String(v || "")); if (!m) return false;
    var digits = (m[1] + m[2]).split("").reverse(), sum = 0;
    digits.forEach(function (d, i) { sum += (i + 1) * Number(d); });
    return sum % 10 === Number(m[3]);
  }

  function parseIntRange(v, min, max) {
    if (v == null || String(v).trim() === "") return { val: NaN, bad: false };
    var n = num(v);
    if (isNaN(n) || Math.floor(n) !== n || n < min || n > max) return { val: NaN, bad: true };
    return { val: n, bad: false };
  }
  function parseDirectExc(v, src, nm) {
    var hasPair = (src != null && String(src).trim() !== "") || (nm != null && String(nm).trim() !== "");
    if (v == null && hasPair) {
      var r = parseIntRange(nm, 100, 1500);
      if (r.bad || isNaN(r.val)) return { map: null, bad: true };
      var key = str(src, 40) || "irradiation";
      var out = {}; out[key] = r.val;
      return { map: out, bad: false };
    }
    if (v == null || v === "") return { map: null, bad: false };
    var obj = null;
    if (typeof v === "object" && !Array.isArray(v)) obj = v;
    else {
      var s = String(v).trim();
      if (!s) return { map: null, bad: false };
      if (s[0] === "{") { try { obj = JSON.parse(s); } catch (e) { return { map: null, bad: true }; } }
      else {
        obj = {};
        var parts = s.split(/[;,]+/), ok = true;
        parts.forEach(function (part) {
          var t = part.trim(); if (!t) return;
          var m1 = /^([^:]+?)\s*:\s*(\d{3,4})\s*(?:nm)?$/i.exec(t);
          var m2 = /^(\d{3,4})\s*nm\s*(.*)$/i.exec(t);
          if (m1) obj[str(m1[1], 40) || "irradiation"] = Number(m1[2]);
          else if (m2) obj[str(m2[2], 40) || "irradiation"] = Number(m2[1]);
          else ok = false;
        });
        if (!ok || !Object.keys(obj).length) return { map: null, bad: true };
      }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { map: null, bad: true };
    var clean = {}, keys = Object.keys(obj);
    if (!keys.length) return { map: null, bad: false };
    for (var i = 0; i < keys.length; i++) {
      var k = str(keys[i], 40), rv = parseIntRange(obj[keys[i]], 100, 1500);
      if (!k || rv.bad || isNaN(rv.val)) return { map: null, bad: true };
      clean[k] = rv.val;
    }
    return { map: clean, bad: false };
  }
  function formatDirectExc(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    var keys = Object.keys(v);
    return keys.map(function (k) { return k + ": " + v[k] + " nm"; }).join("; ");
  }
  function formatUv(d) {
    if (!d) return "";
    var parts = [];
    if (d.uv_lmax != null && !isNaN(Number(d.uv_lmax))) parts.push("λmax " + d.uv_lmax + " nm");
    if (d.uv_eps != null && !isNaN(Number(d.uv_eps))) parts.push("ε " + Number(d.uv_eps).toLocaleString("en-US") + " M⁻¹ cm⁻¹");
    var base = parts.join(" · ");
    if (d.uv_cond) base = base ? base + " (" + d.uv_cond + ")" : d.uv_cond;
    return base || d.uv || "";
  }

  /* ---------- reactions in which a molecule was employed ----------
     Each reaction comes from a paper given by its DOI. The entry's own molecule is implicit:
     as a "donor" it is the photocatalyst above the arrow, as an "acceptor" it is the first
     reactant. Structures are SMILES; the server parses every one of them. */
  var MAX_REACTIONS = 10, MAX_RX_MOLS = 4, RX_WORDS = 50;
  function wordCount(t) { t = String(t || "").trim(); return t ? t.split(/\s+/).length : 0; }
  function smilesList(v) {
    return (Array.isArray(v) ? v : []).map(function (x) { return str(x, 400); }).filter(Boolean);
  }
  /* one reaction -> {clean, error} */
  function checkReaction(r, n) {
    var at = n ? "Reaction " + n + ": " : "";
    function E(m) { return { error: at ? at + m : m.charAt(0).toUpperCase() + m.slice(1) }; }
    r = r && typeof r === "object" && !Array.isArray(r) ? r : {};
    var doi = cleanDoi(r.doi);
    if (!doi) return E("enter the DOI of the paper first.");
    if (!isDoi(doi)) return E("the paper must be given as a DOI (for example 10.1021/jacs.0c05069), not as a link.");
    var role = r.role === "donor" ? "donor" : r.role === "acceptor" ? "acceptor" : "";
    if (!role) return E("choose whether the molecule acts as donor or acceptor.");
    var reactants = smilesList(r.reactants), products = smilesList(r.products), catalyst = str(r.catalyst, 400);
    /* an acceptor can also be what the reaction makes (e.g. the Z isomer of an E/Z isomerisation) */
    var asProduct = role === "acceptor" && r.as_product === true;
    if (reactants.length > MAX_RX_MOLS || products.length > MAX_RX_MOLS) return E("at most " + MAX_RX_MOLS + " reactants and " + MAX_RX_MOLS + " products.");
    if ((role === "donor" || asProduct) && !reactants.length) return E(asProduct ? "draw the reactant this molecule is made from (e.g. the other isomer)." : "draw at least one reactant.");
    if (!products.length && !asProduct) return E("draw at least one product.");
    if (role === "acceptor" && !catalyst) return E("draw the photocatalyst (sensitizer) that goes above the arrow.");
    var loading = str(r.loading, 40), temperature = str(r.temperature, 40), solvent = str(r.solvent, 80);
    var wl = String(r.wavelength == null ? "" : r.wavelength).replace(/\s*nm\s*$/i, "").trim();
    var wave = parseIntRange(wl, 100, 1500);
    if (!loading) return E("give the catalyst loading (for example 5 mol%).");
    if (wave.bad || isNaN(wave.val)) return E("the wavelength must be a whole number of nanometres (100–1500).");
    if (!temperature) return E("give the temperature (for example 25 °C or rt).");
    if (!solvent) return E("give the solvent.");
    var description = str(r.description, 400).replace(/\s+/g, " ");
    if (wordCount(description) > RX_WORDS) return E("keep the description to " + RX_WORDS + " words or fewer.");
    var clean = { doi: doi, role: role, reactants: reactants, products: products, catalyst: role === "acceptor" ? catalyst : null,
      loading: loading, wavelength: wave.val, temperature: temperature, solvent: solvent, description: description };
    if (asProduct) clean.as_product = true;   /* only stored when set, so older reactions stay unchanged */
    return { clean: clean, error: null };
  }
  /* list -> {clean: [...], smiles: [every structure], dois: [distinct DOIs], error}. "existing" counts reactions already stored. */
  function checkReactions(list, existing) {
    var out = { clean: [], smiles: [], dois: [], error: null };
    if (list == null || list === "") return out;
    if (!Array.isArray(list)) { out.error = "The reactions could not be read."; return out; }
    if (list.length + (existing || 0) > MAX_REACTIONS) {
      out.error = "At most " + MAX_REACTIONS + " reactions per entry" + (existing ? " (this entry already has " + existing + ")." : "."); return out;
    }
    for (var i = 0; i < list.length; i++) {
      var c = checkReaction(list[i], list.length > 1 ? i + 1 : 0);
      if (c.error) { out.error = c.error; return out; }
      out.clean.push(c.clean);
      out.smiles = out.smiles.concat(c.clean.reactants, c.clean.products, c.clean.catalyst ? [c.clean.catalyst] : []);
      if (out.dois.indexOf(c.clean.doi.toLowerCase()) < 0) out.dois.push(c.clean.doi.toLowerCase());
    }
    return out;
  }

  /* Raw form payload -> clean, length-capped fields. */
  function normalize(p) {
    p = p || {};
    var unit = pick(p.unit, ["kcal", "kj", "ev"], "kcal");
    var k = unit === "kj" ? 1 / KJ_PER_KCAL : unit === "ev" ? KCAL_PER_EV : 1;
    var et = num(p.et), unc = num(p.unc);
    var doi = cleanDoi(p.doi);
    var lmaxIn = p.uv_lmax, condIn = p.uv_cond;
    if (lmaxIn == null && condIn == null && p.uv) {
      var um = /(\d{3,4})\s*nm/i.exec(String(p.uv));
      if (um) lmaxIn = um[1];
      condIn = String(p.uv).replace(/^\s*(?:λmax\s*)?\d{3,4}\s*nm\s*/i, "").trim();
    }
    var lmax = parseIntRange(lmaxIn, 100, 1500);
    var eps = parseIntRange(p.uv_eps, 0, 100000000);
    var dir = parseDirectExc(p.direct_exc != null ? p.direct_exc : p.direct, p.direct_src, p.direct_nm);
    return {
      name: str(p.name, 200), commercial_name: str(p.commercial_name, 200), cas: cleanCas(p.cas), cls: str(p.cls, 80), smiles: str(p.smiles, 400),
      role: pick(p.role, ["acceptor", "donor", "both"], "acceptor"),
      et: et, unit: unit, unc: unc,
      kcal: isNaN(et) ? NaN : et * k,
      uncKcal: isNaN(unc) ? NaN : Math.abs(unc) * k,
      origin: p.origin === "calc" ? "calc" : "exp",
      kind: str(p.kind, 80), tech: str(p.tech, 80), solvent: str(p.solvent, 120), temp: str(p.temp, 60),
      func: str(p.func, 120), basis: str(p.basis, 120), solv: str(p.solv, 120),
      cite: str(p.cite, 400), doi: doi, loc: str(p.loc, 200), quote: str(p.quote, 300),
      uv_lmax: lmax.val, uv_lmax_bad: lmax.bad,
      uv_eps: eps.val, uv_eps_bad: eps.bad,
      uv_cond: str(condIn, 120),
      direct_exc: dir.map, direct_bad: dir.bad,
      by: str(p.by, 120),
      usedoi: cleanDoi(p.usedoi), usenote: str(p.usenote, 300),
      reactions: checkReactions(p.reactions, 0)
    };
  }

  function gradeOf(n) {
    return n >= 80 ? { label: "Good", cls: "exp" } : n >= 50 ? { label: "Fair", cls: "warn" } : { label: "Poor", cls: "bad" };
  }

  /* ctx.structureOk : true | false | null (null = could not be checked)
   * ctx.doiResolves : true | false | null (null = not checked yet)
   * ctx.same        : entries with the same structure [{name, doi, et_kcal}], or null if unknown */
  function scoreEntry(f, ctx) {
    ctx = ctx || {};
    var items = [];
    function add(label, got, max, note) { items.push({ label: label, got: got, max: max, note: note || "" }); }

    if (ctx.structureOk == null) add("Structure parses", 0, 15, "Not checked: the structure library was unavailable");
    else add("Structure parses", ctx.structureOk ? 15 : 0, 15, ctx.structureOk ? "" : (f.smiles ? "The SMILES could not be read" : "No structure given"));

    add("IUPAC name given", f.name ? 3 : 0, 3);

    var okEt = !isNaN(f.kcal) && f.kcal >= 20 && f.kcal <= 120;
    add("E_T in a plausible range", okEt ? 12 : 0, 12, isNaN(f.kcal) ? "No value given" : okEt ? "" : "Outside 20–120 kcal/mol: check the unit");

    var stated = f.kind && f.kind !== "Other or not stated", computedKind = /^Computed/.test(f.kind);
    if (stated && f.origin !== "calc" && computedKind) add("Value type stated", 5, 8, "A computed value type on a measured value");
    else add("Value type stated", stated ? 8 : 0, 8);

    if (f.origin === "calc") {
      add("Method or functional", f.func ? 8 : 0, 8);
      add("Basis set", f.basis ? 7 : 0, 7);
      add("Solvent model", f.solv ? 5 : 0, 5);
      add("Value type matches a computation", computedKind ? 3 : 0, 3, computedKind ? "" : "Choose adiabatic or vertical");
    } else {
      add("Technique", f.tech ? 10 : 0, 10);
      add("Solvent or matrix", f.solvent ? 5 : 0, 5);
      add("Temperature", f.temp ? 5 : 0, 5);
      add("Uncertainty given", !isNaN(f.unc) ? 3 : 0, 3);
    }

    var doiOk = isDoi(f.doi);
    add("DOI well formed", doiOk ? 6 : 0, 6, f.doi && !doiOk ? "This does not look like a DOI" : "");
    if (!doiOk) add("DOI resolves", 0, 6, f.doi ? "" : "No DOI given");
    else if (ctx.doiResolves == null) add("DOI resolves", 0, 6, "Checked when the entry is submitted");
    else add("DOI resolves", ctx.doiResolves ? 6 : 0, 6, ctx.doiResolves ? "" : "doi.org does not know this DOI");

    add("Citation", f.cite ? 5 : 0, 5);
    add("Location in the paper", f.loc ? 6 : 0, 6);

    var words = f.quote ? f.quote.split(/\s+/).length : 0;
    add("Verbatim line", words > 0 && words <= 25 ? 4 : 0, 4, words > 25 ? "Keep it to one short line (25 words or fewer)" : "");

    /* Measured and computed values of one molecule legitimately differ, so each is
       compared only with entries of its own origin (entries without an origin count as both). */
    var cons = 0, note = "No structure to compare";
    if (ctx.same && !isNaN(f.kcal)) {
      var dup = null, best = Infinity, mine = round1(f.kcal);
      var peers = ctx.same.filter(function (d) { return !d.origin || d.origin === f.origin; });
      peers.forEach(function (d) {
        var diff = Math.abs(Number(d.et_kcal) - f.kcal);
        if (diff < best) best = diff;
        /* stored values are rounded to 0.1, so compare rounded values */
        if (f.doi && String(d.doi || "").toLowerCase() === f.doi.toLowerCase() && Math.abs(round1(Number(d.et_kcal)) - mine) < 0.05) dup = d;
      });
      if (dup) { cons = 0; note = "Looks like a duplicate of “" + dup.name + "” (same structure, DOI and value)"; }
      else if (!peers.length) {
        cons = 8; note = ctx.same.length ? "No existing " + (f.origin === "calc" ? "computed" : "measured") + " value for this structure" : "No existing entry for this structure";
      }
      else {
        cons = best <= 5 ? 8 : best <= 10 ? 5 : 2;
        note = best <= 5 ? "Within 5 kcal/mol of an existing entry for this structure"
          : "Differs by " + best.toFixed(1) + " kcal/mol from the closest existing entry. This can be right if the value type differs";
      }
    }
    add("Consistency with the database", cons, 8, note);

    add("UV-vis or excitation data", (!isNaN(f.uv_lmax) || f.uv_cond || f.direct_exc) ? 4 : 0, 4);

    var total = items.reduce(function (a, i) { return a + i.got; }, 0);
    return { total: total, grade: gradeOf(total).label, items: items };
  }

  /* The minimum a submission needs. Returns a message, or null when it can be sent. */
  function requiredError(f, ctx) {
    ctx = ctx || {};
    if (!f.smiles) return "Add the structure as a SMILES or draw it.";
    if (ctx.structureOk === false) return "The SMILES could not be read. Fix it or redraw the structure.";
    if (!f.name) return "Enter the IUPAC name.";
    if (isNaN(f.kcal)) return "Enter the triplet energy value.";
    if (!(f.kcal > 0 && f.kcal <= ET_MAX)) return "The triplet energy must be above 0 and at most " + ET_MAX + " kcal/mol. Check the value and the unit.";
    if (!f.cite && !f.doi) return "Add a citation or a DOI so the value can be traced.";
    if (f.doi && !isDoi(f.doi)) return "Give the source as a DOI (for example 10.1021/jacs.0c05069), not as a link.";
    if (f.cas && !casValid(f.cas)) return "The CAS number is not valid: check the digits and the format (for example 100-42-5).";
    if (f.uv_lmax_bad) return "UV-vis λmax must be an integer between 100 and 1500 nm.";
    if (f.uv_eps_bad) return "UV-vis ε must be a non-negative integer.";
    if (f.direct_bad) return "Direct excitation must be a wavelength (100–1500 nm) or a {source: nm} map.";
    if (f.usedoi && !isDoi(f.usedoi)) return "The DOI of the paper where the molecule was used does not look like a DOI.";
    if (f.usenote && !f.usedoi) return "Add the DOI of the paper the description refers to.";
    if (f.reactions && f.reactions.error) return f.reactions.error;
    return null;
  }

  /* Normalised fields + score -> database row (without status, ids or server-only columns). */
  function toDoc(f, sc) {
    var unitLabel = f.unit === "kj" ? "kJ/mol" : f.unit === "ev" ? "eV" : "kcal/mol";
    var doc = {
      name: f.name || "(unnamed)", smiles: f.smiles, role: f.role, origin: f.origin,
      et_kcal: round1(f.kcal),
      et_reported: f.et + (isNaN(f.unc) ? "" : " ± " + f.unc) + " " + unitLabel,
      et_type: f.kind || "Not stated",
      method: f.origin === "calc" ? ["Computation", f.func, f.basis].filter(Boolean).join(", ") : (f.tech || "Not stated"),
      conditions: f.origin === "calc" ? f.solv : [f.solvent, f.temp].filter(Boolean).join(", "),
      source_kind: "form", score: sc.total, score_items: sc.items
    };
    /* two decimals: 0.02 eV is 0.46 kcal/mol, and 0.1 kJ/mol must not round to 0 */
    if (!isNaN(f.uncKcal)) doc.et_unc = Math.round(f.uncKcal * 100) / 100;
    if (!isNaN(f.uv_lmax)) doc.uv_lmax = f.uv_lmax;
    if (!isNaN(f.uv_eps)) doc.uv_eps = f.uv_eps;
    if (f.direct_exc) doc.direct_exc = f.direct_exc;
    [["commercial_name", f.commercial_name], ["cas", f.cas], ["cls", f.cls], ["citation", f.cite], ["doi", f.doi], ["location", f.loc], ["quote", f.quote],
     ["uv_cond", f.uv_cond], ["submitted_by", f.by]].forEach(function (p) { if (p[1]) doc[p[0]] = p[1]; });
    if (f.usedoi) doc.uses = [{ doi: f.usedoi, note: f.usenote }];
    if (f.reactions && f.reactions.clean.length) doc.reactions = f.reactions.clean;
    return doc;
  }

  /* ---------- corrections suggested by readers ----------
     Fields a reader may propose a new value for, with how the value is checked. "uses_add"
     adds a paper (DOI + note) in which the molecule was used. Shared with the server. */
  var SUGGEST_FIELDS = [
    ["name", "IUPAC name", "text"], ["commercial_name", "Commercial name", "text"], ["cas", "CAS number", "cas"], ["smiles", "SMILES (structure)", "smiles"],
    ["cls", "Class", "text"], ["role", "Role", "role"], ["origin", "Origin (experimental or computed)", "origin"],
    ["et_kcal", "E_T (kcal/mol)", "et"], ["et_unc", "± Uncertainty (kcal/mol)", "unc"],
    ["et_reported", "Value as reported in the paper", "text"], ["et_type", "Value type", "text"],
    ["method", "Method", "text"], ["conditions", "Conditions", "text"], ["citation", "Citation", "text"],
    ["doi", "DOI", "doi"], ["location", "Where in the paper", "text"], ["quote", "Verbatim line", "text"],
    ["uv_lmax", "UV-vis λmax (nm)", "lmax"], ["uv_eps", "UV-vis ε (M⁻¹ cm⁻¹)", "eps"], ["uv_cond", "UV-vis conditions", "text"],
    ["direct_exc", "Direct excitation (e.g. LED: 415)", "direct_map"],
    ["uses_add", "Add a paper where it was used in photocatalysis", "use"],
    ["reactions_add", "Reactions it was employed in", "reactions"]
  ];
  var ROLES = ["acceptor", "donor", "both"], ORIGINS = ["exp", "calc"];
  /* changes: {field: value} -> {clean: {...}, error: string|null}. Structure parsing is checked separately. */
  function checkSuggestion(changes) {
    var clean = {}, keys = Object.keys(changes || {}), known = {};
    SUGGEST_FIELDS.forEach(function (f) { known[f[0]] = f; });
    if (!keys.length) return { clean: clean, error: "Choose at least one field to correct." };
    if (keys.length > SUGGEST_FIELDS.length) return { clean: clean, error: "Too many changes in one suggestion." };
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], f = known[k], v = changes[k];
      if (!f) return { clean: clean, error: "“" + k + "” cannot be corrected this way." };
      var type = f[2], label = f[1];
      if (type === "use") {
        var doi = cleanDoi(v && v.doi), note = str(v && v.note, 300);
        if (!isDoi(doi)) return { clean: clean, error: "Give the paper where it was used as a DOI." };
        clean[k] = { doi: doi, note: note }; continue;
      }
      if (type === "reactions") {
        var rx = checkReactions(v, 0);
        if (rx.error) return { clean: clean, error: rx.error };
        if (!rx.clean.length) return { clean: clean, error: "Add at least one reaction, or remove the empty one." };
        clean[k] = rx.clean; continue;
      }
      if (type === "direct_map") {
        var dm = parseDirectExc(v);
        if (dm.bad) return { clean: clean, error: label + " must be like \"LED: 415, Kessil: 427\" or JSON {\"LED\": 415}." };
        clean[k] = dm.map; continue;
      }
      var t = str(v, type === "text" ? 500 : 400);
      if (type === "et" || type === "unc") {
        var n = num(t);
        if (type === "et" && !(n > 0 && n <= ET_MAX)) return { clean: clean, error: label + " must be a number above 0 and at most " + ET_MAX + "." };
        if (type === "unc" && t !== "" && !(n >= 0)) return { clean: clean, error: label + " must be a positive number." };
        clean[k] = t === "" ? null : n; continue;
      }
      if (type === "lmax" || type === "eps") {
        var ir = parseIntRange(t, type === "lmax" ? 100 : 0, type === "lmax" ? 1500 : 100000000);
        if (ir.bad) return { clean: clean, error: type === "lmax" ? label + " must be an integer (100–1500 nm)." : label + " must be a non-negative integer." };
        clean[k] = isNaN(ir.val) ? null : ir.val; continue;
      }
      if (type === "doi") { t = cleanDoi(t); if (!isDoi(t)) return { clean: clean, error: "Give the source as a DOI, not as a link." }; }
      if (type === "cas") { t = cleanCas(t); if (t && !casValid(t)) return { clean: clean, error: "The CAS number is not valid." }; }
      if (type === "role" && ROLES.indexOf(t) < 0) return { clean: clean, error: "Choose acceptor, donor or both." };
      if (type === "origin" && ORIGINS.indexOf(t) < 0) return { clean: clean, error: "Choose experimental or computed." };
      if ((type === "smiles" || k === "name") && !t) return { clean: clean, error: label + " cannot be empty." };
      clean[k] = t === "" ? null : t;
    }
    return { clean: clean, error: null };
  }

  /* ================= redox potentials (table redox_entries) =================
     A value is kept as reported (e, against ref) and, when the reference can be converted,
     also against SCE. Excited-state potentials (state S1 or T1) say whether E* was measured
     directly or estimated as E + E00, and which E00 was used. */
  var E_MAX = 5;            /* V; anything beyond is a typing or unit error, never stored */
  var E_PLAUSIBLE = 3.5;    /* V vs SCE; ground- and excited-state potentials fall inside */
  var STATES = ["S0", "S1", "T1"], KINDS = ["red", "ox"], EXCITED_FROM = ["direct", "estimated"];
  var CATEGORIES = ["photocatalyst", "substrate"];
  function round3(x) { return Math.round(x * 1000) / 1000; }

  /* Reference electrodes and their offset to SCE (V): E(vs SCE) = E(vs ref) + off.
     The table is RedoxDB's (alebusso12, used with permission), after Pavlishchuk & Addison,
     Inorg. Chim. Acta 2000, 298, 97 and Connelly & Geiger, Chem. Rev. 1996, 96, 877.
     off: null = depends on the solvent (Fc+/Fc), NaN = cannot be converted. */
  var REF_TABLE = [
    { id: "SCE", off: 0 },
    { id: "SHE", off: -0.241 },
    { id: "NHE", off: -0.241 },
    { id: "Fc+/Fc", off: null },
    { id: "Me10Fc+/Me10Fc", off: -0.13, note: "in MeCN" },
    { id: "Ag/AgCl (sat. KCl)", off: -0.045 },
    { id: "Ag/AgCl (3 M KCl)", off: -0.032 },
    { id: "Ag/AgCl (1 M KCl)", off: 0 },
    { id: "Ag/AgCl (3.5 M NaCl)", off: -0.03, note: "convention of Roth, Romero, Nicewicz 2016" },
    { id: "Ag/AgCl", off: -0.045, note: "filling not stated: saturated KCl assumed" },
    { id: "Ag/Ag+ (0.01 M AgNO3, MeCN)", off: 0.298 },
    { id: "Ag/Ag+ (0.1 M AgNO3, MeCN)", off: 0.36 },
    { id: "Ag/Ag+", off: NaN, note: "depends on the Ag+ concentration: not converted" },
    { id: "other", off: NaN }
  ];
  var REFS = REF_TABLE.map(function (r) { return r.id; });
  /* Fc+/Fc against SCE by solvent. A mixture or an unlisted solvent gives no conversion. */
  var FC_VS_SCE = [
    [/\b(mecn|acetonitrile|ch3cn|acn)\b/i, 0.38],
    [/\b(dmf|dimethylformamide)\b/i, 0.45],
    [/\b(ch2cl2|dcm|dichloromethane|methylene chloride)\b/i, 0.46],
    [/\b(thf|tetrahydrofuran)\b/i, 0.56],
    [/\b(dmso|dimethyl sulfoxide|dimethylsulfoxide)\b/i, 0.43]
  ];
  /* What the site can display potentials against (the "unit" switch of the database). */
  var DISPLAY_REFS = [
    { id: "SCE", ref: "SCE", solvent: "" },
    { id: "Fc+/Fc (MeCN)", ref: "Fc+/Fc", solvent: "MeCN" },
    { id: "NHE", ref: "NHE", solvent: "" },
    { id: "Ag/AgCl (sat. KCl)", ref: "Ag/AgCl (sat. KCl)", solvent: "" },
    { id: "Ag/AgCl (3 M KCl)", ref: "Ag/AgCl (3 M KCl)", solvent: "" },
    { id: "Ag/Ag+ (0.01 M AgNO3, MeCN)", ref: "Ag/Ag+ (0.01 M AgNO3, MeCN)", solvent: "" }
  ];

  function isFiniteNum(v) { return typeof v === "number" && isFinite(v); }
  function refKey(s) { return String(s || "").toLowerCase().replace(/[\s(),]/g, ""); }
  var REF_BY_KEY = {};
  REF_TABLE.forEach(function (r) { REF_BY_KEY[refKey(r.id)] = r.id; });
  /* Reference electrode as typed or extracted -> one of REFS ("" when nothing was given). */
  function cleanRef(v) {
    var t = str(v, 60).replace(/^vs\.?\s*/i, "");
    if (!t) return "";
    var l = refKey(t);
    if (REF_BY_KEY[l]) return REF_BY_KEY[l];
    if (/^(me10fc|decamethylferrocen|dmfc)/.test(l)) return "Me10Fc+/Me10Fc";
    if (/^(fc\+?\/fc\+?|ferrocenium\/ferrocene|ferrocene|fc)$/.test(l)) return "Fc+/Fc";
    if (/^ag\/agcl/.test(l)) {
      if (/nacl/.test(l)) return /3\.5m/.test(l) ? "Ag/AgCl (3.5 M NaCl)" : "Ag/AgCl";
      if (/sat/.test(l)) return "Ag/AgCl (sat. KCl)";
      if (/(^|[^.\d])3(\.0)?m/.test(l)) return "Ag/AgCl (3 M KCl)";
      if (/(^|[^.\d])1(\.0)?m/.test(l)) return "Ag/AgCl (1 M KCl)";
      return "Ag/AgCl";
    }
    if (/^(ag\/ag\+|ag\+\/ag)/.test(l)) {
      if (/0\.01m/.test(l)) return "Ag/Ag+ (0.01 M AgNO3, MeCN)";
      if (/0\.1m/.test(l)) return "Ag/Ag+ (0.1 M AgNO3, MeCN)";
      return "Ag/Ag+";
    }
    return "other";
  }
  function refInfo(ref) {
    for (var i = 0; i < REF_TABLE.length; i++) if (REF_TABLE[i].id === ref) return REF_TABLE[i];
    return null;
  }
  function fcOffset(solvent) {
    var s = String(solvent || ""), hits = FC_VS_SCE.filter(function (r) { return r[0].test(s); });
    return hits.length === 1 ? hits[0][1] : NaN;
  }
  /* Offset of ref against SCE (V), or NaN when it cannot be converted. */
  function refOffset(ref, solvent) {
    var r = refInfo(ref);
    if (!r) return NaN;
    return r.off === null ? fcOffset(solvent) : r.off;
  }
  /* Potential (V) against ref -> V against SCE, and back. NaN when it cannot be converted. */
  function toSce(v, ref, solvent) {
    var off = refOffset(ref, solvent);
    return !isFiniteNum(v) || isNaN(off) ? NaN : round3(v + off);
  }
  function fromSce(v, ref, solvent) {
    var off = refOffset(ref, solvent);
    return !isFiniteNum(v) || isNaN(off) ? NaN : round3(v - off);
  }

  function normalizeRedox(p) {
    p = p || {};
    var unit = pick(p.unit, ["v", "mv"], "v"), k = unit === "mv" ? 0.001 : 1;
    var e = num(p.e), unc = num(p.unc);
    var state = pick(p.state, STATES, "S0"), excited = state !== "S0";
    var origin = p.origin === "calc" ? "calc" : "exp";
    var lmax = parseIntRange(p.uv_lmax, 100, 1500), tau = num(p.tau_ns);
    var f = {
      property: "redox",
      name: str(p.name, 200), commercial_name: str(p.commercial_name, 200), cas: cleanCas(p.cas), cls: str(p.cls, 80), smiles: str(p.smiles, 400),
      kind: pick(p.kind, KINDS, "red"), state: state, couple: str(p.couple, 40),
      excited_from: excited ? pick(p.excited_from, EXCITED_FROM, "") : "",
      e00: excited ? num(p.e00) : NaN, e00_note: excited ? str(p.e00_note, 200) : "",
      e: e, unit: unit, unc: unc,
      v: isNaN(e) ? NaN : e * k,
      uncV: isNaN(unc) ? NaN : Math.abs(unc) * k,
      ref: cleanRef(p.ref), origin: origin,
      e_type: str(p.e_type, 80), tech: str(p.tech, 80), solvent: str(p.solvent, 120), electrolyte: str(p.electrolyte, 120), temp: str(p.temp, 60),
      func: str(p.func, 120), basis: str(p.basis, 120), solv: str(p.solv, 120),
      cite: str(p.cite, 400), doi: cleanDoi(p.doi), loc: str(p.loc, 200), quote: str(p.quote, 300),
      by: str(p.by, 120),
      category: pick(p.category, CATEGORIES, ""), activated_group: str(p.activated_group, 80),
      uv_lmax: lmax.val, uv_lmax_bad: lmax.bad, tau_ns: tau, tau_bad: !isNaN(tau) && !(tau >= 0)
    };
    f.sce = toSce(f.v, f.ref, origin === "calc" ? f.solv : f.solvent);
    return f;
  }

  /* ctx as for scoreEntry; ctx.same lists redox entries with the same structure
     [{name, doi, e_sce, origin, kind, state}], or null if unknown. */
  function scoreRedox(f, ctx) {
    ctx = ctx || {};
    var items = [];
    function add(label, got, max, note) { items.push({ label: label, got: got, max: max, note: note || "" }); }

    if (ctx.structureOk == null) add("Structure parses", 0, 15, "Not checked: the structure library was unavailable");
    else add("Structure parses", ctx.structureOk ? 15 : 0, 15, ctx.structureOk ? "" : (f.smiles ? "The SMILES could not be read" : "No structure given"));

    add("IUPAC name given", f.name ? 3 : 0, 3);

    var probe = isNaN(f.sce) ? f.v : f.sce, okE = !isNaN(probe) && Math.abs(probe) <= E_PLAUSIBLE;
    add("Potential in a plausible range", okE ? 8 : 0, 8, isNaN(f.v) ? "No value given" : okE ? "" : "Beyond ±" + E_PLAUSIBLE + " V: check the unit and the sign");

    var refStated = f.ref && f.ref !== "other";
    add("Reference electrode stated", refStated ? 7 : 0, 7, f.ref === "other" ? "An unlisted reference cannot be compared with other values" : "");
    add("Converts to SCE", !isNaN(f.sce) ? 4 : 0, 4, !isNaN(f.sce) ? (f.ref === "Ag/AgCl" ? "Filling not stated: saturated KCl assumed" : "")
      : f.ref === "Fc+/Fc" ? "Give the solvent so Fc+/Fc can be converted" : f.ref === "Ag/Ag+" ? "Give the Ag+ concentration so Ag/Ag+ can be converted" : "");

    var stated = f.e_type && f.e_type !== "Other or not stated", computedKind = /^Computed/.test(f.e_type);
    if (stated && f.origin !== "calc" && computedKind) add("Value type stated", 3, 5, "A computed value type on a measured value");
    else add("Value type stated", stated ? 5 : 0, 5);

    if (f.state === "S0") add("Redox couple or E* derivation", f.couple ? 4 : 0, 4, f.couple ? "" : "Give the couple, e.g. M/M•−");
    else {
      var derived = f.excited_from === "direct" || (f.excited_from === "estimated" && !isNaN(f.e00));
      /* E0,0 is optional, but an estimate without it loses these points */
      add("Redox couple or E* derivation", derived ? 4 : 0, 4, derived ? "" : f.excited_from === "estimated" ? "Give the E0,0 used for the estimate" : "Say whether E* was measured or estimated from E0,0");
    }

    if (f.origin === "calc") {
      add("Method or functional", f.func ? 7 : 0, 7);
      add("Basis set", f.basis ? 6 : 0, 6);
      add("Solvent model", f.solv ? 5 : 0, 5);
      add("Value type matches a computation", computedKind ? 2 : 0, 2, computedKind ? "" : "Choose adiabatic or vertical");
    } else {
      add("Technique", f.tech ? 8 : 0, 8);
      add("Solvent", f.solvent ? 5 : 0, 5);
      add("Supporting electrolyte", f.electrolyte ? 4 : 0, 4);
      add("Uncertainty or temperature", (!isNaN(f.unc) || f.temp) ? 3 : 0, 3);
    }

    var doiOk = isDoi(f.doi);
    add("DOI well formed", doiOk ? 6 : 0, 6, f.doi && !doiOk ? "This does not look like a DOI" : "");
    if (!doiOk) add("DOI resolves", 0, 6, f.doi ? "" : "No DOI given");
    else if (ctx.doiResolves == null) add("DOI resolves", 0, 6, "Checked when the entry is submitted");
    else add("DOI resolves", ctx.doiResolves ? 6 : 0, 6, ctx.doiResolves ? "" : "doi.org does not know this DOI");

    add("Citation", f.cite ? 4 : 0, 4);
    add("Location in the paper", f.loc ? 6 : 0, 6);
    var words = f.quote ? f.quote.split(/\s+/).length : 0;
    add("Verbatim line", words > 0 && words <= 25 ? 4 : 0, 4, words > 25 ? "Keep it to one short line (25 words or fewer)" : "");

    /* Compared only with values of the same kind, state and origin, against SCE. */
    var cons = 0, note = "No structure to compare";
    if (ctx.same && !isNaN(f.v)) {
      var peers = ctx.same.filter(function (d) {
        return (!d.origin || d.origin === f.origin) && (d.kind || "red") === f.kind && (d.state || "S0") === f.state;
      });
      var comparable = peers.filter(function (d) { return d.e_sce != null && !isNaN(Number(d.e_sce)); });
      if (!peers.length) {
        cons = 8; note = ctx.same.length ? "No existing value of this kind for this structure" : "No existing entry for this structure";
      } else if (isNaN(f.sce) || !comparable.length) {
        cons = 4; note = "Cannot compare: no value against SCE";
      } else {
        var dup = null, best = Infinity, mine = round3(f.sce);
        comparable.forEach(function (d) {
          var diff = Math.abs(Number(d.e_sce) - f.sce);
          if (diff < best) best = diff;
          if (f.doi && String(d.doi || "").toLowerCase() === f.doi.toLowerCase() && Math.abs(round3(Number(d.e_sce)) - mine) < 0.0005) dup = d;
        });
        if (dup) { cons = 0; note = "Looks like a duplicate of “" + dup.name + "” (same structure, DOI and value)"; }
        else {
          cons = best <= 0.1 ? 8 : best <= 0.2 ? 5 : 2;
          note = best <= 0.1 ? "Within 0.1 V of an existing entry for this structure"
            : "Differs by " + best.toFixed(2) + " V from the closest existing entry. This can be right if the conditions differ";
        }
      }
    }
    add("Consistency with the database", cons, 8, note);

    var total = items.reduce(function (a, i) { return a + i.got; }, 0);
    return { total: total, grade: gradeOf(total).label, items: items };
  }

  function requiredRedoxError(f, ctx) {
    ctx = ctx || {};
    if (!f.smiles) return "Add the structure as a SMILES or draw it.";
    if (ctx.structureOk === false) return "The SMILES could not be read. Fix it or redraw the structure.";
    if (!f.name) return "Enter the IUPAC name.";
    if (isNaN(f.v)) return "Enter the potential.";
    if (!(Math.abs(f.v) <= E_MAX)) return "The potential must be between −" + E_MAX + " and +" + E_MAX + " V. Check the value and the unit.";
    if (!f.ref) return "Choose the reference electrode the potential was reported against.";
    if (!isNaN(f.uncV) && f.uncV > 1) return "The uncertainty must be at most 1 V.";
    if (!isNaN(f.e00) && !(f.e00 > 0 && f.e00 <= 6)) return "E00 must be above 0 and at most 6 eV.";
    if (!f.cite && !f.doi) return "Add a citation or a DOI so the value can be traced.";
    if (f.doi && !isDoi(f.doi)) return "Give the source as a DOI (for example 10.1021/jacs.0c05069), not as a link.";
    if (f.cas && !casValid(f.cas)) return "The CAS number is not valid: check the digits and the format (for example 100-42-5).";
    if (f.uv_lmax_bad) return "UV-vis λmax must be an integer between 100 and 1500 nm.";
    if (f.tau_bad) return "The excited-state lifetime must be a positive number of nanoseconds.";
    return null;
  }

  function toRedoxDoc(f, sc) {
    var calc = f.origin === "calc";
    var doc = {
      name: f.name || "(unnamed)", smiles: f.smiles, kind: f.kind, state: f.state, origin: f.origin,
      e_v: round3(f.v), e_ref: f.ref,
      e_reported: f.e + (isNaN(f.unc) ? "" : " ± " + f.unc) + " " + (f.unit === "mv" ? "mV" : "V") + " vs " + f.ref,
      e_type: f.e_type || "Not stated",
      method: calc ? ["Computation", f.func, f.basis].filter(Boolean).join(", ") : (f.tech || "Not stated"),
      conditions: calc ? f.solv : [f.solvent, f.electrolyte, f.temp].filter(Boolean).join(", "),
      source_kind: "form", score: sc.total, score_items: sc.items
    };
    if (!isNaN(f.sce)) doc.e_sce = f.sce;
    if (!isNaN(f.uncV)) doc.e_unc = round3(f.uncV);
    if (f.state !== "S0") {
      if (f.excited_from) doc.excited_from = f.excited_from;
      if (!isNaN(f.e00)) doc.e00_ev = round3(f.e00);
    }
    if (!isNaN(f.uv_lmax)) doc.uv_lmax = f.uv_lmax;
    if (!isNaN(f.tau_ns)) doc.tau_ns = f.tau_ns;
    [["commercial_name", f.commercial_name], ["cas", f.cas], ["cls", f.cls], ["couple", f.couple], ["e00_note", f.e00_note],
     ["solvent", calc ? "" : f.solvent], ["electrolyte", calc ? "" : f.electrolyte],
     ["category", f.category], ["activated_group", f.activated_group],
     ["citation", f.cite], ["doi", f.doi], ["location", f.loc], ["quote", f.quote], ["submitted_by", f.by]]
      .forEach(function (p) { if (p[1]) doc[p[0]] = p[1]; });
    return doc;
  }

  /* Reader corrections for a redox entry. e_sce is not offered: the curator recomputes it
     when e_v, e_ref or the solvent change. */
  var REDOX_SUGGEST_FIELDS = [
    ["name", "IUPAC name", "text"], ["commercial_name", "Commercial name", "text"], ["cas", "CAS number", "cas"], ["smiles", "SMILES (structure)", "smiles"],
    ["cls", "Class", "text"], ["kind", "Reduction or oxidation", "kind"], ["state", "State (S0, S1, T1)", "state"],
    ["couple", "Redox couple", "text"], ["excited_from", "E* measured or estimated", "excited_from"], ["e00_ev", "E00 (eV)", "e00"],
    ["origin", "Origin (experimental or computed)", "origin"],
    ["e_v", "Potential as reported (V)", "e"], ["e_unc", "± Uncertainty (V)", "unc_v"], ["e_ref", "Reference electrode", "ref"],
    ["e_reported", "Value as reported in the paper", "text"], ["e_type", "Value type", "text"],
    ["method", "Method", "text"], ["conditions", "Conditions", "text"], ["solvent", "Solvent", "text"], ["electrolyte", "Supporting electrolyte", "text"],
    ["category", "Photocatalyst or substrate", "category"], ["activated_group", "Activated bond or group", "text"],
    ["uv_lmax", "UV-vis λmax (nm)", "lmax"], ["tau_ns", "Excited-state lifetime (ns)", "tau"],
    ["citation", "Citation", "text"], ["doi", "DOI", "doi"], ["location", "Where in the paper", "text"], ["quote", "Verbatim line", "text"]
  ];
  function checkRedoxSuggestion(changes) {
    var clean = {}, keys = Object.keys(changes || {}), known = {};
    REDOX_SUGGEST_FIELDS.forEach(function (f) { known[f[0]] = f; });
    if (!keys.length) return { clean: clean, error: "Choose at least one field to correct." };
    if (keys.length > REDOX_SUGGEST_FIELDS.length) return { clean: clean, error: "Too many changes in one suggestion." };
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], f = known[k];
      if (!f) return { clean: clean, error: "“" + k + "” cannot be corrected this way." };
      var type = f[2], label = f[1], t = str(changes[k], type === "text" ? 500 : 400);
      if (type === "e" || type === "unc_v" || type === "e00") {
        var n = num(t);
        if (type === "e" && !(Math.abs(n) <= E_MAX)) return { clean: clean, error: label + " must be a number between −" + E_MAX + " and +" + E_MAX + "." };
        if (type === "unc_v" && t !== "" && !(n >= 0 && n <= 1)) return { clean: clean, error: label + " must be between 0 and 1." };
        if (type === "e00" && t !== "" && !(n > 0 && n <= 6)) return { clean: clean, error: label + " must be above 0 and at most 6." };
        clean[k] = t === "" ? null : n; continue;
      }
      if (type === "lmax") {
        var lr = parseIntRange(t, 100, 1500);
        if (lr.bad) return { clean: clean, error: label + " must be an integer (100–1500 nm)." };
        clean[k] = isNaN(lr.val) ? null : lr.val; continue;
      }
      if (type === "tau") {
        var tn = num(t);
        if (t !== "" && !(tn >= 0)) return { clean: clean, error: label + " must be a positive number." };
        clean[k] = t === "" ? null : tn; continue;
      }
      if (type === "category" && t !== "" && CATEGORIES.indexOf(t) < 0) return { clean: clean, error: "Choose photocatalyst or substrate." };
      if (type === "ref") { t = cleanRef(t); if (!t) return { clean: clean, error: "Choose a reference electrode." }; }
      if (type === "kind" && KINDS.indexOf(t) < 0) return { clean: clean, error: "Choose reduction (red) or oxidation (ox)." };
      if (type === "state" && STATES.indexOf(t) < 0) return { clean: clean, error: "Choose S0, S1 or T1." };
      if (type === "excited_from" && t !== "" && EXCITED_FROM.indexOf(t) < 0) return { clean: clean, error: "Choose measured directly or estimated." };
      if (type === "doi") { t = cleanDoi(t); if (!isDoi(t)) return { clean: clean, error: "Give the source as a DOI, not as a link." }; }
      if (type === "cas") { t = cleanCas(t); if (t && !casValid(t)) return { clean: clean, error: "The CAS number is not valid." }; }
      if (type === "origin" && ORIGINS.indexOf(t) < 0) return { clean: clean, error: "Choose experimental or computed." };
      if ((type === "smiles" || k === "name") && !t) return { clean: clean, error: label + " cannot be empty." };
      clean[k] = t === "" ? null : t;
    }
    return { clean: clean, error: null };
  }

  var redox = { E_MAX: E_MAX, E_PLAUSIBLE: E_PLAUSIBLE, REFS: REFS, REF_TABLE: REF_TABLE, DISPLAY_REFS: DISPLAY_REFS,
    STATES: STATES, KINDS: KINDS, CATEGORIES: CATEGORIES,
    cleanRef: cleanRef, refInfo: refInfo, fcOffset: fcOffset, refOffset: refOffset, toSce: toSce, fromSce: fromSce,
    normalize: normalizeRedox, scoreEntry: scoreRedox, requiredError: requiredRedoxError, toDoc: toRedoxDoc,
    SUGGEST_FIELDS: REDOX_SUGGEST_FIELDS, checkSuggestion: checkRedoxSuggestion };

  root.EntScore = { DOI_RE: DOI_RE, ET_MAX: ET_MAX, num: num, cleanDoi: cleanDoi, isDoi: isDoi, cleanCas: cleanCas, casValid: casValid,
    parseDirectExc: parseDirectExc, formatDirectExc: formatDirectExc, formatUv: formatUv,
    SUGGEST_FIELDS: SUGGEST_FIELDS, checkSuggestion: checkSuggestion,
    MAX_REACTIONS: MAX_REACTIONS, MAX_RX_MOLS: MAX_RX_MOLS, RX_WORDS: RX_WORDS, wordCount: wordCount,
    checkReaction: checkReaction, checkReactions: checkReactions,
    normalize: normalize, gradeOf: gradeOf, scoreEntry: scoreEntry, requiredError: requiredError, toDoc: toDoc,
    redox: redox };
})(typeof globalThis !== "undefined" ? globalThis : this);
