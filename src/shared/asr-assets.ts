export interface ImportAssetsProgress {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  progress: number
  label: string
  error?: string
}

/** Onboarding / Settings snapshot of Parakeet + Whisper-floor readiness. */
export interface AsrAssetsStatus extends ImportAssetsProgress {
  ready: boolean
  reason?: 'lean-pack-not-installed' | 'invalid-profile'
}
