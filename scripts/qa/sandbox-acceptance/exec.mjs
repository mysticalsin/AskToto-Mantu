// WP14 sandbox acceptance — the only place this tooling runs a helper command. Every command passes the guard
// first, so `open`, `launchctl` and `osascript` cannot be reached even by accident.
import { spawnSync } from 'node:child_process'
import { assertCommandAllowed } from './guard.mjs'

/**
 * Run a short helper to completion. Never uses a shell. Throws GuardError for a forbidden command.
 * @param {string} file absolute path of the helper
 * @param {readonly string[]} args
 * @param {{ timeoutMs?: number, env?: Record<string, string | undefined>, spawn?: typeof spawnSync }} [options]
 */
export function runTool(file, args, { timeoutMs = 60_000, env = process.env, spawn = spawnSync } = {}) {
  assertCommandAllowed(file, args)
  const result = spawn(file, [...args], { encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 16 * 1024 * 1024 })
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : null
  }
}
