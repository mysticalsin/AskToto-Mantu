# Runbook: QA

How a change is proven before it reaches users. Tests never run on a developer's Mac (owner decision D-28,
see [`AGENTS.md`](../../AGENTS.md)): every suite below runs in GitHub Actions, and the run is read with `gh run view`.

Blocks marked `verify` or `verify-dry` are executed by `scripts/docs/verify-commands.mjs` against the release commit:
`verify-dry` blocks are only resolved against the commit's tree (the script, file or config must exist), `verify` blocks
are resolved and run.

## 1. The gates a pull request must pass

`build.yml` runs on every push and pull request: type-check, the whole vitest suite (desktop, Worker proxy, operator,
mode-skills lock), the skipped-test audit, the architecture ratchet and layering rules, the workflow-pin gate, the
dependency audit and the secret scan. Read a run instead of re-running anything locally:

```bash verify-dry
gh run view
npm run typecheck
npm test
npm run check:skips
npm run check:architecture
npm run check:layering
npm run check:bugs
```

The gates that execute no repository test code and need only Node run as part of the docs job as well:

```bash verify
npm run check:workflow-pins
npm run check:bugs
```

## 2. Physical QA of a packaged build

Unit tests prove functions; the physical suite proves the shipped app against real IPC, real settings on disk and real
streaming. Two hosted lanes drive it without touching a developer machine:

- `packaged-smoke.yml` builds the unsigned app on macOS and Windows runners, installs it into a fresh directory and runs
  `scripts/qa/packaged-smoke.mjs`: the app starts, the renderer reports ready, it quits cleanly and nothing it started is
  alive five seconds later.
- `windows-qa.yml` installs a released Windows build and runs HK-W, hard-killing only Metis and taking a census of every
  descendant process.

```bash verify-dry
node scripts/qa/packaged-smoke.mjs
node scripts/qa/e2e-workflows.mjs --list
node scripts/check-packaged-launch.mjs
```

`scripts/qa/e2e-workflows.mjs` attaches to a running build over CDP with an isolated profile; its header holds the exact
launch command. It is the tool for the QA machine, not for a developer laptop.

## 3. Defects

Every defect a QA pass finds becomes a numbered row in [`docs/qa/BUG-LEDGER.md`](../qa/BUG-LEDGER.md). A row marked `FIXED`
must name a regression test that cites its MQA id; `npm run check:bugs` fails the build otherwise. The reproduction is a
failing test first, then the fix, and the test stays.

## 4. What needs a person or an outside account

Rows that need a real cloud-file provider, a provider account or a physical QA machine are reported `BLOCKED_EXTERNAL` by
the tools with the exact step to unblock them. They are never faked and never counted as passed. The quality targets the
runs are measured against live in [`docs/qa/QUALITY-SCORECARD.md`](../qa/QUALITY-SCORECARD.md).
