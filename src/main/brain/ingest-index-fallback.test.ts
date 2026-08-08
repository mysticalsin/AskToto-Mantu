import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { brainBackfillProgress, ingestFailureDetails, startBackfill, whenIndexWritesSettle } from './ingest'
import { readIndex } from './store'

vi.mock('electron')

// Faithful-but-disk-free stand-in for the real localBaseReady (main/llm/local-routing.ts): mirrors its
// two settings-driven checks (localLlm.enabled, the org allowlist) that this test suite actually
// exercises, while skipping the real function's binary-on-disk / model-downloaded checks, which no test
// environment here can satisfy. local-routing.test.ts already covers the real function's own logic —
// this suite is only responsible for proving ingest.ts's pickProviderCandidates() consults it correctly.
const localBaseReadyMock = vi.hoisted(() =>
  vi.fn((s: { localLlm: { enabled: boolean } }, allowed: string[] | null) => {
    if (!s.localLlm.enabled) return false
    if (allowed && !allowed.includes('local')) return false
    return true
  })
)
vi.mock('../llm/local-routing', () => ({ localBaseReady: localBaseReadyMock }))

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

/**
 * Meeting-index reliability fix: brain/ingest.ts's cloud failover waterfall (ingest-resilience.test.ts)
 * had nothing to fail over to when only one cloud provider was ever configured (the Cahê pilot's
 * single embedded Kimi key) — a down/unreachable/misconfigured sole provider meant the meeting simply
 * never got indexed. This suite covers the new `localLlm.fallback` last-resort candidate appended
 * to the END of pickProviderCandidates()'s cloud waterfall.
 */
