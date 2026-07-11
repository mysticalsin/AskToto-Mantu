/**
 * local-prewarm.test.ts — proves PLAN.md §4.4's pre-warm path (Rock 5): the local:prewarm payload schema
 * (shared/ipc.ts), the handler's settings gate (local-routing.ts's localPrewarmEligible), and the
 * start-ensure wiring the handler shares with a real ask (local.ts's ensureLocalRuntimeStarted). index.ts's
 * IPC handler itself has no test harness (no index.test.ts anywhere in this repo — see
 * local-routing.test.ts's doc comment for the same reasoning), so the "handler-gating" cases below compose
 * the handler's exact body from these exported, tested primitives rather than importing index.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LocalPrewarmPayloadSchema } from '@shared/ipc'

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

type LocalLlmSettings = {
  localLlm: { enabled: boolean; modelId: string; useFor: { suggest: boolean; summary: boolean; vision: boolean } }
}
const settingsFor = (overrides: Partial<LocalLlmSettings['localLlm']> = {}): LocalLlmSettings => ({
  localLlm: {
    enabled: true,
    modelId: 'qwen3.5-2b',
    useFor: { suggest: true, summary: true, vision: true },
    ...overrides
  }
})

describe('localPrewarmEligible', () => {
  it('true when enabled and useFor.suggest is on', () => {
    expect(localPrewarmEligible(settingsFor())).toBe(true)
  })

  it('false when localLlm is disabled, regardless of useFor.suggest', () => {
    expect(localPrewarmEligible(settingsFor({ enabled: false }))).toBe(false)
  })

  it('false when useFor.suggest is off, even though localLlm is enabled', () => {
    expect(localPrewarmEligible(settingsFor({ useFor: { suggest: false, summary: true, vision: true } }))).toBe(false)
  })

  it('is independent of useFor.summary/useFor.vision — only the suggest toggle gates prewarm', () => {
    expect(
      localPrewarmEligible(settingsFor({ useFor: { suggest: true, summary: false, vision: false } }))
    ).toBe(true)
  })
})

// ─── ensureLocalRuntimeStarted (local.ts) — the handler's start-ensure wiring ──────────────────────────
const localRuntimeMock = vi.hoisted(() => ({
  isRunning: vi.fn(() => false),
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
  }))
}))
vi.mock('./local-models', () => localModelsMock)

vi.mock('./openai', () => ({ streamOpenAI: vi.fn(() => ({ abort: vi.fn() })) }))

import { ensureLocalRuntimeStarted } from './local'

beforeEach(() => {
  vi.clearAllMocks()
  localRuntimeMock.isRunning.mockReturnValue(false)
  localRuntimeMock.start.mockResolvedValue(undefined)
})

describe('ensureLocalRuntimeStarted', () => {
  it('starts the runtime with the configured model’s manifest paths when not already running', async () => {
    await ensureLocalRuntimeStarted('qwen3.5-0.8b')
    expect(localModelsMock.modelPaths).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localRuntimeMock.start).toHaveBeenCalledWith({
      gguf: '/models/qwen3.5-0.8b/model.gguf',
      mmproj: '/models/qwen3.5-0.8b/mmproj.gguf'
    })
  })

  it('skips start() entirely when the runtime is already running', async () => {
    localRuntimeMock.isRunning.mockReturnValue(true)
    await ensureLocalRuntimeStarted('qwen3.5-2b')
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
async function runPrewarmHandler(s: LocalLlmSettings, text: string): Promise<void> {
  if (!localPrewarmEligible(s)) return
  localRuntimeMock.markActivity()
  try {
    await ensureLocalRuntimeStarted(s.localLlm.modelId)
    localRuntimeMock.prewarm(text)
  } catch {
    /* best-effort — the real handler catches + debug-logs; never throws to the renderer */
  }
}

describe('local:prewarm handler-gating (composed from the tested primitives above)', () => {
  it('disabled localLlm -> no prewarm call at all (not even markActivity)', async () => {
    await runPrewarmHandler(settingsFor({ enabled: false }), 'THEM: any transcript tail')
    expect(localRuntimeMock.markActivity).not.toHaveBeenCalled()
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })

  it('useFor.suggest off -> no prewarm call, even with localLlm enabled', async () => {
    await runPrewarmHandler(
      settingsFor({ useFor: { suggest: false, summary: true, vision: true } }),
      'THEM: any transcript tail'
    )
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })

  it('enabled + suggest-on -> ensures the runtime is started for the CONFIGURED model, then prewarms with the exact (already renderer-clipped) text', async () => {
    const clippedTail = 'THEM: '.padEnd(5990, 'x') + ' — what should I say next?'
    await runPrewarmHandler(settingsFor({ modelId: 'qwen3.5-0.8b' }), clippedTail)
    expect(localRuntimeMock.markActivity).toHaveBeenCalledOnce()
    expect(localModelsMock.modelPaths).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localRuntimeMock.prewarm).toHaveBeenCalledWith(clippedTail)
  })

  it('enabled + suggest-on + runtime already running -> skips start(), still prewarms', async () => {
    localRuntimeMock.isRunning.mockReturnValue(true)
    await runPrewarmHandler(settingsFor(), 'THEM: hello')
    expect(localRuntimeMock.start).not.toHaveBeenCalled()
    expect(localRuntimeMock.prewarm).toHaveBeenCalledWith('THEM: hello')
  })

  it('a start failure (missing binary/model) is swallowed — never throws, and prewarm is never called', async () => {
    localRuntimeMock.start.mockRejectedValue(new Error('llama-server binary missing'))
    await expect(runPrewarmHandler(settingsFor(), 'THEM: hello')).resolves.toBeUndefined()
    expect(localRuntimeMock.prewarm).not.toHaveBeenCalled()
  })
})
