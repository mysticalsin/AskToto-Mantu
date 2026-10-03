# Runbook: staging

Staging is the Operator Worker's second environment (`metis-operator-staging`, its own D1 database and secrets). It exists so a
change to D1 schema, HMAC verification or Access identity resolution is seen working before production. The full
procedures, including secrets, Access policy and rollback, are in [`docs/operator/RUNBOOKS.md`](../operator/RUNBOOKS.md);
this page is the order of operations.

Nothing here runs on a developer Mac against a real account: a real staging deploy runs only in GitHub Actions, through
`.github/workflows/operator-staging.yml`, with a staging-only token the owner stores in the repository's protected `staging`
environment. The dry-run forms print the full plan and touch nothing, and CI runs the staging dry-run on every push.

## 1. Order

1. Preview the staging plan, then the production plan:

```bash verify-dry
node operator/scripts/deploy.mjs --dry-run --env staging
node operator/scripts/deploy.mjs --dry-run --env production
```

2. Deploy staging by dispatching the Operator staging workflow from main; there is no `wrangler login` on a Mac. Its deploy
   job checks that the dry-run plan names only `metis-operator-staging`, then runs `deploy.mjs --env staging`, which refuses
   a dirty tree, type-checks and tests the operator package, builds the client and world bundles, runs the D1 migration
   runner before the deploy so new code never meets old schema, deploys, then runs the post-deploy smoke with the deployed
   version. Any failing step stops the rest. The job uploads a content-free receipt with the sha256 of the bundle wrangler
   uploaded, then runs the named check from `scripts/qa/staging-checks/index.mjs` and uploads its report and `lane.json`:

   ```bash
   gh workflow run operator-staging.yml --ref main -f deploy=true -f check=health
   gh workflow run operator-staging.yml --ref main -f deploy=false -f check=gateway-privacy
   ```

   The `staging` environment holds `OPERATOR_STAGING_CLOUDFLARE_TOKEN` (deploy step only),
   `OPERATOR_STAGING_GATEWAY_READ_TOKEN` and `OPERATOR_STAGING_TEST_DEVICE_CREDENTIAL`; the repository variable
   `OPERATOR_STAGING_URL` names the staging Worker. Only the owner sets them, with `gh secret set` and `gh variable set`. A
   `lane.json` whose `deployment` is `unknown` names no deploy run for the version staging serves and is not evidence of a
   live deployment.
3. Read the deploy receipt and the check's `lane.json`, and open the staging console. Confirm the change by hand.
4. Only then deploy production with the same command and `--env production`.

The desktop app does not talk to staging by default. A build under test points at it through managed config, not through a
code change.

## 2. Schema changes

`operator/schema.sql` and `operator/schema-alter.sql` are the source of truth and the migrator applies them statement by
statement, idempotently. Apply a migration to the local wrangler D1 ahead of a code deploy with the migration runner, and run the read-only smoke
against a deployed environment's URL:

```bash verify-dry
node operator/scripts/migrate.mjs --local
node operator/scripts/smoke.mjs --url <staging-url>
```

The Worker's own health endpoint reports which tables and columns D1 actually has, so a missed migration shows up there and
not as a silent 500.

## 3. Exit criteria

A change leaves staging when the smoke passes, the console shows the change working, and, for anything that touches
identity or the vault, the negative case fails closed (a seat without approval is refused, a missing secret returns a clear
error). If any of these is unproven, the row stays `BLOCKED_EXTERNAL` with the exact step rather than being called done.
