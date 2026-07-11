/**
 * local-prewarm.test.ts — proves PLAN.md §4.4's pre-warm path (Rock 5): the local:prewarm payload schema
 * (shared/ipc.ts), the handler's settings gate (local-routing.ts's localPrewarmEligible), and the
 * start-ensure wiring the handler shares with a real ask (local.ts's ensureLocalRuntimeStarted). index.ts's
 * IPC handler itself has no test harness (no index.test.ts anywhere in this repo — see
 * local-routing.test.ts's doc comment for the same reasoning), so the "handler-gating" cases below compose
 * the handler's exact body from these exported, tested primitives rather than importing index.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SETTINGS, LocalPrewarmPayloadSchema, type Settings } from '@shared/ipc'
import { buildPrewarmMessages } from './prewarm'

// ─── LocalPrewarmPayloadSchema (shared/ipc.ts) ─────────────────────────────────────────────────────────
describe('LocalPrewarmPayloadSchema', () => {
  it('accepts a realistic transcript-tail payload', () => {
    const r = LocalPrewarmPayloadSchema.safeParse({ text: 'THEM: what did the client say about pricing?' })
    expect(r.success).toBe(true)
  })

  it('accepts text right at the 24000-char cap', () => {
    const r = LocalPrewarmPayloadSchema.safeParse({ text: 'a'.repeat(24_000) })
    expect(r.success).toBe(true)
  })

  it('rejects text over the 24000-char cap (defense-in-depth against a compromised/malfunctioning renderer)', () => {
    const r = LocalPrewarmPayloadSchema.safeParse({ text: 'a'.repeat(24_001) })
    expect(r.success).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(LocalPrewarmPayloadSchema.safeParse({ text: '' }).success).toBe(false)
  })

  it('rejects a missing text field', () => {
    expect(LocalPrewarmPayloadSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a non-object payload (e.g. a compromised/malformed renderer message)', () => {
    expect(LocalPrewarmPayloadSchema.safeParse(null).success).toBe(false)
    expect(LocalPrewarmPayloadSchema.safeParse('hello').success).toBe(false)
    expect(LocalPrewarmPayloadSchema.safeParse(undefined).success).toBe(false)
  })

  it('rejects a wrong-typed text field', () => {
    expect(LocalPrewarmPayloadSchema.safeParse({ text: 12345 }).success).toBe(false)
  })
})

// ─── localPrewarmEligible (local-routing.ts) — the handler's settings gate ────────────────────────────
import { localPrewarmEligible } from './local-routing'

const settingsFor = (overrides: Partial<Settings['localLlm']> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  localLlm: {
    enabled: true,
    modelId: 'qwen3.5-2b',
    useFor: { suggest: true, summary: true, vision: true },
    ...overrides
  }
})

describe('localPrewarmEligible', () => {
  it('true when enabled and useFor.suggest is on, with no allowlist restriction', () => {
    expect(localPrewarmEligible(settingsFor(), null)).toBe(true)
  })

  it('false when localLlm is disabled, regardless of useFor.suggest', () => {
    expect(localPrewarmEligible(settingsFor({ enabled: false }), null)).toBe(false)
  })

  it('false when useFor.suggest is off, even though localLlm is enabled', () => {
    expect(localPrewarmEligible(settingsFor({ useFor: { suggest: false, summary: true, vision: true } }), null)).toBe(false)
  })

  it('is independent of useFor.summary/useFor.vision — only the suggest toggle gates prewarm', () => {
    expect(
      localPrewarmEligible(settingsFor({ useFor: { suggest: true, summary: false, vision: false } }), null)
    ).toBe(true)
  })

  // F6 hardening: the org allowlist gate.
  it('false when the org allowlist excludes "local", even though localLlm is fully enabled', () => {
    expect(localPrewarmEligible(settingsFor(), ['anthropic', 'openai'])).toBe(false)
  })

  it('true when the org allowlist explicitly includes "local"', () => {
    expect(localPrewarmEligible(settingsFor(), ['anthropic', 'local'])).toBe(true)
  })
})

// ─── ensureLocalRuntimeStarted (local.ts) — the handler's start-ensure wiring ──────────────────────────
const localRuntimeMock = vi.hoisted(() => ({
  isRunning: vi.fn(() => false),
  getState: vi.fn(() => 'stopped' as const),
  getActiveModelKey: vi.fn((): string | null => null),
  start: vi.fn(async () => {}),
  markActivity: vi.fn(),
  prewarm: vi.fn(),
  baseURL: vi.fn(() => 'http://127.0.0.1:54321/v1'),
  sessionKey: vi.fn(() => 'deadbeefsessionkeydeadbeefsessionkeydeadbeefsessionkeydeadbeef')
}))
vi.mock('./local-runtime', () => localRuntimeMock)

const localModelsMock = vi.hoisted(() => ({
  modelPaths: vi.fn((id: string) => ({
    dir: `/models/${id}`,
    gguf: `/models/${id}/model.gguf`,
    mmproj: `/models/${id}/mmproj.gguf`
  })),
  verifyIntegrity: vi.fn(async () => {})
}))
vi.mock('./local-models', () => localModelsMock)

vi.mock('./openai', () => ({ streamOpenAI: vi.fn(() => ({ abort: vi.fn() })) }))

import { ensureLocalRuntimeStarted } from './local'

beforeEach(() => {
  vi.clearAllMocks()
  localRuntimeMock.isRunning.mockReturnValue(false)
  localRuntimeMock.getState.mockReturnValue('stopped')
  localRuntimeMock.getActiveModelKey.mockReturnValue(null)
  localRuntimeMock.start.mockResolvedValue(undefined)
  localModelsMock.verifyIntegrity.mockResolvedValue(undefined)
})

describe('ensureLocalRuntimeStarted', () => {
  it('cold start (state stopped): verifies integrity BEFORE starting, then starts with the configured model’s manifest paths', async () => {
    const order: string[] = []
    localModelsMock.verifyIntegrity.mockImplementation(async () => {
      order.push('verify')
    })
    localRuntimeMock.start.mockImplementation(async () => {
      order.push('start')
    })
    await ensureLocalRuntimeStarted('qwen3.5-0.8b')
    expect(localModelsMock.verifyIntegrity).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localModelsMock.modelPaths).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localRuntimeMock.start).toHaveBeenCalledWith({
      gguf: '/models/qwen3.5-0.8b/model.gguf',
      mmproj: '/models/qwen3.5-0.8b/mmproj.gguf'
    })
    expect(order).toEqual(['verify', 'start'])
  })

  // F2 hardening: ensureLocalRuntimeStarted no longer early-returns on isRunning() — it ALWAYS delegates
  // to start(), which is now idempotent per-model (a no-op for the same model, a switch for a different
  // one). Skipping start() here would silently break a model switch requested while "running".
  it('F2: still calls start() (idempotently) when the runtime is already running — the no-op/switch decision belongs to start() now', async () => {
    localRuntimeMock.getState.mockReturnValue('running')
    await ensureLocalRuntimeStarted('qwen3.5-2b')
    expect(localRuntimeMock.start).toHaveBeenCalledWith({
      gguf: '/models/qwen3.5-2b/model.gguf',
      mmproj: '/models/qwen3.5-2b/mmproj.gguf'
    })
  })

  // F5 hardening: the integrity re-check only runs once per sidecar spawn (cold start), never on every
  // request against an already-running or already-starting sidecar SERVING THE SAME MODEL.
  it('F5: skips verifyIntegrity when already running the SAME model (a warm request)', async () => {
    localRuntimeMock.getState.mockReturnValue('running')
    localRuntimeMock.getActiveModelKey.mockReturnValue('/models/qwen3.5-2b/model.gguf')
    await ensureLocalRuntimeStarted('qwen3.5-2b')
    expect(localModelsMock.verifyIntegrity).not.toHaveBeenCalled()
  })

  it('F5: skips verifyIntegrity when already starting the SAME model', async () => {
    localRuntimeMock.getState.mockReturnValue('starting')
    localRuntimeMock.getActiveModelKey.mockReturnValue('/models/qwen3.5-2b/model.gguf')
    await ensureLocalRuntimeStarted('qwen3.5-2b')
    expect(localModelsMock.verifyIntegrity).not.toHaveBeenCalled()
    expect(localRuntimeMock.start).toHaveBeenCalled()
  })

  // G2 hardening: getState()==='stopped' alone only catches a cold start — a model SWITCH requested while
  // the runtime is already running/starting must ALSO re-verify, since it spawns a different, unverified
  // GGUF. getActiveModelKey() is what lets ensureLocalRuntimeStarted see that the requested model differs
  // from what's actually loaded, even though getState() stays 'running' throughout the switch.
  describe('G2: integrity re-verify on model switch', () => {
    it('switching models while RUNNING (active key differs from the requested model) re-verifies the NEW model even though state is not stopped', async () => {
      localRuntimeMock.getState.mockReturnValue('running')
      localRuntimeMock.getActiveModelKey.mockReturnValue('/models/qwen3.5-2b/model.gguf') // A is active
      await ensureLocalRuntimeStarted('qwen3.5-0.8b') // request switches to B
      expect(localModelsMock.verifyIntegrity).toHaveBeenCalledWith('qwen3.5-0.8b')
    })

    it('re-requesting the model that is ALREADY the active/running one does NOT re-verify — no redundant re-hash on warm same-model requests', async () => {
      localRuntimeMock.getState.mockReturnValue('running')
      localRuntimeMock.getActiveModelKey.mockReturnValue('/models/qwen3.5-2b/model.gguf') // A is active
      await ensureLocalRuntimeStarted('qwen3.5-2b') // request for the SAME model A
      expect(localModelsMock.verifyIntegrity).not.toHaveBeenCalled()
    })

    it('switching models while STARTING (active key differs) also re-verifies the newly requested model', async () => {
      localRuntimeMock.getState.mockReturnValue('starting')
      localRuntimeMock.getActiveModelKey.mockReturnValue('/models/qwen3.5-2b/model.gguf') // A is starting
      await ensureLocalRuntimeStarted('qwen3.5-0.8b') // request switches to B mid-start
      expect(localModelsMock.verifyIntegrity).toHaveBeenCalledWith('qwen3.5-0.8b')
    })
  })

  it('F5: a verifyIntegrity failure (corrupt file) propagates and start() is never called', async () => {
    localModelsMock.verifyIntegrity.mockRejectedValue(new Error('checksum mismatch'))
    await expect(ensureLocalRuntimeStarted('qwen3.5-0.8b')).rejects.toThrow('checksum mismatch')
    expect(localRuntimeMock.start).not.toHaveBeenCalled()
  })

  it('propagates a start failure (the caller — index.ts’s handler — is what must swallow it)', async () => {
    localRuntimeMock.start.mockRejectedValue(new Error('llama-server binary missing'))
    await expect(ensureLocalRuntimeStarted('qwen3.5-0.8b')).rejects.toThrow('llama-server binary missing')
  })
})

// ─── The handler's full body, composed from the primitives above ──────────────────────────────────────
// Mirrors index.ts's local:prewarm handler EXACTLY (assertMainWindow + zod parse are the only steps not
// reproduced here — assertMainWindow has its own IPC-sender-boundary test coverage via the existing
// import-decoder tests, and the zod parse is covered by the LocalPrewarmPayloadSchema suite above).
async function runPrewarmHandler(s: Settings, allowed: string[] | null, text: string): Promise<void> {
  if (!localPrewarmEligible(s, allowed)) return
  localRuntimeMock.markActivity()
  try {
    await ensureLocalRuntimeStarted(s.localLlm.modelId)
    localRuntimeMock.prewarm(buildPrewarmMessages(text, s))
  } catch {
    /* best-effort — the real handler catches + debug-logs; never throws to the renderer */
  }
}

