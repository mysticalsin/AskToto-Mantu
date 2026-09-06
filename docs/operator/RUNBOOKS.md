# Métis Operator runbooks

Operational procedures for `metis-operator`, the fleet control plane Worker. Everything here
assumes the tooling added for plan task P4.0: `operator/scripts/deploy.mjs`, `smoke.mjs`,
`backup.mjs`, `dev-session.mjs`, and (from a separate concurrent task) `migrate.mjs`.

No Cloudflare auth exists on the machine these scripts were written on. Every real command below
needs Tony to run, once per machine:

```sh
cd operator
npx wrangler@4 login
```

## 1. Deploy: staging, then production

Deploy staging first, run the smoke checks, then deploy production. Never skip staging for a
change that touches D1 schema, HMAC verification, or Access identity resolution.

```sh
node operator/scripts/deploy.mjs --env staging
# read the receipt, open the staging console, confirm the change
node operator/scripts/deploy.mjs --env production
```

Each run: refuses a dirty git tree (pass `--allow-dirty` only for a deliberate uncommitted
experiment on staging, never for production), typechecks and tests the operator package, builds
the client and world bundles, stamps `OPERATOR_VERSION` (short git sha) and `OPERATOR_BUILT_AT`
(ISO timestamp) onto the Worker via `wrangler deploy --var`, runs the D1 migration runner before
the deploy so new code never meets old schema, deploys, then runs the post-deploy smoke against
the environment's URL. Any step failing stops every step after it.

Preview the full plan without touching anything:

```sh
node operator/scripts/deploy.mjs --dry-run --env staging
node operator/scripts/deploy.mjs --dry-run --env production
```

### Rollback

A smoke failure right after a deploy is the signal to roll back immediately, not to debug live:

```sh
cd operator
npx wrangler@4 rollback                 # production
npx wrangler@4 rollback --env staging   # staging
```

`wrangler rollback` reverts the Worker's code to the previous deployment. It does not revert a D1
migration. If the deploy that broke things also ran a migration, restoring behavior may require a
compensating migration or a data restore (see section 3) rather than just a code rollback.

## 2. Migrate

D1 migrations are applied by `operator/scripts/migrate.mjs`, statement by statement, idempotent
(a duplicate-column or duplicate-table statement is a no-op, not a failure). `deploy.mjs` always
runs this before `wrangler deploy`; run it by hand only to apply a schema change ahead of a code
deploy, or to check status.

```sh
node operator/scripts/migrate.mjs --local                    # against local wrangler dev D1
node operator/scripts/migrate.mjs --remote                   # production D1
node operator/scripts/migrate.mjs --remote --env staging     # staging D1
```

Never edit `operator/schema.sql` or `operator/schema-alter.sql` and skip running the migrator; the
committed schema files are the source of truth and the Worker's own `/v1/admin/health.json`
(Settings -> Platform health) reports which tables and columns are actually present in D1 via
`PRAGMA table_info`, so a missed migration surfaces there rather than as a silent 500 in
production.

## 3. Backup and restore

Weekly export, more often before a schema change or a risky migration:

```sh
node operator/scripts/backup.mjs                    # production, metis-operator
node operator/scripts/backup.mjs --env staging       # staging, metis-operator-staging
```

Writes `operator/backups/<db>-<timestamp>.sql` (gitignored: a D1 export is a full data dump,
ciphertext Ask text and hashed license keys included, and never belongs in git history).

### D1 Time Travel (preferred for an accidental write or a bad migration)

D1 keeps continuous point-in-time backups for 30 days with no separate export step. For "someone
just ran a bad UPDATE" or "the last migration broke a table", this is faster and safer than a SQL
file restore:

```sh
cd operator
npx wrangler@4 d1 time-travel info metis-operator
npx wrangler@4 d1 time-travel restore metis-operator --timestamp=<ISO-8601>
```

### Restoring from a `backup.mjs` export (full re-seed, or past the 30-day Time Travel window)

```sh
node operator/scripts/backup.mjs --restore operator/backups/metis-operator-<timestamp>.sql
```

