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

## Phase 3 — enforcement (BUILT, and COMPILED OFF — no setting turns it on)

`checkLicenseGrace()` is wired into a real startup gate in `src/renderer/src/App.tsx`: when the gate is
consulted and the verdict says blocked, the app shows a blocking activation screen instead of the bar —
never a silent exit, always a path to activate or retry.

**It is never consulted on a shipped build (MQA-068).** `App.tsx`'s `LICENSE_ENFORCEMENT` constant is
`false`, so `licenseEnforced` is constant-false, `window.toto.licenseGate()` is never called and the
`<LicenseGate/>` branch is unreachable; `Settings.tsx`'s `LICENSE_UI_ENABLED` is `false`, so the only
activation form in the app never renders. `licenseValid` can therefore never become true, so main's 12h
revocation heartbeat — gated on `licenseGateEnabled && licenseValid` — never fires either. This section
previously said enforcement followed `settings.licenseGateEnabled`; it does not, and the shipped
enterprise example config was set-and-locking that key on the strength of this paragraph.

Remaining work to actually use this in a licensed rollout:

0. Flip `LICENSE_ENFORCEMENT` (`App.tsx`) and `LICENSE_UI_ENABLED` (`Settings.tsx`) **together**, in one
   change, and re-verify activation → seat consumption → revocation end to end. Flipping the first alone
   ships a blocking gate with no form to activate past it. Until this is done, every item below is moot.

1. ~~On launch, when `licenseGateEnabled`~~ — done, see above.
2. ~~Grace UX~~ — done: 7-30 day offline grace shows a quiet pending note; hard-cap expiry shows
   the blocking screen with "reconnect to re-validate" (see `license-platform-plan.md` Phase 0).
3. Enterprise rollout: ship the gate on ONLY in builds destined for licensed customers (a build-time
   flag), keeping internal/dev builds unlocked. Still open, and step 0 is its prerequisite: there is no
   per-deployment managed-config toggle today either — `licenseGateEnabled` is inert in both directions.
4. Kill-switch semantics documented for sales: revoke = blocked at next heartbeat (≤7 days
   offline, immediate when online). Still open as a sales-facing document. The server side and
   `main/license.ts` are implemented and unit-verified (Phase 0), but no client heartbeat can fire until
   step 0 lands — so this must not be sold as live today.

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

## Phase 5 — member pass + offline-first JWS foundation (this change)

Extends the same license product. Does not replace phone-home `/activate`.
Enforcement stays compiled off (`LICENSE_ENFORCEMENT` and `LICENSE_UI_ENABLED`
are both false; MQA-068). Selling stays closed.

- Settings → Identity shows a Métis member pass (local serial / install id,
  install date, member number or pending). Design contract:
  `docs/design/IDENTITY-CARD.md`.
- Offline-first Ed25519 JWS verify in main, cache in the OS secret store,
  `LICENSE_ACTIVATION_OPEN=false`. Activate runs the real client path and
  returns `ActivationUnavailable`.
- Reserved server routes: `POST /v1/licenses/activate`,
  `POST /v1/installs/register` (stubbed on `license-server/`). OpenAPI:
  `docs/license-v1.openapi.yaml`.
- Air-gap `license.metis` parser + verify, plus optional MDM path detect.
  No live deploy and no payments in this phase.

## Explicitly out of scope

- Payments/checkout (deals are closed by humans; a license is minted after the contract).
- Per-user accounts inside a company (the unit is a machine seat under a company license).
- Taking payment or opening live activation (`LICENSE_ACTIVATION_OPEN` stays false).
