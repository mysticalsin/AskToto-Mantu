import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newestCrashDump, type BootRecord } from './boot-sentinel'

const BRAIN_RESUME_SENTINEL = 'brain-resume-incomplete.json'

export type BrainResumeDeath = BootRecord & { crashDump: string | null }

function brainResumeSentinelPath(userData: string): string {
  return join(userData, BRAIN_RESUME_SENTINEL)
}

function readBrainResumeRecord(userData: string): BootRecord | null {
  try {
    const raw = JSON.parse(readFileSync(brainResumeSentinelPath(userData), 'utf8')) as Partial<BootRecord>
    if (typeof raw?.startedAt !== 'string' || raw.startedAt === '') return null
    return {
      startedAt: raw.startedAt,
      pid: typeof raw.pid === 'number' ? raw.pid : -1,
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
      consecutive: typeof raw.consecutive === 'number' && raw.consecutive >= 0 ? raw.consecutive : 0
    }
  } catch {
    return null
  }
}

/** Read a stale brain-resume marker without claiming the current run's resume window. */
export function readBrainResumeDeath(userData: string): BrainResumeDeath | null {
  const previous = readBrainResumeRecord(userData)
  return previous ? { ...previous, consecutive: previous.consecutive + 1, crashDump: newestCrashDump(userData) } : null
}

/**
 * Claim the delayed brain-resume window and report the previous launch if it died inside that window.
 * The early boot sentinel may already be cleared by this point; this marker is deliberately separate.
 */
export function beginBrainResumeWatch(
  userData: string,
  version: string,
  now: () => string = () => new Date().toISOString()
): BrainResumeDeath | null {
  const previous = readBrainResumeDeath(userData)
  const consecutive = previous?.consecutive ?? 0
  try {
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      brainResumeSentinelPath(userData),
      JSON.stringify({ startedAt: now(), pid: process.pid, version, consecutive } satisfies BootRecord),
      { mode: 0o600 }
    )
  } catch {
    /* best-effort: losing this marker costs only the next launch's diagnosis, never this boot */
  }
  return previous
}

/** Clear the delayed brain-resume marker. Idempotent for finally/will-quit/forced-exit paths. */
export function endBrainResumeWatch(userData: string): void {
  try {
    rmSync(brainResumeSentinelPath(userData), { force: true })
  } catch {
    /* best-effort */
  }
}

export function describeBrainResumeDeath(d: BrainResumeDeath): string {
  return (
    `previous launch (pid ${d.pid}, v${d.version}, started ${d.startedAt}) died during brain resume; ` +
    `consecutive brain-resume deaths: ${d.consecutive}; newest Crashpad minidump: ${d.crashDump ?? 'none'}`
  )
}