Without `--yes` this only prints the exact commands and the reasoning above, does not touch D1,
and exits 0. Restoring a SQL export does not truncate existing tables first (`CREATE TABLE IF NOT
EXISTS` is a no-op against an existing schema, and `INSERT` rows can conflict with rows written
since the backup), so the safe path for a real disaster recovery is: create a fresh D1 database,
restore into that, verify the data, then repoint the Worker's `d1_databases` binding in
`operator/wrangler.jsonc` and redeploy. Pass `--yes` only once that plan, not the default in-place
restore, is what you actually intend.

**Restore tested on staging once** before this runbook is trusted for a production incident:
export staging, make a throwaway change, restore from the export, confirm the data matches.
Record the date this was last verified here when it is done.

## 4. Rotate a secret

Every secret is set with `wrangler secret put` (hidden prompt, never a shell argument that lands
in shell history):

```sh
cd operator
npx wrangler@4 secret put <NAME>
npx wrangler@4 secret put <NAME> --env staging
```

| Secret | What breaks if missing or rotated without updating callers |
| --- | --- |
| `OPERATOR_INGEST_SECRET` | Every desktop seat's HMAC signature stops verifying. `/v1/ingest`, `/v1/heartbeat`, `/v1/use`, `/v1/skills/manifest` all return 401 to every seat until every seat's local secret (Settings -> Privacy -> Ingest secret, or `METIS_OPERATOR_INGEST_SECRET`) is updated to match. Rotate by rolling both sides together, or by accepting a fleet-wide outage window. |
| `OPERATOR_PROMPT_KEY` | New Asks encrypt fine with the new key, but every previously stored Ask's `prompt_cipher` was encrypted under the OLD key and Reveal on those rows starts failing to decrypt. It is also the fallback source for the session-signing secret (see `OPERATOR_SESSION_SECRET` below): rotating it without setting an explicit `OPERATOR_SESSION_SECRET` first invalidates every signed-in admin session at the same time. |
| `OPERATOR_SESSION_SECRET` | If unset, the console session cookie is HMAC-signed with an HKDF derivation of `OPERATOR_PROMPT_KEY` (see `operator/src/access.ts`). Rotating this (or the `OPERATOR_PROMPT_KEY` it falls back to) signs everyone out; they simply hit the Access login flow again, no data loss. Prefer setting this explicitly and independently from `OPERATOR_PROMPT_KEY` so the two can be rotated on different schedules. |
| `OPERATOR_SKILL_PRIVATE_KEY` | Push (skills/:id/push) starts failing with a 500 ("skill signing key missing"). Existing pushed packs still verify against the public key already bundled in `src/main/operator-skill-key.ts`; only NEW pushes are blocked. Rotating the private key without updating that bundled public half means every desktop stops trusting new pushes until a new app build ships the new public key. |
| `OPERATOR_VAULT_KEY` | Stored LLM provider keys and the Cloudflare account token in `vault_keys` become undecryptable. Keys and the Cloudflare connection must be re-added after rotation; there is no in-place re-encryption path today. |
| `POLICY_AUD` | Cloudflare Access JWT verification starts rejecting every JWT (audience mismatch), so a fresh unauthenticated browser session cannot sign in even though Access itself still gates the login page. An already-minted console session cookie (`OPERATOR_SESSION_SECRET` path) keeps working until it expires (max 12 hours), which is why this rotation is safer than it sounds. |
| `CF_OAUTH_CLIENT_ID` / `CF_OAUTH_CLIENT_SECRET` | The Cloudflare account connect flow (Keys -> Cloudflare connect card) returns 503 with a clear "OAuth secrets missing" message instead of a permanent red banner. Nothing else on the console depends on these. |

`TEAM_DOMAIN` and `OPERATOR_VERSION` are **vars**, not secrets (see `operator/wrangler.jsonc`);
they are visible in the dashboard and in `wrangler deploy` output by design.

## 5. Access policy

