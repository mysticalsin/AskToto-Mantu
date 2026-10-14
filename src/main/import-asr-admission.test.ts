import { describe, expect, it, vi } from 'vitest'
import { createImportAsrAdmission } from './import-asr-admission'

function setup(
  overrides: Record<string, unknown> = {},
  route: { asrEngine: string; asrLanguage: string } = { asrEngine: 'parakeet', asrLanguage: 'auto' }
) {
  const capability = { value: 'available' as 'available' | 'cloud-only-unsupported' | 'unavailable' }
  const allowed = { value: true }
  const epoch = { value: 0 }
  const deps = {
    captureAdmission: () => {
      if (!allowed.value || capability.value !== 'available') throw new Error('admission refused')
      const captured = { ...route }
      const capturedEpoch = epoch.value
      return {
        settings: captured,
        assertCurrent: () => {
          if (
            !allowed.value ||
            capability.value !== 'available' ||
            epoch.value !== capturedEpoch ||
            route.asrEngine !== captured.asrEngine ||
            route.asrLanguage !== captured.asrLanguage
          ) {
            throw new Error('admission refused')
          }
        }
      }
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
  return { callbacks: createImportAsrAdmission(deps), deps, capability, allowed, epoch }
}

describe('queued import ASR admission', () => {
  it('rechecks policy after optional model readiness before admitting the decoder', async () => {
    let release!: (value: boolean) => void
    let markReadyEntered!: () => void
    const ready = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      markReadyEntered = resolve
    })
    const context = setup(
      {
        isHighTierModelReady: vi.fn(() => {
          markReadyEntered()
          return ready
        })
      },
      { asrEngine: 'whisper', asrLanguage: 'auto' }
    )
    const admission = context.callbacks.onDecodeAdmission({} as never, {
      totalMemoryBytes: 16_000_000_000,
      freeMemoryBytes: 8_000_000_000
    })
    await entered
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
    let markEnsureEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEnsureEntered = resolve
    })
    const context = setup({
      ensureParakeetModel: vi.fn(() => {
        markEnsureEntered()
        return modelReady
      })
    })
    let current = true
    const transcribing = context.callbacks.transcribe(new Float32Array(8), undefined, () => current)
    await entered
    current = false
    release()

    await expect(transcribing).rejects.toThrow('no longer current')
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })

  it('does not enter native inference after the captured settings epoch changes during readiness', async () => {
    let release!: () => void
    let markEntered!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const route = { asrEngine: 'parakeet', asrLanguage: 'auto' }
    const context = setup(
      {
        ensureParakeetModel: vi.fn(() => {
          markEntered()
          return ready
        })
      },
      route
    )
    const transcribing = context.callbacks.transcribe(new Float32Array(8))
    await entered
    route.asrEngine = 'whisper'
    release()

    await expect(transcribing).rejects.toThrow('admission refused')
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })

  it('does not mint a replacement lease after an epoch-only change during optional readiness', async () => {
    let release!: (value: boolean) => void
    let markEntered!: () => void
    const ready = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const context = setup(
      {
        isHighTierModelReady: vi.fn(() => {
          markEntered()
          return ready
        })
      },
      { asrEngine: 'whisper', asrLanguage: 'auto' }
    )
    const admission = context.callbacks.onDecodeAdmission({} as never, {
      totalMemoryBytes: 16_000_000_000,
      freeMemoryBytes: 8_000_000_000
    })
    await entered
    context.epoch.value += 2
    release(true)

    await expect(admission).rejects.toThrow('admission refused')
    expect(context.deps.setWhisperTierAdmission).not.toHaveBeenCalled()
  })

  it('does not use the legacy Parakeet fallback when the route becomes cloud-only', async () => {
    const context = setup(
      {
        whisperImportTranscribe: vi.fn(async () => {
          context.capability.value = 'cloud-only-unsupported'
          throw new Error('runtime unavailable')
        })
      },
      { asrEngine: 'whisper', asrLanguage: 'auto' }
    )

    await expect(context.callbacks.transcribe(new Float32Array(8))).rejects.toThrow('admission refused')
    expect(context.deps.ensureParakeetModel).not.toHaveBeenCalled()
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })

  it('keeps the established local Whisper-to-Parakeet fallback in an allowed local profile', async () => {
    const context = setup(
      {
        whisperImportTranscribe: vi.fn(async () => {
          throw new Error('local Whisper runtime unavailable')
        })
      },
      { asrEngine: 'whisper', asrLanguage: 'auto' }
    )

    await expect(context.callbacks.transcribe(new Float32Array(8))).resolves.toBe('recognized words here')
    expect(context.deps.ensureParakeetModel).toHaveBeenCalledOnce()
    expect(context.deps.parakeetTranscribe).toHaveBeenCalledOnce()
  })

  it('does not warm a fallback model after the Whisper attempt becomes stale', async () => {
    let rejectWhisper!: (error: Error) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let current = true
    const context = setup(
      {
        whisperImportTranscribe: vi.fn(() => {
          markStarted()
          return new Promise<string>((_resolve, reject) => {
            rejectWhisper = reject
          })
        })
      },
      { asrEngine: 'whisper', asrLanguage: 'auto' }
    )
    const attempt = context.callbacks.transcribe(new Float32Array(8), undefined, () => current)
    await started
    current = false
    rejectWhisper(new Error('Whisper failed'))

    await expect(attempt).rejects.toThrow('no longer current')
    expect(context.deps.ensureParakeetModel).not.toHaveBeenCalled()
    expect(context.deps.parakeetTranscribe).not.toHaveBeenCalled()
  })
})
