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
| `BACKUP_INTERVAL_HOURS` | `24`                        | How often the server snapshots its own store into `BACKUP_DIR`. `0` disables the schedule (on-demand backups still work). Effective interval is capped at ~596 hours (Node's max timer delay). |
| `BACKUP_KEEP`          | `30`                         | How many snapshots to retain; older ones are pruned after each backup. Minimum 1 — the newest snapshot is always kept. |
| `BACKUP_DIR`           | `<data dir>/backups`         | Where snapshots are written. Defaults to a `backups/` folder next to the data file, i.e. on the same persistent volume. |
| `LICENSE_WEBHOOK_URL`  | *(unset)*                    | When set, the server POSTs JSON events here (created/revoked/deleted/seat-limit/expiring-soon...). Unset = no webhooks. |
| `LICENSE_WEBHOOK_SECRET` | *(unset)*                  | When set, each webhook delivery carries `X-AskToto-Signature: sha256=<hex>` (HMAC of the raw body) so the receiver can verify authenticity. |
| `WEBHOOK_EXPIRY_ALERT_DAYS` | `14`                    | How far ahead the expiring-soon webhook sweep looks.                    |
| `METRICS_TOKEN`        | *(unset)*                    | Enables `GET /metrics` (Prometheus text format), authenticated with `Authorization: Bearer <METRICS_TOKEN>`. Unset = the endpoint 404s. Use a separate, lower-privilege secret than the admin token. |

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

`data/licenses.json` is the business record. It is protected in two layers:

**Automatic on-server snapshots (built in, on by default).** Every
`BACKUP_INTERVAL_HOURS` (default 24, plus once at startup) the server writes a full
snapshot to `BACKUP_DIR` (default `data/backups/`, on the same volume as the db) and
prunes past `BACKUP_KEEP` (default 30). A snapshot identical to the previous one is
skipped, so an idle server doesn't churn its disk. Snapshots use the exact
`/admin/export` wrapper, so any of them can be fed straight to `/admin/restore`.
The dashboard's Analytics tab shows the last snapshot time and has a "Back up now"
button; `GET /admin/backups` lists them and `GET /admin/backups/<name>` downloads one.

**Off-box copies (your job).** On-server snapshots don't survive the disk dying.
Pull a copy off the box through the admin API of a running server (no volume access
needed):

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
- Switch to the Analytics tab for the activation timeline (last 30 days),
  seat utilization per license, server version/uptime, and the last-backup
  status with a "Back up now" button.
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
has passed (`< now`, same boundary as the `/activate`/`/heartbeat` gate), regardless of `revoked`. `revokedLicenses` = every revoked license, regardless
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
`deactivate_admin`, `delete`, `restore`, `backup`. Stored as an append-only
JSONL file (`data/audit.jsonl`) next to `licenses.json`; a write failure
here logs a warning but never fails the request that triggered it.

**`GET /admin/analytics`** → chart-ready aggregates for the dashboard's
Analytics tab:

```json
{
  "activationsByDay": [ { "day": "2026-06-07", "count": 3 }, ... ],
  "seatUtilization": [ { "licenseKey": "ATK-...", "companyName": "Acme Corp", "seatsUsed": 42, "seatCap": 50, "revoked": false }, ... ]
}
```

`activationsByDay` covers the last 30 UTC days (zero-count days included);
`seatUtilization` lists every license sorted by seats used, then cap.

**`GET /admin/export`** → the exact persisted store, restore-compatible:
`{ version, exportedAt, licenses: [...] }`.

**`POST /admin/restore`** — `{ licenses: [...] }` (or a raw array) →
replaces the entire store. Snapshots the current data to
`licenses.pre-restore-<timestamp>.bak` next to the db first, validates the
payload before mutating, and audit-logs the restore.

**`DELETE /admin/licenses/:key`** → permanently removes a license
(mis-mints and test licenses; revoke real customers instead). The audit
line preserves a snapshot of the deleted record.

**`POST /admin/backup`** → writes an on-demand snapshot (always, even if
identical to the last one) → `{ ok, file, licenseCount }`.

**`GET /admin/backups`** → `{ dir, files: [ { name, size, mtime } ] }`,
newest first. **`GET /admin/backups/:name`** downloads one snapshot (the
name must match the generated `licenses-backup-*.json` shape exactly).
All three return `503 backups_disabled` if the backup manager isn't wired
in.

## Webhook notifications

Set `LICENSE_WEBHOOK_URL` and the server POSTs a JSON event there whenever
the license business needs attention:

| Event                    | When                                                              |
|--------------------------|-------------------------------------------------------------------|
| `license.created`        | a license was minted                                              |
| `license.revoked` / `license.unrevoked` | revocation toggled                                 |
| `license.deleted`        | a license was permanently removed                                 |
| `store.restored`         | the store was replaced from a backup                              |
| `license.seat_limit`     | an `/activate` bounced off the seat cap (throttled: at most once per license per hour) |
| `license.expiring_soon`  | a license enters the `WEBHOOK_EXPIRY_ALERT_DAYS` window (default 14 days; swept every 12 h; fired once per license per expiry date — extending the license re-arms it) |

Payload shape: `{ event, at, license?: { licenseKey, companyName, seatCap,
seatsUsed, expiresAt, revoked }, details? }` — `store.restored` is a
store-level event and carries only `details: { restoredCount }`, no
`license` field. Deliveries are sent in order,
never block or fail the request that triggered them, retry twice on network
errors or 5xx (a 4xx response is terminal), and time out after 5 s per
attempt. With `LICENSE_WEBHOOK_SECRET` set, each delivery carries
`X-AskToto-Signature: sha256=<hex>` — the HMAC-SHA256 of the raw request
body — so your receiver can drop forgeries. Point the URL at a Slack/Teams
relay, n8n, Zapier, or a 20-line endpoint of your own. The expiring-soon
dedupe state is in-memory, so a server restart may repeat a reminder once.

## Monitoring with Prometheus

Set `METRICS_TOKEN` to enable `GET /metrics` (Prometheus text exposition
format, gauge metrics: `asktoto_uptime_seconds`, `asktoto_licenses_total`,
`asktoto_licenses_active`, `asktoto_licenses_revoked`,
`asktoto_licenses_expired`, `asktoto_licenses_expiring_soon`,
`asktoto_seat_cap_total`, `asktoto_seats_used_total`,
`asktoto_seats_active_30d`). Scrape config:

```yaml
scrape_configs:
  - job_name: asktoto-licenses
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ["your-license-server.example.com"]
```

Unset, the endpoint returns 404 like any unknown route. For a simple
up/down check without Prometheus, `GET /health` remains unauthenticated.

## Tests

```bash
cd license-server
npm install
npm test
```

Uses Node's built-in `node:test` + `node:assert` — no extra test framework
dependency for this standalone service.
