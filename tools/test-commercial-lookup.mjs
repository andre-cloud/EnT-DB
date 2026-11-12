// Checks PubChem commercial-name lookup from CAS and duplicate title handling.
// Run: node tools/test-commercial-lookup.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeNode(tag) {
  return {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...args) { this.children = args; },
  };
}

globalThis.window = globalThis;
globalThis.ENT_CONFIG = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
  documentElement: { removeAttribute() {}, setAttribute() {}, getAttribute() { return null; } },
  body: { classList: { toggle() {} } },
  head: { appendChild() {} },
  getElementById: () => null,
  addEventListener: () => {},
  createElement: (tag) => makeNode(tag),
  createTextNode: (t) => ({ textContent: t }),
};

(0, eval)(readFileSync(join(root, "docs/assets/score.js"), "utf8"));
(0, eval)(readFileSync(join(root, "docs/assets/common.js"), "utf8"));

const Ent = globalThis.Ent;

// 1. Input validation for CAS
let res = await Ent.lookupCommercialNameDetailed("");
assert.equal(res.code, "no_cas");
assert.equal(res.value, "");

res = await Ent.lookupCommercialNameDetailed("100-42-6"); // invalid check digit
assert.equal(res.code, "bad_input");
assert.equal(res.value, "");

// 2. Primary PubChem Title lookup
let calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, body: opts && opts.body });
  return {
    ok: true,
    status: 200,
    json: async () => ({ PropertyTable: { Properties: [{ CID: 3102, Title: "Benzophenone" }] } }),
  };
};

res = await Ent.lookupCommercialNameDetailed("119619");
assert.equal(res.code, "ok");
assert.equal(res.value, "Benzophenone");
assert.equal(calls.length, 1);
assert.ok(calls[0].url.endsWith("/compound/name/property/Title/JSON"));
assert.equal(calls[0].body, "name=119-61-9");

// 3. Fallback to Synonyms when Title is a CAS number or CID placeholder
calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  if (url.endsWith("/property/Title/JSON")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ PropertyTable: { Properties: [{ CID: 7501, Title: "100-42-5" }] } }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      InformationList: {
        Information: [{
          Synonym: ["100-42-5", "UNII-44LJ2U959V", "DTXSID2021284", "Styrene", "Ethenylbenzene", "styrene"],
        }],
      },
    }),
  };
};

res = await Ent.lookupCommercialNameDetailed("100-42-5");
assert.equal(res.code, "ok");
assert.equal(res.value, "Styrene");
assert.deepEqual(res.synonyms, ["Styrene", "Ethenylbenzene"]);
assert.equal(calls.length, 2);

// 4. 404 from PubChem
globalThis.fetch = async () => ({ ok: false, status: 404 });
res = await Ent.lookupCommercialNameDetailed("7732-18-5");
assert.equal(res.code, "not_found");
assert.equal(res.value, "");

// 5. Lookup synonyms directly
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    InformationList: { Information: [{ Synonym: ["492-22-8", "CID10339", "Thioxanthone", "9H-Thioxanthen-9-one"] }] },
  }),
});
const synRes = await Ent.lookupCommercialSynonyms("492228");
assert.equal(synRes.code, "ok");
assert.deepEqual(synRes.values, ["Thioxanthone", "9H-Thioxanthen-9-one"]);

// 6. renderMolTitle avoids duplicating identical commercial & IUPAC names (case-insensitive)
const hostSame = makeNode("div");
Ent.renderMolTitle(hostSame, { commercial_name: "Anthracene", name: "anthracene" });
assert.equal(hostSame.children[0].children.length, 1);

const hostDiff = makeNode("div");
Ent.renderMolTitle(hostDiff, { commercial_name: "Benzophenone", name: "diphenylmethanone" });
assert.equal(hostDiff.children[0].children.length, 2);

console.log("commercial name lookup checks passed");
