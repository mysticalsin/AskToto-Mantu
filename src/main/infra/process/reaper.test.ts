import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapBootSidecars, readRegistryRecords, testOnly, type ProcessIdentity, type ReaperAdapters } from './reaper'
import { argsFingerprint, type SidecarRecord } from './registry'

const USER_DATA = '/profile'
const LLAMA = '/bundle/Resources/llama/mac/arm64/llama-server'
const FM = '/usr/bin/fm'
const MAIN: ProcessIdentity = {
  pid: 10,
  ppid: 1,
  osStartTime: '2026-09-27T10:00:00.000Z',
  exeRealpath: '/Applications/Metis.app/Contents/MacOS/Metis',
  args: []
}

function spawned(overrides: Partial<SidecarRecord> = {}): SidecarRecord {
  const args = ['-m', '/profile/local-llm/models/qwen/model.gguf']
  return {
    kind: 'spawned',
    sessionId: 's1',
    name: 'llama-server',
    pid: 42,
    pgid: 42,
    osStartTime: '2026-09-27T09:58:00.000Z',
    exeRealpath: LLAMA,
    argsFingerprint: argsFingerprint(args),
    recordedAt: '2026-09-27T09:58:01.000Z',
    ...overrides
  }
}

function proc(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid: 42,
    ppid: 1,
    pgid: 42,
    osStartTime: '2026-09-27T09:58:00.000Z',
    exeRealpath: LLAMA,
    args: ['-m', '/profile/local-llm/models/qwen/model.gguf'],
    ...overrides
  }
}

function adapters(opts: {
  records?: SidecarRecord[]
  live?: ProcessIdentity | null
  list?: ProcessIdentity[]
} = {}): ReaperAdapters & { killed: number[]; audits: Array<{ event: string; detail: Record<string, unknown> }> } {
  const killed: number[] = []
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = []
  return {
    killed,
    audits,
    readRegistryRecords: () => opts.records ?? [],
    processInfo: vi.fn(async () => opts.live ?? null),
    listProcesses: vi.fn(async () => opts.list ?? []),
    kill: vi.fn((pid: number) => {
      killed.push(pid)
    }),
    audit: vi.fn((event: 'sidecar.reaped' | 'sidecar.reap.skipped', detail: Record<string, unknown>) => {
      audits.push({ event, detail })
    }),
    logSkip: vi.fn()
  }
}

async function run(ad: ReaperAdapters): Promise<void> {
  await reapBootSidecars({
    userData: USER_DATA,
    currentMain: MAIN,
    llamaServerRealpath: LLAMA,
    adapters: ad
  })
}