describe('brain ingest — local last-resort index fallback', () => {
  let userData: string
  let meetingsFolder: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    })
  }

  const respondError = (message: string) => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => opts.handlers.onError(message))
    return { abort: () => {} }
  }
  const respondJson = (json = '{}') => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-index-fallback-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-index-fallback-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    // Same env-var sweep as ingest-resilience.test.ts / ingest-local.test.ts: a real provider key
    // exported in this shell (KIMI_API_KEY, NVIDIA_API_KEY, ...) must never leak an extra eligible
    // cloud candidate into these tests.
    for (const p of PROVIDER_IDS) clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({
      meetingsFolder,
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: true, summary: false, vision: true }, // summary OFF: exercise the cloud-waterfall branch, not the exclusive-local one
        fallback: true
      }
    })
    createStreamMock.mockReset()
    localBaseReadyMock.mockClear()
    localBaseReadyMock.mockImplementation((s: { localLlm: { enabled: boolean } }, allowed: string[] | null) => {
      if (!s.localLlm.enabled) return false
      if (allowed && !allowed.includes('local')) return false
      return true
    })
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('never contacts local when a cloud provider is configured and healthy (regression guard)', async () => {
    writeFileSync(join(meetingsFolder, 'cloud-healthy.md'), '---\ndate: 2026-01-01\n---\nAcme renewal call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['cloud-healthy.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('anthropic')
  })

  it('indexes via local when zero cloud providers are configured (the reported Cahê-pilot failure mode)', async () => {
    writeFileSync(join(meetingsFolder, 'no-cloud.md'), '---\ndate: 2026-01-02\n---\nAcme wants a renewal.', 'utf8')
    // Force zero cloud eligibility via a real allowlist rather than relying on "no setApiKey call was
    // made": store.ts's module-level _apiKeyCache is not guaranteed clear across a fresh mkdtempSync
    // profile (clearApiKey no-ops when the NEW profile's key file doesn't exist, so it never reaches the
    // cache-delete line) — a provider keyed by an EARLIER test in this same worker can otherwise leak in
    // as a false "configured" candidate. The allowlist check runs before the key check either way, so
    // this is robust regardless of cache state, and is itself a realistic policy shape.
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: ['local'] }), 'utf8')
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['no-cloud.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
  })

  it('fails over past an exhausted cloud waterfall onto local', async () => {
    writeFileSync(join(meetingsFolder, 'cloud-down.md'), '---\ndate: 2026-01-03\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    setApiKey('openai', 'fake-openai-key')
    createStreamMock
      .mockImplementationOnce(respondError('503 Service Unavailable'))
      .mockImplementationOnce(respondError('503 Service Unavailable'))
      .mockImplementationOnce(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['cloud-down.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(3)
    expect(createStreamMock.mock.calls.map((c) => c[0].providerId)).toEqual(['anthropic', 'openai', 'local'])
  })

  it('leaves legacy behavior unchanged when fallback is off — still throws with cloud exhausted', async () => {
    writeFileSync(join(meetingsFolder, 'fallback-off.md'), '---\ndate: 2026-01-04\n---\nAcme call.', 'utf8')
    // Deny-all allowlist guarantees zero cloud candidates regardless of any key leaked from an earlier
    // test's _apiKeyCache entry (see the comment in the zero-cloud test above) — the fallback is also
    // explicitly off, so this proves BOTH gates independently keep the pool empty.
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: [] }), 'utf8')
    setSettings({ localLlm: { ...getSettings().localLlm, fallback: false } })
    createStreamMock.mockImplementation(respondJson())

    // startBackfill's own hasUsableProvider() precheck (ingest.ts) bails out BEFORE ever queuing the
    // job when nothing is eligible — it does not queue-then-fail. The file is left pending (no
    // index.json record at all) for the next reconcile once a provider becomes available, exactly the
    // legacy "single Kimi key down" outcome this change must not alter when fallback is off.
    expect(startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['fallback-off.md']).toBeUndefined()
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('leaves the exclusive local-only mode (useFor.summary) completely unaffected by fallback', async () => {
    writeFileSync(join(meetingsFolder, 'exclusive-local.md'), '---\ndate: 2026-01-05\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key') // a healthy cloud provider IS configured...
    setSettings({
      localLlm: { ...getSettings().localLlm, useFor: { ...getSettings().localLlm.useFor, summary: true }, fallback: false }
    })
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    // ...yet local is the ONLY candidate, exactly as before this change — useFor.summary short-circuits
    // before pickProviderCandidates ever reaches the cloud waterfall or the new fallback line.
    expect(readIndex(getSettings()).ingested['exclusive-local.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
  })

  it('never falls back to local when localLlm.enabled is off, even with fallback on', async () => {
    writeFileSync(join(meetingsFolder, 'local-disabled.md'), '---\ndate: 2026-01-06\n---\nAcme call.', 'utf8')
    // Deny-all allowlist keeps cloud eligibility at zero regardless of any leaked key, isolating this
    // test to proving the ONE thing it's about: localLlm.enabled=false blocks the fallback even though
    // fallback is on and local would otherwise be reachable (localBaseReady's first check).
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: [] }), 'utf8')
    setSettings({ localLlm: { ...getSettings().localLlm, enabled: false, fallback: true } })
    createStreamMock.mockImplementation(respondJson())

    // Same graceful-defer contract as the fallback-off test above — nothing queued, nothing
    // attempted, the file waits for a real provider instead of failing loudly.
    expect(startBackfill()).toEqual({ queued: 0, deferred: 'no-provider' })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['local-disabled.md']).toBeUndefined()
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('respects a REAL org allowedProviders policy that excludes local — data-residency still enforced', async () => {
    writeFileSync(join(meetingsFolder, 'org-blocked.md'), '---\ndate: 2026-01-07\n---\nAcme call.', 'utf8')
    // A real per-user managed-config.json, at the exact path getAllowedProviders() reads
    // (join(app.getPath('userData'), 'managed-config.json')) — end-to-end, not mocked: an org that
    // pinned ["anthropic"] must fail local closed exactly like it already fails every other
    // non-approved cloud provider closed.
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: ['anthropic'] }), 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondError('503 Service Unavailable'))

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    const record = readIndex(getSettings()).ingested['org-blocked.md']
    expect(record?.ok).toBe(false)
    // anthropic is the ONLY eligible candidate throughout — local was excluded by policy before it could
    // ever become one, not merely last-and-unreached (the many-clouds test below covers ordering). Two
    // calls, not one: with a single-candidate pool exhausted on the first pass, extractMeeting's same-
    // provider "reminder" retry (ingest.ts's runWindow) re-walks the whole (still one-candidate) pool a
    // second time before giving up — the same doubling ingest-resilience.test.ts's "propagates the last
    // error..." case proves for a 2-provider pool (2 providers x 2 passes = 4 calls).
    expect(createStreamMock).toHaveBeenCalledTimes(2)
    expect(createStreamMock.mock.calls.every((c) => c[0].providerId === 'anthropic')).toBe(true)
  })

  it('keeps local strictly LAST regardless of how many cloud candidates are eligible', async () => {
    writeFileSync(join(meetingsFolder, 'many-clouds.md'), '---\ndate: 2026-01-08\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    setApiKey('openai', 'fake-openai-key')
    setApiKey('nvidia', 'fake-nvidia-key')
    createStreamMock
      .mockImplementationOnce(respondError('network error'))
      .mockImplementationOnce(respondError('network error'))
      .mockImplementationOnce(respondError('network error'))
      .mockImplementationOnce(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['many-clouds.md']?.ok).toBe(true)
    const order = createStreamMock.mock.calls.map((c) => c[0].providerId)
    expect(order.at(-1)).toBe('local')
    expect(order.indexOf('local')).toBe(order.length - 1)
  })

  it('redacts absolute paths out of per-file failure details before they reach the renderer', () => {
    // fs errors quote the full path (Windows username included); the ledger key already names the file,
    // so the embedded path is pure disclosure — a support-channel screenshot of the tooltip must not
    // leak the local directory layout. Pure-function check, no backfill needed.
    const details = ingestFailureDetails({
      version: 1,
      ingested: {
        'bad-meeting.md': {
          at: 2,
          ok: false,
          error: "ENOENT: no such file or directory, open 'C:\\Users\\Tony\\OneDrive\\Meetings\\bad-meeting.md'"
        },
        'mac-meeting.md': {
          at: 1,
          ok: false,
          error: 'EACCES: permission denied, open /Users/tony/Documents/meetings/mac-meeting.md'
        },
        'fine.md': { at: 3, ok: true }
      }
    } as never)
    expect(details).toHaveLength(2)
    expect(details[0].error).not.toContain('C:\\Users')
    expect(details[0].error).not.toContain('Tony')
    expect(details[0].error).toContain('ENOENT')
    expect(details[0].error).toContain('bad-meeting.md') // basename survives — still actionable
    expect(details[1].error).not.toContain('/Users/tony')
    expect(details[1].error).toContain('mac-meeting.md')
  })

  it('propagates the last error and records ok:false when local ALSO fails after cloud is exhausted', async () => {
    writeFileSync(join(meetingsFolder, 'everything-down.md'), '---\ndate: 2026-01-09\n---\nAcme call.', 'utf8')
    // Pin eligibility to exactly [anthropic, local] regardless of any key leaked from an earlier test —
    // see the zero-cloud test's comment on _apiKeyCache.
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: ['anthropic', 'local'] }), 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    // Every call transport-fails (a real 5xx-shaped message, so isIngestTransportFailure keeps engaging
    // the failover walk each time — an unrecognizable message like "crashed" would read as PERMANENT and
    // stop the walk after one hop, which is not what this test is proving).
    createStreamMock.mockImplementation(respondError('503 Service Unavailable'))

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    const record = readIndex(getSettings()).ingested['everything-down.md']
    expect(record?.ok).toBe(false)
    expect(record?.error).toContain('503')
    // 2 candidates x (first pass + same-provider-pinned reminder retry, which with no servedBy re-walks
    // the full unpinned pool) = 4 calls, alternating [anthropic, local, anthropic, local] — matching
    // ingest-resilience.test.ts's "propagates the last error..." shape for a 2-candidate pool.
    expect(createStreamMock.mock.calls.map((c) => c[0].providerId)).toEqual(['anthropic', 'local', 'anthropic', 'local'])
  })
})
