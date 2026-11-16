// Checks two-admin approval rules in schema.sql, common.js, and admin.html/admin.js.
// Run: node tools/test-approvals.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Verify schema.sql contains DB-level two-admin enforcement
const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");
for (const needle of [
  "alter table public.entries add column if not exists approvals jsonb not null default '[]'::jsonb",
  "alter table public.suggestions add column if not exists approvals jsonb not null default '[]'::jsonb",
  "create or replace function public.current_admin_email()",
  "create or replace function public.count_valid_approvals(p_approvals jsonb)",
  "create or replace function public.entries_enforce_approval_policy()",
  "create trigger entries_approval_policy_trg",
  "create or replace function public.approve_entries(p_ids uuid[], p_note text default null)",
  "create or replace function public.revoke_entry_approval(p_id uuid, p_note text default null)",
  "create or replace function public.suggestions_enforce_approval_policy()",
  "create trigger suggestions_approval_policy_trg",
  "create or replace function public.approve_suggestion(p_id uuid, p_note text default null)",
  "create or replace function public.revoke_suggestion_approval(p_id uuid, p_note text default null)",
  "grant execute on function public.approve_entries(uuid[], text) to authenticated",
  "grant execute on function public.revoke_entry_approval(uuid, text) to authenticated",
  "grant execute on function public.approve_suggestion(uuid, text) to authenticated",
  "grant execute on function public.revoke_suggestion_approval(uuid, text) to authenticated",
  // Redox potentials follow the same two-admin rules.
  "create table if not exists public.redox_entries (",
  "create or replace function public.redox_enforce_approval_policy()",
  "create trigger redox_approval_policy_trg",
  "create or replace function public.approve_redox_entries(p_ids uuid[], p_note text default null)",
  "create or replace function public.revoke_redox_approval(p_id uuid, p_note text default null)",
  "grant execute on function public.approve_redox_entries(uuid[], text) to authenticated",
  "grant execute on function public.revoke_redox_approval(uuid, text) to authenticated",
  "check (num_nonnulls(entry_id, redox_id) = 1)",
  "create or replace function public.list_redox(p_user text default '', p_pass text default '')",
]) {
  assert.ok(schema.includes(needle), `schema.sql missing: ${needle}`);
}

// 2. Minimal DOM & browser stub to load score.js and common.js
function makeNode(tag) {
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    id: "",
    type: "",
    textContent: "",
    hidden: false,
    disabled: false,
    checked: false,
    title: "",
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    appendChild(ch) { if (ch) this.children.push(ch); return ch; },
    replaceChildren(...args) { this.children = args.filter(Boolean); },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} })); },
  };
  return node;
}

function matches(node, sel) {
  if (!node || !node.tagName) return false;
  if (sel === "button") return node.tagName === "BUTTON";
  if (sel.startsWith(".")) return String(node.className || "").split(/\s+/).includes(sel.slice(1));
  const m = /^([a-z]+)?\[data-act="([^"]+)"\]$/i.exec(sel);
  if (m) {
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    return node.getAttribute("data-act") === m[2];
  }
  return false;
}

const fetchCalls = [];
globalThis.window = globalThis;
globalThis.ENT_CONFIG = { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "sb_publishable_test" };
globalThis.document = {
  createElement: (t) => makeNode(t),
  createTextNode: (t) => ({ textContent: String(t), children: [] }),
  getElementById: () => null,
  addEventListener: () => {},
  documentElement: makeNode("html"),
  body: makeNode("body"),
};
globalThis.localStorage = {
  _map: new Map([
    ["entdb-admin-session", JSON.stringify({
      access_token: "tok_admin",
      refresh_token: "ref_admin",
      expires_at: Date.now() + 3600 * 1000,
      email: "alice@example.org",
    })],
  ]),
  getItem(k) { return this._map.get(k) ?? null; },
  setItem(k, v) { this._map.set(k, String(v)); },
  removeItem(k) { this._map.delete(k); },
};
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ id: "e1", status: "pending", approvals: [{ email: "alice@example.org", at: "2026-11-12T10:00:00Z" }] }]),
  };
};

(0, eval)(readFileSync(join(root, "docs/assets/score.js"), "utf8"));
(0, eval)(readFileSync(join(root, "docs/assets/common.js"), "utf8"));

const Ent = globalThis.Ent;

