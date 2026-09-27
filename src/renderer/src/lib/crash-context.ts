import type { RendererCrashContext, RendererCrashReport } from '@shared/ipc'

const DEFAULT_CONTEXT: RendererCrashContext = { view: 'answer', listening: false }
let lastContext: RendererCrashContext = DEFAULT_CONTEXT

/** Record what App is rendering. Called from App's render body, not an effect: a render that throws never
 *  commits, so an effect would still hold the previous view — the wrong one when a view switch is what crashed. */
export function noteCrashContext(context: RendererCrashContext): void {
  lastContext = context
}

/** The ErrorBoundary's report: the error plus the last noted context, defaulted before App first renders. */
export function crashReport(
  error: Error | null | undefined,
  componentStack: string | null | undefined
): RendererCrashReport {
  return {
    ...lastContext,
    message: error?.message ?? 'Unknown renderer error',
    ...(error?.stack ? { stack: error.stack } : {}),
    ...(componentStack ? { componentStack } : {})
  }
}
