import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_CREDENTIAL_KEYS,
  createHermeticSandbox,
  hermeticWranglerEnv,
  mergedEnv
} from '../../scripts/hermetic/sandbox-env.mjs'

// M2-0190 acceptance #2 — "Tests that invoke wrangler run with Cloudflare credentials unset, a
// sandboxed config directory and --local only; a test proves no request leaves localhost."
//
// Every other wrangler-touching test in this suite (deploy.contract.test.ts, migrate-runner.contract
// .test.ts, ...) fakes the exec — deliberately, so the suite stays fast and doesn't need real Cloudflare
// access. This is the one exception: a real `wrangler d1 execute --local` run (fast — a one-shot CLI
// command, not a long-running dev server), under scripts/hermetic/deny-non-loopback.cjs, which turns
// "wrangler stayed local" from a trusted CLI flag into a mechanically enforced fact — the process
// itself would crash on the first non-loopback connect() attempt, anywhere in wrangler's dependency
// tree, not just in code this repo owns.
const REPO_ROOT = resolve(__dirname, '..', '..')
const WRANGLER_BIN = resolve(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const DENY_NON_LOOPBACK = resolve(REPO_ROOT, 'scripts', 'hermetic', 'deny-non-loopback.cjs')
const OPERATOR_DIR = resolve(REPO_ROOT, 'operator')

describe('hermeticWranglerEnv', () => {
  it('strips every real Cloudflare credential and sandboxes wrangler’s own config directory', () => {
    const sandbox = createHermeticSandbox()
    const env = hermeticWranglerEnv(sandbox)
    for (const key of CLOUDFLARE_CREDENTIAL_KEYS) expect(env[key]).toBeUndefined()
    expect(env.WRANGLER_SEND_METRICS).toBe('false')
    expect(env.WRANGLER_HIDE_BANNER).toBe('true')
    expect(env.XDG_CONFIG_HOME.startsWith(sandbox.home)).toBe(true)
  })
})

describe('a real wrangler --local invocation never leaves loopback', () => {
  // Windows quality job: this spawns a real, if short-lived, wrangler/workerd subprocess — a known
  // source of CI-only flakiness (path separators, native SQLite bindings) unrelated to the isolation
  // this test proves. The mechanism itself (hermeticWranglerEnv, deny-non-loopback.cjs) is exercised
  // for real on the ubuntu leg of this same job; Windows still gets the pure env-builder assertions
  // above.
  it.skipIf(process.platform === 'win32')(
    'wrangler d1 execute --local completes with no Cloudflare credentials and every connect() forced through the loopback-only preload',
    () => {
      const sandbox = createHermeticSandbox()
      const env = mergedEnv(hermeticWranglerEnv(sandbox))
      env.NODE_OPTIONS = `--require ${DENY_NON_LOOPBACK}`
      env.CI = 'true'

      const output = execFileSync(
        process.execPath,
        [
          WRANGLER_BIN,
          'd1',
          'execute',
          'metis-operator',
          '--local',
          '--persist-to',
          resolve(sandbox.tmp, 'wrangler-state'),
          '--command',
          'SELECT 1'
        ],
        { cwd: OPERATOR_DIR, encoding: 'utf8', env, stdio: 'pipe' }
      )

      // If ANY dependency in wrangler's tree had opened a non-loopback connection — an update check, a
      // telemetry ping, a real API call despite --local — scripts/hermetic/deny-non-loopback.cjs would
      // have thrown this exact error and crashed the process (execFileSync would then throw instead of
      // returning). Reaching this line at all is the proof; the explicit assertion is belt-and-braces.
      expect(output).not.toContain('HERMETIC_NETWORK_DENIED')
    },
    30_000
  )
})
