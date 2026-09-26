import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('../../mac-helper', () => ({ macStatFlagsSpawnSpec: vi.fn() }))

import { auditLog, mainLog } from '../../logger'
import { macStatFlagsSpawnSpec } from '../../mac-helper'
import { WINDOWS_POWERSHELL } from '../../win-security'
import {
  presenceFromStFlags,
  presenceFromWinAttributes,
  presenceProbeFor,
  createDatalessDetector,
  type ContentPresence,
  type FileVersion,
  type PresenceProbe
} from './dataless'

afterEach(() => {
  vi.restoreAllMocks()
})

function fileVersion(path: string, overrides: Partial<Omit<FileVersion, 'path'>> = {}): FileVersion {
  return { path, mtimeMs: 1_000, ctimeMs: 1_000, size: 10, ...overrides }
}

// ---------------------------------------------------------------------------------------------------
// D1 / D2 — pure decoding
// ---------------------------------------------------------------------------------------------------

describe('presenceFromStFlags', () => {
  const table: Array<[number, ContentPresence]> = [
    [0, 'local'],
    [0x20, 'local'], // UF_COMPRESSED alone: an APFS-compressed LOCAL file, not dataless
    [0x8000, 'local'],
    [0x40000000, 'dataless'], // SF_DATALESS
    [0x40000020, 'dataless'] // SF_DATALESS + UF_COMPRESSED
  ]

  it.each(table)('flags 0x%s decodes to %s (SF_DATALESS marks cloud-only, UF_COMPRESSED alone is local)', (flags, expected) => {
    expect(presenceFromStFlags(flags)).toBe(expected)
  })

  it('a failed stat (null) is unknown', () => {
    expect(presenceFromStFlags(null)).toBe('unknown')
  })
})

