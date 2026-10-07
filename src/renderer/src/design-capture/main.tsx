import React from 'react'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../tokens.css'
import './capture.css'
import { DesignIndex, DesignSurface } from './DesignSurface'
import { DESIGN_STATE_IDS, resolveDesignStateIncludingQa } from './states'

declare global {
  interface Window {
    /** Read by scripts/design/capture-states.mjs: the state ids to screenshot. */
    __DESIGN_CAPTURE__?: { states: readonly string[] }
  }
}

const requested = new URLSearchParams(window.location.search).get('state')
const state = resolveDesignStateIncludingQa(window.location.search)

window.__DESIGN_CAPTURE__ = { states: DESIGN_STATE_IDS }

function CaptureApp(): JSX.Element {
  useEffect(() => {
    let cancelled = false
    delete document.documentElement.dataset.captureReady
    delete document.documentElement.dataset.captureState

    void document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (cancelled) return
          if (state) document.documentElement.dataset.captureState = state.id
          document.documentElement.dataset.captureReady = state || !requested ? '1' : 'unknown-state'
        })
      )
    )

    return () => {
      cancelled = true
    }
  }, [])

  return state ? <DesignSurface state={state} /> : <DesignIndex unknown={requested ?? undefined} />
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CaptureApp />
  </React.StrictMode>
)
