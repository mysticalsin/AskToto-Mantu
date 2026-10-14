export type RuntimeInstallFeature = 'offline-asr' | 'speaker-embedding' | 'local-llm'
export type RuntimeInstallModel =
  | 'asr.parakeet-tdt-0.6b-v3-int8'
  | 'asr.whisper-base-q8'
  | 'speaker.embedding'
  | 'qwen3.5-0.8b'
  | 'qwen3.5-4b'

export interface RuntimeInstallPlanPreview {
  readonly planId: string
  readonly feature: RuntimeInstallFeature
  readonly selectedModelId: RuntimeInstallModel | null
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly peakScratchBytes: number
  readonly expiresInMs: number
}

export type RuntimeInstallResponse =
  | { readonly ok: true; readonly generationIdentity: string; readonly installedBytes: number }
  | { readonly ok: false; readonly reason: 'not-configured' | 'stale-plan' | 'cancelled' | 'unavailable' }
  | { readonly cancelled: true }
