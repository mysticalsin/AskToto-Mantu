# Windows pack — 1.8.9 E2E (native CI in progress)

## Status

Linux cross-pack of 1.8.9 was DOA (`cachedDataRejected`) then fixed with `ASKTOTO_PLAIN_MAIN=1`.
User still reported “not opening” on Windows. Follow-up:

1. Unblocked CI Security (`sharp` → 0.35.4, `js-yaml` → 4.3.2) so Windows package jobs can run.
2. `unsigned-win-pack.yml` now runs on push to `cursor/windows-pack-*` **and** runs the real
   `check-packaged-launch.mjs` gate on `windows-latest`.
3. Windows launch UX: tray empty-icon fallback + one-shot “Métis is running” tray toast
   (`winRunningHintShown`) so skipTaskbar + 8×2 island is not mistaken for a dead app.
4. Runtime gate refuses `.jsc` in Windows packs built off `win32` / with `ASKTOTO_PLAIN_MAIN=1`.

## What to install

Prefer the **GitHub Actions artifact** from workflow **Unsigned Windows pack** on this branch once
the launch gate is green — that is the only path that proves Metis.exe opened on real Windows.

Draft release (Linux plain-main interim): `v1.8.9-unsigned-win`
https://github.com/mysticalsin/AskToto-Mantu/releases/tag/untagged-7ba8cd20144c96a6b185

After CI finishes, this doc and the draft release will be updated with the native-pack SHA-256s.

## If it “doesn’t open”

Métis is tray-first on Windows (`skipTaskbar`). After launch:

1. Check the **system tray** (near the clock; “Show hidden icons”).
2. Look for a Windows notification: “Métis is running”.
3. Confirm `%APPDATA%\asktoto\logs\audit.log` contains `app.started`.
4. If you still see `cachedDataRejected`, you have the old bytecode build — uninstall and use the
   new artifact (asar must have large `out/main/index.js`, no `.jsc`).

Branch: `cursor/windows-pack-latest-8ca3`.
