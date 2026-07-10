import React, { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import 'streamdown/styles.css'
import './styles.css'
import { App } from './App'

/** Stops a render throw from white-screening the always-on overlay; offers a one-click recover. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  // Surface the real fault: the on-screen card only shows error.message, but the stack + the React
  // component stack (which component threw) are what actually pin a render crash. console.error is
  // forwarded to the main-process log when ASKTOTO_DEBUG_RENDERER is set, so a field crash is diagnosable
  // without the renderer devtools open.
  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // eslint-disable-next-line no-console
    console.error('[error-boundary]', error?.message, '\nstack:', error?.stack, '\ncomponentStack:', info?.componentStack)
  }
  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="glass-strong m-1.5 flex flex-col items-center gap-3 rounded-2xl p-6 text-center">
        <div className="font-ui text-[14px] font-semibold text-[color:var(--color-ink)]">
          Métis hit a snag
        </div>
        <div className="max-w-[420px] text-[12px] text-[color:var(--color-ink-2)]">
          {this.state.error.message || 'Something went wrong rendering the overlay.'}
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="no-drag focus-ring rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
        >
          Reload
        </button>
      </div>
    )
  }
}

// Screenshot/dev aid: ?shotbg=dark paints a solid backdrop so the otherwise-transparent overlay
// is visible in a captured PNG (white-on-white is invisible). No-op in normal use.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('shotbg')) {
  const sb = new URLSearchParams(location.search).get('shotbg')
  document.documentElement.classList.add(sb === 'light' ? 'shot-bg-light' : 'shot-bg')
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