describe('local:prewarm handler-gating (composed from the tested primitives above)', () => {
  it('disabled localLlm -> no prewarm call at all (not even markActivity)', async () => {
    await runPrewarmHandler(settingsFor({ enabled: false }), null, 'THEM: any transcript tail')
    expect(localRuntimeMock.markActivity).not.toHaveBeenCalled()
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })

  it('useFor.suggest off -> no prewarm call, even with localLlm enabled', async () => {
    await runPrewarmHandler(
      settingsFor({ useFor: { suggest: false, summary: true, vision: true } }),
      null,
      'THEM: any transcript tail'
    )
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })

  // F6 hardening: the allowlist gate, end to end through the composed handler.
  it('org allowlist excludes "local" -> no prewarm call at all, even with localLlm fully enabled', async () => {
    await runPrewarmHandler(settingsFor(), ['anthropic'], 'THEM: any transcript tail')
    expect(localRuntimeMock.markActivity).not.toHaveBeenCalled()
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })

  it('enabled + suggest-on -> ensures the runtime is started for the CONFIGURED model, then prewarms with the EXACT live-suggest prefix (F4)', async () => {
    const s = settingsFor({ modelId: 'qwen3.5-0.8b' })
    const clippedTail = 'THEM: '.padEnd(5990, 'x') + ' — what should I say next?'
    await runPrewarmHandler(s, null, clippedTail)
    expect(localRuntimeMock.markActivity).toHaveBeenCalledOnce()
    expect(localModelsMock.modelPaths).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localRuntimeMock.prewarm).toHaveBeenCalledWith(buildPrewarmMessages(clippedTail, s))
  })

  it('enabled + suggest-on + runtime already running -> still calls start() (F2 idempotency) and prewarms', async () => {
    localRuntimeMock.getState.mockReturnValue('running')
    const s = settingsFor()
    await runPrewarmHandler(s, null, 'THEM: hello')
    expect(localRuntimeMock.start).toHaveBeenCalled()
    expect(localRuntimeMock.prewarm).toHaveBeenCalledWith(buildPrewarmMessages('THEM: hello', s))
  })

  it('a start failure (missing binary/model) is swallowed — never throws, and prewarm is never called', async () => {
    localRuntimeMock.start.mockRejectedValue(new Error('llama-server binary missing'))
    await expect(runPrewarmHandler(settingsFor(), null, 'THEM: hello')).resolves.toBeUndefined()
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })

  it('a verifyIntegrity failure (cold start, corrupt file) is swallowed too — never throws, prewarm never called', async () => {
    localModelsMock.verifyIntegrity.mockRejectedValue(new Error('checksum mismatch'))
    await expect(runPrewarmHandler(settingsFor(), null, 'THEM: hello')).resolves.toBeUndefined()
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })
})
