# AskToto License Server

A small, standalone phone-home license server for AskToto. It controls
**whether the app is allowed to run** for a given company — it has nothing to
do with LLM API keys (those are bring-your-own-key and configured entirely
client-side).

This is **not** part of the AskToto Electron app's build. It's a separate
Node service you deploy wherever you like (Fly.io, Railway, a plain VPS,
Docker anywhere) and point the app at via a server URL.

> **No license is required to run AskToto** until you configure a server URL
> and turn on the license gate in Settings (client-side, off by default).
> Deploy this server before you actually need to issue real licenses — the
> app works fully without it in the meantime.

## How it works

- Each company gets one **license key** with a **seat cap** (max concurrent
  activated machines), plus optional contact name, contact email, and notes
  for your own record-keeping (deal notes, plan tier, whatever's useful).
- The AskToto client calls `/activate` once per machine, then periodically
  calls `/heartbeat` to stay validated.
- The client is responsible for a 7-day offline grace period if it can't
  reach the server — that logic lives in the AskToto app itself, not here.
- Data is stored in a single JSON file (`data/licenses.json`) with atomic
  writes (write-to-tmp-then-rename) serialized through an in-process write
  queue. No database required.

## Running locally

```bash
cd license-server
npm install
LICENSE_ADMIN_TOKEN=some-long-random-secret node server.mjs
```

Environment variables:

| Variable              | Default                     | Notes                                                                 |
|-----------------------|------------------------------|------------------------------------------------------------------------|
| `PORT`                | `8420`                       | HTTP port to listen on                                                 |
| `LICENSE_ADMIN_TOKEN`  | *(unset)*                    | Required for `/admin/*` routes. If unset, those routes return `503`.   |
| `LICENSE_DB_PATH`      | `license-server/data/licenses.json` | Where the JSON data file lives. Point this at a persistent volume in production. |
| `TRUST_PROXY`          | *(unset)*                    | Set to `1` ONLY when the server sits behind a reverse proxy (the deploy/ Caddy stack, Fly, nginx, Cloudflare) so per-client rate limiting and the admin lockout key on the real client IP. Leave unset when directly exposed, so a spoofed `X-Forwarded-For` can't be used to dodge those limits. |

## Deploying

The easiest turnkey path (your own server + a domain + automatic HTTPS) is in
[`deploy/README.md`](deploy/README.md).

This is a plain Node HTTP service — any of the following works. Pick
whichever fits your existing infra; none of this is prescriptive. In all
cases: the only thing that must survive restarts/redeploys is the `data/`
directory (or wherever `LICENSE_DB_PATH` points) — that's where
`licenses.json` and `audit.jsonl` live.

- **Docker Compose - one command on any box, including a Raspberry Pi** (the
  node:22-alpine base image is multi-arch, so the identical compose file builds
  natively on arm64 Pi 4/5, armv7, and x86 PCs):
  ```bash
  cd license-server
  LICENSE_ADMIN_TOKEN=$(openssl rand -hex 24) docker compose up -d --build
  ```
  Save that token somewhere safe (it is the admin credential). Dashboard:
  `http://<host>:8420/admin/ui`. License data lives on the `license_data`
  volume and survives rebuilds; updating = `git pull` then the same command.
  On a Pi, give the first build a few minutes.

- **Docker, anywhere** (a VPS, a container platform, etc.):
  ```bash
  docker build -t asktoto-license-server .
  docker run -p 8420:8420 \
    -e LICENSE_ADMIN_TOKEN=some-long-random-secret \
    -v /path/on/host/data:/app/data \
    asktoto-license-server
  ```
  Make sure `/app/data` is a persistent volume — otherwise licenses.json is
  lost on every container restart.

Railway (or any other VPS with Docker) works the same way: create a service
from this directory, set `LICENSE_ADMIN_TOKEN`, and attach a persistent
volume mounted at `/app/data`.

### Deploy to Fly.io

`fly.toml` in this directory already points at the Dockerfile, sets the
internal port to `8420`, and mounts a volume at `/app/data` (where the
server's default `LICENSE_DB_PATH` already resolves inside the container —
no extra env var needed). From `license-server/`:

```bash
fly launch --no-deploy                              # uses the existing fly.toml, don't deploy yet
fly volumes create license_data --size 1 --region iad  # match the region in fly.toml
fly secrets set LICENSE_ADMIN_TOKEN=$(openssl rand -hex 32)
fly deploy
```

Fly gives you HTTPS automatically. A plain VPS needs Caddy or a Cloudflare
proxy in front instead.

## Generating a license

Use the bundled CLI against a **running** server (no direct file access
needed):

```bash
node scripts/generate-license.mjs \
  --url https://your-license-server.example.com \
  --token some-long-random-secret \
  --company "Acme Corp" \
  --seats 25 \
  --expires 2027-01-01   # optional; omit for a perpetual license
```

It prints the resulting license key clearly, e.g.:

```
License created successfully.

  Company:     Acme Corp
  Seat cap:    25
  Expires:     2027-01-01T00:00:00.000Z

  License key:

    ATK-7QHM2K9X3VBN8ZC1FGJ0
```

## Backups and restore

`data/licenses.json` is the business record. Back it up and restore it through the
admin API of a running server (no direct volume access needed):

Back up (one exact `GET /admin/export` call, written to a timestamped file):

```
node scripts/backup.mjs --url <server-url> --token <admin-token> [--out ./backups]
```

Restore (REPLACES the entire store from a backup file; the server writes a
`licenses.pre-restore-<timestamp>.bak` snapshot next to its data file first, so a
wrong restore can't lose the current licenses):

```
node scripts/restore.mjs --url <server-url> --token <admin-token> --file ./backups/licenses-backup-....json --yes
```

Without `--yes`, restore only prints what it would do. Take a fresh backup before
any restore.

Crontab example (daily backup at 2am):

```
0 2 * * * cd /path/to/license-server && node scripts/backup.mjs --url https://your-license-server.example.com --token "$LICENSE_ADMIN_TOKEN" --out /path/to/backups >> /var/log/asktoto-license-backup.log 2>&1
```

A partially-corrupt `licenses.json` (valid JSON but a malformed record) has its bad
entries dropped with a warning on load; a file that isn't parseable JSON at all makes
the server refuse to start rather than come up with an empty store (which would
silently un-license every customer).

## Managing licenses in the browser

The server ships with a small admin dashboard, no separate deploy needed.

Open `<your-server-url>/admin/ui` in a browser (e.g.
`https://your-license-server.example.com/admin/ui`, or `http://localhost:8420/admin/ui`
when running locally). Visiting `/admin` redirects there too. Paste in your
`LICENSE_ADMIN_TOKEN` when prompted. It's stored only in that browser's
`localStorage`, so you won't need to re-enter it next time on the same device.

From the dashboard you can:

- See every license at a glance: company, seats used vs. cap, seats active
  in the last 30 days, status (active/revoked/expired), created and expiry
  dates.
- Create a new license (company name, seat cap, optional expiry, optional
  contact name/email and notes).
- Open a license to see its full key, its activated machines, and free a
  seat for any of them.
- Revoke or unrevoke a license, edit its seat cap or expiry date, and edit
  its contact name/email or notes.
- Export every license as a CSV file (button in the header) for finance or
  a spreadsheet.
- Switch to the audit log view to see every admin mutation (create, revoke,
  unrevoke, patch, seat free) with a timestamp and details.

The page itself contains no secrets. Only the browser calling it needs the
admin token, and every admin action still goes through the same
bearer-token-gated API described below. Sign out from the header to clear
the token from that browser.

The CLI (`npm run generate-license`) still works exactly as before, it's the
better option for scripting or batch-issuing licenses.

## Endpoint reference

All request/response bodies are JSON (`Content-Type: application/json`).

### Client endpoints

**`POST /activate`** — `{ licenseKey, machineId, machineName? }`

Activates a machine against a license. Idempotent: re-activating an
already-activated `machineId` (e.g. app restart) just refreshes
`lastSeenAt` and does not consume another seat.

- `{ ok: true, companyName, seatCap, seatsUsed, expiresAt }` on success
- `{ ok: false, error: "invalid" }` — unknown license key
- `{ ok: false, error: "revoked" }` — license has been revoked
- `{ ok: false, error: "expired" }` — license's `expiresAt` has passed
- `{ ok: false, error: "seat_limit_reached" }` — all seats taken by other machines

(Checked in that priority order: invalid > revoked > expired > seat limit.)

**`POST /heartbeat`** — `{ licenseKey, machineId }`

Re-validates an already-activated machine. Never consumes a seat.

- Same success shape as `/activate`.
- Same `invalid` / `revoked` / `expired` errors.
- `{ ok: false, error: "not_activated" }` — this machine was never activated for this key

**`POST /deactivate`** — `{ licenseKey, machineId }`

Frees a seat. Unauthenticated by design (the app itself calls this to free
its own seat on uninstall), but the dashboard's "free seat" button also
calls this same route with the admin token attached — the audit log tells
the two apart (see below).

- `{ ok: true }` on success
- `{ ok: false, error: "not_found" }` — unknown license key, or machine wasn't activated

**`GET /health`** — unauthenticated, for uptime/monitoring checks.

→ `{ ok: true, version, uptimeSeconds, licenseCount }` — `version` is this
server's `package.json` version, `uptimeSeconds` is how long this server
process has been up, `licenseCount` is the total number of licenses in the
store.

### Admin endpoints

All require header `Authorization: Bearer <LICENSE_ADMIN_TOKEN>`. If the
server has no `LICENSE_ADMIN_TOKEN` configured, every admin route returns
`503` rather than silently allowing or denying.

The bearer token is the entire security model for these routes, so failed
auth attempts are rate-limited per IP: after 10 failed attempts from one IP
within 15 minutes, that IP gets `429 { ok: false, error: "too_many_attempts" }`
for the rest of the window — even if it then supplies the correct token. A
successful auth from that IP clears its failure count. (The `503`
admin-disabled response never counts as a failed attempt.) This is separate,
in-process, per-server-instance state, independent of the `/activate`
`/heartbeat` rate limiter.

**`POST /admin/licenses`** — `{ companyName, seatCap, expiresAt?, contactName?, contactEmail?, notes? }`
→ `{ licenseKey, companyName, seatCap, expiresAt }`

**`GET /admin/licenses`**
→ list of `{ licenseKey, companyName, seatCap, seatsUsed, activeSeats30d, revoked, expiresAt, createdAt, contactName }`
(no `activations`/`machineId`/`contactEmail`/`notes` detail in the list view)

**`GET /admin/licenses/:key`**
→ full detail: everything in the list view plus `contactEmail`, `notes`, and
the `activations` array (`machineId`, `machineName`, `activatedAt`, `lastSeenAt`)

**`GET /admin/licenses.csv`** → `text/csv`, one row per license:
`companyName,licenseKey,seatCap,seatsUsed,activeSeats30d,revoked,createdAt,expiresAt,contactName,contactEmail`
(ISO dates, RFC4180 quoting)

**`GET /admin/stats`** → dashboard summary, computed in a single pass over the store:

```json
{
  "totalLicenses": 12,
  "activeLicenses": 9,
  "revokedLicenses": 2,
  "expiredLicenses": 1,
  "totalSeatCap": 340,
  "totalSeatsUsed": 118,
  "totalActive30d": 97,
  "expiringSoon": [
    { "licenseKey": "ATK-...", "companyName": "Acme Corp", "expiresAt": 1234567890000 }
  ]
}
```

`activeLicenses` = not revoked and not expired. `expiredLicenses` = every license whose `expiresAt`
has passed (`<= now`), regardless of `revoked`. `revokedLicenses` = every revoked license, regardless
of expiry — so a license that is both revoked and expired counts in both. `totalActive30d` sums, across
every license, the activations whose `lastSeenAt` falls within the last 30 days (same convention as
`activeSeats30d` above — it doesn't care whether the license itself is active). `expiringSoon` lists
not-revoked, not-yet-expired licenses whose `expiresAt` falls within the next 30 days, soonest first.

**`POST /admin/licenses/:key/revoke`** → sets `revoked: true`, returns full detail

**`POST /admin/licenses/:key/unrevoke`** → sets `revoked: false`, returns full detail

**`PATCH /admin/licenses/:key`** — `{ seatCap?, expiresAt?, contactName?, contactEmail?, notes? }`
(at least one field required) → updates and returns full detail

**`GET /admin/audit?limit=200`** → the last `limit` audit entries (default
200, max 1000), newest first: `{ at, action, licenseKey, details }` where
`action` is one of `create`, `revoke`, `unrevoke`, `patch`, `deactivate`,
`deactivate_admin`. Stored as an append-only JSONL file
(`data/audit.jsonl`) next to `licenses.json`; a write failure here logs a
warning but never fails the request that triggered it.

## Tests

```bash
cd license-server
npm install
npm test
```

Uses Node's built-in `node:test` + `node:assert` — no extra test framework
dependency for this standalone service.
