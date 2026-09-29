import React from 'react'
import { createRoot } from 'react-dom/client'
import './capture.css'
import { DesignIndex, DesignSurface } from './DesignSurface'
import { DESIGN_STATE_IDS, resolveDesignState } from './states'

declare global {
  interface Window {
    /** Read by scripts/design/capture-states.mjs: the state ids to screenshot. */
    __DESIGN_CAPTURE__?: { states: readonly string[] }
  }
}

const requested = new URLSearchParams(window.location.search).get('state')
const state = resolveDesignState(window.location.search)

window.__DESIGN_CAPTURE__ = { states: DESIGN_STATE_IDS }

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
