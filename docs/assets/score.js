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
      usedoi: cleanDoi(p.usedoi), usenote: str(p.usenote, 300)
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
    ["uses_add", "Add a paper where it was used in photocatalysis", "use"]
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

  root.EntScore = { DOI_RE: DOI_RE, ET_MAX: ET_MAX, num: num, cleanDoi: cleanDoi, isDoi: isDoi, cleanCas: cleanCas, casValid: casValid,
    parseDirectExc: parseDirectExc, formatDirectExc: formatDirectExc, formatUv: formatUv,
    SUGGEST_FIELDS: SUGGEST_FIELDS, checkSuggestion: checkSuggestion,
    normalize: normalize, gradeOf: gradeOf, scoreEntry: scoreEntry, requiredError: requiredError, toDoc: toDoc };
})(typeof globalThis !== "undefined" ? globalThis : this);
