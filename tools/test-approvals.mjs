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

console.log("approval tests passed");