// 3. Approval state & deduplication
{
  const d = {
    approvals: [
      { email: "ALICE@Example.org", at: "2026-11-12T10:00:00Z" },
      { email: "alice@example.org", at: "2026-11-12T10:05:00Z" },
    ],
  };
  const apAlice = Ent.approvalState(d, "alice@example.org");
  assert.equal(apAlice.count, 1);
  assert.equal(apAlice.byMe, true);
  assert.equal(apAlice.byOthers.length, 0);
  assert.equal(apAlice.needed, 1);

  const apBob = Ent.approvalState(d, "Bob@Example.org");
  assert.equal(apBob.count, 1);
  assert.equal(apBob.byMe, false);
  assert.equal(apBob.byOthers.length, 1);
  assert.equal(apBob.needed, 1);
}

// 4. Filter sort "approvals" orders 1/2 entries before 0/2 entries
{
  const rows = [
    { id: "a", name: "A", smiles: "C", et_kcal: 50, score: 90, created_at: "2026-01-01T00:00:00Z", approvals: [] },
    { id: "b", name: "B", smiles: "CC", et_kcal: 55, score: 60, created_at: "2026-01-02T00:00:00Z", approvals: [{ email: "alice@example.org", at: "2026-11-12T10:00:00Z" }] },
  ];
  const st = Ent.newSearch("approvals");
  const res = Ent.filterRows(rows, st);
  assert.deepEqual(res.rows.map((r) => r.id), ["b", "a"]);
}

// 5. Card rendering across 0/2, 1/2 by other, 1/2 by me, 2/2 approved, rejected
{
  const baseDoc = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Benzophenone",
    smiles: "O=C(c1ccccc1)c1ccccc1",
    role: "donor",
    origin: "exp",
    et_kcal: 68.6,
    smiles_checked: true,
    status: "pending",
    approvals: [],
  };
  const mkAdm = (email) => ({
    email,
    busy: {},
    drafts: {},
    activeId: "",
    selected: {},
    onSelect: () => {},
    onPatch: async () => true,
    approve: async () => true,
    reject: async () => true,
    revoke: async () => true,
  });

  // 0/2 pending
  const c0 = Ent.card(baseDoc, { admin: mkAdm("alice@example.org") });
  const b0 = c0.querySelector('button[data-act="approve"]');
  assert.equal(b0.textContent, "Verify (1/2)");
  assert.equal(b0.disabled, false);
  assert.equal(c0.querySelector(".approval-note"), null);

  // 1/2 verified by Alice, viewed by Bob
  const doc1 = { ...baseDoc, approvals: [{ email: "alice@example.org", at: "2026-11-12T10:00:00Z" }] };
  const c1Other = Ent.card(doc1, { admin: mkAdm("bob@example.org") });
  const b1Other = c1Other.querySelector('button[data-act="approve"]');
  assert.equal(b1Other.textContent, "Approve (2/2)");
  assert.equal(b1Other.disabled, false);
  assert.ok(c1Other.querySelector(".approval-note").children[0].textContent.includes("alice@example.org"));

  // 1/2 verified by Alice, viewed by Alice
  const c1Me = Ent.card(doc1, { admin: mkAdm("alice@example.org") });
  const b1Me = c1Me.querySelector('button[data-act="approve"]');
  const revMe = c1Me.querySelector('button[data-act="revoke"]');
  assert.equal(b1Me.textContent, "Verified by you (1/2)");
  assert.equal(b1Me.disabled, true);
  assert.equal(revMe.textContent, "Withdraw verification");

  // 2/2 approved
  const doc2 = {
    ...baseDoc,
    status: "approved",
    approvals: [
      { email: "alice@example.org", at: "2026-11-12T10:00:00Z" },
      { email: "bob@example.org", at: "2026-11-12T11:00:00Z" },
    ],
  };
  const c2 = Ent.card(doc2, { admin: mkAdm("alice@example.org") });
  assert.ok(c2.querySelector(".approval-note").children[0].textContent.includes("alice@example.org and bob@example.org"));

  // Rejected
  const docRej = { ...baseDoc, status: "rejected", approvals: [] };
  const cRej = Ent.card(docRej, { admin: mkAdm("alice@example.org") });
  assert.equal(cRej.querySelector('button[data-act="approve"]').textContent, "Verify (1/2)");
}

