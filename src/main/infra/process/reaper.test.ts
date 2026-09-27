import { describe, expect, it, vi } from 'vitest'
import { reapBootSidecars, testOnly, type ProcessIdentity, type ReaperAdapters } from './reaper'
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
})
