# EnT-DB

A curated database of triplet energies for energy-transfer (EnT) donors and acceptors.
Every entry records the value, how it was determined (experiment or computation, and which),
the paper it comes from and where in that paper, and the structure.

Site: https://nuniwo-source.github.io/EnT-DB/

## How it works

- **Browse and search.** Text search, plus exact-structure, substructure and similarity search
  (structures are handled in the browser by [OpenChemLib](https://github.com/cheminfo/openchemlib-js)).
- **Submit.** Anyone can propose an entry. The form scores it from 0 to 100 for completeness and
  consistency; the server recomputes the score, so the browser cannot fake it.
- **Review.** A submission is stored as *pending* and the curator is notified. It becomes public
  only when a curator approves it on the review page (`admin.html`).

The score measures whether an entry is complete and consistent (structure parses, plausible value,
method fully specified, DOI resolves, agreement with existing entries). It does not prove the value is right.

## Layout

| Path | What it is |
| --- | --- |
| `docs/` | The static site served by GitHub Pages |
| `docs/assets/config.js` | The two public settings that connect the site to the backend |
| `docs/assets/score.js` | The scoring rules (shared by browser and server) |
| `supabase/schema.sql` | Database tables, access rules and the public view |
| `supabase/seed.sql` | First batch of literature entries, imported as pending |
| `docs/batches/` | Literature batches (JSON). A curator imports new ones into the queue from the review page |
| `supabase/functions/submit/index.ts` | Server function: validates, scores, stores, notifies. **Generated** |
| `tools/` | `build-function.mjs` regenerates the server function; `test-score.mjs` tests the scoring |

Until `docs/assets/config.js` is filled in, the site shows only a "not open yet" notice.

## Setup

Everything below is on free plans.

### 1. GitHub Pages

Repository **Settings → Pages → Build and deployment**: source *Deploy from a branch*, branch `main`, folder `/docs`.

### 2. Supabase (database, sign-in, server function)

1. Create a project at supabase.com.
2. **SQL Editor**: run `supabase/schema.sql`, then `supabase/seed.sql`.
3. Still in the SQL editor, list the curators' email addresses:
   ```sql
   insert into public.admins (email) values ('first@example.org'), ('second@example.org')
   on conflict do nothing;
   ```
4. **Authentication → Users → Add user → Create new user**: create one account per curator, with the same
   email as in step 3, a password, and *Auto Confirm User* ticked. Curators sign in on `admin.html` with these.
   (Email sign-in links are not used: Supabase's built-in mailer only delivers to members of the project's team.)
   Then **Authentication → Sign In / Providers**: switch off *Allow new users to sign up*. Curator rights
   go only to accounts with a *confirmed* email listed in `admins`, but nobody else needs an account at all.
5. **Edge Functions → Deploy a new function → Via editor**: name it `submit` and paste the whole of
   `supabase/functions/submit/index.ts`. Switch **Verify JWT off** for this function: visitors are anonymous.
   Access is controlled inside the function (shared site login, rate limit).
6. **Edge Functions → Secrets**: add `SITE_URL` = `https://nuniwo-source.github.io/EnT-DB` and `IP_SALT` = any long random text
   (required: without it the function refuses submissions), plus the notification secret from step 4 below.
7. **Project Settings → API**: copy the *Project URL* and the *anon / publishable* key into `docs/assets/config.js`
   and commit. These two values are meant to be public. Never commit the *service role* key.

### 3. Shared site login (optional)

To keep the site private while it is being set up, give it one shared user name and password.
Run this in the SQL editor with your own values; the password is stored only as a bcrypt hash in the database,
never in this repository:

```sql
insert into public.site_access (username, pass_hash)
values ('USER NAME', extensions.crypt('PASSWORD', extensions.gen_salt('bf')))
on conflict (username) do update set pass_hash = excluded.pass_hash;
```

While that table has a row, the data and the submission endpoint both refuse requests without the right login;
the check runs in the database, so it cannot be skipped from the browser. To open the site to everyone:
`delete from public.site_access;`

The login is a single shared secret with no lockout after wrong attempts, so pick a long password
and treat it as a temporary measure. The review page does not use it: curators sign in with their own email and password.

### 4. Notifications

Choose one or both; the function sends whichever is configured.

- **Email (Resend).** Create a Resend account *with the address that should receive the notifications*, create an API key,
  and add the secrets `RESEND_API_KEY` and `NOTIFY_EMAIL`. Without a verified domain Resend only delivers to the
  account's own address, which is exactly enough for a single curator. For several curators, verify a domain in Resend,
  set `NOTIFY_FROM` to an address on it, and list the curators comma-separated in `NOTIFY_EMAIL`.
- **Phone push (ntfy).** Install the ntfy app, subscribe to a long random topic name, and add it as the secret `NTFY_TOPIC`.
  No account needed. Anyone who knows the topic name can read the notifications, so keep it unguessable.

### Keeping the free project awake

Supabase pauses a free project after a week without requests. Any visit to the site counts as a request;
if the site may sit unvisited, set up a weekly ping of the site's public data URL.

## Literature batches

`docs/batches/index.json` lists JSON files of entries transcribed from openly licensed datasets, in review-priority order
(experimental values and well-known catalysts first). When a curator opens `admin.html`, entries not yet in the database are
offered for import as *pending*; each carries an `import_key`, so importing twice adds nothing. Sources and licences:

- MarcusEnT supporting data (Hölter, Schlosser, Hümpel, Spierling, Glorius), Zenodo doi:10.5281/zenodo.23505512, CC BY 4.0
- EnTdecker dataset (Schlosser et al., J. Am. Chem. Soc. 2024, 146, 13266), Zenodo doi:10.5281/zenodo.10391170, CC BY 4.0
- DvTE benchmark data (Popescu, Paton, Chem 2024, 10, 3428), github.com/patonlab/DvTE, MIT licence

## Development

```
node tools/test-score.mjs          # scoring rules
node tools/build-function.mjs      # regenerate the server function after editing score.js or the template
```

## Limits worth knowing

- The submission endpoint has a honeypot field, a limit of 5 submissions per hour per connection and of 30 per hour
  from all visitors together, and no captcha. The per-connection limit relies on the address the proxy reports,
  so a determined sender can get around it; the overall limit still caps the queue and the notifications.
- Submissions are refused while the server cannot load the structure library, so every stored entry has been checked.
- Curator accounts are created by hand in the Supabase dashboard; there is no self-service password reset.
- Values are transcribed from the cited papers. Check the source before relying on one.
