import { describe, expect, it, vi } from 'vitest'
import { createImportAsrAdmission } from './import-asr-admission'

function setup(overrides: Record<string, unknown> = {}) {
  const capability = { value: 'available' as 'available' | 'cloud-only-unsupported' | 'unavailable' }
  const allowed = { value: true }
  const deps = {
    currentSettings: () => ({ asrEngine: 'parakeet', asrLanguage: 'auto' }),
    assertAdmissionAllowed: () => {
      if (!allowed.value || capability.value !== 'available') throw new Error('admission refused')
    },
    capabilityState: () => capability.value,
    isAdmissionRefusal: (error: unknown) => error instanceof Error && error.message === 'admission refused',
    hasHighMemoryHeadroom: () => true,
    isHighTierModelReady: vi.fn(async () => true),
    setWhisperTierAdmission: vi.fn(async () => {}),
    ensureParakeetModel: vi.fn(async () => {}),
    parakeetTranscribe: vi.fn(async () => 'recognized words here'),
    whisperImportTranscribe: vi.fn(async () => 'recognized words here'),
    detectImportLanguage: vi.fn(() => 'en'),
    ...overrides
  }
  return { callbacks: createImportAsrAdmission(deps), deps, capability, allowed }
}

describe('queued import ASR admission', () => {
  it('rechecks policy after optional model readiness before admitting the decoder', async () => {
    let release!: (value: boolean) => void
    const ready = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const context = setup({ isHighTierModelReady: vi.fn(() => ready) })
    const admission = context.callbacks.onDecodeAdmission({} as never, {
      totalMemoryBytes: 16_000_000_000,
      freeMemoryBytes: 8_000_000_000
    })
    context.allowed.value = false
    release(true)

    await expect(admission).rejects.toThrow('admission refused')
    expect(context.deps.setWhisperTierAdmission).not.toHaveBeenCalled()
  })

  it('does not start native inference after its attempt is superseded during model readiness', async () => {
    let release!: () => void
    const modelReady = new Promise<void>((resolve) => {
      release = resolve
    })
    const context = setup({ ensureParakeetModel: vi.fn(() => modelReady) })
    let current = true
    const transcribing = context.callbacks.transcribe(new Float32Array(8), undefined, () => current)
    current = false
    release()

    await expect(transcribing).rejects.toThrow('no longer current')
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })

  it('does not use the legacy Parakeet fallback when the route becomes cloud-only', async () => {
    const context = setup({
      currentSettings: () => ({ asrEngine: 'whisper', asrLanguage: 'auto' }),
      whisperImportTranscribe: vi.fn(async () => {
        context.capability.value = 'cloud-only-unsupported'
        throw new Error('runtime unavailable')
      })
    })

    await expect(context.callbacks.transcribe(new Float32Array(8))).rejects.toThrow('runtime unavailable')
    expect(context.deps.ensureParakeetModel).not.toHaveBeenCalled()
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })

  it('does not warm a fallback model after the Whisper attempt becomes stale', async () => {
    let rejectWhisper!: (error: Error) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let current = true
    const context = setup({
      currentSettings: () => ({ asrEngine: 'whisper', asrLanguage: 'auto' }),
      whisperImportTranscribe: vi.fn(() => {
        markStarted()
        return new Promise<string>((_resolve, reject) => {
          rejectWhisper = reject
        })
      })
    })
    const attempt = context.callbacks.transcribe(new Float32Array(8), undefined, () => current)
    await started
    current = false
    rejectWhisper(new Error('Whisper failed'))

    await expect(attempt).rejects.toThrow('no longer current')
    expect(context.deps.ensureParakeetModel).not.toHaveBeenCalled()
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })
})
