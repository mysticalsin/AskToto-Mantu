/**
 * Prefetch Act 2's heavyweight Answer/Copilot chunks during Act 1 idle.
 * The small DemoScene is loaded with onboarding so Continue opens it without a wait.
 */
export function prefetchOnboardingDemoChunks(): void {
  void import('../components/Answer')
  void import('../components/Copilot')
}