- Team: `tony-walteur`, `TEAM_DOMAIN=https://tony-walteur.cloudflareaccess.com`.
- Self-hosted Access application **Métis Operator** on the Worker's host. Policy: Allow, exactly
  two emails (`tony.walteur@gmail.com`, `twalteur@amaris.com`), no other identity provider rule.
- Session duration: whatever the Access application policy sets (Access's own session, which
  gates the login step) plus the Worker's own minted session cookie, capped at 12 hours absolute
  from mint time regardless of activity, re-minted only once the current one is over an hour old.
- Bypass policies (Access must not wrap these, or every seat and every automated check breaks):
  `/health`, `/v1/ingest`, `/v1/heartbeat`, `/v1/use`, `/v1/skills/manifest`, `/assets/*`. The
  Worker's own JSON 401 already gates `/v1/admin/*`; do not add a second Access application over
  it.
- Never enable **Protect this Worker**. That setting Access-wraps every path including the HMAC
  and public asset routes above, which locks out every desktop seat and every smoke check at once.
  If this is ever enabled by mistake, `checkAccessRedirect`/`checkAdminDashboardUnauth` in
  `smoke.mjs` will not be what fails; the HMAC checks (`checkHeartbeatNoHmac`,
  `checkIngestGetNever200`) will start seeing an Access login page instead of the expected 401,
  which is the tell.

Full Zero Trust app and policy walkthrough: `docs/design/OPERATOR.md`.

## 6. Incident response

### Read logs by request id

Every response carries `cf-ray` as its request id (surfaced to the admin as `request_id` on audit
rows, and shown on error toasts in the console so a user can quote it back). To pull the
Cloudflare-side log for one request:

```sh
cd operator
npx wrangler@4 tail --format=pretty
# then reproduce, or filter tail output for the reported cf-ray value
```

`Workers Logs` (Observability, enabled in `wrangler.jsonc`) retains structured request logs in the
dashboard for longer than a live `tail` session; search there by the same `cf-ray` value when the
incident already happened.

### Roll back a bad deploy

See section 1's rollback subsection. `wrangler rollback` first; only reach for a data restore
(section 3) if the bad deploy also wrote bad data via a migration or a code bug, not for a code-only
regression.

### Disable a seat

From Sessions (or Licenses), Revoke the seat's approval. This is `POST
/v1/admin/licenses/:deviceId/revoke` (or the license-jti revoke route for an issued license), and
is audited. A revoked seat's next heartbeat gets `approved: false` in the response; the desktop
Ask/Listen/Recap surfaces gate on that flag. This does not delete the seat's history (heartbeats,
Asks, events stay for traceability); it only stops new privileged actions.

### Revoke a license

From Licenses, Revoke on the issued row (by `jti`). This marks the issued license `revoked` in
`issued_licenses`; any seat currently activated against that `jti` loses licensed status on its
next heartbeat. Revoking a license does not revoke the seat's separate approval state; revoke both
when the intent is to fully cut a seat off.

### General incident posture

1. Confirm scope with `smoke.mjs` against the affected environment; it is read-only and safe to
   run at any time, including mid-incident.
2. Check `/v1/admin/health.json` (Settings -> Platform health) for bindings, Access config, and D1
   schema status before assuming the code is at fault.
3. Roll back code first if a deploy correlates with the incident start time; that is reversible in
   seconds. Only touch data (restore, manual D1 query) once the code causing further damage is
   stopped.
4. Every admin mutation and every Reveal is in the `audit` table with a `request_id`; use it to
   reconstruct exactly what an operator did and when, without ever needing Ask plaintext.

## 7. CI

`.github/workflows/build.yml`'s `operator` job runs on every push and every pull request into
`main`/`master`: installs, rebuilds both generated bundles (`build:operator-client`, and
`build:operator-world` once that script lands) and fails if the committed file drifts from a fresh
build, typechecks `operator/tsconfig.json` and `operator/client/tsconfig.json`, and runs the
operator test suite plus the contract tests for the scripts in this runbook
(`operator/scripts/*.contract.test.ts`). It does not deploy; `deploy.mjs` is run by hand by Tony,
never from CI, because there is no Cloudflare auth (and no secrets) in CI for this Worker.
