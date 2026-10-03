/**
 * Pure helpers shared by packaged-smoke.mjs and the golden-flows modules that it delegates to (M2-0410):
 * audit-log parsing, the trusted-overlay URL test and the park-window proof. Kept in one leaf module so
 * neither side has to import the other.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess, sleep } from '../lib/app-driver.mjs'

export const AUDIT_POLL_MS = 250

/** JSON-lines audit transport ('{text}', logger.ts): blank and malformed lines are skipped, never guessed. */
export function parseAuditLog(text) {
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return records
}

export function readAuditLog(auditLogPath) {
  try {
    return readFileSync(auditLogPath, 'utf8')
  } catch {
    return ''
  }
}

/** True iff `url` is the trusted overlay's own `file:` document (overlayRendererUrl). */
export function isOverlayUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'file:' && parsed.pathname.endsWith('/renderer/index.html')
}

function readSmokeParkState(userData) {
  try {
    return JSON.parse(readFileSync(join(userData, 'smoke-park-state.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Poll the park-window marker until islandResting is proved (not a blind sleep). */
export async function waitUntilParked(userData, sinceMs, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readSmokeParkState(userData)
    if (state && typeof state.at === 'number' && state.at >= sinceMs && state.parked === true) {
      return state
    }
    await sleep(AUDIT_POLL_MS)
  }
  return null
}

export async function parkAndProve({ executable, env, userData }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const since = Date.now()
    const result = await runProcess(executable, ['--metis-smoke-reopen=park-window'], 10_000, { env })
    if (result.error) return result
    const proved = await waitUntilParked(userData, since)
    if (proved) return result
    await sleep(200)
  }
  return { code: null, signal: null, error: true }
}