describe('boot sidecar reaper', () => {
  it('REAP-1: skips a live PID whose OS start time differs from the registry entry', async () => {
    const ad = adapters({
      records: [spawned()],
      live: proc({ osStartTime: '2026-09-27T10:01:00.000Z' })
    })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'start-time-mismatch', pid: 42 })
    })
  })

  it('REAP-2: logs corrupt registry entries and never kills from them', async () => {
    const ad = adapters({ records: [{ ...spawned(), corrupt: true } as SidecarRecord & { corrupt: true }], live: proc() })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'corrupt-registry' })
    })
  })

  it('REAP-3: skips a reused PID whose executable realpath differs', async () => {
    const ad = adapters({ records: [spawned()], live: proc({ exeRealpath: '/other/bin/llama-server' }) })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'exe-mismatch', pid: 42 })
    })
  })

  it('skips a registered sidecar whose live argv no longer matches the recorded fingerprint', async () => {
    const ad = adapters({ records: [spawned()], live: proc({ args: ['-m', '/profile/local-llm/other/model.gguf'] }) })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'args-mismatch', pid: 42 })
    })
  })

  it('skips a registry entry when process info returns a different PID than the one looked up', async () => {
    const ad = adapters({ records: [spawned()], live: proc({ pid: 99 }) })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'pid-mismatch', pid: 42 })
    })
  })

  it('logs a process-info failure and still applies the legacy orphan rule to unregistered llama-server orphans', async () => {
    const ad = adapters({
      records: [spawned()],
      list: [proc({ pid: 74, osStartTime: '2026-09-27T09:00:00.000Z' })]
    })
    vi.mocked(ad.processInfo).mockRejectedValueOnce(new Error('proc table unavailable'))

    await run(ad)

    expect(ad.killed).toEqual([74])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'process-info-failed', pid: 42 })
    })
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reaped',
      detail: { name: 'llama-server', pid: 74, reason: 'legacy-orphan' }
    })
  })

  it('accepts helper argv that includes argv[0] before the recorded spawn arguments', async () => {
    const ad = adapters({ records: [spawned()], live: proc({ args: [LLAMA, '-m', '/profile/local-llm/models/qwen/model.gguf'] }) })

    await run(ad)

    expect(ad.killed).toEqual([42])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reaped',
      detail: { name: 'llama-server', pid: 42, reason: 'registry' }
    })
  })

  it('skips ambiguous registry entries for the same PID and never kills either record', async () => {
    const ad = adapters({
      records: [spawned(), spawned({ osStartTime: '2026-09-27T09:59:00.000Z' })],
      live: proc()
    })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'ambiguous-entry', pid: 42 })
    })
  })

  it('does not let the legacy orphan rule kill a PID already present in the registry', async () => {
    const ad = adapters({
      records: [spawned(), spawned({ osStartTime: '2026-09-27T09:59:00.000Z' })],
      live: proc(),
      list: [proc()]
    })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reap.skipped',
      detail: expect.objectContaining({ reason: 'ambiguous-entry', pid: 42 })
    })
  })

  it('REAP-4: never applies the legacy orphan rule to /usr/bin/fm', async () => {
    const ad = adapters({
      list: [
        proc({
          pid: 77,
          exeRealpath: FM,
          args: ['-m', '/profile/local-llm/models/qwen/model.gguf'],
          osStartTime: '2026-09-27T09:00:00.000Z'
        })
      ]
    })

    await run(ad)

    expect(ad.killed).toEqual([])
    expect(ad.audits).toEqual([])
  })

  it('REAP-5: reaps only a legacy llama-server orphan matching bundle exe, userData model args, ppid 1, and pre-main start', async () => {
    const ad = adapters({
      list: [
        proc({ pid: 70, ppid: 12, osStartTime: '2026-09-27T09:00:00.000Z' }),
        proc({ pid: 71, args: ['-m', '/elsewhere/local-llm/model.gguf'], osStartTime: '2026-09-27T09:00:00.000Z' }),
        proc({ pid: 72, exeRealpath: '/tmp/llama-server', osStartTime: '2026-09-27T09:00:00.000Z' }),
        proc({ pid: 73, osStartTime: '2026-09-27T10:30:00.000Z' }),
        proc({ pid: 74, osStartTime: '2026-09-27T09:00:00.000Z' })
      ]
    })

    await run(ad)

    expect(ad.killed).toEqual([74])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reaped',
      detail: { name: 'llama-server', pid: 74, reason: 'legacy-orphan' }
    })
  })

  it('REAP-5: compares legacy orphan start times as time values, not ISO strings', async () => {
    const ad = adapters({
      list: [
        proc({ pid: 80, osStartTime: '2026-09-27T10:00:00.100Z' }),
        proc({ pid: 81, osStartTime: '2026-09-27T09:59:59.999Z' })
      ]
    })

    await reapBootSidecars({
      userData: USER_DATA,
      currentMain: { ...MAIN, osStartTime: '2026-09-27T10:00:00Z' },
      llamaServerRealpath: LLAMA,
      adapters: ad
    })

    expect(ad.killed).toEqual([81])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reaped',
      detail: { name: 'llama-server', pid: 81, reason: 'legacy-orphan' }
    })
  })

  it('resolves no realpath for a 2,000-line ps listing that has no owned sidecar', async () => {
    const lines = Array.from(
      { length: 2_000 },
      (_, i) => `${1000 + i}     1  ${1000 + i} Sun Sep 27 09:00:00 2026     /usr/libexec/daemon-${i} --flag value`
    )
    const resolveRealpath = vi.fn(async (path: string) => path)

    const out = await testOnly.parsePosixPsListing(lines.join('\n'), testOnly.isOwnedProcessName, resolveRealpath)

    expect(out).toEqual([])
    expect(resolveRealpath).not.toHaveBeenCalled()
  })

  it('resolves only owned sidecar lines of a ps listing and keeps their identity', async () => {
    const lines = [
      '  501     1   501 Sun Sep 27 09:00:00 2026     /usr/libexec/unrelated --x',
      `   74     1    74 Sun Sep 27 09:00:00 2026     ${LLAMA} -m /profile/local-llm/models/qwen/model.gguf`,
      '  502     1   502 Sun Sep 27 09:00:00 2026     /usr/bin/other'
    ]
    const resolveRealpath = vi.fn(async (path: string) => path)

    const out = await testOnly.parsePosixPsListing(lines.join('\n'), testOnly.isOwnedProcessName, resolveRealpath)

    expect(resolveRealpath).toHaveBeenCalledTimes(1)
    expect(resolveRealpath).toHaveBeenCalledWith(LLAMA)
    expect(out).toEqual([
      {
        pid: 74,
        ppid: 1,
        pgid: 74,
        osStartTime: new Date('Sun Sep 27 09:00:00 2026').toISOString(),
        exeRealpath: LLAMA,
        args: [LLAMA, '-m', '/profile/local-llm/models/qwen/model.gguf']
      }
    ])
  })

  it('filters a full ps listing by owned names but resolves every line of an explicit pid lookup', () => {
    const full = testOnly.psCandidateFilter()
    expect(full(LLAMA)).toBe(true)
    expect(full('/usr/libexec/unrelated')).toBe(false)
    expect(testOnly.psCandidateFilter([])('/usr/libexec/unrelated')).toBe(false)
    const lookup = testOnly.psCandidateFilter([501])
    expect(lookup('/usr/libexec/unrelated')).toBe(true)
    expect(lookup(LLAMA)).toBe(true)
  })

  it('requires a provable absolute userData model path for the legacy orphan rule', () => {
    expect(testOnly.legacyArgsPointAtUserModel(['-m', 'local-llm/models/qwen/model.gguf'], '/profile/local-llm/')).toBe(false)
    expect(testOnly.legacyArgsPointAtUserModel(['-m', '/profile/local-llm/models/qwen/model.gguf'], '/profile/local-llm/')).toBe(true)
  })

  it('kills a registered sidecar only when PID, OS start time, and executable realpath all match', async () => {
    const ad = adapters({ records: [spawned()], live: proc() })

    await run(ad)

    expect(ad.killed).toEqual([42])
    expect(ad.audits).toContainEqual({
      event: 'sidecar.reaped',
      detail: { name: 'llama-server', pid: 42, reason: 'registry' }
    })
  })

  it('reads append-only registries in order, preserving the before-spawn intent and complete spawned identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-reaper-'))
    try {
      const runDir = join(root, 'run')
      mkdirSync(runDir)
      const args = ['-m', '/profile/local-llm/models/qwen/model.gguf']
      const spawnedRecord = spawned()
      writeFileSync(
        join(runDir, 'sidecars-s1.json'),
        [
          JSON.stringify({
            kind: 'intent',
            sessionId: 's1',
            name: 'llama-server',
            argsFingerprint: argsFingerprint(args),
            recordedAt: '2026-09-27T09:58:00.000Z'
          }),
          JSON.stringify(spawnedRecord)
        ].join('\n') + '\n'
      )

      const records = readRegistryRecords(runDir)

      expect(records).toEqual([
        expect.objectContaining({
          kind: 'intent',
          sessionId: 's1',
          name: 'llama-server',
          argsFingerprint: argsFingerprint(args)
        }),
        expect.objectContaining({
          kind: 'spawned',
          name: 'llama-server',
          pid: 42,
          pgid: 42,
          osStartTime: '2026-09-27T09:58:00.000Z',
          exeRealpath: LLAMA,
          argsFingerprint: argsFingerprint(args)
        })
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
