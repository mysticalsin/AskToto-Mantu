/**
 * Overlay reconciler (G17): keeps the overlay window's applied state converging on its desired state.
 *
 * Triggers (each runs the bounded passes at 0, 250, 1000 and 2500 ms, then stops):
 *   - powerMonitor 'resume' and 'unlock-screen'
 *   - screen 'display-added', 'display-removed' and 'display-metrics-changed'
 *   - the overlay's own 'enter-full-screen' and 'leave-full-screen' (Spaces and full-screen transitions)
 * A single immediate pass, with no schedule, answers 'always-on-top-changed' so the echo of our own
 * re-assert never starts a sequence.
 *
 * Invariants:
 *   - No polling: the passes are armed once from infra/scheduler/bounded-passes and a new trigger restarts
 *     the sequence rather than stacking one. Between disturbances nothing is scheduled.
 *   - Desired bounds and visibility are captured only at intentional transitions (`captureDesired`, called
 *     from the app's own overlay transition note), when the window is shown, and from its own move/resize
 *     events outside a recovery sequence, never while the OS is still settling; an unreachable rect is never
 *     captured. A hide is only ever the user's, so a plan shows a hidden window but never hides one.
 *   - Protection and click-through come from `ports.live()` on every pass.
 *   - An exclusive onboarding window is not reconciled here; on a display change it goes to the app's own
 *     stage re-apply, as before.
 */
import { type PassTimers, realPassTimers, runBoundedPasses } from '../../infra/scheduler/bounded-passes'
import type { OverlayLayout } from '@shared/overlay-chrome'
import {
  type DisplayInfo,
  type OverlayAction,
  type OverlayApplied,
  type OverlayDesired,
  OVERLAY_RECOVERY_PASS_MS,
  nearestDisplay,
  overlapsAnyDisplay,
  planOverlayPass,
  type Rect
} from './overlay-state'

export type OverlayReconcileReason = 'resume' | 'unlock' | 'display' | 'space' | 'drift'

/** What the app's own flags and settings say right now. Read on every pass, never cached. */
export interface OverlayLive {
  layout: OverlayLayout
  parked: boolean
  contentProtection: boolean
  clickThrough: boolean
  /** Exclusive onboarding owns the display and its own bounds guard. */
  exclusive: boolean
  /** The app owns the bounds (parked Hide/Island rest, right-edge sidecar). */
  delegateBounds: boolean
}

