/**
 * Prefetch Act 2 chunks during Act 1 idle — without sync-importing OnboardingDemoScene
 * (which statically pulls Bar/QuickActions into the exclusive first-paint path).
 */
export function prefetchOnboardingDemoChunks(): void {
  void import('../components/Answer')
  void import('../components/Copilot')
  void import('../components/OnboardingDemoScene')
}
