import { app } from 'electron'

// Dev-only environment escape hatches — ONE gate for all of them.
//
// A packaged install's environment is writable by anything running as the user: `setx X 1` /
// HKCU\Environment on Windows, `launchctl setenv` / ~/Library/LaunchAgents on macOS. Both persist
// across launches and need no elevation. So an env switch that changes a privacy, data-loss, or
// update decision must never be honored in a shipped build — a planted variable plus one relaunch
// would otherwise silently reconfigure it with the UI still reporting the old state.
//
// Every such switch goes through devEnv() rather than reading process.env directly, so the gate is
// one decision in one place instead of a per-site `app.isPackaged` read that is easy to forget
// (which is exactly how ASKTOTO_DISABLE_CP ended up gated for contentProtection but not for
// Private View — MQA-148).

/**
 * Fail-CLOSED read of `app.isPackaged`. A throw (app unavailable / not ready) counts as PACKAGED, so
 * a hatch can never open by accident — and, just as important, the read can never propagate an
 * exception into a caller on a save path. Mirrors the guarded read in secrets.ts's useFileBackend().
 *
 * `=== true` (not `!== false`) because Electron always defines this as a boolean at runtime; the only
 * source of `undefined` is the vitest electron mock, which IS an unpackaged dev process.
 */
export function isPackagedBuild(): boolean {
  try {
    return app.isPackaged === true
  } catch {
    return true
  }
}

/** The value of a dev-only env var, or undefined in a packaged build. */
export function devEnv(name: string): string | undefined {
  return isPackagedBuild() ? undefined : process.env[name]
}

/**
 * Whether DevTools may be opened. Packaged builds say no.
 *
 * This lives here, not as a module const in index.ts, because it must be reachable from EVERY window
 * construction in src/main — and it was not. intelligence.ts's dashboard window was built with no
 * `devTools` key at all, so Electron's default (true) applied and DevTools were available in shipped
 * builds on the one window whose preload can read the decrypted brain. The commit that introduced the
 * gate claimed it covered every BrowserWindow; its contract test only counted occurrences inside
 * index.ts, so the fourth window was invisible to it.
 *
 * Routing through devEnv() also hardens the override: ASKTOTO_DEVTOOLS is a dev-only hatch, and a
 * packaged build must ignore a planted environment variable (see the note at the top of this file).
 */
export function devToolsEnabled(): boolean {
  return !isPackagedBuild() || devEnv('ASKTOTO_DEVTOOLS') === '1'
}
