import type { ImportJob } from './import-job-types'

export interface ImportAsrAdmissionJob {
  jobId: string
}

export interface ImportAsrMemorySnapshot {
  totalMemoryBytes: unknown
  freeMemoryBytes: unknown
}

export type ImportAsrAttemptGuard = () => boolean
export type ImportAsrTranscriber = (
  samples: Float32Array,
  opts?: { language?: string | null },
  stillCurrent?: ImportAsrAttemptGuard
) => Promise<string>
export type ImportAsrLanguageProbe = (
  samples: Float32Array,
  stillCurrent?: ImportAsrAttemptGuard
) => Promise<string | null>
export type ImportAsrDecodeAdmission = (
  job: ImportJob,
  memory: ImportAsrMemorySnapshot,
  stillCurrent?: ImportAsrAttemptGuard
) => void | Promise<void>
export interface ImportAsrAdmissionDependencies {
  currentSettings(): { asrEngine: string; asrLanguage: string } | Promise<{ asrEngine: string; asrLanguage: string }>
  assertAdmissionAllowed():
    | void
    | { asrEngine: string; asrLanguage: string }
    | Promise<void | { asrEngine: string; asrLanguage: string }>
  capabilityState():
    | 'available'
    | 'cloud-only-unsupported'
    | 'unavailable'
    | Promise<'available' | 'cloud-only-unsupported' | 'unavailable'>
  isAdmissionRefusal(error: unknown): boolean
  hasHighMemoryHeadroom(totalMemoryBytes: unknown, freeMemoryBytes: unknown): boolean
  isHighTierModelReady(): Promise<boolean>
  setWhisperTierAdmission(totalMemoryBytes: unknown, freeMemoryBytes: unknown, highTierVerified: boolean): Promise<void>
  ensureParakeetModel(): Promise<void>
  parakeetTranscribe(samples: Float32Array): Promise<string>
  whisperImportTranscribe(
    samples: Float32Array,
    language: string,
    probe?: (samples: Float32Array) => Promise<string | null>
  ): Promise<string>
  detectImportLanguage(text: string): string | null
}

/** Owns the awaited local-ASR admission points for queued imports. Every model start is bound to the
 * manager's live attempt as well as a fresh main-owned policy/capability observation. */
export function createImportAsrAdmission(deps: ImportAsrAdmissionDependencies) {
  const admit = async (stillCurrent: ImportAsrAttemptGuard): Promise<{ asrEngine: string; asrLanguage: string }> => {
    if (!stillCurrent()) throw new Error('Import ASR attempt is no longer current.')
    const admitted = await deps.assertAdmissionAllowed()
    if (!stillCurrent()) throw new Error('Import ASR attempt is no longer current.')
    return admitted ?? deps.currentSettings()
  }

  return {
    async onDecodeAdmission(
      _job: ImportAsrAdmissionJob,
      memory: ImportAsrMemorySnapshot,
      stillCurrent: ImportAsrAttemptGuard = () => true
    ): Promise<boolean> {
      const settings = await admit(stillCurrent)
      let highTierVerified = false
      if (
        settings.asrEngine !== 'parakeet' &&
        deps.hasHighMemoryHeadroom(memory.totalMemoryBytes, memory.freeMemoryBytes)
      ) {
        try {
          highTierVerified = await deps.isHighTierModelReady()
        } catch {
          // Unreadable optional files are indistinguishable from unavailable ones for admission purposes.
        }
        await admit(stillCurrent)
      }
      await deps.setWhisperTierAdmission(memory.totalMemoryBytes, memory.freeMemoryBytes, highTierVerified)
      await admit(stillCurrent)
      return highTierVerified
    },

    async transcribe(
      samples: Float32Array,
      opts?: { language?: string | null },
      stillCurrent: ImportAsrAttemptGuard = () => true
    ): Promise<string> {
      await admit(stillCurrent)
      const settings = await admit(stillCurrent)
      const engine = settings.asrEngine
      if (engine === 'parakeet') {
        await deps.ensureParakeetModel()
        await admit(stillCurrent)
        const text = await deps.parakeetTranscribe(samples)
        await admit(stillCurrent)
        return text
      }

      const userPin = settings.asrLanguage
      const language = userPin !== 'auto' ? userPin : (opts?.language ?? 'auto')
      try {
        const text = await deps.whisperImportTranscribe(samples, language, async (probeSamples) => {
          await admit(stillCurrent)
          await deps.ensureParakeetModel()
          await admit(stillCurrent)
          const probeText = await deps.parakeetTranscribe(probeSamples)
          await admit(stillCurrent)
          return probeText
        })
        await admit(stillCurrent)
        return text
      } catch (error) {
        await admit(stillCurrent)
        if (deps.isAdmissionRefusal(error) || (await deps.capabilityState()) !== 'available') throw error
        await admit(stillCurrent)
        // Full/local profiles retain the established Whisper-to-Parakeet fallback.
        await deps.ensureParakeetModel()
        await admit(stillCurrent)
        const text = await deps.parakeetTranscribe(samples)
        await admit(stillCurrent)
        return text
      }
    },

    async probeLanguageName(
      samples: Float32Array,
      stillCurrent: ImportAsrAttemptGuard = () => true
    ): Promise<string | null> {
      try {
        await admit(stillCurrent)
        if ((await deps.capabilityState()) !== 'available') return null
        await admit(stillCurrent)
        await deps.ensureParakeetModel()
        await admit(stillCurrent)
        const text = await deps.parakeetTranscribe(samples)
        await admit(stillCurrent)
        if (text.trim().split(/\s+/).filter(Boolean).length < 4) return null
        return deps.detectImportLanguage(text)
      } catch (error) {
        if (deps.isAdmissionRefusal(error) || !stillCurrent()) throw error
        return null
      }
    }
  }
}