describe('presenceFromWinAttributes', () => {
  const localAttrs = [0x20, 0x80, 0x80020, 0x100020] // ARCHIVE, NORMAL, PINNED-hydrated combos
  const datalessAttrs = [0x1000, 0x40000, 0x400000, 0x401420] // OFFLINE, RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS

  it.each(localAttrs)('attribute word 0x%s is local (archive/normal/pinned-but-hydrated)', (attrs) => {
    expect(presenceFromWinAttributes(attrs)).toBe('local')
  })

  it.each(datalessAttrs)('attribute word 0x%s marks a placeholder (dataless)', (attrs) => {
    expect(presenceFromWinAttributes(attrs)).toBe('dataless')
  })

  it('a failed query (null) is unknown', () => {
    expect(presenceFromWinAttributes(null)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------------------------------
// C1-C11 — createDatalessDetector, driven by a fake PresenceProbe (no real process spawned)
// ---------------------------------------------------------------------------------------------------

/** 'dataless' for names starting `dataless`, 'unknown' for names starting `gone`, else 'local'. */
function byName(path: string): ContentPresence {
  const base = path.split('/').pop() ?? path
  if (base.startsWith('gone')) return 'unknown'
  if (base.startsWith('dataless')) return 'dataless'
  return 'local'
}

describe('createDatalessDetector', () => {
  it('classifies a listing with one probe call covering every file and answers every path', async () => {
    const probe = vi.fn<PresenceProbe>(async (paths) => paths.map(byName))
    const detector = createDatalessDetector(probe)
    const files = [fileVersion('/a/local.md'), fileVersion('/a/dataless.md'), fileVersion('/a/gone.md')]

    const result = await detector.classify(files)

    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(['/a/local.md', '/a/dataless.md', '/a/gone.md'])
    expect(result.get('/a/local.md')).toBe('local')
    expect(result.get('/a/dataless.md')).toBe('dataless')
    expect(result.get('/a/gone.md')).toBe('unknown')
  })

  it('serves an unchanged file from cache without probing again', async () => {
    const probe = vi.fn<PresenceProbe>(async (paths) => paths.map(byName))
    const detector = createDatalessDetector(probe)
    const f = fileVersion('/a/local.md')

    await detector.classify([f])
    const result = await detector.classify([f])

    expect(probe).toHaveBeenCalledTimes(1)
    expect(result.get('/a/local.md')).toBe('local')
  })

  const versionChanges: Array<[string, Partial<Omit<FileVersion, 'path'>>]> = [
    ['mtimeMs', { mtimeMs: 2_000 }],
    ['ctimeMs', { ctimeMs: 2_000 }],
    ['size', { size: 20 }]
  ]

  it.each(versionChanges)('re-probes a file whose %s changed', async (_label, change) => {
    const probe = vi.fn<PresenceProbe>(async (paths) => paths.map(byName))
    const detector = createDatalessDetector(probe)
    const f = fileVersion('/a/local.md')

    await detector.classify([f])
    await detector.classify([{ ...f, ...change }])

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never probes an empty listing or a fully cached one', async () => {
    const probe = vi.fn<PresenceProbe>(async (paths) => paths.map(byName))
    const detector = createDatalessDetector(probe)

    expect(await detector.classify([])).toEqual(new Map())
    expect(probe).not.toHaveBeenCalled()

    const f = fileVersion('/a/local.md')
    await detector.classify([f])
    probe.mockClear()
    await detector.classify([f])
    expect(probe).not.toHaveBeenCalled()
  })

  it('never caches unknown: a file whose query failed is probed again on the next call', async () => {
    const probe = vi.fn<PresenceProbe>(async (paths) => paths.map(byName))
    const detector = createDatalessDetector(probe)
    const f = fileVersion('/a/gone.md')

    await detector.classify([f])
    await detector.classify([f])

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("a missing probe (null) answers unknown for every file and audits storage.dataless_probe_failed {reason:'unavailable', files}", async () => {
    const probe = vi.fn<PresenceProbe>(async () => null)
    const detector = createDatalessDetector(probe)

    const result = await detector.classify([fileVersion('/a/x.md'), fileVersion('/a/y.md')])

    expect([...result.values()]).toEqual(['unknown', 'unknown'])
    expect(auditLog).toHaveBeenCalledWith('storage.dataless_probe_failed', { reason: 'unavailable', files: 2 })
  })

  const failureCases: Array<[string, PresenceProbe]> = [
    [
      'rejects',
      async () => {
        throw new Error('boom')
      }
    ],
    ['answers the wrong count', async (paths) => paths.slice(0, -1).map((): ContentPresence => 'local')]
  ]

  it.each(failureCases)("a probe that %s answers unknown with reason 'failed'", async (_label, impl) => {
    const probe = vi.fn<PresenceProbe>(impl)
    const detector = createDatalessDetector(probe)

    const result = await detector.classify([fileVersion('/a/x.md')])

    expect([...result.values()]).toEqual(['unknown'])
    expect(auditLog).toHaveBeenCalledWith('storage.dataless_probe_failed', { reason: 'failed', files: 1 })
  })

  it('after a failure, misses stay unknown without a probe for 60s, then the probe is retried', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const probe = vi.fn<PresenceProbe>(async () => {
      throw new Error('boom')
    })
    const detector = createDatalessDetector(probe)

    await detector.classify([fileVersion('/a/x.md')])
    expect(probe).toHaveBeenCalledTimes(1)

    now += 59_000
    await detector.classify([fileVersion('/a/x.md')])
    expect(probe).toHaveBeenCalledTimes(1) // still inside the 60s retry window: no new probe

    now += 2_000 // total 61s since the failure
    await detector.classify([fileVersion('/a/x.md')])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('audits once per failure streak: fail, fail after the window (no new audit), success, fail => 2 audits total', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let shouldFail = true
    const probe = vi.fn<PresenceProbe>(async (paths) => {
      if (shouldFail) throw new Error('boom')
      return paths.map((): ContentPresence => 'local')
    })
    const detector = createDatalessDetector(probe)

    await detector.classify([fileVersion('/a/x.md')]) // fail -> audit #1
    now += 61_000
    await detector.classify([fileVersion('/a/x.md')]) // fail again, same streak -> no new audit
    shouldFail = false
    now += 61_000
    await detector.classify([fileVersion('/a/x.md')]) // success -> streak resolved
    shouldFail = true
    now += 61_000
    await detector.classify([fileVersion('/a/x.md')]) // fail -> audit #2

    const failureAudits = vi.mocked(auditLog).mock.calls.filter(([event]) => event === 'storage.dataless_probe_failed')
    expect(failureAudits).toHaveLength(2)
  })

  it('audit and log records are content-free', async () => {
    const secretPath = '/a/SECRET-MEETING-TITLE.md'

    const failingProbe = vi.fn<PresenceProbe>(async () => {
      throw new Error(secretPath)
    })
    await createDatalessDetector(failingProbe).classify([fileVersion(secretPath)])

    const okProbe = vi.fn<PresenceProbe>(async (paths) => paths.map((): ContentPresence => 'local'))
    await createDatalessDetector(okProbe).classify([fileVersion(secretPath)])

    const allCalls = [...vi.mocked(auditLog).mock.calls, ...vi.mocked(mainLog.warn).mock.calls, ...vi.mocked(mainLog.info).mock.calls]
    expect(allCalls.length).toBeGreaterThan(0)
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain('SECRET-MEETING-TITLE')
    }
  })

  it('does not retain an unbounded number of versions: after 50 000 distinct files the first is probed again', async () => {
    const probe = vi.fn<PresenceProbe>(async (paths) => paths.map((): ContentPresence => 'local'))
    const detector = createDatalessDetector(probe)
    const first = fileVersion('/a/file-0.md')

    await detector.classify([first])
    const many = Array.from({ length: 50_000 }, (_, i) => fileVersion(`/a/file-${i + 1}.md`))
    await detector.classify(many)

    probe.mockClear()
    await detector.classify([first])
    expect(probe).toHaveBeenCalledTimes(1) // evicted by the 10 000-entry bound, so re-probed
  })
})

// ---------------------------------------------------------------------------------------------------
// P1-P6 — the darwin wire protocol, driven by a stand-in helper (`node -e`) so it runs on every CI OS
// ---------------------------------------------------------------------------------------------------

/** Speaks the section-2 protocol: reads NUL-separated stdin paths, answers one word per basename. An
 *  unlisted basename answers null (a failed stat). If UTF-8 broke anywhere across the pipe, the
 *  non-ASCII name would miss this table and read back as `unknown`. */
const WORDS_BY_NAME =
  "{ 'local.md': 0, 'compressed.md': 32, 'dataless.md': 1073741824, 'compressed-dataless.md': 1073741856, " +
  "'Métis réunion.md': 1073741824 }"
const STAND_IN =
  `const words = ${WORDS_BY_NAME}\n` +
  `const paths = require('node:fs').readFileSync(0, 'utf8').split('\\0')\n` +
  `process.stdout.write(JSON.stringify(paths.map((p) => words[require('node:path').basename(p)] ?? null)))`

async function classifyWithDarwinProbe(paths: string[]): Promise<Map<string, ContentPresence>> {
  return createDatalessDetector(presenceProbeFor('darwin')).classify(paths.map((p) => fileVersion(p)))
}

describe('darwin wire protocol (stand-in helper)', () => {
  it("sends NUL-separated UTF-8 paths on stdin and decodes the helper's words", async () => {
    vi.mocked(macStatFlagsSpawnSpec).mockReturnValue({ command: process.execPath, args: ['-e', STAND_IN] })

    const result = await classifyWithDarwinProbe([
      '/x/local.md',
      '/x/compressed.md',
      '/x/dataless.md',
      '/x/compressed-dataless.md',
      '/x/Métis réunion.md',
      '/x/gone.md'
    ])

    expect([...result.values()]).toEqual(['local', 'local', 'dataless', 'dataless', 'dataless', 'unknown'])
  })

  const brokenHelpers: Array<[string, string]> = [
    ['exits non-zero', "require('node:fs').readFileSync(0); process.exit(1)"],
    ['prints garbage', "require('node:fs').readFileSync(0); process.stdout.write('not json')"],
    ['answers the wrong count', "require('node:fs').readFileSync(0); process.stdout.write(JSON.stringify([0]))"]
  ]

  it.each(brokenHelpers)('a helper that %s leaves every file unknown', async (_label, script) => {
    vi.mocked(macStatFlagsSpawnSpec).mockReturnValue({ command: process.execPath, args: ['-e', script] })

    const result = await classifyWithDarwinProbe(['/x/a.md', '/x/b.md'])

    expect([...result.values()]).toEqual(['unknown', 'unknown'])
  })

  it(
    'a helper that never answers is abandoned at the deadline and classify settles with unknown',
    async () => {
      vi.mocked(macStatFlagsSpawnSpec).mockReturnValue({
        command: process.execPath,
        args: ['-e', "require('node:fs').readFileSync(0); setInterval(() => {}, 1000)"]
      })

      const result = await classifyWithDarwinProbe(['/x/a.md'])

      expect([...result.values()]).toEqual(['unknown'])
    },
    15_000
  )

  it('a helper that exits without reading a large stdin raises no unhandled EPIPE', async () => {
    vi.mocked(macStatFlagsSpawnSpec).mockReturnValue({ command: process.execPath, args: ['-e', 'process.exit(0)'] })
    const bigPaths = Array.from({ length: 5_000 }, (_, i) => `/x/${'a'.repeat(90)}-${i}.md`)

    const result = await classifyWithDarwinProbe(bigPaths)

    expect([...result.values()].every((v) => v === 'unknown')).toBe(true)
  })

  it("a missing helper (no spawn spec) answers unknown and audits reason 'unavailable'", async () => {
    vi.mocked(macStatFlagsSpawnSpec).mockReturnValue(null)

    const result = await classifyWithDarwinProbe(['/x/a.md'])

    expect([...result.values()]).toEqual(['unknown'])
    expect(auditLog).toHaveBeenCalledWith('storage.dataless_probe_failed', { reason: 'unavailable', files: 1 })
  })

  it('other platforms: every file is local', async () => {
    const probe = presenceProbeFor('linux')
    const result = await probe(['/x/a.md', '/x/b.md'])
    expect(result).toEqual(['local', 'local'])
  })
})

// ---------------------------------------------------------------------------------------------------
// W1 — the real Windows PowerShell attribute probe (skipped off win32)
// ---------------------------------------------------------------------------------------------------

it.runIf(process.platform === 'win32')(
  'win32: one PowerShell query reports FILE_ATTRIBUTE_OFFLINE, keeps input order, decodes a non-ASCII path and answers unknown for a missing path',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dataless-'))
    const localFile = join(dir, 'local.md')
    const offlineFile = join(dir, 'offline.md')
    const unicodeFile = join(dir, "Métis réunion d'équipe.md")
    const missingFile = join(dir, 'gone.md')
    try {
      writeFileSync(localFile, 'local fixture')
      writeFileSync(offlineFile, 'offline fixture')
      writeFileSync(unicodeFile, 'unicode fixture')

      try {
        execFileSync('attrib', ['+O', offlineFile])
      } catch {
        execFileSync(
          WINDOWS_POWERSHELL,
          ['-NoProfile', '-NonInteractive', '-Command', '[IO.File]::SetAttributes($env:FIXTURE, [IO.FileAttributes]::Offline)'],
          { env: { ...process.env, FIXTURE: offlineFile } }
        )
      }

      const versionOf = (path: string): FileVersion => {
        try {
          const st = statSync(path)
          return { path, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size }
        } catch {
          return { path, mtimeMs: 0, ctimeMs: 0, size: 0 }
        }
      }
      const files = [localFile, offlineFile, unicodeFile, missingFile].map(versionOf)

      const detector = createDatalessDetector(presenceProbeFor('win32'))
      const result = await detector.classify(files)

      expect(result.get(localFile)).toBe('local')
      expect(result.get(offlineFile)).toBe('dataless')
      expect(result.get(unicodeFile)).toBe('local')
      expect(result.get(missingFile)).toBe('unknown')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
