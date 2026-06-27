# AskToto — Rollback Runbook

Scope: reverting AskToto 0.1.0 to a prior version. For a desktop app, "rollback" = install the previous
artifact; there is no server deploy to revert and no schema migration to undo. Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. When to roll back

A new release causes a regression (crash on launch, broken Listen/answers, bad config handling). Because
the app is local and per-user, rollback is **per-machine** and low-risk.

## 2. Rollback methods

| Method | Steps | Notes |
|--------|-------|-------|
| **Reinstall prior artifact** | Quit AskToto → install the previous `.dmg`/`.exe`/AppX from the release archive | Primary method; keep N-1 artifacts available |
| **electron-updater downgrade** | If the update host is live, publish the prior version as `latest`; clients update "down" to it | Requires the update host (currently placeholder, `updater.ts:14-18`) |
| **Portable exe (Windows)** | Run the prior `AskToto-Portable-<v>.exe` without installing | Side-by-side test of an old version (`electron-builder.yml:54-56`) |

## 3. Data / config compatibility (verified — safe to roll back)

- **Settings are forward/backward tolerant**: `getSettings()` validates per-key and drops/repairs
  anything an older or newer build doesn't understand, never throwing (`store.ts:142-160`; proven by
  `selftest.ts:30-66`). An older version reading a newer `settings.json` keeps the keys it knows.
- **Sparse user overrides**: only changed keys are persisted, so unknown keys from a newer version don't
  block an older one (`store.ts:162-184`).
- **Notes are plain markdown + frontmatter** — version-independent; any build reads them
  (`transcripts.ts`, `recall.ts`).
- **Encrypted artifacts** use a stable `ATKENC1` marker across versions (`store.ts:104`,
  `transcripts.ts:17`).
- **No database, no migrations** → nothing to reverse.

## 4. Post-rollback checks

1. App launches to tray.
2. Settings load (or fail safe to defaults) — no crash.
3. **Test key** round-trip succeeds (`store.ts:214-263`).
4. Listen + ask work; a saved transcript appears in the notes folder.
5. Self-test JSON all-pass (`selftest.ts`).

## 5. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| LOW | electron-updater rollback path unusable until an update host exists | `updater.ts:14-18` | Stand up the host (DEPLOYMENT_RUNBOOK) to enable managed downgrade |
| LOW | No documented retention of N-1 build artifacts | release process | Archive at least the last 2 signed releases for manual rollback |

## 6. N/A

- Database migration rollback, traffic shifting, infra revert — **N/A**: no server, no DB, no migrations.
