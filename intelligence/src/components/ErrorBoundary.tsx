import { Component, type ReactNode } from 'react'

/**
 * Catches a render error in a single view so it degrades to an inline message instead of unmounting the
 * whole React tree to a blank screen (React 18 tears down the root on an uncaught render error). Wrap it
 * with a `key` that changes per route so switching tabs remounts it fresh and clears the error — the
 * NavBar lives outside the boundary, so navigation always still works.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    // Dev signal; in the packaged app this surfaces in the renderer console for support triage.
    console.error('[intelligence] view crashed:', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-xl px-6 py-16 text-center">
          <p className="text-sm text-rose-300">This view hit an error and couldn&rsquo;t render.</p>
          <p className="mt-2 break-words text-xs text-white/40 [overflow-wrap:anywhere]">
            {this.state.error.message}
          </p>
          <p className="mt-3 text-xs text-white/50">
            Switch tabs or reload — the rest of the dashboard is unaffected.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}