// 6. Suggestion card rendering
{
  const entry = { id: "e1", name: "Styrene", smiles: "C=Cc1ccccc1", et_kcal: 62, origin: "exp" };
  const sg = { id: "s1", entry_id: "e1", status: "pending", changes: { et_kcal: 62.5 }, comment: "Check Table 1", approvals: [{ email: "alice@example.org", at: "2026-11-12T10:00:00Z" }] };
  const sBob = Ent.suggestionCard(sg, entry, { email: "bob@example.org", busy: {}, approve: () => {}, revoke: () => {}, reject: () => {}, edit: () => {} });
  assert.ok(sBob.querySelectorAll("button").some((b) => b.textContent === "Approve & apply (2/2)"));

  const sAlice = Ent.suggestionCard(sg, entry, { email: "alice@example.org", busy: {}, approve: () => {}, revoke: () => {}, reject: () => {}, edit: () => {} });
  assert.ok(sAlice.querySelectorAll("button").some((b) => b.textContent === "Verified by you (1/2)" && b.disabled));
  assert.ok(sAlice.querySelectorAll("button").some((b) => b.textContent === "Withdraw verification" && !b.disabled));
}

// 7. API RPC endpoints & chunking (>100 ids)
{
  fetchCalls.length = 0;
  const ids = Array.from({ length: 105 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  const rows = await Ent.api.adminApproveMany(ids);
  assert.equal(fetchCalls.length, 2);
  assert.equal(rows.length, 2);
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/approve_entries"));
  assert.equal(JSON.parse(fetchCalls[0].init.body).p_ids.length, 100);
  assert.equal(JSON.parse(fetchCalls[1].init.body).p_ids.length, 5);
  assert.equal(JSON.parse(fetchCalls[0].init.body).p_note, null);

  fetchCalls.length = 0;
  await Ent.api.adminRevokeApproval("id-1", "oops");
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/revoke_entry_approval"));
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { p_id: "id-1", p_note: "oops" });

  fetchCalls.length = 0;
  await Ent.api.adminApproveSuggestion("sg-1", "looks good");
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/approve_suggestion"));
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { p_id: "sg-1", p_note: "looks good" });

  fetchCalls.length = 0;
  await Ent.api.adminRevokeSuggestionApproval("sg-1");
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/revoke_suggestion_approval"));
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { p_id: "sg-1", p_note: null });
}

// 8. admin.html & admin.js wiring checks
const adminHtml = readFileSync(join(root, "docs/admin.html"), "utf8");
assert.ok(adminHtml.includes('data-triage="need2"'));
assert.ok(adminHtml.includes('data-triage="wait2"'));
assert.ok(adminHtml.includes('value="approvals"'));

const adminJs = readFileSync(join(root, "docs/assets/admin.js"), "utf8");
new Script(readFileSync(join(root, "docs/assets/common.js"), "utf8"), { filename: "common.js" });
new Script(adminJs, { filename: "admin.js" });
assert.ok(adminJs.includes('data-act="approve"'));
assert.ok(adminJs.includes("adminApproveMany"));
assert.ok(adminJs.includes("adminRevokeApproval"));
assert.ok(adminJs.includes("adminApproveSuggestion"));
assert.ok(adminJs.includes("adminRevokeSuggestionApproval"));

