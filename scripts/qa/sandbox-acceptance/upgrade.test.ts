import { describe, expect, it } from 'vitest'
import {
  UPGRADE_SETTINGS_PATCH,
  UPGRADE_STEPS,
  diffSnapshots,
  eventCounts,
  isRunning,
  judgeRollback,
  judgeSingleInstance,
  judgeVersion,
  reportedVersions,
  snapshotMeetings
} from './upgrade.mjs'

const fakeFs = (files: Record<string, string>) => ({
  list: () => Object.keys(files),
  hash: (path: string) => `h:${files[path.split('/').pop() as string]}`,
  size: (path: string) => files[path.split('/').pop() as string].length
})

describe('meeting snapshots', () => {
  it('separates saved meeting files from drafts, README and index, and records hash and size only', () => {
    const snap = snapshotMeetings(
      '/m',
      fakeFs({
        '2026-10-21_1000-a.md': 'one',
        'README.md': 'r',
        'index.md': 'i',
        '.autosave-draft-x.md': 'd',
        '2026-10-21_1000-note-b.md': 'n'
      })
    )
    expect(Object.keys(snap.saved)).toEqual(['2026-10-21_1000-a.md'])
    expect(snap.saved['2026-10-21_1000-a.md']).toEqual({ sha256: 'h:one', bytes: 3 })
    expect(Object.keys(snap.others).sort()).toEqual(['.autosave-draft-x.md', '2026-10-21_1000-note-b.md', 'README.md', 'index.md'])
  })

  it('returns empty maps for a missing folder and skips entries that cannot be read', () => {
    expect(snapshotMeetings('/nope', { list: () => { throw new Error('ENOENT') } })).toEqual({ saved: {}, others: {} })
    const skipped = snapshotMeetings('/m', {
      list: () => ['a.md', 'dir.md'],
      hash: (path) => {
        if (path.endsWith('dir.md')) throw new Error('EISDIR')
        return 'x'
      },
      size: () => 1
    })
    expect(Object.keys(skipped.saved)).toEqual(['a.md'])
  })
})

describe('diffSnapshots', () => {
  const a = { 'a.md': { sha256: '1' }, 'b.md': { sha256: '2' } }
  it('is identical for equal maps and ignores added files for the identity verdict', () => {
    expect(diffSnapshots(a, { ...a })).toEqual({ missing: [], added: [], changed: [], identical: true })
    const withNew = diffSnapshots(a, { ...a, 'c.md': { sha256: '3' } })
    expect(withNew.added).toEqual(['c.md'])
    expect(withNew.identical).toBe(true)
  })
  it('reports a missing file and a changed file as not identical', () => {
    const diff = diffSnapshots(a, { 'a.md': { sha256: 'changed' } })
    expect(diff).toMatchObject({ missing: ['b.md'], changed: ['a.md'], identical: false })
  })
})

describe('reportedVersions and judgeVersion', () => {
  it('collects only app.started and app.renderer.ready versions, deduplicated and sorted', () => {
    expect(
      reportedVersions([
        { event: 'app.started', version: '2.12.0' },
        { event: 'app.renderer.ready', version: '2.12.0' },
        { event: 'other', version: '9.9.9' },
        { event: 'app.started' }
      ])
    ).toEqual(['2.12.0'])
  })

  const base = { expected: '2.12.0', plistVersion: '2.12.0', ipcVersion: '2.12.0', auditVersions: ['2.12.0'], previousVersion: '1.9.7' }
  it('passes only when plist, IPC and audit all report the expected version and it differs from the previous build', () => {
    expect(judgeVersion(base)).toEqual({ ok: true, problems: [] })
  })
  it('names every disagreement', () => {
    expect(judgeVersion({ ...base, plistVersion: '1.9.7' }).problems.join()).toMatch(/Info\.plist/)
    expect(judgeVersion({ ...base, ipcVersion: null }).problems.join()).toMatch(/running app reported nothing/)
    expect(judgeVersion({ ...base, auditVersions: [] }).ok).toBe(false)
    expect(judgeVersion({ ...base, auditVersions: ['2.12.0', '1.9.7'] }).ok).toBe(false)
    expect(judgeVersion({ ...base, previousVersion: '2.12.0' }).problems.join()).toMatch(/nothing was upgraded/)
  })
})

