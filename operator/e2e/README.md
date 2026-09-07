# operator/e2e — dev-e2e

Proves the whole Métis Operator product works end to end against a REAL running Worker (`npx
wrangler@4 dev --local`) with a REAL local D1, driven by simulated Métis desktop seats that sign
real HMAC requests exactly the way the Electron client does. No Cloudflare account, no `wrangler
login`, no mocks: `boot.mjs` generates throwaway local secrets, starts the Worker, applies the real
migrations (`scripts/migrate.mjs`) and the real QA fixture (`scripts/seed-local.mjs`), and every
scenario after that is a genuine HTTP round trip — HMAC-signed device requests, cookie-authenticated
admin requests, and (for `console`) a real headless browser loading the real rendered HTML.

## Run it

One command:

```sh
npm run e2e:operator
```

or directly:

```sh
node operator/e2e/run.mjs                     # all four scenarios
node operator/e2e/run.mjs tracking licensing   # only the named scenario(s)
```

### Required environment

- **The Bash sandbox's network restriction must be disabled** for this run. `wrangler dev --local`
  binds a real loopback TCP port (and workerd's inspector port), and this sandbox denies binding to
  loopback addresses by default ("Failed to bind to 127.0.0.1:9229: permission denied"). In Claude
  Code, that means running the suite with the sandbox disabled for that Bash call.
- **Chromium's own sandbox** (used by the `console` scenario's Playwright browser) needs mach ports
  this environment also denies; `console.mjs` already launches with `--no-sandbox`, which is the
  correct and sufficient fix — no extra flag needed from the caller, but it does mean the same "Bash
  sandbox disabled" requirement above also covers Chromium's launch.
- `npm_config_cache` should point at a writable scratch dir (see the repo's own scratchpad
  convention) so the one-time `npx wrangler@4` package fetch has somewhere to land.
- `METIS_QA_SCRATCH` optionally overrides where `boot.mjs`/`seed-local.mjs` put their scratch files
  (esbuild bundles, the seed SQL file, and `$SCRATCH/home` — see below). Defaults to the same
  scratch directory `scripts/seed-local.mjs` already hardcodes.

### What boot.mjs actually does

1. Generates `OPERATOR_INGEST_SECRET`, `OPERATOR_PROMPT_KEY`, `OPERATOR_VAULT_KEY` (32 random bytes,
   base64) and an ephemeral Ed25519 keypair for `OPERATOR_SKILL_PRIVATE_KEY`, and writes them to a
   temp `operator/.dev.vars` (removed on teardown; any pre-existing file is backed up and restored).
   No secret value is ever printed to stdout.
2. Picks two free TCP ports and starts `npx wrangler@4 dev --local --ip 127.0.0.1 --port <port>
   --inspector-port <port>` from `operator/`, with `HOME` redirected to `$SCRATCH/home` (this
   sandbox denies writing to the real `~/Library/Preferences/.wrangler/logs`).
3. Waits for the Worker process to accept a connection at all (not for a clean `/health` — see the
   defect noted below), then runs `node scripts/migrate.mjs --local` and `node
   scripts/seed-local.mjs` (both from `operator/`, so `wrangler`'s own config auto-discovery finds
   `operator/wrangler.jsonc`), then waits for `/health` to report `schema: "ok"`.
4. Mints an admin console session cookie for `tony.walteur@gmail.com` using the exact algorithm in
   `scripts/dev-session.mjs` (itself a mirror of `operator/src/access.ts`), imported directly rather
   than re-derived.
5. Returns `{ baseUrl, cookieHeader, ingestSecret, promptKey, vaultKey, hmac, stop() }` to the
   scenarios. `stop()` kills the whole `wrangler dev`/workerd process group, restores/removes the
   temp `.dev.vars`, and removes `operator/.wrangler` (the local D1/session state) so every run
   starts clean.

### One environment quirk worth knowing about (not a product bug)

Local `wrangler dev` fetches `request.cf` (country/city/lat/lon) ONCE per process from a live trace
lookup — it is not derived per-request from anything a client sends, matching
`operator/src/geo.ts`'s doc comment ("Geo from Cloudflare `request.cf` only... never read the raw
IP"). To simulate three seats in three different countries against one local dev process, `seat.mjs`
sets the `MF-CF-Blob` request header, which is workerd/Miniflare's own documented local-dev
mechanism for overriding `request.cf` per request (`CoreHeaders.CF_BLOB` in the `miniflare` package;
nothing the Worker's own code reads or trusts — in production Cloudflare's edge sets `request.cf`
itself and this header is never sent). This is not a way to spoof geo against a real deployment; it
only works because `wrangler dev --local` is workerd running as a plain local process.

## Files

- `boot.mjs` — boots/tears down the Worker (see above). Also runnable standalone for manual
  debugging: `node operator/e2e/boot.mjs` prints the base URL and cookie, then waits for Ctrl+C.
- `seat.mjs` — a simulated Métis desktop seat. Signs every `/v1/*` request with the REAL canonical
  string from `src/shared/operator-hmac.ts` (bundled once via esbuild, not reimplemented) and
  Node's `node:crypto`, mirroring `src/main/operator-hmac-sign.ts` byte for byte. Methods:
  `heartbeat`, `ask`, `recap`, `listen`, `rating`, `crmSend`, `manifest`, `integrations`, plus a
  low-level `request()` for the auth scenario's deliberately-invalid requests.
