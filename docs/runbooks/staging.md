# Runbook: staging

Staging is the Operator Worker's second environment (`metis-operator-staging`, its own D1 database and secrets). It exists so a
change to D1 schema, HMAC verification or Access identity resolution is seen working before production. The full
procedures, including secrets, Access policy and rollback, are in [`docs/operator/RUNBOOKS.md`](../operator/RUNBOOKS.md);
this page is the order of operations.

Nothing here runs on a developer Mac against a real account without the owner: every real command needs a
`wrangler login` the owner performs. The dry-run forms print the full plan and touch nothing, and CI runs the staging dry-run
on every push.

## 1. Order

1. Preview the staging plan, then the production plan:

```bash verify-dry
node operator/scripts/deploy.mjs --dry-run --env staging
node operator/scripts/deploy.mjs --dry-run --env production
```

2. Deploy staging. The deploy refuses a dirty tree, type-checks and tests the operator package, builds the client and world
   bundles, runs the D1 migration runner before the deploy so new code never meets old schema, deploys, then runs the
   post-deploy smoke against the environment's URL. Any failing step stops the rest.
3. Read the smoke receipt and open the staging console. Confirm the change by hand.
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
