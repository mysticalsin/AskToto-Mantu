import type { RendererCrashContext, RendererCrashReport } from '@shared/ipc'

/** Record what App is rendering. Called from App's render body, before any effect can commit stale state. */
export function noteCrashContext(_context: RendererCrashContext): void {
  // Scaffolding: the real renderer crash context cache lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}

/** The ErrorBoundary's report: the error plus the last noted context. */
export function crashReport(
  _error: Error | null | undefined,
  _componentStack: string | null | undefined
): RendererCrashReport {
  // Scaffolding: the real renderer crash report builder lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
