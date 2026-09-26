// W0-HERMETIC (M2-0190) — the same per-run sandbox vitest.config.ts's `hermeticHomeEnv` gives every
// vitest worker (see M2-0001), for anything that spawns a plain process INSTEAD of running inside a
// vitest worker: license-server's `node --test`, the scripts/qa harnesses, and any test that shells out
// to `swift test` or `wrangler`. None of those runners has a `test.env` hook, so the sandbox has to be
// built here and layered onto the child process's environment before it starts.
//
// Zero external dependencies (node:fs/os/path only) and one small module, so every consumer (root
// vitest.config.ts, license-server, scripts/qa, operator's wrangler test) builds the exact same sandbox
// shape from a single source, rather than five independent, silently-drifting copies.
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * @typedef {{ home: string, tmp: string }} HermeticSandbox
 */

/**
 * A fresh, empty, per-run home directory plus its own tmp subdirectory — mirrors
 * vitest.config.ts's `mkdtempSync(join(tmpdir(), 'metis-test-home-'))` + `join(testHome, 'tmp')`.
 * Nothing under `home` exists before this call, so there is nothing real left to resolve into.
 *
 * @returns {HermeticSandbox}
 */
export function createHermeticSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'metis-test-home-'))
  const tmp = join(home, 'tmp')
  mkdirSync(tmp, { recursive: true })
  return { home, tmp }
}

/**
 * The env every hermetic child process gets, extended with `extra`. Root vitest.config.ts's own
 * `hermeticHomeEnv` is built from this same function (plus its own `PLAYWRIGHT_BROWSERS_PATH`), so a
 * `homedir()`/`app.getPath()`-derived path can never tell whether it's running under vitest or under
 * one of these wrapped runners — there is only ever the one implementation.
 *
 * @param {HermeticSandbox} sandbox
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string | undefined>}
 */
export function hermeticEnv(sandbox, extra = {}) {
  return {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    // Windows detectOneDrive() trusts these before the home directory; empty means "no OneDrive".
    OneDrive: '',
    OneDriveCommercial: '',
    OneDriveConsumer: '',
    APPDATA: join(sandbox.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(sandbox.home, 'AppData', 'Local'),
    TMPDIR: sandbox.tmp,
    TMP: sandbox.tmp,
    TEMP: sandbox.tmp,
    METIS_TEST_HOME: sandbox.home,
    // Unique per run/worktree — __mocks__/electron.ts derives every app.getPath(...) answer from this,
    // so a concurrent run (another worktree, a parallel agent) never shares a userData/documents path.
    ASKTOTO_TEST_SANDBOX_ROOT: sandbox.home,
    ...extra
  }
}

// Real Cloudflare account credentials a developer/CI/agent shell might already have exported for
// day-to-day `wrangler` use. A wrangler-invoking test must never inherit these — acceptance criterion
// #2 of M2-0190 ("Cloudflare credentials unset"). Explicit `undefined` values (not just omission) so
// `mergedEnv` below deletes any inherited value from `process.env` rather than leaving it in place.
/** @type {readonly string[]} */
export const CLOUDFLARE_CREDENTIAL_KEYS = Object.freeze([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_CLIENT_ID',
  'CLOUDFLARE_CLIENT_SECRET',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET'
])

/**
 * `hermeticEnv` plus the wrangler-specific isolation M2-0190 asks for: no real account credentials,
 * wrangler's own global config directory (`~/.wrangler`, or `$XDG_CONFIG_HOME/.wrangler` on newer
 * versions) redirected into the sandbox instead of the real home, and its anonymous-metrics call
 * turned off so a `--local` run never has a reason to leave the loopback interface at all.
 *
 * @param {HermeticSandbox} sandbox
 * @returns {Record<string, string | undefined>}
 */
export function hermeticWranglerEnv(sandbox) {
  /** @type {Record<string, string | undefined>} */
  const env = hermeticEnv(sandbox, {
    XDG_CONFIG_HOME: join(sandbox.home, '.config'),
    WRANGLER_SEND_METRICS: 'false',
    // WRANGLER_SEND_METRICS only turns off wrangler's own telemetry POST. Every command still calls
    // printWranglerBanner(), which — unless this is set — awaits an npm-registry GET for the latest
    // wrangler version before the command's real work even starts. WRANGLER_HIDE_BANNER makes
    // printWranglerBanner() return before it ever calls updateCheck(), so this is the variable that
    // actually keeps a `--local` run on loopback, not a side effect this repo is relying on by accident.
    WRANGLER_HIDE_BANNER: 'true'
  })
  for (const key of CLOUDFLARE_CREDENTIAL_KEYS) env[key] = undefined
  return env
}

/**
 * Layers `env` onto a copy of `process.env`, deleting any key `env` sets to `undefined` instead of
 * passing it through as the literal string `"undefined"` (what `{ ...process.env, ...env }` alone would
 * do to `child_process.spawn`, which stringifies every value it's given).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {NodeJS.ProcessEnv}
 */
export function mergedEnv(env) {
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}
