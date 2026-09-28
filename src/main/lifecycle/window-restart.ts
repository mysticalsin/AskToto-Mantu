export interface WindowRestartCaptureState {
  listeningActive: boolean
  audioArmed: boolean
  legacyListeningActive: boolean
  cloudSttActive: boolean
}

export function captureActiveForWindowRestart(state: WindowRestartCaptureState): boolean {
  return state.listeningActive || state.audioArmed || state.legacyListeningActive || state.cloudSttActive
}
