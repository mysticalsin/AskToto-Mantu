import React from 'react'
import { createRoot } from 'react-dom/client'
import '../tokens.css'
import './capture.css'
import './settings/settings.css'
import { DesignIndex, DesignSurface } from './DesignSurface'
import { DESIGN_CAPTURE_STATES, resolveDesignStateIncludingQa, type DesignViewport } from './states'

declare global {
  interface Window {
    /** Read by scripts/design/capture-states.mjs: the states to screenshot, each with its viewport. */
    __DESIGN_CAPTURE__?: { states: readonly { id: string; viewport: DesignViewport }[] }
  }
}

const requested = new URLSearchParams(window.location.search).get('state')
const state = resolveDesignStateIncludingQa(window.location.search)

window.__DESIGN_CAPTURE__ = { states: DESIGN_CAPTURE_STATES }

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {state ? <DesignSurface state={state} /> : <DesignIndex unknown={requested ?? undefined} />}
  </React.StrictMode>
)

// The capture driver waits for this flag: fonts loaded and two frames painted, so no screenshot catches a
// half-laid-out page. An unknown state is flagged instead so the driver fails loudly rather than shooting it.
void document.fonts.ready.then(() =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      document.documentElement.dataset.captureReady = state || !requested ? '1' : 'unknown-state'
    })
  )
)
