import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHermeticSandbox, hermeticWranglerEnv, mergedEnv } from '../../scripts/hermetic/sandbox-env.mjs'

// M2-0190 acceptance #2 — "Tests that invoke wrangler run with Cloudflare credentials unset, a
// sandboxed config directory and --local only; a test proves no request leaves localhost."
//
// Every other wrangler-touching test in this suite (deploy.contract.test.ts, migrate-runner.contract
// .test.ts, ...) fakes the exec — deliberately, so the suite stays fast and doesn't need real Cloudflare
// access. This is the one exception: a real `wrangler d1 execute --local` run (fast — a one-shot CLI
// command, not a long-running dev server), under scripts/hermetic/deny-non-loopback.cjs. That preload
// covers exactly the Node process wrangler itself runs in (it inherits NODE_OPTIONS): a non-loopback
// connect() from wrangler's CLI code or any Node dependency in its tree crashes the process. It does not
// cover the native workerd child process, DNS resolution, or UDP — those need a separate mechanism (see
// this ticket's advisory notes on a network-namespaced CI leg).
//
// A clean exit alone is never proof here: wrangler's own metrics dispatcher catches a failed fetch and
// only logs it at debug level, so a non-loopback connect() denied deep inside wrangler's dependency tree
// could leave the process exiting 0 with the denial visible nowhere else. deny-non-loopback.cjs writes
// every denial to the child's stderr synchronously, independent of whether wrangler catches the error —
// so `spawnSync` plus the explicit stderr check below is what actually proves "stayed local."
//
// scripts/hermetic/sandbox-env.test.ts already covers hermeticWranglerEnv's own assertions
// (credential-stripping, config-dir sandboxing); this file is only the real-process proof.
const REPO_ROOT = resolve(__dirname, '..', '..')
const WRANGLER_BIN = resolve(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const DENY_NON_LOOPBACK = resolve(REPO_ROOT, 'scripts', 'hermetic', 'deny-non-loopback.cjs')
const OPERATOR_DIR = resolve(REPO_ROOT, 'operator')

describe('a real wrangler --local invocation never leaves loopback', () => {
  let sandbox: ReturnType<typeof createHermeticSandbox> | undefined

  afterEach(() => {
    if (sandbox) rmSync(sandbox.home, { recursive: true, force: true })
    sandbox = undefined
  })

  // Windows quality job: this spawns a real, if short-lived, wrangler/workerd subprocess — a known
  // source of CI-only flakiness (path separators, native SQLite bindings) unrelated to the isolation
  // this test proves. The mechanism itself (hermeticWranglerEnv, deny-non-loopback.cjs) is exercised
  // for real on the ubuntu leg of this same job; Windows still gets the pure env-builder assertions in
  // scripts/hermetic/sandbox-env.test.ts.
  it.skipIf(process.platform === 'win32')(
    'wrangler d1 execute --local completes with no Cloudflare credentials and every connect() forced through the loopback-only preload',
    () => {
      sandbox = createHermeticSandbox()
      const env = mergedEnv(hermeticWranglerEnv(sandbox))
      env.NODE_OPTIONS = `--require "${DENY_NON_LOOPBACK}"`
      // wrangler's own telemetry/update-check code branches on CI: without it, --local's first run in a
      // fresh sandbox config dir also prompts interactively (which env.CI otherwise suppresses).
      env.CI = 'true'

      const result = spawnSync(
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
          // A distinctive literal, not `SELECT 1` — the assertion below must not be satisfiable by
          // incidental "1"s elsewhere in wrangler's own output (a row count, a duration).
          'SELECT 424242 as answer'
        ],
        { cwd: OPERATOR_DIR, encoding: 'utf8', env }
      )

      // Three independent checks, not one: a clean exit alone proves nothing (wrangler can catch and
      // swallow a denied connect() internally), and stdout containing the query's result alone proves
      // only that the command did its real work, not that nothing else happened alongside it. Together:
      // the command completed normally, it did the real work asked of it, and deny-non-loopback.cjs never
      // had anything to report on this child's stderr.
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('424242')
      expect(result.stderr).not.toContain('HERMETIC_NETWORK_DENIED')
    },
    30_000
  )
})
