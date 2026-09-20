export interface CompletedOnboardingExitFallbackState {
  sameOverlay: boolean
  overlayDestroyed: boolean
  onboardingLive: boolean
  overlayTransparent: boolean
  listeningActive: boolean
  audioArmed: boolean
  cloudSttActive: boolean
}

/** The recovery is safe only after the completed opaque setup window loses its renderer handoff. */
export function shouldRecoverCompletedOnboardingExit(state: CompletedOnboardingExitFallbackState): boolean {
  return (
    state.sameOverlay &&
    !state.overlayDestroyed &&
    !state.onboardingLive &&
    !state.overlayTransparent &&
    !state.listeningActive &&
    !state.audioArmed &&
    !state.cloudSttActive
  )
}
