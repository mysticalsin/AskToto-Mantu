# Métis license platform — plan

**Status (2026-07-10): Phases 0, 1, and most of Phase 4 are shipped. Phase 3 (enforcement) is
wired but ships inert (gate off by default). The only genuinely open work is Phase 2's actual
public deployment step — the deploy scaffolding exists, it just hasn't been run against a public
host yet.**

The goal: Tony mints as many per-company licenses as he wants, controls seats, revokes at will,
and customers activate with one paste. Companies bring their own LLM API key (BYOK); the license
only governs whether Métis runs.

## Phase 0 — core licensing (DONE, shipped 2026-07-05, commit 3679594)

- `license-server/`: standalone Node service, deployable anywhere (Dockerfile included).
  JSON-file storage with atomic writes; no database to operate.
- License model: company name, seat cap, optional expiry, revocable. Keys: `ATK-` + 20
  Crockford-base32 chars, generated with crypto randomness. **Generation is unlimited** - every
  mint is one POST (or one CLI command, or one click once Phase 1 lands).
- Endpoints: `/activate` (seat-cap enforced, idempotent per machine), `/heartbeat` (re-validates
  without consuming a seat), `/deactivate` (frees a seat), plus bearer-token admin CRUD
  (create / list / detail / revoke / unrevoke / edit seats+expiry). Timing-safe token check.
- `scripts/generate-license.mjs`: mint from the terminal.
- App client: stable per-install machine id, activation UI in Settings → About → License,
  7-day offline grace inside a 30-day hard cap, server-authoritative state (a renderer can't
  self-issue a license). **Enforcement gate ships OFF and is wired nowhere** - deliberate, so
  nothing locks anyone out before the server is deployed and tested.
- Verified live end to end: mint → 2 activations → 3rd refused at cap → heartbeat → revoke →
  blocked → seat freed. Plus real-UI activation through Settings ("Active · Mantu · up to 50 seats").
- Running now: Docker container `asktoto-license` on Tony's Mac (port 8420, persistent volume);
  admin token + the Mantu 50-seat key in `~/AI-Brain-build/asktoto-license/`.

## Phase 1 — management dashboard (DONE, shipped 2026-07-06, commits cc2c64f/71ccce7)

- `/admin/ui` served by the same server (`license-server/admin/index.html`): token gate, license
  table (company, key with click-to-copy, seats used/cap, status, expiry), detail view with
  per-machine activations and "free seat", revoke/unrevoke, edit seats/expiry inline, new-license
  form that shows the fresh key large with copy. Self-contained single HTML file, no CDN, Mantu
  dark theme.
- Shipped alongside: brute-force lockout on the admin token, trust-proxy hardening, self-backups
  (`license-server/lib/backups.mjs`, `scripts/backup.mjs`/`restore.mjs`), webhooks
  (`lib/webhooks.mjs`), and a Prometheus metrics/analytics endpoint.

## Phase 2 — real deployment (NEXT — infra scaffolding DONE, actual deploy step still open)

The local Docker server only reaches this Mac. Customers need a public URL. All of the deploy
scaffolding already exists in the repo (`license-server/fly.toml`, `docker-compose.prod.yml`,
`deploy/Caddyfile`, `scripts/backup.mjs`/`restore.mjs`) — the only remaining work is actually
running it:

1. ~~Pick a host~~ — `fly.toml` targets Fly.io; a VPS + `docker-compose.prod.yml` + `Caddyfile` is
   the alternative, both already checked in.
2. Deploy `license-server/` there; set `LICENSE_ADMIN_TOKEN` (new random value; keep it out of
   the repo forever). Still open — the container currently only runs on Tony's Mac (see Phase 0).
3. ~~HTTPS is table stakes~~ — Fly gives it automatically; the VPS path's `Caddyfile` is already
   written.
4. ~~Backups~~ — `scripts/backup.mjs`/`restore.mjs` already implement the daily-copy-off-box plan.
5. Point Métis installs at the public URL instead of 127.0.0.1. Still open until step 2 lands.

## Phase 3 — enforcement (WIRED, ships inert — gate is off by default)

`checkLicenseGrace()` is already wired into a real startup gate in `src/renderer/src/App.tsx`
(~lines 1746-1773): when `settings.licenseGateEnabled` is true and the verdict says blocked, the
app shows a blocking activation screen instead of the bar — never a silent exit, always a path to
activate or retry. `licenseGateEnabled` defaults to `false` (`src/shared/ipc.ts`), so this ships
inert until an operator turns it on via managed-config or Settings. Remaining work to actually use
this in a licensed rollout:

1. ~~On launch, when `licenseGateEnabled`~~ — done, see above.
2. ~~Grace UX~~ — done: 7-30 day offline grace shows a quiet pending note; hard-cap expiry shows
   the blocking screen with "reconnect to re-validate" (see `license-platform-plan.md` Phase 0).
3. Enterprise rollout: ship the gate default-on ONLY in builds destined for licensed customers
   (a build-time flag or managed-config key), keeping internal/dev builds unlocked. Still open —
   today it's a manual per-deployment managed-config toggle, not an automated build-time split.
4. Kill-switch semantics documented for sales: revoke = blocked at next heartbeat (≤7 days
   offline, immediate when online). Still open as a sales-facing document; the mechanics
   themselves are implemented and verified (Phase 0's end-to-end proof).

## Phase 4 — platform niceties (pull-based, build when a real need appears)

- ~~Per-license metadata: contact person, deal notes~~ — DONE: `contactName`/`contactEmail`/`notes`
  are patchable fields on every license (`license-server/lib/app.mjs`'s `PATCH
  /admin/licenses/:key`). Plan tier is not modeled yet; add it the same way if it becomes needed.
- ~~Admin audit log~~ — DONE: append-only JSONL trail (`license-server/lib/audit.mjs`,
  `data/audit.jsonl`), served at `GET /admin/audit`.
- Seat telemetry: lastSeenAt is already stored per machine - surface "active in the last 30
  days" per company for renewal conversations. Still open.
- ~~CSV export for finance~~ — DONE: `GET /admin/licenses.csv` (`license-server/lib/csv.mjs`,
  with CSV-injection/formula-injection neutralization).
- Postgres migration ONLY if licenses grow past thousands or multiple admin writers appear -
  the JSON store is correct and sufficient below that. Still open (not needed yet).
- Email delivery of keys (SMTP or a transactional provider) - today copy-paste from the
  dashboard is fine. Still open (not needed yet).

## Explicitly out of scope

- Payments/checkout (deals are closed by humans; a license is minted after the contract).
- Per-user accounts inside a company (the unit is a machine seat under a company license).
- Offline-signed license files (the phone-home model was chosen deliberately for revocation and
  live seat control).
