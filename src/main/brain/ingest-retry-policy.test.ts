import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { MeetingExtractionSchema } from '@shared/brain'
import type { StreamHandle, StreamHandlers, StreamOptions } from '../llm/shared'
import type { BackfillStartOptions } from './ingest'
import { MAX_INGEST_ATTEMPTS } from '../infra/scheduler/policy'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { brainBackfillProgress, reconcileMeetingsInBackground, requestBackfill, requestBackfillRun, resumeBackfillIfPending, startBackfill, whenIndexWritesSettle } from './ingest'
import { catchUpIntelligenceIndexIfNeeded } from './intelligence-index'
import { runConsolidationIfDue } from './consolidate'
import { brainDir, readIndex, writeIndex, writeMeetingExtraction } from './store'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
const auditLogMock = vi.hoisted(() => vi.fn())
const unreadablePaths = vi.hoisted(() => new Set<string>())

vi.mock('../llm', () => ({ createStream: createStreamMock }))
vi.mock('../logger', async (orig) => ({ ...(await orig()), auditLog: auditLogMock }))
vi.mock('../transcripts', async (orig) => {
  const actual = await orig<typeof import('../transcripts')>()
  return {
    ...actual,
    readSavedFile: (file: string) => {
      if (unreadablePaths.has(file)) {
        const error = new Error('synthetic cloud placeholder timeout') as NodeJS.ErrnoException
        error.code = 'ETIMEDOUT'
        throw error
      }
      return actual.readSavedFile(file)
    }
  }
})

type IngestModule = typeof import('./ingest')
type StoreModule = typeof import('../store')
type BrainStoreModule = typeof import('./store')

const userTrigger: BackfillStartOptions = { trigger: 'user' }

function respondJson(markerCalls: string[], json = '{}') {
  return (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    const prompt = JSON.stringify(opts.req)
    const marker = ['eligible', 'backedoff', 'exhausted', 'unreadable', 'unacked'].find((word) => prompt.includes(word))
    if (marker) markerCalls.push(marker)
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => undefined }
  }
}

