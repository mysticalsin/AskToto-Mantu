# Runbook: operations

Day-to-day operation of what Métis ships with: the Operator Worker, the Cloudflare provider Worker and the license service.
The desktop app itself has no server to operate; its health is read from its own logs (see
[diagnostics](diagnostics.md)).

| Component | What it is | Runbook |
|---|---|---|
| Operator (`operator/`) | Cloudflare Worker + D1 fleet control plane behind Cloudflare Access | [`docs/operator/RUNBOOKS.md`](../operator/RUNBOOKS.md): deploy, migrate, backup and restore, secret rotation, Access policy, incident response |
| Cloudflare proxy (`cloudflare-proxy/`) | Worker the operator's team deploys so provider account tokens never ship in the app | [`docs/CLOUDFLARE.md`](../CLOUDFLARE.md), [`cloudflare-proxy/README.md`](../../cloudflare-proxy/README.md) |
| License service (`license-server/`) | Self-hosted activation service; enforcement is compiled off in the app today | [`docs/license-platform-plan.md`](../license-platform-plan.md) |
| Server intelligence plane (`services/`) | Local compose profile only; nothing is deployed until the owner approves a host | [`services/README.md`](../../services/README.md) |

## 1. Deploy, migrate, back up

Every operator procedure has a dry-run or read-only form. Run the plan first:

```bash verify-dry
node operator/scripts/deploy.mjs --dry-run --env production
node operator/scripts/backup.mjs --dry-run --env staging
node operator/scripts/migrate.mjs --remote --dry-run --env staging
```

Staging always goes first ([staging runbook](staging.md)). A backup export is a full data dump: it stays out of git.
D1 Time Travel is the preferred recovery for a bad write or migration; the SQL export is for a full re-seed.

## 2. Secrets and identity

Secrets are set with `wrangler secret put` and never with a shell argument. Rotating `OPERATOR_INGEST_SECRET` breaks every
seat's HMAC until each seat has the new value, and rotating `OPERATOR_PROMPT_KEY` or `OPERATOR_VAULT_KEY` makes the data
encrypted under the old key unreadable, so the table in the operator runbook is read before any rotation. The embedded provider
key has its own rotation procedure in [`docs/security/EMBEDDED-KEY-ROTATION.md`](../security/EMBEDDED-KEY-ROTATION.md).

## 3. Incidents

1. Read the Worker log for the request id (`cf-ray`) the user quotes.
2. A smoke failure right after a deploy is rolled back with `wrangler rollback` before it is debugged. A rollback does not undo
   a D1 migration.
3. To cut a seat off, revoke its approval and its license; they are separate states.
4. Meeting content is private user data. It is never pasted into an issue, a log or a prompt while diagnosing.

The read-only smoke is safe against production at any time:

```bash verify-dry
node operator/scripts/smoke.mjs --url <operator-url>
node scripts/verify-audit-log.mjs
```

## 4. Network egress

What the app is allowed to contact, and through which hop, is listed in [`docs/NETWORK-EGRESS.md`](../NETWORK-EGRESS.md);
check it before opening a firewall rule for a fleet.
