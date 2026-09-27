import { describe, expect, it } from 'vitest'
import { isInside, ownedProcesses, parseProcessTable, roleCounts, survivors } from './owned-processes.mjs'

const ROOT = '/opt/smoke/Metis.app'

function pids(entries: { pid: number }[]): number[] {
  return entries.map((entry) => entry.pid).sort((a, b) => a - b)
}

describe('parseProcessTable (darwin)', () => {
  it('yields pid, ppid, a finite increasing startedMs, and the full executable path (spaces, parentheses) as the role', () => {
    const output = [
      '   501     1 Fri Sep 26 23:53:00 2026 /opt/smoke/Metis.app/Contents/MacOS/Metis',
      '   502   501 Fri Sep 26 23:53:01 2026 /opt/smoke/Metis.app/Contents/Frameworks/Metis Helper (Renderer).app/Contents/MacOS/Metis Helper (Renderer)'
    ].join('\n')

    const entries = parseProcessTable('darwin', output)

    expect(entries).toEqual([
      { pid: 501, ppid: 1, startedMs: expect.any(Number), exe: '/opt/smoke/Metis.app/Contents/MacOS/Metis', role: 'Metis' },
      {
        pid: 502,
        ppid: 501,
        startedMs: expect.any(Number),
        exe: '/opt/smoke/Metis.app/Contents/Frameworks/Metis Helper (Renderer).app/Contents/MacOS/Metis Helper (Renderer)',
        role: 'Metis Helper (Renderer)'
      }
    ])
    expect(Number.isFinite(entries[0].startedMs)).toBe(true)
    expect(entries[1].startedMs).toBeGreaterThan(entries[0].startedMs)
  })

  it('skips blank rows, rows lacking a start time, and rows with an unparseable date', () => {
    const output = [
      '',
      '   700     1 /opt/smoke/no-date-fields',
      '   701     1 Xxx Yyy 99 99:99:99 2026 /opt/smoke/unparseable-date',
      '   601     1 Fri Sep 26 23:53:00 2026 /opt/smoke/Metis.app/Contents/MacOS/Metis'
    ].join('\n')

    const entries = parseProcessTable('darwin', output)

    expect(pids(entries)).toEqual([601])
  })
})

describe('parseProcessTable (win32)', () => {
  it('parses a JSON array, keeps started, and never returns a cmd field', () => {
    const output = JSON.stringify([
      { pid: 100, ppid: 1, started: 1000, exe: 'C:\\smoke\\Metis.exe', cmd: '"C:\\smoke\\Metis.exe"' },
      {
        pid: 101,
        ppid: 100,
        started: 1001,
        exe: 'C:\\smoke\\Metis.exe',
        cmd: '"C:\\smoke\\Metis.exe" --type=renderer --field-trial-handle=1234'
      }
    ])

    const entries = parseProcessTable('win32', output)

    expect(entries).toEqual([
      { pid: 100, ppid: 1, startedMs: 1000, exe: 'C:\\smoke\\Metis.exe', role: 'Metis.exe' },
      { pid: 101, ppid: 100, startedMs: 1001, exe: 'C:\\smoke\\Metis.exe', role: 'Metis.exe (renderer)' }
    ])
    for (const entry of entries) expect('cmd' in entry).toBe(false)
  })

  it('parses a single JSON object (ConvertTo-Json drops the array for one row)', () => {
    const output = JSON.stringify({ pid: 100, ppid: 1, started: 1000, exe: 'C:\\smoke\\Metis.exe', cmd: null })

    const entries = parseProcessTable('win32', output)

    expect(entries).toEqual([{ pid: 100, ppid: 1, startedMs: 1000, exe: 'C:\\smoke\\Metis.exe', role: 'Metis.exe' }])
  })

  it('gives exe: null and role "unknown" for a protected process with no ExecutablePath', () => {
    const output = JSON.stringify({ pid: 4, ppid: 0, started: 0, exe: null, cmd: null })

    const entries = parseProcessTable('win32', output)

    expect(entries).toEqual([{ pid: 4, ppid: 0, startedMs: 0, exe: null, role: 'unknown' }])
  })
})

