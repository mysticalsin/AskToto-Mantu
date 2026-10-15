import type { ImportAsrAttemptGuard, ImportAsrMemorySnapshot } from './import-job-types'

export type {
  ImportAsrAttemptGuard,
  ImportAsrDecodeAdmission,
  ImportAsrLanguageProbe,
  ImportAsrMemorySnapshot,
  ImportAsrTranscriber
} from './import-job-types'

export interface ImportAsrAdmissionJob {
  jobId: string
}

export interface ImportAsrAdmissionLease {
  settings: { asrEngine: string; asrLanguage: string }
  assertCurrent(): void
}
export interface ImportAsrAdmissionDependencies {
  captureAdmission(): ImportAsrAdmissionLease | Promise<ImportAsrAdmissionLease>
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
  const assertLeaseCurrent = (stillCurrent: ImportAsrAttemptGuard, lease: ImportAsrAdmissionLease): void => {
    if (!stillCurrent()) throw new Error('Import ASR attempt is no longer current.')
    lease.assertCurrent()
    if (!stillCurrent()) throw new Error('Import ASR attempt is no longer current.')
  }

  const admit = async (
    stillCurrent: ImportAsrAttemptGuard,
    expected?: { asrEngine: string; asrLanguage: string },
    previous?: ImportAsrAdmissionLease
  ): Promise<ImportAsrAdmissionLease> => {
    if (!stillCurrent()) throw new Error('Import ASR attempt is no longer current.')
    if (previous) assertLeaseCurrent(stillCurrent, previous)
    const lease = await deps.captureAdmission()
    // A forced authority read can suspend. Recheck the operation's original lease after that await so
    // an allowed A→B→A transition cannot mint a replacement lease for stale decoder work.
    if (previous) assertLeaseCurrent(stillCurrent, previous)
    assertLeaseCurrent(stillCurrent, lease)
    if (
      expected &&
      (lease.settings.asrEngine !== expected.asrEngine || lease.settings.asrLanguage !== expected.asrLanguage)
    ) {
      throw new Error('Import ASR settings changed during this attempt.')
    }
    return lease
  }

  return {
    async onDecodeAdmission(
      _job: ImportAsrAdmissionJob,
      memory: ImportAsrMemorySnapshot,
      stillCurrent: ImportAsrAttemptGuard = () => true
    ): Promise<boolean> {
      const lease = await admit(stillCurrent)
      const { settings } = lease
      let currentLease = lease
      let highTierVerified = false
      if (
        settings.asrEngine !== 'parakeet' &&
        deps.hasHighMemoryHeadroom(memory.totalMemoryBytes, memory.freeMemoryBytes)
      ) {
        try {
          assertLeaseCurrent(stillCurrent, lease)
          highTierVerified = await deps.isHighTierModelReady()
        } catch {
          // Unreadable optional files are indistinguishable from unavailable ones for admission purposes.
        }
        assertLeaseCurrent(stillCurrent, currentLease)
        const current = await admit(stillCurrent, settings, currentLease)
        currentLease = current
        assertLeaseCurrent(stillCurrent, current)
      }
      assertLeaseCurrent(stillCurrent, currentLease)
      const current = await admit(stillCurrent, settings, currentLease)
      currentLease = current
      assertLeaseCurrent(stillCurrent, current)
      await deps.setWhisperTierAdmission(memory.totalMemoryBytes, memory.freeMemoryBytes, highTierVerified)
      assertLeaseCurrent(stillCurrent, current)
      return highTierVerified
    },

    async transcribe(
      samples: Float32Array,
      opts?: { language?: string | null },
      stillCurrent: ImportAsrAttemptGuard = () => true
    ): Promise<string> {
      const lease = await admit(stillCurrent)
      const { settings } = lease
      const engine = settings.asrEngine
      if (engine === 'parakeet') {
        assertLeaseCurrent(stillCurrent, lease)
        await deps.ensureParakeetModel()
        assertLeaseCurrent(stillCurrent, lease)
        const current = await admit(stillCurrent, settings, lease)
        assertLeaseCurrent(stillCurrent, current)
        const text = await deps.parakeetTranscribe(samples)
        assertLeaseCurrent(stillCurrent, current)
        return text
      }

      const userPin = settings.asrLanguage
      const language = userPin !== 'auto' ? userPin : (opts?.language ?? 'auto')
      let currentLease = lease
      try {
        assertLeaseCurrent(stillCurrent, lease)
        const text = await deps.whisperImportTranscribe(samples, language, async (probeSamples) => {
          assertLeaseCurrent(stillCurrent, currentLease)
          const current = await admit(stillCurrent, settings, currentLease)
          currentLease = current
          assertLeaseCurrent(stillCurrent, current)
          await deps.ensureParakeetModel()
          assertLeaseCurrent(stillCurrent, current)
          const ready = await admit(stillCurrent, settings, current)
          currentLease = ready
          assertLeaseCurrent(stillCurrent, ready)
          const probeText = await deps.parakeetTranscribe(probeSamples)
          assertLeaseCurrent(stillCurrent, ready)
          return probeText
        })
        assertLeaseCurrent(stillCurrent, currentLease)
        return text
      } catch (error) {
        assertLeaseCurrent(stillCurrent, currentLease)
        const current = await admit(stillCurrent, settings, currentLease)
        currentLease = current
        assertLeaseCurrent(stillCurrent, current)
        if (deps.isAdmissionRefusal(error)) throw error
        const capability = await deps.capabilityState()
        assertLeaseCurrent(stillCurrent, current)
        if (capability !== 'available') throw error
        const fallback = await admit(stillCurrent, settings, current)
        assertLeaseCurrent(stillCurrent, fallback)
        // Full/local profiles retain the established Whisper-to-Parakeet fallback.
        await deps.ensureParakeetModel()
        assertLeaseCurrent(stillCurrent, fallback)
        const ready = await admit(stillCurrent, settings, fallback)
        assertLeaseCurrent(stillCurrent, ready)
        const text = await deps.parakeetTranscribe(samples)
        assertLeaseCurrent(stillCurrent, ready)
        return text
      }
    },

    async probeLanguageName(
      samples: Float32Array,
      stillCurrent: ImportAsrAttemptGuard = () => true
    ): Promise<string | null> {
      try {
        const lease = await admit(stillCurrent)
        const capability = await deps.capabilityState()
        assertLeaseCurrent(stillCurrent, lease)
        if (capability !== 'available') return null
        const current = await admit(stillCurrent, lease.settings, lease)
        assertLeaseCurrent(stillCurrent, current)
        await deps.ensureParakeetModel()
        assertLeaseCurrent(stillCurrent, current)
        const ready = await admit(stillCurrent, lease.settings, current)
        assertLeaseCurrent(stillCurrent, ready)
        const text = await deps.parakeetTranscribe(samples)
        assertLeaseCurrent(stillCurrent, ready)
        if (text.trim().split(/\s+/).filter(Boolean).length < 4) return null
        return deps.detectImportLanguage(text)
      } catch (error) {
        if (deps.isAdmissionRefusal(error) || !stillCurrent()) throw error
        return null
      }
    }
  }
}
