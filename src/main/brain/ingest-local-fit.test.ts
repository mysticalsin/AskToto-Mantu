import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandle, StreamHandlers, StreamOptions } from '../llm/shared'
import { clearApiKey, getSettings, setSettings } from '../store'
import { brainBackfillProgress, startBackfill } from './ingest'
import { readIndex } from './store'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { LOCAL_PREEMPTED_MESSAGE } from '../llm/local'

vi.mock('electron')

/** The 4,096-token slot the CPU profile gives llama-server: the machine state behind the reported bursts. */
const SLOT_TOKENS = 4096

vi.mock('../llm/local-routing', () => ({
  localBaseReady: () => true,
  resolveRoutingMode: (s: { routingMode?: string }) => s.routingMode ?? 'auto'
}))
vi.mock('../llm/local', async (orig) => ({
  ...(await orig<typeof import('../llm/local')>()),
  localSlotTokens: () => SLOT_TOKENS
}))
const auditLogMock = vi.hoisted(() => vi.fn())
vi.mock('../logger', async (orig) => ({ ...(await orig<typeof import('../logger')>()), auditLog: auditLogMock }))

/**
 * A stub llama-server with a 4,096-token slot. It admits a request only when the prompt (system, the
 * summary-mode user framing and the transcript at three characters per token, plus chat-template tokens)
 * and the reserved answer fit, and otherwise fails exactly as the real server does.
 */
const requests: Array<{ tokens: number }> = []
function promptTokens(opts: StreamOptions): number {
  const framing = 'Conversation transcript:\n\n"""\n\n"""\n\nSummarize it as instructed.'.length
  return Math.ceil((opts.system.length + framing + (opts.req.transcript ?? '').length) / 3) + 32
}
function slotModel(opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle {
  const tokens = promptTokens(opts) + (opts.maxOutputTokens ?? 0)
  requests.push({ tokens })
  queueMicrotask(() => {
    if (tokens > SLOT_TOKENS) {
      opts.handlers.onError(`request (${tokens} tokens) exceeds the available context size (${SLOT_TOKENS} tokens), try increasing it`)
      return
    }
    opts.handlers.onDelta('{}')
    opts.handlers.onDone({})
  })
  return { abort: () => {} }
}
const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

const failedIngests = (): number =>
  auditLogMock.mock.calls.filter(([event, detail]) => event === 'brain.ingest' && detail?.ok === false).length

describe('M2-0430: background extraction fits a 4,096-token local slot and never retries in a burst', () => {
  let userData: string
  let meetingsFolder: string

  const drain = async (): Promise<void> => {
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 10_000 })
    await settleBrainWritesForTests()
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-local-fit-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-local-fit-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    for (const provider of PROVIDER_IDS) clearApiKey(provider)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({
      meetingsFolder,
      provider: 'anthropic',
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-4b',
        useFor: { suggest: true, summary: true, vision: false },
        fallback: false
      }
    })
    requests.length = 0
    vi.clearAllMocks()
    createStreamMock.mockImplementation(slotModel)
  })

  afterEach(async () => {
    await settleBrainWritesForTests()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
  })

  it('chunks a meeting so every request fits the slot, and indexes it with no ok:false event', async () => {
    // About 7,000 characters: one 24,000-character window used to send ~5,900 tokens into a 4,096 slot.
    const lines = Array.from({ length: 90 }, (_, i) => `THEM: Synthetic line ${i} about the rollout plan and its owners.`)
    writeFileSync(join(meetingsFolder, 'long.md'), `---\ndate: 2026-09-29\n---\n${lines.join('\n')}`, 'utf8')

    expect(await startBackfill()).toEqual({ queued: 1 })
    await drain()

    expect(readIndex(getSettings()).ingested['long.md']?.ok).toBe(true)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((r) => r.tokens <= SLOT_TOKENS)).toBe(true)
    expect(failedIngests()).toBe(0)
  })

  it('records a meeting that cannot fit as exhausted, with no model call, and never retries it automatically', async () => {
    // One unbroken line: windows never split a line, so no window can fit the slot.
    writeFileSync(join(meetingsFolder, 'one-line.md'), `---\ndate: 2026-09-29\n---\nTHEM: ${'word '.repeat(4000)}`, 'utf8')

    expect(await startBackfill()).toEqual({ queued: 1 })
    await drain()

    const record = readIndex(getSettings()).ingested['one-line.md']
    expect(record).toMatchObject({ ok: false, exhausted: true, attempts: 1 })
    expect(createStreamMock).not.toHaveBeenCalled()
    expect(failedIngests()).toBe(1)

    // Every automatic trigger holds an exhausted source: no second ok:false, no model call.
    for (let i = 0; i < 3; i++) {
      expect(await startBackfill()).toEqual({ queued: 0 })
      await drain()
    }
    expect(createStreamMock).not.toHaveBeenCalled()
    expect(failedIngests()).toBe(1)
  })

  it('a context overflow the estimate missed is exhausted after ONE request, without the JSON-reminder retry', async () => {
    writeFileSync(join(meetingsFolder, 'dense.md'), '---\ndate: 2026-09-29\n---\nTHEM: Short synthetic meeting.', 'utf8')
    createStreamMock.mockImplementation((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
      requests.push({ tokens: SLOT_TOKENS + 1 })
      queueMicrotask(() => opts.handlers.onError('request (4097 tokens) exceeds the available context size (4096 tokens)'))
      return { abort: () => {} }
    })

    expect(await startBackfill()).toEqual({ queued: 1 })
    await drain()
    expect(await startBackfill()).toEqual({ queued: 0 })
    await drain()

    expect(readIndex(getSettings()).ingested['dense.md']).toMatchObject({ ok: false, exhausted: true })
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(failedIngests()).toBe(1)
  })

  it('marks the local extraction as background work and resends it after a recap pre-empts it, without a failure', async () => {
    writeFileSync(join(meetingsFolder, 'preempted.md'), '---\ndate: 2026-09-29\n---\nTHEM: Short synthetic meeting.', 'utf8')
    createStreamMock.mockImplementationOnce((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
      queueMicrotask(() => opts.handlers.onError(LOCAL_PREEMPTED_MESSAGE))
      return { abort: () => {} }
    })

    expect(await startBackfill()).toEqual({ queued: 1 })
    await drain()

    expect(readIndex(getSettings()).ingested['preempted.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(2)
    expect(createStreamMock.mock.calls.every(([opts]) => opts.background === true)).toBe(true)
    expect(failedIngests()).toBe(0)
  })
})
