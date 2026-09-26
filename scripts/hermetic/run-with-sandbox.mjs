#!/usr/bin/env node
// W0-HERMETIC (M2-0190) — CLI front end for scripts/hermetic/sandbox-env.mjs. Wraps a test command
// that has no config-level env hook of its own (license-server's `node --test`; a future scripts/qa
// runner) so it starts under the same fresh per-run HOME/TMPDIR sandbox vitest.config.ts already gives
// every vitest worker.
//
// Usage: node scripts/hermetic/run-with-sandbox.mjs [--wrangler] -- <command> [args...]
//   --wrangler   use hermeticWranglerEnv (strips Cloudflare credentials, sandboxes wrangler's own
//                config dir) instead of the plain hermeticEnv.
//
// Exits with the wrapped command's own exit code (or 1 if it was killed by a signal), so callers (an
// npm "test" script, a CI step) see a real pass/fail, not this wrapper's own.
import { spawnSync } from 'node:child_process'
import { createHermeticSandbox, hermeticEnv, hermeticWranglerEnv, mergedEnv } from './sandbox-env.mjs'

const args = process.argv.slice(2)
const sepIndex = args.indexOf('--')
if (sepIndex === -1 || sepIndex === args.length - 1) {
  console.error('usage: run-with-sandbox.mjs [--wrangler] -- <command> [args...]')
  process.exit(2)
}
const useWrangler = args.slice(0, sepIndex).includes('--wrangler')
const [command, ...commandArgs] = args.slice(sepIndex + 1)

const sandbox = createHermeticSandbox()
const env = useWrangler ? hermeticWranglerEnv(sandbox) : hermeticEnv(sandbox)

const result = spawnSync(command, commandArgs, { stdio: 'inherit', env: mergedEnv(env) })
if (result.error) {
  console.error(`[run-with-sandbox] failed to start ${command}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
