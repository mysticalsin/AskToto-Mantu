# FITO-185-AB — idempotent createTray/registerIpc, and the real Act1 timing floor

**Branch:** `release/1.9.1`
**Tip:** `10f65920aa83be852e0bd03eb7e6bf3e3a073edb` (`10f6592`)
**Date:** 2026-09-15 (America/Toronto)

## Why

FITO-185-Z (`d2aa49a`) / FITO-185-AA (`ef070ef`) hoist `createTray` + `registerIpc` +
`createWindow` ahead of the boot awaits so exclusive Act1 is not stuck behind proxy/CLI/key
seeding. Boot's own `runStep` pass then calls all three again.

Only `createWindow` guarded itself (`if (win && !win.isDestroyed()) return`). The other two did
not:

- `createTray()` unconditionally does `tray = new Tray(...)` → a second menu-bar item, first Tray
  orphaned.
- `registerIpc()` unconditionally calls `ipcMain.handle(...)`, which throws on an
  already-registered channel → the second pass aborts mid-registration, logged and swallowed as
  `app.crash boot_step registerIpc`.

Latent while the hoist was TDZ-dead (`Cannot access 'runStep' before initialization`, see below).
Live from `ef070ef`, where the hoist actually runs.

## Fix

Guard both the same way `createWindow` does — `tray && !tray.isDestroyed()` early return, and a
module-level `ipcRegistered` flag.

## Proven

Four launches of `Metis-10f6592-qa.app` against one profile
(`proof/profile-10f6592-ab-183919/logs/audit.log`):

| event | count |
|---|---|
| `tray.created` | 4 |
| `app.started` | 4 |
| `app.boot.watch_cleared` | 4 |
| `app.crash` | **0** |

Exactly one of each per launch — the hoist and the boot pass no longer double-fire. No
`Attempted to register a second handler` anywhere in `~/Library/Logs/asktoto/main.log`, and no
`[boot] FITO-185-Z early exclusive window failed` after the TDZ fix.

## Act1 timing — measured from process exec, via CDP (no screen scraping)

`scripts`-free harness: spawn the binary, record wall clock at exec, attach over
`--remote-debugging-port`, read the renderer's own `performance.timeOrigin` and paint entries.

| Mark | warm profile | cold (wiped) profile |
|---|---|---|
| `tray.created` (first hoisted statement) | +0.339s | — |
| `app.started` (inside `createWindow`) | +0.342s | — |
| renderer `timeOrigin` (navigation start) | +0.407s | +0.345s |
| **first paint / first-contentful-paint (Act1 shell)** | **+0.579s** | **+0.525s** |
| `app.act1.dom` probe | +2.573s | — |

`act1-first-paint` class, `Métis` wordmark, `Next` and `#act1-boot-chrome` all present at that
paint. Page-only screenshot: `proof/fito-185-ab-10f6592-act1-page.png`. Raw:
`proof/fito-185-ab-10f6592-cdp.json`.

## Verdict on the stamp bar

**The ≤300ms-from-process-start gate is not reachable in this architecture, and no change inside
`createWindow` can reach it.**

Budget on a warm launch:

- **0 → 339ms** — Electron/Chromium process boot plus `src/main` module evaluation, all of it
  before the hoist's first statement. On its own this already exceeds the whole gate.
- 339 → 342ms — `createTray` (3ms).
- 342 → 407ms — `registerIpc` + `createWindow` + renderer process spawn (65ms).
- 407 → 579ms — renderer parses `index.html` and paints the Act1 shell (172ms).

There is no `await` left in that path; FITO-185-Z/AA already banked everything removable there.
The only remaining lever is the 339ms of main-process startup — i.e. lazy-importing the heavy
`src/main` modules so `whenReady` fires sooner. That is a separate, larger piece of work.

Progression for the record: 185-Y `WINDOW_AT` 5.015s → 185-Z/AA claimed 0.744s → measured here
**0.525–0.579s to Act1 paint**.

### First-ever launch after install is different

The first launch of a freshly packed bundle took **+4.44s to `app.started`** — macOS verifying an
unseen binary (code-sign + dyld cache miss), not app code. Every launch after that is the 0.34s
figure above. Worth knowing before anyone re-measures on a fresh pack and reports a regression.

## Tests

```
npx tsc --noEmit -p tsconfig.node.json                 # clean
npx vitest run src/main src/renderer/src/lib/onboarding src/renderer/src/components/Onboarding
```

3436 passed. 28 failures are all sandbox/host artifacts, not code: loopback `listen` EPERM
(`clickupOAuth`, `planeOAuth`, `mcpClient`), fetch-redirect `egress-guard`, and two spawn tests.
Re-run outside the sandbox: 85/86 pass. The one remainder,
`mac-helper.test.ts > degrades to null … when the helper binary is absent`, fails identically on a
clean tree (the helper binary exists on this Mac, so "absent" cannot hold) — pre-existing, host-specific.

## Constraint

No Latest. No merge. QA left open for Tony.
