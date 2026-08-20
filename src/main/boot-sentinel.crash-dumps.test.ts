import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginBootWatch, describeEarlyDeath, newestCrashDump } from './boot-sentinel'

/**
 * MQA-210 — the boot sentinel only ever looked in `<userData>/Crashpad/reports`, which is Crashpad's
 * WINDOWS database layout. On macOS and Linux the same database keeps its minidumps in `new/`,
 * `pending/` and `completed/`, so `readdirSync` threw ENOENT and every Mac early-death trace ended
 * "newest Crashpad minidump: none" — on exactly the platform whose packaged app has never been
 * launch-verified. The module was written from Windows evidence and its existing test could not catch
 * the difference because it creates the Windows directory itself before asserting.
 *
 * Runnable on any host: the layouts are fixtures on disk, not a platform branch, which is also why the
 * fix scans the database instead of encoding one OS's shape.
 */
describe('MQA-210 — the crash-dump scan must not assume the Windows Crashpad layout', () => {
  let userData: string

  /** Write a minidump at an explicit mtime so "newest" is deterministic, not a race with the clock. */
  function dump(relDir: string, name: string, mtimeSec: number): void {
    const dir = join(userData, 'Crashpad', relDir)
    mkdirSync(dir, { recursive: true })
    const p = join(dir, name)
    writeFileSync(p, 'minidump')
    utimesSync(p, mtimeSec, mtimeSec)
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-mqa210-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('MQA-210: finds a minidump in the macOS/Linux layout (pending/)', () => {
    dump('pending', 'mac-pending.dmp', 1_700_000_000)
    expect(newestCrashDump(userData)).toBe('mac-pending.dmp')
  })

  it('MQA-210: finds a minidump in the macOS/Linux layout (completed/)', () => {
    dump('completed', 'mac-completed.dmp', 1_700_000_000)
    expect(newestCrashDump(userData)).toBe('mac-completed.dmp')
  })

  it('MQA-210: still finds the Windows layout (reports/) — the shipped path must not regress', () => {
    dump('reports', 'win.dmp', 1_700_000_000)
    expect(newestCrashDump(userData)).toBe('win.dmp')
  })

  it('MQA-210: picks the newest dump across the whole database, not the first directory it reads', () => {
    dump('reports', 'older.dmp', 1_700_000_000)
    dump('completed', 'newest.dmp', 1_700_000_900)
    dump('pending', 'middle.dmp', 1_700_000_500)
    expect(newestCrashDump(userData)).toBe('newest.dmp')
  })

  it('MQA-210: ignores Crashpad bookkeeping that is not a minidump', () => {
    dump('pending', 'real.dmp', 1_700_000_000)
    mkdirSync(join(userData, 'Crashpad', 'attachments', 'abc'), { recursive: true })
    writeFileSync(join(userData, 'Crashpad', 'settings.dat'), 'x')
    writeFileSync(join(userData, 'Crashpad', 'pending', 'real.meta'), 'x')
    expect(newestCrashDump(userData)).toBe('real.dmp')
  })

  it('MQA-210: no Crashpad database at all is still null, never a throw', () => {
    expect(newestCrashDump(userData)).toBeNull()
    expect(newestCrashDump(join(userData, 'does-not-exist'))).toBeNull()
  })

  it('MQA-210: the early-death trace names the Mac dump instead of reporting none', () => {
    expect(beginBootWatch(userData, '1.6.0')).toBeNull() // first launch: nothing to report
    dump('pending', 'mac-early-death.dmp', 1_700_000_000) // …that run died; Crashpad caught it
    const death = beginBootWatch(userData, '1.6.0')
    expect(death?.crashDump).toBe('mac-early-death.dmp')
    expect(describeEarlyDeath(death!)).toContain('mac-early-death.dmp')
  })
})
