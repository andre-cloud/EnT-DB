/* EnT-DB scoring and normalisation.
 * One file, two homes: the browser loads it for the live preview, and the
 * same text is embedded in supabase/functions/submit/index.ts, where the
 * score that counts is computed. Edit here, then run tools/build-function.mjs. */
(function (root) {
  "use strict";

  var KCAL_PER_EV = 23.0605, KJ_PER_KCAL = 4.184;

  function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max || 500); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }
  function pick(v, allowed, fallback) { return allowed.indexOf(v) >= 0 ? v : fallback; }

  /* Raw form payload -> clean, length-capped fields. */
  function normalize(p) {
    p = p || {};
    var unit = pick(p.unit, ["kcal", "kj", "ev"], "kcal");
    var k = unit === "kj" ? 1 / KJ_PER_KCAL : unit === "ev" ? KCAL_PER_EV : 1;
    var et = num(p.et), unc = num(p.unc);
    var doi = str(p.doi, 200).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
    return {
      name: str(p.name, 200), cls: str(p.cls, 80), smiles: str(p.smiles, 400),
      role: pick(p.role, ["acceptor", "donor", "both"], "acceptor"),
      et: et, unit: unit, unc: unc,
      kcal: isNaN(et) ? NaN : et * k,
      uncKcal: isNaN(unc) ? NaN : Math.abs(unc) * k,
      origin: p.origin === "calc" ? "calc" : "exp",
      kind: str(p.kind, 80), tech: str(p.tech, 80), solvent: str(p.solvent, 120), temp: str(p.temp, 60),
      func: str(p.func, 120), basis: str(p.basis, 120), solv: str(p.solv, 120),
      cite: str(p.cite, 400), doi: doi, loc: str(p.loc, 200), quote: str(p.quote, 300),
      uv: str(p.uv, 200), direct: str(p.direct, 200), by: str(p.by, 120)
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

    add("Name given", f.name ? 3 : 0, 3);

    var okEt = !isNaN(f.kcal) && f.kcal >= 20 && f.kcal <= 120;
    add("E_T in a plausible range", okEt ? 12 : 0, 12, isNaN(f.kcal) ? "No value given" : okEt ? "" : "Outside 20–120 kcal/mol: check the unit");

    add("Value type stated", f.kind && f.kind !== "Other or not stated" ? 8 : 0, 8);

    if (f.origin === "calc") {
      add("Method or functional", f.func ? 8 : 0, 8);
      add("Basis set", f.basis ? 7 : 0, 7);
      add("Solvent model", f.solv ? 5 : 0, 5);
      var ck = /^Computed/.test(f.kind);
      add("Value type matches a computation", ck ? 3 : 0, 3, ck ? "" : "Choose adiabatic or vertical");
    } else {
      add("Technique", f.tech ? 10 : 0, 10);
      add("Solvent or matrix", f.solvent ? 5 : 0, 5);
      add("Temperature", f.temp ? 5 : 0, 5);
      add("Uncertainty given", !isNaN(f.unc) ? 3 : 0, 3);
    }

    var doiOk = /^10\.\d{4,9}\/\S+$/.test(f.doi);
    add("DOI well formed", doiOk ? 6 : 0, 6, f.doi && !doiOk ? "This does not look like a DOI" : "");
    if (!doiOk) add("DOI resolves", 0, 6, f.doi ? "" : "No DOI given");
    else if (ctx.doiResolves == null) add("DOI resolves", 0, 6, "Checked when the entry is submitted");
    else add("DOI resolves", ctx.doiResolves ? 6 : 0, 6, ctx.doiResolves ? "" : "doi.org does not know this DOI");

    add("Citation", f.cite ? 5 : 0, 5);
    add("Location in the paper", f.loc ? 6 : 0, 6);

    var words = f.quote ? f.quote.split(/\s+/).length : 0;
    add("Verbatim line", words > 0 && words <= 25 ? 4 : 0, 4, words > 25 ? "Keep it to one short line (25 words or fewer)" : "");

    var cons = 0, note = "No structure to compare";
    if (ctx.same && !isNaN(f.kcal)) {
      var dup = null, best = Infinity;
      ctx.same.forEach(function (d) {
        var diff = Math.abs(Number(d.et_kcal) - f.kcal);
        if (diff < best) best = diff;
        if (f.doi && String(d.doi || "").toLowerCase() === f.doi.toLowerCase() && diff < 0.05) dup = d;
      });
      if (dup) { cons = 0; note = "Looks like a duplicate of “" + dup.name + "” (same structure, DOI and value)"; }
      else if (!ctx.same.length) { cons = 8; note = "No existing entry for this structure"; }
      else {
        cons = best <= 5 ? 8 : best <= 10 ? 5 : 2;
        note = best <= 5 ? "Within 5 kcal/mol of an existing entry for this structure"
          : "Differs by " + best.toFixed(1) + " kcal/mol from the closest existing entry. This can be right if the value type differs";
      }
    }
    add("Consistency with the database", cons, 8, note);

    add("UV-vis or excitation data", f.uv || f.direct ? 4 : 0, 4);

    var total = items.reduce(function (a, i) { return a + i.got; }, 0);
    return { total: total, grade: gradeOf(total).label, items: items };
  }

  /* The minimum a submission needs. Returns a message, or null when it can be sent. */
  function requiredError(f, ctx) {
    ctx = ctx || {};
    if (!f.smiles) return "Add the structure as a SMILES or draw it.";
    if (ctx.structureOk === false) return "The SMILES could not be read. Fix it or redraw the structure.";
    if (isNaN(f.kcal)) return "Enter the triplet energy value.";
    if (!f.cite && !f.doi) return "Add a citation or a DOI so the value can be traced.";
    return null;
  }

  /* Normalised fields + score -> database row (without status, ids or server-only columns). */
  function toDoc(f, sc) {
    var unitLabel = f.unit === "kj" ? "kJ/mol" : f.unit === "ev" ? "eV" : "kcal/mol";
    var doc = {
      name: f.name || "(unnamed)", smiles: f.smiles, role: f.role, origin: f.origin,
      et_kcal: Math.round(f.kcal * 10) / 10,
      et_reported: f.et + (isNaN(f.unc) ? "" : " ± " + f.unc) + " " + unitLabel,
      et_type: f.kind || "Not stated",
      method: f.origin === "calc" ? ["Computation", f.func, f.basis].filter(Boolean).join(", ") : (f.tech || "Not stated"),
      conditions: f.origin === "calc" ? f.solv : [f.solvent, f.temp].filter(Boolean).join(", "),
      source_kind: "form", score: sc.total, score_items: sc.items
    };
    if (!isNaN(f.uncKcal)) doc.et_unc = Math.round(f.uncKcal * 10) / 10;
    [["cls", f.cls], ["citation", f.cite], ["doi", f.doi], ["location", f.loc], ["quote", f.quote],
     ["uv", f.uv], ["direct_exc", f.direct], ["submitted_by", f.by]].forEach(function (p) { if (p[1]) doc[p[0]] = p[1]; });
    return doc;
  }

  root.EntScore = { normalize: normalize, gradeOf: gradeOf, scoreEntry: scoreEntry, requiredError: requiredError, toDoc: toDoc };
})(typeof globalThis !== "undefined" ? globalThis : this);