describe('judgeSingleInstance', () => {
  const good = {
    second: { exited: true, code: 0, signal: null, ms: 900 },
    firstAlive: true,
    firstResponsive: true,
    crashRecords: 0
  }
  it('passes when the second instance exits 0 quickly and the first stays up and answers', () => {
    expect(judgeSingleInstance(good).ok).toBe(true)
  })
  it('fails for a lingering, signalled, non-zero or slow second instance', () => {
    expect(judgeSingleInstance({ ...good, second: { exited: false, code: null, signal: null, ms: 30_000 } }).problems.join()).toMatch(/still running/)
    expect(judgeSingleInstance({ ...good, second: { exited: true, code: null, signal: 'SIGSEGV', ms: 100 } }).problems.join()).toMatch(/SIGSEGV/)
    expect(judgeSingleInstance({ ...good, second: { exited: true, code: 1, signal: null, ms: 100 } }).ok).toBe(false)
    expect(judgeSingleInstance({ ...good, second: { exited: true, code: 0, signal: null, ms: 20_000 } }, 15_000).ok).toBe(false)
  })
  it('fails when the first instance died, hung or recorded a crash', () => {
    expect(judgeSingleInstance({ ...good, firstAlive: false }).problems.join()).toMatch(/no longer running/)
    expect(judgeSingleInstance({ ...good, firstResponsive: false }).problems.join()).toMatch(/did not answer/)
    expect(judgeSingleInstance({ ...good, crashRecords: 1 }).ok).toBe(false)
  })
})

describe('judgeRollback', () => {
  const clean = { launched: true, launchError: null, crashed: false, integrity: { missing: [], changed: [] }, listedAll: true, readableAll: true }
  it('passes when the older build starts and lists and reads every meeting', () => {
    expect(judgeRollback(clean)).toEqual({ status: 'PASS', outcome: 'starts-and-lists' })
  })
  it('records a safe refusal and a partial listing as gaps, never as a pass', () => {
    expect(judgeRollback({ ...clean, launched: false, launchError: 'no app.renderer.ready' })).toMatchObject({ status: 'NOT_SUPPORTED', outcome: 'refused-safely' })
    expect(judgeRollback({ ...clean, readableAll: false })).toMatchObject({ status: 'NOT_SUPPORTED', outcome: 'starts-lists-partly' })
  })
  it('fails on a crash, and on any changed or missing meeting even when the app started', () => {
    expect(judgeRollback({ ...clean, launched: false, crashed: true, launchError: 'app.crash' }).status).toBe('FAIL')
    expect(judgeRollback({ ...clean, integrity: { missing: ['a.md'], changed: [] } })).toMatchObject({ status: 'FAIL', outcome: 'data-damaged' })
    expect(judgeRollback({ ...clean, launched: false, integrity: { missing: [], changed: ['a.md'] } }).status).toBe('FAIL')
  })
})

describe('small helpers', () => {
  it('counts audit events by name only', () => {
    expect(eventCounts([{ event: 'a' }, { event: 'a', secret: 'x' }, { event: 'b' }, {}])).toEqual({ a: 2, b: 1 })
  })
  it('treats a child that already exited as not running without signalling it', () => {
    expect(isRunning({ exitCode: 0, signalCode: null, pid: 1 } as never)).toBe(false)
    expect(isRunning({ exitCode: null, signalCode: 'SIGKILL', pid: 1 } as never)).toBe(false)
    expect(isRunning({ exitCode: null, signalCode: null, pid: process.pid } as never)).toBe(true)
  })
  it('lists the scenario steps once each, ending with the legacy-migration gap', () => {
    expect(new Set(UPGRADE_STEPS).size).toBe(UPGRADE_STEPS.length)
    expect(UPGRADE_STEPS[0]).toBe('install-previous')
    expect(UPGRADE_STEPS.at(-1)).toBe('legacy-profile-migration')
    expect(Object.keys(UPGRADE_SETTINGS_PATCH)).toEqual(['askFollowUpMemory'])
  })
})