describe('isInside', () => {
  it('respects the path boundary: a sibling whose name extends the root is not inside it', () => {
    expect(isInside('/opt/smoke/Metis.app', '/opt/smoke/Metis.app-old/x', 'darwin')).toBe(false)
    expect(isInside('/opt/smoke/Metis.app', '/opt/smoke/Metis.app/Contents/MacOS/Metis', 'darwin')).toBe(true)
  })

  it('treats the root itself as not inside', () => {
    expect(isInside('/opt/smoke/Metis.app', '/opt/smoke/Metis.app', 'darwin')).toBe(false)
  })

  it('does not misclassify a child directory whose name merely starts with ".."', () => {
    expect(isInside('/opt/smoke', '/opt/smoke/..foo/bar', 'darwin')).toBe(true)
  })

  it('is case-insensitive and accepts either separator on win32', () => {
    expect(isInside('d:/a/_temp/smoke', 'D:\\A\\_TEMP\\SMOKE\\metis.exe', 'win32')).toBe(true)
    expect(isInside('D:\\a\\_temp\\smoke', 'd:/a/_temp/smoke-other/metis.exe', 'win32')).toBe(false)
  })
})

describe('ownedProcesses', () => {
  // main and a descendant chain (child, grandchild) live outside the root on purpose here, so this
  // fixture can tell the descendant-walk rule apart from the root-residency rule below.
  const main = { pid: 100, ppid: 1, startedMs: 1000, exe: `${ROOT}/Contents/MacOS/Metis`, role: 'Metis' }
  const child = { pid: 101, ppid: 100, startedMs: 1001, exe: '/opt/elsewhere/helper', role: 'helper' }
  const grandchild = { pid: 102, ppid: 101, startedMs: 1002, exe: '/opt/elsewhere/helper', role: 'helper' }
  // The Crashpad shape: reparented to pid 1, never a descendant of main, but it lives under the root.
  const crashpad = {
    pid: 103,
    ppid: 1,
    startedMs: 1003,
    exe: `${ROOT}/Contents/Frameworks/chrome_crashpad_handler`,
    role: 'chrome_crashpad_handler'
  }
  // Same-named process, outside the root, not a descendant — never owned by name alone.
  const unrelatedLlamaServer = { pid: 200, ppid: 1, startedMs: 999, exe: '/usr/local/bin/llama-server', role: 'llama-server' }
  // Recorded parent id equals main's pid, but it started BEFORE main: pid reuse must not adopt it.
  const staleChild = { pid: 99, ppid: 100, startedMs: 500, exe: '/opt/elsewhere/stale', role: 'stale' }
  const table = [main, child, grandchild, crashpad, unrelatedLlamaServer, staleChild]

  it('includes main, a grandchild, and a root resident whose parent is pid 1, and excludes the unrelated same-named process and the pre-main stale child', () => {
    const owned = ownedProcesses(table, { mainPid: 100, installRoot: ROOT, platform: 'darwin' })

    expect(pids(owned)).toEqual([100, 101, 102, 103])
  })

  it('with mainPid: null, returns root residents only', () => {
    const owned = ownedProcesses(table, { mainPid: null, installRoot: ROOT, platform: 'darwin' })

    expect(pids(owned)).toEqual([100, 103])
  })
})

describe('survivors', () => {
  const installRoot = ROOT
  const platform = 'darwin'
  const owned = [
    { pid: 100, ppid: 1, startedMs: 1000, exe: `${ROOT}/Contents/MacOS/Metis`, role: 'Metis' },
    { pid: 101, ppid: 100, startedMs: 1001, exe: '/opt/elsewhere/helper', role: 'helper' }
  ]

  it('does not count a reused pid with a different start time, counts a still-present owned process, counts a new root resident, and ignores unrelated processes', () => {
    const table = [
      { pid: 100, ppid: 1, startedMs: 1000, exe: `${ROOT}/Contents/MacOS/Metis`, role: 'Metis' }, // still present
      { pid: 101, ppid: 1, startedMs: 9999, exe: '/opt/elsewhere/reused', role: 'reused' }, // pid reused, different start
      { pid: 105, ppid: 1, startedMs: 2000, exe: `${ROOT}/Contents/Frameworks/NewHelper`, role: 'NewHelper' }, // new under root
      { pid: 300, ppid: 1, startedMs: 1500, exe: '/usr/bin/unrelated', role: 'unrelated' } // unrelated
    ]

    const result = survivors(owned, table, { installRoot, platform })

    expect(pids(result)).toEqual([100, 105])
  })
})

describe('roleCounts', () => {
  it('counts entries per role with sorted keys', () => {
    const entries = [{ role: 'B' }, { role: 'A' }, { role: 'A' }, { role: 'C' }].map((r, i) => ({
      pid: i,
      ppid: 0,
      startedMs: 0,
      exe: null,
      ...r
    }))

    const counts = roleCounts(entries)

    expect(Object.keys(counts)).toEqual(['A', 'B', 'C'])
    expect(counts).toEqual({ A: 2, B: 1, C: 1 })
  })
})
