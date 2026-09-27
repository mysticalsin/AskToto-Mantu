import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandle, StreamHandlers, StreamOptions } from '../llm/shared'
import type { BackfillStartOptions } from './ingest'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import {
  brainBackfillProgress,
  enqueueIngest,
  requestBackfill,
  requestBackfillRun,
  resumeBackfillIfPending,
  startBackfill,
  whenIndexWritesSettle
} from './ingest'
import { readIndex, writeIndex, writeMeetingExtraction } from './store'
import { MeetingExtractionSchema } from '@shared/brain'
import {
  noteUserInput,
  resetMaintenanceGateForTests,
  settlePriorExit,
  startMaintenanceGate
} from '../infra/scheduler/maintenance'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
const auditLogMock = vi.hoisted(() => vi.fn())

vi.mock('../llm', () => ({ createStream: createStreamMock }))
vi.mock('../logger', async (orig) => ({ ...(await orig()), auditLog: auditLogMock }))

const userTrigger = { trigger: 'user' } as unknown as BackfillStartOptions

function heldStream(held: Array<() => void>): (opts: StreamOptions & { handlers: StreamHandlers }) => StreamHandle {
  return (opts) => {
    held.push(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => undefined }
  }
}

function okStream(): (opts: StreamOptions & { handlers: StreamHandlers }) => StreamHandle {
  return (opts) => {
    queueMicrotask(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => undefined }
  }
}

describe('M2-0033 maintenance gate for background ingest', () => {
  let userData: string
  let meetingsFolder: string
  let uptime: number
  let interactiveActive: boolean
  let scheduled: Array<{ run: () => void; ms: number }>
  let held: Array<() => void>

  const startGate = (prior: 'clean' | 'unclean' | undefined = 'clean') => {
    resetMaintenanceGateForTests()
    scheduled = []
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => interactiveActive,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    if (prior) settlePriorExit(prior)
  }

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    await whenIndexWritesSettle()
  }

  const writeMeeting = (name: string, body = name) => {
    writeFileSync(join(meetingsFolder, name), `---\ndate: 2026-01-01\n---\n${body}`, 'utf8')
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-m2-0033-gate-ud-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'metis-m2-0033-gate-meetings-'))
    uptime = 121_000
    interactiveActive = false
    scheduled = []
    held = []
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    for (const p of PROVIDER_IDS) clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(heldStream(held))
    auditLogMock.mockReset()
    startGate('clean')
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('EX-2: in the boot quiet period, resume and reconcile queue work but call no model; firing the quiet-period wake at 120 s starts it and audits window-open with uptimeMs >= 120000', async () => {
    uptime = 0
    startGate('clean')
    writeMeeting('quiet.md', 'quiet period work')
    await writeIndex(getSettings(), { ...readIndex(getSettings()), backfillRequested: true } as never)

    resumeBackfillIfPending()
    requestBackfill()
    expect(createStreamMock).not.toHaveBeenCalled()
    expect(scheduled[0]?.ms).toBe(120_000)

    uptime = 120_000
    scheduled[0].run()
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    held.splice(0).forEach((release) => release())
    await waitForIdle()
    expect(auditLogMock).toHaveBeenCalledWith('scheduler.job', expect.objectContaining({
      kind: 'model-work',
      outcome: 'window-open',
      uptimeMs: expect.any(Number)
    }))
    const event = auditLogMock.mock.calls.find(([eventName]) => eventName === 'scheduler.job')?.[1] as { uptimeMs?: number } | undefined
    expect(event?.uptimeMs).toBeGreaterThanOrEqual(120_000)
  })

  it('EX-2: after an unclean exit, nothing starts after 120 s until a deliberate input; a mouse move does not count, a mouseDown does', async () => {
    uptime = 121_000
    startGate('unclean')
    writeMeeting('unclean.md', 'unclean gate work')
    requestBackfill()
    expect(createStreamMock).not.toHaveBeenCalled()
    noteUserInput('mouseMove')
    expect(createStreamMock).not.toHaveBeenCalled()
    noteUserInput('mouseDown')
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  })

  it('EX-2: with no settlePriorExit the gate stays closed after 120 s (fail-closed)', () => {
    uptime = 121_000
    startGate(undefined)
    writeMeeting('unknown.md', 'unknown prior work')
    requestBackfill()
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('EX-2: automatic extraction runs one model call at a time (three held streams → one in flight), while a user Retry during the quiet period runs at once with full cloud concurrency', async () => {
    writeMeeting('one.md')
    writeMeeting('two.md')
    writeMeeting('three.md')
    requestBackfill()
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    expect(held).toHaveLength(1)
    held.shift()?.()
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalledTimes(2), { timeout: 10_000 })

    uptime = 0
    startGate('clean')
    createStreamMock.mockClear()
    held = []
    writeMeeting('retry-a.md')
    writeMeeting('retry-b.md')
    writeMeeting('retry-c.md')
    requestBackfillRun({ force: true, ...userTrigger })
    await vi.waitFor(() => expect(createStreamMock.mock.calls.length).toBeGreaterThan(1), { timeout: 10_000 })
  })

  it('EX-2: an active interactive local stream holds automatic extraction; once it ends, the next nudge (requestBackfill) starts it', async () => {
    interactiveActive = true
    writeMeeting('interactive.md')
    requestBackfill()
    expect(createStreamMock).not.toHaveBeenCalled()
    interactiveActive = false
    requestBackfill()
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  })

  it('EX-2: a user Retry during the quiet period promotes already-queued automatic jobs instead of leaving them waiting', async () => {
    uptime = 0
    startGate('clean')
    writeMeeting('promote.md')
    requestBackfill()
    expect(createStreamMock).not.toHaveBeenCalled()
    requestBackfillRun({ force: true, ...userTrigger })
    await vi.waitFor(() => expect(createStreamMock).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  })

  it('EX-2: live saves (enqueueIngest) and reconcile-strategy repairs are never held by the gate', async () => {
    uptime = 0
    startGate('clean')
    createStreamMock.mockImplementation(okStream())
    writeMeeting('live.md')
    await enqueueIngest(join(meetingsFolder, 'live.md'))
    await waitForIdle()
    expect(readIndex(getSettings()).ingested['live.md']?.ok).toBe(true)

    createStreamMock.mockClear()
    writeMeeting('repair.md')
    await writeMeetingExtraction(getSettings(), 'repair-md', MeetingExtractionSchema.parse({ title24: 'Repair synthetic extraction' }))
    startBackfill(undefined, { force: true } as BackfillStartOptions)
    await waitForIdle()
    expect(readIndex(getSettings()).ingested['repair.md']?.ok).toBe(true)
    expect(createStreamMock).not.toHaveBeenCalled()
  })
})
