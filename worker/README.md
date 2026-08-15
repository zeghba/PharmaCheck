# PharmaCheck sync Worker

A small Cloudflare Worker that gives PharmaCheck a shared database across
several phones. The app stays local-first — every screen reads the copy on the
device, so the counter still works with no signal — and this Worker is what
makes those copies agree.

It exists because two things cannot live on a phone:

- **The Turso platform token.** It can create and destroy every database in the
  organisation. It is a Worker secret and is never sent to a device.
- **The authority to decide what a price is.** Turso scopes database tokens by
  table and action, not by column. A token that lets a vendor decrement `qty`
  to record a sale is necessarily a token that lets them rewrite `price` and
  `cost` — the two numbers their pay is calculated from. So vendors post sales
  here, and the server reads the price out of its own row and ignores whatever
  the device claimed.

Roughly 900 lines, no framework, no dependencies at runtime.

## Setup

### 1. Turso

Create an account and a group, then a platform token:

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso group create default            # skip if you already have one
turso auth api-tokens mint pharmacheck
```

Note the token it prints and your organisation slug (`turso org list`).

### 2. Cloudflare

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create PHARMACIES
```

Paste the namespace `id` it prints into `wrangler.toml`, and set your Turso
organisation slug in the `[vars]` block.

### 3. Secrets

```bash
npx wrangler secret put TURSO_PLATFORM_TOKEN   # from step 1
npx wrangler secret put SESSION_SECRET         # any long random string
npx wrangler secret put SETUP_KEY              # you choose; gates provisioning
```

For `SESSION_SECRET`, `openssl rand -base64 32` is fine.

### 4. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL. Check it:

```bash
curl https://pharmacheck-sync.<subdomain>.workers.dev/v1/health
```

Every field under `configured` should be `true`. That URL and your setup key are
what you type into the app's **Settings** tab — nothing else from this page goes
onto a phone.

## Creating a pharmacy

From the app: **Settings → Set up a new pharmacy**. Or by hand:

```bash
curl -X POST https://<worker>/v1/pharmacy \
  -H "x-setup-key: $SETUP_KEY" \
  -H "content-type: application/json" \
  -d '{"pharmacy":"central","managerName":"Sarah Kaur","managerPin":"1234"}'
```

That creates the database `pharmacheck-central`, applies the schema, and writes
the manager account. The pharmacy code is what every device types once, in
Settings, to join.

## API

| Route | Auth | Who | Does |
|---|---|---|---|
| `GET /v1/health` | — | — | reports which secrets are set, never their values |
| `POST /v1/pharmacy` | `x-setup-key` | owner | creates a database, applies the schema, writes the manager |
| `GET /v1/accounts?pharmacy=` | pharmacy code | — | names for the sign-in picker, no PINs |
| `POST /v1/signin` | pharmacy + PIN | anyone | returns a session token and a full snapshot |
| `POST /v1/pull` | bearer | any signed-in | full snapshot |
| `POST /v1/push` | bearer | any signed-in | applies queued operations, role-checked, returns a snapshot |

`MANAGER_ONLY` in `src/index.js` is the single list of what a vendor cannot do.
The role guard in the app's `go()` is a UI convenience; this is the boundary.

## Admin API

Everything under `/v1/admin/` is the surface the [admin app](../admin/README.md)
talks to — creating pharmacies, managing their accounts, and setting the Turso
credentials. It lives behind a different claim from the pharmacy API:

| Route | Does |
|---|---|
| `POST /v1/admin/signin` | exchanges `SETUP_KEY` for an 8-hour admin session |
| `GET /v1/admin/overview` | totals across every pharmacy, plus a row each |
| `GET \| POST /v1/admin/pharmacies` | list, or create one with its first manager |
| `GET \| DELETE /v1/admin/pharmacies/:code` | one pharmacy in full, or archive it |
| `POST \| PATCH \| DELETE …/accounts[/:id]` | add, edit or remove a manager or vendor |
| `GET \| PUT /v1/admin/config` | the Turso organisation, group and platform token |
| `GET /v1/admin/config/test` | asks Turso whether those credentials actually work |

An admin token carries `r: "admin"` and no pharmacy; a pharmacy token carries a
pharmacy and a role. Neither can be edited into the other — the signature covers
the claim — and each is refused by the other's routes. `test/admin.test.js`
holds that boundary in place.

`DELETE /v1/admin/pharmacies/:code` drops the pharmacy from the KV index and
evicts it from the in-isolate cache, but **keeps its database** unless the body
carries `{"dropDatabase": true}`. The records outlive the decision to stop using
them; destroying them is a separate, explicit act.

## What the PIN is worth

Four digits is ten thousand possibilities. PINs are stored as PBKDF2-SHA256
(210k iterations, per-account salt), so a database dump does not hand over
everyone's PIN, and `/v1/signin` locks an account for 15 minutes after 8 wrong
attempts, so the space cannot be walked online.

That is the honest limit of a 4-digit PIN, and it is why the PIN is not the
security boundary. The **session token** is: it is signed with `SESSION_SECRET`,
scoped to one account, carries that account's role, expires after 12 hours, and
cannot be minted anywhere but here.

## Cost

Sign-ins and sales, not queries — reads are served from the copy on the device.
A busy pharmacy is a few hundred requests a day, against a free tier of 100,000.
Turso's Developer plan ($4.99/mo) covers unlimited databases; the free tier's
100 databases is plenty to trial it.

## Local development

```bash
npx wrangler dev --remote
```

`--remote` matters: the Worker calls the Turso API over the network, and the
local-only simulator cannot reach it.
