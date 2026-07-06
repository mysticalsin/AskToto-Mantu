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
  activated machines).
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

## Deploying

This is a plain Node HTTP service — any of the following works. Pick
whichever fits your existing infra; none of this is prescriptive.

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

- **Fly.io**: `fly launch` in this directory (it'll detect the Dockerfile),
  then `fly secrets set LICENSE_ADMIN_TOKEN=...` and attach a small volume
  mounted at `/app/data` (set `LICENSE_DB_PATH=/app/data/licenses.json`).

- **Railway**: create a new service from this directory, set the
  `LICENSE_ADMIN_TOKEN` environment variable, and attach a persistent volume
  mounted at `/app/data`.

In all cases: the only thing that must survive restarts/redeploys is the
`data/` directory (or wherever `LICENSE_DB_PATH` points).

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

Frees a seat.

- `{ ok: true }` on success
- `{ ok: false, error: "not_found" }` — unknown license key, or machine wasn't activated

### Admin endpoints

All require header `Authorization: Bearer <LICENSE_ADMIN_TOKEN>`. If the
server has no `LICENSE_ADMIN_TOKEN` configured, every admin route returns
`503` rather than silently allowing or denying.

**`POST /admin/licenses`** — `{ companyName, seatCap, expiresAt? }`
→ `{ licenseKey, companyName, seatCap, expiresAt }`

**`GET /admin/licenses`**
→ list of `{ licenseKey, companyName, seatCap, seatsUsed, revoked, expiresAt, createdAt }`
(no `activations`/`machineId` detail in the list view)

**`GET /admin/licenses/:key`**
→ full detail, including the `activations` array (`machineId`, `machineName`, `activatedAt`, `lastSeenAt`)

**`POST /admin/licenses/:key/revoke`** → sets `revoked: true`, returns full detail

**`POST /admin/licenses/:key/unrevoke`** → sets `revoked: false`, returns full detail

**`PATCH /admin/licenses/:key`** — `{ seatCap?, expiresAt? }` → updates and returns full detail

## Tests

```bash
cd license-server
npm install
npm test
```

Uses Node's built-in `node:test` + `node:assert` — no extra test framework
dependency for this standalone service.
