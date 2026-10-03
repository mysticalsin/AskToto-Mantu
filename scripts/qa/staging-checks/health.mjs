// Staging check `health` (M2-0103): runs the Operator's read-only smoke (operator/scripts/smoke.mjs) against
// the staging Worker with --expected-version, so a healthy older Worker cannot pass. The report keeps each
// smoke check's name and verdict only: smoke details carry response bodies, redirect locations and the base
// URL, whose workers.dev subdomain names the account, so none of them leave this module.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const SMOKE_SCRIPT = 'operator/scripts/smoke.mjs'

/** smoke.mjs argv (run from the repository root). */
export function healthCommand({ url, expectedVersion }) {
  if (typeof expectedVersion !== 'string' || !expectedVersion.trim()) throw new Error('health needs the deployed commit as --expected-version.')
  return [SMOKE_SCRIPT, '--url', url, '--expected-version', expectedVersion, '--json']
}

/** The content-free part of smoke.mjs's --json report. */
export function healthReport(smoke) {
  const checks = Array.isArray(smoke?.checks) ? smoke.checks.map(({ name, ok }) => ({ name: String(name), ok: ok === true })) : []
  return { all_ok: smoke?.allOk === true && checks.length > 0 && checks.every((check) => check.ok), checks }
}

export async function healthCheck({ url, expectedVersion, spawn = spawnSync }) {
  const child = spawn(process.execPath, healthCommand({ url, expectedVersion }), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const base = { expected_version: expectedVersion, smoke_exit_code: child.status ?? null }
  let smoke
  try {
    smoke = JSON.parse(child.stdout ?? '')
  } catch {
    return { ok: false, report: { ...base, all_ok: false, checks: [], detail: 'smoke.mjs printed no JSON report' } }
  }
  const report = { ...base, ...healthReport(smoke) }
  return { ok: child.status === 0 && report.all_ok, report }
}