function respondError(message: string, markerCalls: string[]) {
  return (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    const prompt = JSON.stringify(opts.req)
    const marker = ['eligible', 'backedoff', 'exhausted', 'unreadable', 'unacked'].find((word) => prompt.includes(word))
    if (marker) markerCalls.push(marker)
    queueMicrotask(() => opts.handlers.onError(message))
    return { abort: () => undefined }
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function foreignKeyIndexBytes(): Buffer {
  const marker = Buffer.from('ATKENC2\n', 'utf8')
  const env = {
    v: 2,
    iv: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    ct: randomBytes(64).toString('base64'),
    kLocal: 'F:' + randomBytes(72).toString('base64')
  }
  return Buffer.concat([marker, Buffer.from(JSON.stringify(env), 'utf8')])
}

describe('M2-0033 retry policy across backfill callers', () => {
  let userData: string
  let meetingsFolder: string
  let modelMarkers: string[]

  const waitForIdle = async (ingest: IngestModule = { brainBackfillProgress, whenIndexWritesSettle } as IngestModule): Promise<void> => {
    await vi.waitFor(() => {
      expect(ingest.brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    await ingest.whenIndexWritesSettle()
  }

  const configureSettings = (
    store: StoreModule = { clearApiKey, setApiKey, setSettings } as StoreModule,
    electronApp: typeof app = app
  ) => {
    ;(electronApp.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    for (const p of PROVIDER_IDS) store.clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    store.setSettings({ meetingsFolder })
    store.setApiKey('anthropic', 'fake-anthropic-key')
  }

  const seedFiles = () => {
    writeFileSync(join(meetingsFolder, 'eligible.md'), '---\ndate: 2026-01-01\n---\neligible transcript body', 'utf8')
    writeFileSync(join(meetingsFolder, 'backedoff.md'), '---\ndate: 2026-01-02\n---\nbackedoff transcript body', 'utf8')
    writeFileSync(join(meetingsFolder, 'exhausted.md'), '---\ndate: 2026-01-03\n---\nexhausted transcript body', 'utf8')
    writeFileSync(join(meetingsFolder, 'unreadable.md'), '---\ndate: 2026-01-04\n---\nunreadable transcript body', 'utf8')
    writeFileSync(join(meetingsFolder, 'unacked.md'), '---\ndate: 2026-01-05\n---\nunacked transcript body', 'utf8')
  }

  const sourceVersion = (name: string): string => {
    const st = statSync(join(meetingsFolder, name))
    return `${Math.round(st.mtimeMs)}:${st.size}`
  }

  const seedLedger = async (store: BrainStoreModule = { readIndex, writeIndex, writeMeetingExtraction } as BrainStoreModule) => {
    const now = Date.now()
    await store.writeMeetingExtraction(getSettings(), 'unacked-md', MeetingExtractionSchema.parse({ title24: 'Unacked synthetic extraction' }))
    await store.writeIndex(getSettings(), {
      ...store.readIndex(getSettings()),
      backfillRequested: true,
      ingested: {
        'backedoff.md': { at: now, ok: false, error: 'synthetic backed off', attempts: 2, retryAfter: now + 60 * 60_000, sourceVersion: sourceVersion('backedoff.md') },
        'exhausted.md': { at: now, ok: false, error: 'synthetic exhausted', attempts: MAX_INGEST_ATTEMPTS, exhausted: true, retryAfter: now - 1, sourceVersion: sourceVersion('exhausted.md') },
        'unreadable.md': { at: now, ok: false, error: 'synthetic unreadable', attempts: 1, unreadable: { changedAtMs: Math.round(statSync(join(meetingsFolder, 'unreadable.md')).ctimeMs) }, sourceVersion: sourceVersion('unreadable.md') }
      }
    } as never)
  }

  const relaunch = async () => {
    await whenIndexWritesSettle()
    vi.resetModules()
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    console.error(`[TEMP DEBUG ingest-retry-policy.relaunch] userData=${electron.app.getPath('userData')}`) // TEMP DEBUG — remove before finishing
    const ingest = await import('./ingest')
    const consolidate = await import('./consolidate')
    const intelligence = await import('./intelligence-index')
    const maintenance = await import('../infra/scheduler/maintenance')
    maintenance.resetMaintenanceGateForTests()
    maintenance.startMaintenanceGate({ uptimeMs: () => 121_000, schedule: (_run: () => void, _ms: number) => undefined, interactiveActive: () => false })
    maintenance.settlePriorExit('clean')
    ingest.resumeBackfillIfPending()
    ingest.reconcileMeetingsInBackground()
    await consolidate.runConsolidationIfDue()
    ingest.requestBackfill()
    await intelligence.catchUpIntelligenceIndexIfNeeded()
    await waitForIdle(ingest)
    return { ingest, store: await import('./store') }
  }

  beforeEach(async () => {
    userData = mkdtempSync(join(tmpdir(), 'metis-m2-0033-retry-ud-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'metis-m2-0033-retry-meetings-'))
    modelMarkers = []
    unreadablePaths.clear()
    configureSettings()
    seedFiles()
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondJson(modelMarkers))
    auditLogMock.mockReset()
    await seedLedger()
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('EX-1: three relaunches leave exhausted, backed-off and unreadable records byte-for-byte as seeded and never call a model for them', async () => {
    const seeded = {
      backedoff: readIndex(getSettings()).ingested['backedoff.md'],
      exhausted: readIndex(getSettings()).ingested['exhausted.md'],
      unreadable: readIndex(getSettings()).ingested['unreadable.md']
    }

    for (let i = 0; i < 3; i++) await relaunch()

    const idx = readIndex(getSettings())
    expect(idx.ingested['backedoff.md']).toEqual(seeded.backedoff)
    expect(idx.ingested['exhausted.md']).toEqual(seeded.exhausted)
    expect(idx.ingested['unreadable.md']).toEqual(seeded.unreadable)
    expect(modelMarkers).not.toContain('backedoff')
    expect(modelMarkers).not.toContain('exhausted')
    expect(modelMarkers).not.toContain('unreadable')
  })

  it('EX-1: an eligible source is extracted exactly once across three relaunches', async () => {
    for (let i = 0; i < 3; i++) await relaunch()
    expect(modelMarkers.filter((marker) => marker === 'eligible')).toHaveLength(1)
    expect(readIndex(getSettings()).ingested['eligible.md']?.ok).toBe(true)
  })

  it('EX-1: a completed-but-unacknowledged extraction is merged without any model call and is not repeated', async () => {
    for (let i = 0; i < 3; i++) await relaunch()
    expect(modelMarkers).not.toContain('unacked')
    expect(readIndex(getSettings()).ingested['unacked.md']?.ok).toBe(true)
  })

  it('EX-1: each automatic scan audits scheduler.job with heldExhausted, heldBackedOff and heldUnreadable counts and no file names', async () => {
    await relaunch()
    const scans = auditLogMock.mock.calls.filter(([event]) => event === 'scheduler.job').map(([, payload]) => payload)
    expect(scans).toContainEqual(expect.objectContaining({
      kind: 'backfill',
      trigger: 'automatic',
      outcome: 'scanned',
      heldExhausted: expect.any(Number),
      heldBackedOff: expect.any(Number),
      heldUnreadable: expect.any(Number)
    }))
    expect(JSON.stringify(scans)).not.toMatch(/backedoff\.md|exhausted\.md|unreadable\.md|eligible\.md|unacked\.md/)
  })

  it('EX-3: an explicit Retry (requestBackfillRun({ force: true, trigger: \'user\' })) revives an exhausted source; one more failure lands at attempts 1, not 7', async () => {
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondError('synthetic model failure', modelMarkers))
    const { completion } = requestBackfillRun({ force: true, ...userTrigger })
    await completion
    await waitForIdle()
    const record = readIndex(getSettings()).ingested['exhausted.md']
    expect(record?.attempts).toBe(1)
    expect(record?.exhausted).toBeFalsy()
  })

  it('EX-3: a transcript that cannot be read spends no attempt, is held by automatic scans while its ctime is unchanged, and is retried after the file changes', async () => {
    const file = join(meetingsFolder, 'unreadable.md')
    await writeIndex(getSettings(), {
      ...readIndex(getSettings()),
      ingested: {}
    } as never)
    unreadablePaths.add(file)
    expect(startBackfill(undefined, { force: true } as BackfillStartOptions).queued).toBe(5)
    await waitForIdle()
    const failed = readIndex(getSettings()).ingested['unreadable.md']
    expect(failed?.attempts).toBe(0)
    expect(failed?.retryAfter).toBeUndefined()
    expect(failed?.exhausted).toBeUndefined()
    expect((failed as typeof failed & { unreadable?: { changedAtMs?: number } })?.unreadable?.changedAtMs).toBe(Math.round(statSync(file).ctimeMs))

    createStreamMock.mockClear()
    expect(startBackfill().queued).toBe(0)
    expect(createStreamMock).not.toHaveBeenCalled()

    unreadablePaths.delete(file)
    writeFileSync(file, '---\ndate: 2026-01-04\n---\nunreadable transcript body hydrated', 'utf8')
    expect(startBackfill().queued).toBe(1)
    await waitForIdle()
    expect(readIndex(getSettings()).ingested['unreadable.md']?.ok).toBe(true)
  })

  it('EX-3: with a foreign-key index.json, reconcile, resume, consolidation and the catch-up start no model call, write nothing under .brain, and audit ledger_unavailable once per kind', async () => {
    const s = getSettings()
    const dir = brainDir(s)
    mkdirSync(dir, { recursive: true })
    const primary = join(dir, 'index.json')
    writeFileSync(primary, foreignKeyIndexBytes())
    const beforeIndex = sha256(readFileSync(primary))
    const beforeListing = existsSync(dir) ? readdirSync(dir).sort() : []

    resumeBackfillIfPending()
    reconcileMeetingsInBackground()
    await runConsolidationIfDue()
    await catchUpIntelligenceIndexIfNeeded()
    await waitForIdle()

    expect(createStreamMock).not.toHaveBeenCalled()
    expect(sha256(readFileSync(primary))).toBe(beforeIndex)
    expect(readdirSync(dir).sort()).toEqual(beforeListing)
    expect(auditLogMock.mock.calls).toEqual(expect.arrayContaining([
      ['scheduler.job', { kind: 'backfill', outcome: 'deferred', deferredReason: 'ledger_unavailable' }],
      ['scheduler.job', { kind: 'intelligence-index', outcome: 'deferred', deferredReason: 'ledger_unavailable' }]
    ]))
  })
})