/** The slice of BrowserWindow the reconciler uses. */
export interface OverlayWindowPort {
  isDestroyed(): boolean
  getBounds(): Rect
  setBounds(bounds: Rect, animate?: boolean): void
  isVisible(): boolean
  isAlwaysOnTop(): boolean
  showInactive(): void
  setContentProtection(on: boolean): void
  setIgnoreMouseEvents(on: boolean): void
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

export interface EventSourcePort {
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

export interface OverlayReconcilerPorts<D extends DisplayInfo> {
  window(): OverlayWindowPort | null
  displays(): readonly D[]
  live(): OverlayLive
  /** The app's own re-anchor for a parked, sidecar or exclusive window. */
  delegateReanchor(): void
  /** Float above full-screen apps and pin to all workspaces (the app's one always-on-top routine). */
  assertAlwaysOnTop(): void
  /** DESIGN.md top-edge placement of a window of this size on `display`. */
  topEdgePosition(width: number, height: number, display: D): { x: number; y: number }
  barMinHeight: number
  powerMonitor: EventSourcePort
  screen: EventSourcePort
  timers?: PassTimers
  onError?: (where: string, error: unknown) => void
}

export interface OverlayReconciler {
  /** Subscribe to powerMonitor and screen events once. */
  start(): void
  /** Subscribe to one overlay window's events (a recreated window is bound again). */
  bindWindow(window: OverlayWindowPort): void
  /** Record the window's current visibility and position as the user's or the app's intent. */
  captureDesired(): void
  trigger(reason: OverlayReconcileReason): void
  state(): { desired: OverlayDesired; applied: OverlayApplied }
  dispose(): void
}

const POWER_EVENTS: ReadonlyArray<readonly [string, OverlayReconcileReason]> = [
  ['resume', 'resume'],
  ['unlock-screen', 'unlock']
]
const SCREEN_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'] as const
const LAST_PASS = OVERLAY_RECOVERY_PASS_MS.length - 1

export function createOverlayReconciler<D extends DisplayInfo>(ports: OverlayReconcilerPorts<D>): OverlayReconciler {
  const timers = ports.timers ?? realPassTimers
  const report = (where: string, error: unknown): void => ports.onError?.(where, error)
  let anchor: Rect | null = null
  let anchorDisplayId: number | null = null
  // Unknown until the window is shown or an intentional transition is captured, so a display event during a
  // deferred first show can never show the window early.
  let visible = false
  const applied: OverlayApplied = { contentProtection: null, clickThrough: null }
  let cancelPasses: (() => void) | null = null
  let episodeActive = false
  let applying = false
  let bound: { window: OverlayWindowPort; detach: () => void } | null = null
  const unsubscribers: Array<() => void> = []

  function desiredNow(): OverlayDesired {
    const live = ports.live()
    return {
      anchor,
      anchorDisplayId,
      visible,
      alwaysOnTop: true,
      contentProtection: live.contentProtection,
      clickThrough: live.clickThrough,
      layout: live.layout,
      parked: live.parked
    }
  }

  function captureAnchor(win: OverlayWindowPort): void {
    const bounds = win.getBounds()
    const displays = ports.displays()
    if (!overlapsAnyDisplay(bounds, displays)) return
    anchor = bounds
    anchorDisplayId = nearestDisplay(bounds, displays)?.id ?? null
  }

  function captureDesired(): void {
    const win = ports.window()
    if (!win || win.isDestroyed() || ports.live().exclusive) return
    visible = win.isVisible()
    captureAnchor(win)
  }

  function apply(win: OverlayWindowPort, action: OverlayAction): void {
    switch (action.kind) {
      case 'setBounds':
        win.setBounds(action.bounds, false)
        anchor = action.bounds
        anchorDisplayId = nearestDisplay(action.bounds, ports.displays())?.id ?? null
        return
      case 'reanchor':
        ports.delegateReanchor()
        captureAnchor(win)
        return
      case 'show':
        win.showInactive()
        return
      case 'alwaysOnTop':
        ports.assertAlwaysOnTop()
        return
      case 'contentProtection':
        win.setContentProtection(action.on)
        applied.contentProtection = action.on
        return
      case 'clickThrough':
        win.setIgnoreMouseEvents(action.on)
        applied.clickThrough = action.on
        return
    }
  }

  function runPass(reason: OverlayReconcileReason, index: number): void {
    const win = ports.window()
    if (!win || win.isDestroyed()) return
    const live = ports.live()
    const firstDisplayPass = reason === 'display' && index === 0
    if (live.exclusive) {
      if (firstDisplayPass) ports.delegateReanchor()
      return
    }
    const episode = reason !== 'drift'
    const actions = planOverlayPass({
      desired: desiredNow(),
      observed: { bounds: win.getBounds(), visible: win.isVisible(), alwaysOnTop: win.isAlwaysOnTop() },
      applied,
      displays: ports.displays(),
      mode: live.delegateBounds ? 'delegate' : 'free',
      forceReanchor: firstDisplayPass,
      reassert: episode,
      barMinHeight: ports.barMinHeight,
      topEdgePosition: ports.topEdgePosition
    })
    applying = true
    try {
      for (const action of actions) {
        try {
          apply(win, action)
        } catch (error) {
          report(`apply:${action.kind}`, error)
        }
      }
    } finally {
      applying = false
    }
  }

  function trigger(reason: OverlayReconcileReason): void {
    cancelPasses?.()
    episodeActive = true
    cancelPasses = runBoundedPasses(
      OVERLAY_RECOVERY_PASS_MS,
      (index) => {
        try {
          runPass(reason, index)
        } finally {
          if (index === LAST_PASS) episodeActive = false
        }
      },
      timers,
      (error) => report(`pass:${reason}`, error)
    )
  }

  function onNativeGeometry(): void {
    if (applying || episodeActive) return
    const win = ports.window()
    if (!win || win.isDestroyed() || ports.live().exclusive) return
    captureAnchor(win)
  }

  function onShown(): void {
    if (!applying) visible = true
  }

  function onAlwaysOnTopChanged(): void {
    if (applying || episodeActive) return
    const win = ports.window()
    if (!win || win.isDestroyed() || win.isAlwaysOnTop()) return
    runPass('drift', 0)
  }

  function bindWindow(window: OverlayWindowPort): void {
    bound?.detach()
    const listeners: Array<[string, () => void]> = [
      ['move', onNativeGeometry],
      ['resize', onNativeGeometry],
      ['show', onShown],
      ['enter-full-screen', () => trigger('space')],
      ['leave-full-screen', () => trigger('space')],
      ['always-on-top-changed', onAlwaysOnTopChanged]
    ]
    for (const [event, listener] of listeners) window.on(event, listener)
    bound = {
      window,
      detach: () => {
        for (const [event, listener] of listeners) {
          try {
            window.removeListener(event, listener)
          } catch (error) {
            report('detach', error)
          }
        }
      }
    }
    const win = ports.window()
    if (win === window && !ports.live().exclusive) captureAnchor(window)
  }

  function start(): void {
    if (unsubscribers.length > 0) return
    for (const [event, reason] of POWER_EVENTS) {
      const listener = (): void => trigger(reason)
      ports.powerMonitor.on(event, listener)
      unsubscribers.push(() => ports.powerMonitor.removeListener(event, listener))
    }
    for (const event of SCREEN_EVENTS) {
      const listener = (): void => trigger('display')
      ports.screen.on(event, listener)
      unsubscribers.push(() => ports.screen.removeListener(event, listener))
    }
  }

  function dispose(): void {
    cancelPasses?.()
    cancelPasses = null
    episodeActive = false
    bound?.detach()
    bound = null
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  }

  return {
    start,
    bindWindow,
    captureDesired,
    trigger,
    state: () => ({ desired: desiredNow(), applied: { ...applied } }),
    dispose
  }
}