- `lib/hmac.mjs`, `lib/license.mjs` — esbuild-bundle the real shared TypeScript contracts
  (`src/shared/operator-hmac.ts`, `src/shared/operator-license.ts`) so the harness verifies against
  the product's own code, not a parallel copy of it.
- `lib/http.mjs` — forces this process's `fetch()` to bypass the sandbox's outbound HTTP proxy for
  loopback traffic (see the boot log; this Node build does not reliably honor `NO_PROXY` for a bare
  `127.0.0.1` literal, so without this every request to the booted Worker would silently round-trip
  through the sandbox's proxy debug page instead of reaching it).
- `lib/admin.mjs` — a thin `fetch()` + cookie client for `/v1/admin/*` and the console HTML.
- `lib/ports.mjs`, `lib/assert.mjs` — free-port picker; a tiny pass/fail collector (no test
  framework) that every scenario uses to build its report.
- `scenarios/tracking.mjs`, `scenarios/licensing.mjs`, `scenarios/auth-privacy.mjs`,
  `scenarios/console.mjs` — see below.
- `run.mjs` — boots once, runs the requested scenarios, tears down, prints the report table and the
  boot log tail. `npm run e2e:operator` is `node operator/e2e/run.mjs`.

## Scenarios

### tracking (the one Tony most cares about)

A licensed, approved Montréal-CA seat heartbeats, appears in `/v1/admin/live.json`'s
`liveSeatsTable` and `/v1/admin/realtime/live-seats.json` with its real hostname/country/OS; an ask
lands in `events.json` and `sessions.json` (and the session detail) with its `questionType` but the
raw question text is asserted absent from every one of those responses; the single-ask admin Reveal
endpoint is checked as a positive control (it DOES return the real text, and IS audited — that's the
product's intended two-tier design, not a leak); a recap and a rating land as events, the rating
shows up on the asks list; a CRM send lands as `failed`, is retried (`autoSend: false`, status flips
to `pending`, never straight to `success`).

### licensing

Generates a license via `POST /v1/admin/licenses/generate`, activates it on a seat (the seat sends
back only the jti on its next heartbeat, exactly like `src/main/operator-license-activate.ts` +
`operator-ingest.ts` do on the desktop — never the raw token), asserts the heartbeat reports
`approved: true`, `tier: "metis"`, and its entitlements; revokes it and asserts the next heartbeat
loses all three; then a batch of 5 (`POST /v1/admin/licenses/generate-batch`), asserting 5 distinct
jtis and that all 5 tokens verify with the real `verifyOperatorLicense`.

### auth-privacy

Console GET with no cookie → 302 to the real Access login path; `/v1/admin/dashboard` with no
cookie → 401 JSON (never a redirect, never HTML); a same-cookie but `sec-fetch-site: cross-site`
POST → 403 `{code:"csrf"}`; a heartbeat with a deliberately wrong signature → 401, then the SAME
ts/nonce with the correct signature still succeeds (proving the failed attempt never burned the
nonce), then replaying that same now-used nonce → 401 `replay nonce`. Then a real vault secret and a
real ask-text marker (both unique per run) are checked absent, by raw substring search, from: the
console HTML, `/v1/admin/dashboard`, `/v1/admin/keys`, `/v1/admin/asks`, `/v1/admin/events.json`,
`/v1/admin/sessions.json`, `/v1/admin/audit.json`, the `asks`/`seats` CSV exports, and the raw bytes
of the `asks` XLSX export (the product's own `export/xlsx.ts` writes ZIP entries uncompressed/STORED,
so a byte-level substring search directly checks the real exported content, not a guess). A positive
control confirms the vault key's real last4 legitimately appears in `/v1/admin/keys`.

### console

Playwright, headless Chromium, signed in with the same minted cookie. Opens `/` plus every real nav
page (`operator/src/nav.ts`'s `NAV_IDS`): overview, realtime, events, sessions, licenses, groups,
notifications, keys, connectors, audit, settings. Per page: zero browser console errors, zero
uncaught page errors, zero failed requests, zero 4xx/5xx responses from the Worker; the live rail's
`data-live-indicator[data-state]` is `"live"` (a real Worker response always passes `liveUrl` to
`renderConsole`, so it can never be the static-render-only `"Offline preview"` default in
`operator/src/render/shell.ts`); on Realtime/Sessions specifically, the rendered page text contains
at least one hostname/email from the seats the `tracking` scenario just created, proving real fleet
data reached the browser, not a placeholder.

## Status

Run `npm run e2e:operator` and read the printed table — this file does not restate a snapshot that
can drift from the real output. As of the run that shipped this harness, all four scenarios passed
against a fresh boot; see the task's final report for that run's table and boot log tail.

## Known product observation (not fixed here — out of this task's scope per its own instructions)

`GET /health` (`operator/src/index.ts`, `lastIngestAt`/`lastCronAt`, around lines 168-182) calls
`store.listSeats()`, `store.listAsks(1)`, and `store.listAudit(1, ...)` directly, unlike
`healthD1Status` right above it which wraps its own D1 probe in a `.catch()`. Against a D1 binding
that exists but has no schema yet (a brand-new environment, mid-first-migration), those calls throw
and `/health` 500s instead of reporting `schema` as a missing-table list the way
`/v1/admin/health.json` does. `boot.mjs` works around this by waiting for the process to be
reachable at all before migrating, then checking `/health` for real. Worth a `try/catch` (matching
`healthD1Status`'s own pattern) if this file is touched again.
