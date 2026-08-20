import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/**
 * Boot sentinel — how the app finds out that its PREVIOUS launch died before it finished booting.
 *
 * MQA-175: a native C++ exception (an OSCrypt decrypt of a sync-mangled `.brain/index.json`) unwinds
 * past V8, so `uncaughtException`, `unhandledRejection` and every surrounding try/catch are blind to it.
 * The process simply vanishes: no window, no dialog, no `crash-*.log`, no `app.crash` audit line. Six
 * consecutive launches of the shipped 1.5.4 Windows build died exactly that way and left nothing behind
 * except six Crashpad minidumps the app never looked at.
 *
 * Nothing inside a dying process can report on it, so the record has to be written BEFORE the risky work
 * and removed AFTER it: a file that is still there on the next launch IS the report. That one fact
 * drives both halves of the recovery — the durable trace (what died, when, and which minidump belongs to
 * it) and the routing decision (skip the boot step that did the killing).
 *
 * Deliberately dependency-free (node:fs/node:path only): this runs before anything else can be trusted,
 * and must never be the reason a boot fails.
 */

const SENTINEL = 'boot-incomplete.json'

/** One minidump found in the Crashpad database, with the mtime that decides which one is newest. */
type CrashDump = { name: string; mtimeMs: number }

/** The run currently in progress, as recorded on disk. `consecutive` counts the early deaths that
 *  immediately preceded it, so a repeat offender is distinguishable from a one-off. */
export type BootRecord = { startedAt: string; pid: number; version: string; consecutive: number }

/** A previous run that started and never reached the end of boot, plus the Crashpad minidump that most
 *  likely belongs to it — the app already writes those (crashReporter.start in index.ts) and has never
 *  once read one. */
export type EarlyDeath = BootRecord & { crashDump: string | null }

function sentinelPath(userData: string): string {
  return join(userData, SENTINEL)
}

/** Newest `.dmp` in the Crashpad database under `<userData>/Crashpad`, by mtime. Null when there is none
 *  (or nothing is readable) — a missing dump must never turn the trace into an error.
 *
 *  MQA-210: the database's SUBDIRECTORIES are platform-specific — Crashpad on Windows keeps reports in
 *  `reports/`, on macOS and Linux in `new/`, `pending/` and `completed/`. This used to look only in
 *  `reports/`, so on a Mac the scan threw ENOENT and every early-death trace said "minidump: none" on
 *  exactly the platform whose packaged app has never been launch-verified. Scanning the root and one
 *  level below it costs a couple of tiny directory reads and encodes no platform's shape at all. */
export function newestCrashDump(userData: string): string | null {
  // Both readers answer null instead of throwing: a directory this platform does not use, and an entry
  // Crashpad's own cleanup deleted mid-scan, are both normal — neither may cost us the trace.
  const listOrNull = (dir: string): string[] | null => {
    try {
      return readdirSync(dir)
    } catch {
      return null
    }
  }
  const statOrNull = (p: string): Stats | null => {
    try {
      return statSync(p)
    } catch {
      return null
    }
  }
  const scan = (dir: string, depth: number): CrashDump | null => {
    const names = listOrNull(dir)
    if (!names) return null
    let newest: CrashDump | null = null
    for (const name of names) {
      const st = statOrNull(join(dir, name))
      if (!st) continue
      let found: CrashDump | null = null
      if (st.isDirectory()) {
        if (depth > 0) found = scan(join(dir, name), depth - 1)
      } else if (name.toLowerCase().endsWith('.dmp')) {
        found = { name, mtimeMs: st.mtimeMs }
      }
      if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found
    }
    return newest
  }
  return scan(join(userData, 'Crashpad'), 1)?.name ?? null
}

/**
 * Open a boot watch: claim the sentinel for this run and report the previous run if it never closed one.
 * Call once, as early in the ready sequence as the userData path is settled.
 */
export function beginBootWatch(
  userData: string,
  version: string,
  now: () => string = () => new Date().toISOString()
): EarlyDeath | null {
  const p = sentinelPath(userData)
  let previous: BootRecord | null = null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<BootRecord>
    // Only a record with a real start time proves a previous run got as far as claiming the sentinel; a
    // truncated or hand-edited file is not evidence of a death and must not strand the app in safe start.
    if (typeof raw?.startedAt === 'string' && raw.startedAt !== '') {
      previous = {
        startedAt: raw.startedAt,
        pid: typeof raw.pid === 'number' ? raw.pid : -1,
        version: typeof raw.version === 'string' ? raw.version : 'unknown',
        consecutive: typeof raw.consecutive === 'number' && raw.consecutive >= 0 ? raw.consecutive : 0
      }
    }
  } catch {
    /* absent (the normal case) or unreadable — either way, no evidence of an early death */
  }
  const consecutive = previous ? previous.consecutive + 1 : 0
  try {
    mkdirSync(userData, { recursive: true })
    writeFileSync(p, JSON.stringify({ startedAt: now(), pid: process.pid, version, consecutive }), { mode: 0o600 })
  } catch {
    /* best-effort: a profile we cannot write costs us the next launch's diagnosis, never this boot */
  }
  return previous ? { ...previous, consecutive, crashDump: newestCrashDump(userData) } : null
}

/** Close the boot watch: this run got past the step that kills. Idempotent — also called on a graceful
 *  quit, so quitting inside the watch window is never mistaken for a death. */
export function endBootWatch(userData: string): void {
  try {
    rmSync(sentinelPath(userData), { force: true })
  } catch {
    /* best-effort */
  }
}

/** One line for the crash log / audit trail: what died, when, on which build, and which dump to open. */
export function describeEarlyDeath(d: EarlyDeath): string {
  return (
    `previous launch (pid ${d.pid}, v${d.version}, started ${d.startedAt}) died before boot completed; ` +
    `consecutive early deaths: ${d.consecutive}; newest Crashpad minidump: ${d.crashDump ?? 'none'}`
  )
}
