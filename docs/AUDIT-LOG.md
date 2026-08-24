# The audit trail — what it records, how it is protected, and the retention policy

Métis keeps a security audit log separate from the diagnostic log: one JSON record per line in
`%APPDATA%/asktoto/logs/audit.log` (macOS: `~/Library/Application Support/asktoto/logs/`), file mode
0600, written only by the main process (`src/main/logger.ts`).

## What a record carries

Metadata only, never content: event type (`transcript.deleted`, `key.set`, `capture.screen`, …), a
timestamp, the signed-in actor's email, and event-specific metadata (file basename, provider id,
counts). Transcript text, prompts, and key material are never written — `auditLog`'s contract and the
crash path's `redactSecrets` enforce it.

## Tamper evidence (MQA-232)

Every record carries `seq` (monotonic across the whole trail, never reset by rotation) and `prev`
(hex SHA-256 of the previous record's exact line). Editing, deleting, or reordering any line breaks the
chain at that point. Verify at any time:

```sh
node scripts/verify-audit-log.mjs "%APPDATA%/asktoto/logs"
```

Exit 0 = unbroken. Records written by builds that predate the chain lack the fields and are reported as
a legacy prefix, not a failure. The chain resumes across app restarts (the tip is re-read from disk),
so one chain covers the whole retained window.

What this does and does not claim: the chain makes local tampering **detectable**, not impossible — an
attacker with filesystem access and the will to recompute every subsequent hash can rebuild a
consistent forgery. Hash-chaining raises that from "edit a line" to "rewrite the tail of every
generation", which is the standard local-log posture; for non-repudiation against a privileged local
attacker, forward the trail off the machine (the diagnostics export bundle is the manual form of that).

## Retention

Rotation at 5MB renames the file to `audit-<epoch-ms>.log`; the newest **20 generations**
(`AUDIT_ARCHIVE_GENERATIONS`, `src/main/logger.ts`) are kept, oldest pruned — roughly 100MB / a real
multi-month window, replacing the previous single-`.old` scheme that silently overwrote history past
~10MB. The cap is a compile-time constant on purpose: retention of the security trail is operator
policy, not a per-user setting a compromised session could shrink.

## Erasure stance — decided, not accidental

**"Delete all Métis data" deliberately does not delete the audit trail.** The trail is the record of
actions — including the erasure itself — and destroying it on request would defeat its purpose as a
control (and break the chain's evidentiary value). The balance with data-protection obligations:

- Records are metadata-only; the identifying payload is limited to the actor email and file basenames
  derived from meeting titles.
- Retention is bounded by the generation cap above — nothing is kept indefinitely.
- A data-subject request that genuinely requires purging audit records is an operator action (delete
  the `logs/` directory), consciously outside the in-app erasure flow.

This stance is recorded here so a DPO reviews a decision, not an omission. If the DPO's ruling differs,
change `recallDeleteAll` and this document in the same commit.
