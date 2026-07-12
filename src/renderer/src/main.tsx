import React, { Component, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import 'streamdown/styles.css'
import './styles.css'
import { App } from './App'
import { useAutoResize } from './state'

/**
 * The boundary's fallback replaces the ENTIRE App tree — including App's useAutoResize instance, the
 * only thing that sizes the transparent window. Without its own size reporting, this card renders
 * clipped inside whatever geometry the crash happened in: a crash while minimized left it inside the
 * ~170px control-pill window, showing an unreadable "Métis hit" sliver with the Reload button entirely
 * off-window. Claim a usable window instead: restore the full bar width (idempotent when not
 * minimized) and report the card's own height via the same hook App uses.
 */
function CrashCard({ message, onReload }: { message: string; onReload: () => void }): JSX.Element {
  const setRoot = useAutoResize()
  useEffect(() => {
    // Guarded: if the preload bridge itself is what broke, sizing is unfixable — still show the card.
    try {
      void window.toto.minimize(false)
    } catch {
      /* ignore */
    }
  }, [])
  return (
    // p-1.5 (not m-1.5 on the card): useAutoResize measures THIS element's rect, and a child margin
    // collapses out of it and gets clipped — padding is included. Same pattern as App's root.
    <div ref={setRoot} className="p-1.5">
      <div className="glass-strong flex flex-col items-center gap-3 rounded-2xl p-6 text-center">
        <div className="font-ui text-[14px] font-semibold text-[color:var(--color-ink)]">
          Métis hit a snag
        </div>
        <div className="max-w-[420px] text-[12px] text-[color:var(--color-ink-2)]">
          {message || 'Something went wrong rendering the overlay.'}
        </div>
        <button
          type="button"
          onClick={onReload}
          className="no-drag focus-ring rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
        >
          Reload
        </button>
      </div>
    </div>
  )
}

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
    return <CrashCard message={this.state.error.message} onReload={() => this.setState({ error: null })} />
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
