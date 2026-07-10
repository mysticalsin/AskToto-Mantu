# Métis license platform — plan

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

## Phase 1 — management dashboard (IN FLIGHT)

- `/admin/ui` served by the same server: token gate, license table (company, key with
  click-to-copy, seats used/cap, status, expiry), detail view with per-machine activations and
  "free seat", revoke/unrevoke, edit seats/expiry inline, new-license form that shows the fresh
  key large with copy. Self-contained single HTML file, no CDN, Mantu dark theme.
- Done when: served from the Docker image, tests green, verified in a real browser against the
  running container.

## Phase 2 — real deployment (NEXT, ~an hour of Tony-time + small hosting cost)

The local Docker server only reaches this Mac. Customers need a public URL.

1. Pick a host: Fly.io or Railway (one-command deploys, README has both) or any VPS with Docker.
2. Deploy `license-server/` there; set `LICENSE_ADMIN_TOKEN` (new random value; keep it out of
   the repo forever).
3. HTTPS is table stakes - Fly/Railway give it automatically; a VPS needs Caddy or a
   Cloudflare proxy in front.
4. Backups: `licenses.json` IS the business record. Cron a daily copy off-box (a private
   GitHub gist, S3, or even a scheduled `fly ssh sftp get`). One file, trivially small.
5. Point Métis installs at the public URL instead of 127.0.0.1.

## Phase 3 — enforcement (only after Phase 2 is proven)

Wiring `checkLicenseGrace()` into app startup - the function exists and is tested, deliberately
unused today:

1. On launch, when `licenseGateEnabled`: `{ allowed:false }` → show a blocking activation screen
   (server URL + key form, same plain-language errors as Settings) instead of the bar. Never a
   silent exit; always a path to activate or retry.
2. Grace UX: when running on the 7-30 day offline window, a quiet "license check pending" note in
   Settings, nothing intrusive. Hard-cap expiry shows the blocking screen with "reconnect to
   re-validate".
3. Enterprise rollout: ship the gate default-on ONLY in builds destined for licensed customers
   (a build-time flag or managed-config key), keeping internal/dev builds unlocked.
4. Kill-switch semantics documented for sales: revoke = blocked at next heartbeat (≤7 days
   offline, immediate when online).

## Phase 4 — platform niceties (pull-based, build when a real need appears)

- Per-license metadata: contact person, deal notes, plan tier (fields already trivial to add to
  the JSON model + PATCH endpoint + a column in the dashboard).
- Admin audit log: who revoked/minted what, when (append-only file next to licenses.json).
- Seat telemetry: lastSeenAt is already stored per machine - surface "active in the last 30
  days" per company for renewal conversations.
- CSV export for finance.
- Postgres migration ONLY if licenses grow past thousands or multiple admin writers appear -
  the JSON store is correct and sufficient below that.
- Email delivery of keys (SMTP or a transactional provider) - today copy-paste from the
  dashboard is fine.

## Explicitly out of scope

- Payments/checkout (deals are closed by humans; a license is minted after the contract).
- Per-user accounts inside a company (the unit is a machine seat under a company license).
- Offline-signed license files (the phone-home model was chosen deliberately for revocation and
  live seat control).
