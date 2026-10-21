import { useEffect, useRef } from 'react'

/**
 * Surfaces a best-quality ASR downgrade (listen.qualityDegraded — WebGPU/large model unavailable) to
 * Settings, mirroring the onEngineFallback → asrLastFallbackAt wiring. Patches exactly once per transition
 * to true — guarded by a ref (not the persisted field) so a user who dismisses the note in Settings
 * mid-session isn't immediately fought by this effect re-firing off the same still-true state; re-arms once
 * the flag clears so a later session's fresh downgrade notifies again.
 */
export function useWebgpuFallbackNote(
  qualityDegraded: boolean | undefined,
  patch: (p: { asrWebgpuFallbackAt: number }) => unknown
): void {
  const webgpuNotifiedRef = useRef(false)
  useEffect(() => {
    if (qualityDegraded) {
      if (!webgpuNotifiedRef.current) {
        webgpuNotifiedRef.current = true
        void patch({ asrWebgpuFallbackAt: Date.now() })
      }
    } else {
      webgpuNotifiedRef.current = false
    }
  }, [qualityDegraded, patch])
}