// 9. PhotoreDBox: the same review page on redox_entries
{
  fetchCalls.length = 0;
  await Ent.api.adminApprove("rx-1", null, "redox_entries");
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/approve_redox_entries"));
  fetchCalls.length = 0;
  await Ent.api.adminApprove("e-1", null);
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/approve_entries"));
  fetchCalls.length = 0;
  await Ent.api.adminRevokeApproval("rx-1", null, "redox_entries");
  assert.ok(fetchCalls[0].url.endsWith("/rest/v1/rpc/revoke_redox_approval"));

  const rx = {
    id: "22222222-2222-2222-2222-222222222222", name: "Thioxanthone", smiles: "O=c1c2ccccc2sc2ccccc12",
    kind: "red", state: "S0", origin: "exp", e_v: -2.0, e_ref: "Fc+/Fc", solvent: "MeCN", e_sce: -1.62,
    doi: "10.1021/jacs.0c05069", smiles_checked: true, status: "pending",
    approvals: [{ email: "alice@example.org", at: "2026-11-12T10:00:00Z" }],
  };
  const mk = (email) => ({ email, busy: {}, drafts: {}, activeId: "", selected: {}, onSelect: () => {}, onPatch: async () => true, approve: async () => true, reject: async () => true, revoke: async () => true });
  const cBob = Ent.card(rx, { admin: mk("bob@example.org") });
  assert.equal(cBob.querySelector('button[data-act="approve"]').textContent, "Approve (2/2)");
  const cAlice = Ent.card(rx, { admin: mk("alice@example.org") });
  assert.equal(cAlice.querySelector('button[data-act="approve"]').textContent, "Verified by you (1/2)");
  assert.equal(cAlice.querySelector('button[data-act="revoke"]').textContent, "Withdraw verification");

  // same value = same origin and quantity, within 0.05 V vs SCE from the same paper or 0.01 V otherwise
  const other = { ...rx, id: "x", e_sce: -1.66 };
  assert.equal(Ent.sameValue(rx, other), true);
  assert.equal(Ent.sameValue(rx, { ...other, doi: "10.1021/cr300503r" }), false);
  assert.equal(Ent.sameValue(rx, { ...other, doi: "10.1021/cr300503r", e_sce: -1.625 }), true);
  assert.equal(Ent.sameValue(rx, { ...other, kind: "ox" }), false);
  assert.equal(Ent.sameValue(rx, { ...other, state: "T1" }), false);
  assert.equal(Ent.sameValue(rx, { ...other, origin: "calc" }), false);
  assert.equal(Ent.sameValue(rx, { id: "t", et_kcal: 63, origin: "exp" }), false);

  // e_sce follows e_v, e_ref and the solvent; a ground state carries no E* fields
  assert.deepEqual(Ent.redoxDerivedPatch({ e_v: -2.1 }, rx), { e_v: -2.1, e_sce: -1.72 });
  assert.deepEqual(Ent.redoxDerivedPatch({ e_ref: "Ag/Ag+" }, rx), { e_ref: "Ag/Ag+", e_sce: null });
  assert.deepEqual(Ent.redoxDerivedPatch({ state: "S0" }, { ...rx, state: "T1", excited_from: "estimated", e00_ev: 2.7 }),
    { state: "S0", excited_from: null, e00_ev: null });

  // a reader's correction to a redox value
  const sg = { id: "s2", redox_id: rx.id, entry_id: null, status: "pending", changes: { e_v: -2.05 }, approvals: [] };
  const sc = Ent.suggestionCard(sg, rx, { email: "bob@example.org", busy: {}, approve: () => {}, revoke: () => {}, reject: () => {}, edit: () => {} });
  assert.ok(sc.querySelectorAll("button").some((b) => b.textContent === "Verify correction (1/2)"));
}
{
  const prxHtml = readFileSync(join(root, "docs/photoredbox/admin.html"), "utf8");
  for (const needle of ['data-triage="need2"', 'data-triage="wait2"', 'value="approvals"', 'id="f-prop"', 'id="f-eref"', 'value="e-asc"', 'id="up-file"', 'id="selbar"', 'id="triage-bar"']) {
    assert.ok(prxHtml.includes(needle), `photoredbox/admin.html missing: ${needle}`);
  }
  assert.ok(!prxHtml.includes('id="f-role"') && !prxHtml.includes('id="f-etmin"'), "photoredbox/admin.html must not carry triplet-energy filters");
  assert.ok(prxHtml.indexOf("../assets/site-redox.js") >= 0 && prxHtml.indexOf("../assets/site-redox.js") < prxHtml.indexOf("../assets/admin.js"),
    "photoredbox/admin.html must load site-redox.js before admin.js");
  const site = readFileSync(join(root, "docs/assets/site-redox.js"), "utf8");
  assert.ok(/window\.ENT_SITE\s*=\s*\{\s*kind:\s*"redox"/.test(site));
  assert.ok(adminJs.includes('TABLE = RX ? "redox_entries"'));
  assert.ok(adminJs.includes("sg.redox_id"));
  const untabled = adminJs.split("\n").filter((l) => /api\.admin(Approve|ApproveMany|RevokeApproval|List|Patch|PatchMany|PatchManyRows|Import|DeleteMany)\(/.test(l) && !l.includes("TABLE"));
  assert.deepEqual(untabled, [], "every curator call on entries or redox_entries passes the table");
}

console.log("approval tests passed");
