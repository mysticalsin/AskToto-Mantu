# Runbook: diagnostics

How to find out what an installed Métis did, without ever moving meeting content. Diagnostics carry logs, crash records and
counts. They never carry transcripts, the brain store, the meetings folder or `settings.json`.

## 1. Where the evidence is

The installed app writes under its user-data directory (the folder is still named `asktoto`, on purpose; see the naming note
in [`README.md`](../../README.md)):

| File | What it holds |
|---|---|
| `logs/main.log` | Rotated diagnostic log of the main process; the first file support reads for a field crash |
| `logs/audit.log` | Hash-chained audit trail: every record carries a sequence number and the hash of the line before it |
| `crash-*.log` and the boot sentinel | Written when the previous run did not shut down cleanly |

## 2. The support bundle

Settings → About → Diagnostics offers **Export diagnostics bundle**. It asks where to save, then copies the logs, the crash records, the boot
sentinel and a `MANIFEST.txt` listing exactly which files made it. A locked or missing file is skipped and the manifest shows
that. The export is gated like every privileged channel (sender check and sign-in). A user sends the folder; nobody asks
for a transcript.

Alongside the raw files, `src/main/infra/observability/diagnostics-summary.ts` reduces the audit trail to counts: boots and how
the previous run ended, stalls bucketed by duration, fatal and non-fatal crashes, and reveal outcomes. Counts are safe to
paste into a ticket.

## 3. Prove the audit trail is intact

The audit log's chain is verified offline. Point the tool at a bundle's logs folder (or run it with no argument on the
machine itself):

```bash verify-dry
node scripts/verify-audit-log.mjs
node scripts/verify-audit-log.mjs <logs-dir>
```

Exit 0 means the chain verified, 1 names the first break, 2 means no audit data was found. Records from builds that predate the
chain are reported as a legacy prefix, not a failure.

## 4. Reproduce on a hosted runner, not on a Mac

A packaged-app problem is reproduced through the hosted lanes in the [QA runbook](qa.md), which start the installed app on a
fresh profile and upload a content-free report. Tests and the app are never run on the owner's Mac (decision D-28).
The resource census writes only process names, counts and timings:

```bash verify-dry
node scripts/qa/packaged-smoke.mjs
node scripts/qa/census/run.mjs
```

## 5. What to record in a ticket

The app version and platform, the manifest of the bundle, the audit-chain result, the summary counts and the exact error
text. Not: meeting titles, transcript text, screenshots of meetings, keys or account ids.
