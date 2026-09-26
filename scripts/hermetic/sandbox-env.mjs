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

// Round-1 fixed this as a hand-kept list of credential names, which round-2 validation showed wrangler
// 4.131.1 could still slip past: it also reads the deprecated aliases CF_API_TOKEN/CF_API_KEY/CF_EMAIL/
// CF_ACCOUNT_ID and WRANGLER_CF_AUTHORIZATION_TOKEN (its `deprecatedName` entries), none of which carry
// the CLOUDFLARE_ prefix a name-list has to be told about one at a time. A prefix strip can't miss the
// next alias the same way — the same allow-list-over-deny-list approach scripts/qa/lib/sandbox-guard.mjs
// already uses for ASKTOTO_USERDATA.
/** @type {readonly string[]} */
const CREDENTIAL_PREFIXES = Object.freeze(['CLOUDFLARE_', 'CF_', 'WRANGLER_'])

/**
 * `hermeticEnv` plus the wrangler-specific isolation M2-0190 asks for: no real account credentials (by
 * prefix, not by name — see `CREDENTIAL_PREFIXES`), wrangler's own global config directory (`~/.wrangler`,
 * or `$XDG_CONFIG_HOME/.wrangler` on newer versions) redirected into the sandbox instead of the real home,
 * its anonymous-metrics call and OAuth keyring read turned off, so a `--local` run never has a reason to
 * leave the loopback interface — or the sandboxed config directory — at all.
 *
 * `inheritedEnv` defaults to `process.env` but is a parameter so a test can seed real-looking credential
 * keys and prove they're stripped without mutating the actual process environment.
 *
 * @param {HermeticSandbox} sandbox
 * @param {Record<string, string | undefined>} [inheritedEnv]
 * @returns {Record<string, string | undefined>}
 */
export function hermeticWranglerEnv(sandbox, inheritedEnv = process.env) {
  /** @type {Record<string, string | undefined>} */
  const env = hermeticEnv(sandbox, {
    XDG_CONFIG_HOME: join(sandbox.home, '.config')
  })
  for (const key of Object.keys(inheritedEnv)) {
    if (CREDENTIAL_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = undefined
  }
  // These three must win over the strip loop above — an inherited env can define any of them (e.g. a
  // developer shell exporting WRANGLER_SEND_METRICS=true) under a prefix that loop already stripped to
  // undefined, and the sandbox's own choice always has to be the one that lands in the child.
  env.WRANGLER_SEND_METRICS = 'false'
  // WRANGLER_SEND_METRICS only turns off wrangler's own telemetry POST. Every command still calls
  // printWranglerBanner(), which — unless this is set — awaits an npm-registry GET for the latest
  // wrangler version before the command's real work even starts. WRANGLER_HIDE_BANNER makes
  // printWranglerBanner() return before it ever calls updateCheck(), so this is the variable that
  // actually keeps a `--local` run on loopback, not a side effect this repo is relying on by accident.
  env.WRANGLER_HIDE_BANNER = 'true'
  // Without this, wrangler reads OAuth tokens from the REAL OS keyring regardless of what
  // XDG_CONFIG_HOME/HOME point at above — the sandboxed config directory would hold a fresh, empty
  // config while auth silently fell through to the real account.
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'false'
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
