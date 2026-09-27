import type { RendererCrashContext, RendererCrashReport } from '@shared/ipc'

let lastContext: RendererCrashContext | null = null

/** Record what App is rendering. Called from App's render body, not an effect: a render that throws never
 *  commits, so an effect would still hold the previous view — the wrong one when a view switch is what crashed. */
export function noteCrashContext(context: RendererCrashContext): void {
  lastContext = context
}

/** The ErrorBoundary's report: the error plus the last noted context (absent before App first renders). */
export function crashReport(
  error: Error | null | undefined,
  componentStack: string | null | undefined
): RendererCrashReport {
  return {
    ...(lastContext ?? {}),
    message: error?.message ?? 'Unknown renderer error',
    ...(error?.stack ? { stack: error.stack } : {}),
    ...(componentStack ? { componentStack } : {})
  }
}
