/**
 * The one loading state for every code-split surface (Settings sheet, History / Review / Agenda /
 * Intelligence panel, right-edge Reader). HIG Loading / Progress indicators:
 *   - Show something at once: the surface's own frame appears with the click, in the box the content fills.
 *   - Only a wait people notice gets an indicator: the orb fades in after PANEL_LOADING_DELAY_MS, centered in
 *     that box, so a fast chunk shows no loader at all.
 *   - No vague visible "Loading" label on an activity indicator; assistive tech hears "Loading <Surface>".
 *   - The content hands off with a short cross-fade (loader out, content in). Reduced motion swaps instantly.
 *   - When the content is ready, focus moves to it (its selected tab, heading or first control), never to the
 *     loader; when the surface closes, focus returns to the control that opened it.
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AgentStatus } from '../components/AgentStatus'
import { prefersOverlayReducedMotion } from '../lib/overlay-motion'
import { useSurfaceExitTarget, useSurfaceExiting } from '../lib/surface-exit'

/** A load shorter than this shows no indicator (HIG: only for operations that take noticeable time). */
export const PANEL_LOADING_DELAY_MS = 180
/** The loader-out / content-in cross-fade. Matches --duration-hover (tokens.css). */
export const PANEL_HANDOFF_MS = 150

/**
 * sheet: a self-framed surface that fills the window (Settings); the placeholder draws the same frame.
 * panel: inside <Panel>, whose glass is the frame; the placeholder reserves the panel's floor height.
 * reader: inside the right-edge Reader's scroller; the placeholder fills the visible scroll area.
 */
export type LazyPanelFrame = 'sheet' | 'panel' | 'reader'

type Phase = 'ready' | 'pending' | 'loading' | 'handoff'

const TEXT_ENTRY = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const FOCUSABLE =
  'button:not([disabled]), [href], [role="tab"][tabindex="0"], [tabindex]:not([tabindex="-1"]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Moves focus into a surface that just became ready, unless the surface already placed it (an autoFocus
 * field). Order: an explicit [data-surface-autofocus], the selected tab, the first heading, then the first
 * control that is not a text field (a focused field would make the first Escape blur instead of close).
 */
export function focusSurfaceEntry(root: HTMLElement): HTMLElement | null {
  const active = root.ownerDocument.activeElement
  if (active && active !== root.ownerDocument.body && root.contains(active)) return active as HTMLElement
  const explicit = root.querySelector<HTMLElement>('[data-surface-autofocus]')
  const tab = root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  const heading = root.querySelector<HTMLElement>('h1, h2')
  let target = explicit ?? tab ?? heading
  if (!target) {
    target = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => !TEXT_ENTRY.has(el.tagName)) ?? null
  }
  if (!target) return null
  if (target === heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
  return target
}

function Placeholder({
  frame,
  className,
  onPending
}: {
  frame: LazyPanelFrame
  className?: string
  onPending: (pending: boolean, height?: number) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && frame === 'reader') {
      // Fill the Reader's visible scroll area, so the orb sits where the content will start reading.
      const scroller = el.closest<HTMLElement>('[data-re-reader-scroll]')
      const host = el.parentElement?.parentElement
      if (scroller && host) {
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        const padBottom = Number.parseFloat(getComputedStyle(host).paddingBottom) || 0
        el.style.minHeight = `${Math.max(0, scroller.clientHeight - top - padBottom)}px`
      }
    }
    onPending(true)
    return () => onPending(false, el?.offsetHeight)
  }, [frame, onPending])
  return (
    <div ref={ref} className={['lazy-panel__placeholder', className].filter(Boolean).join(' ')} aria-hidden="true" />
  )
}

export function LazyPanel({
  label,
  frame,
  contentKey,
  className,
  placeholderClassName,
  focusOnReady = frame !== 'reader',
  children
}: {
  /** The surface's name, announced as "Loading <label>". */
  label: string
  frame: LazyPanelFrame
  /** The view shown; a change cross-fades the new content in and moves focus into it. */
  contentKey?: string
  className?: string
  /** The sheet frame's own surface classes, so the placeholder is the same frame the content draws. */
  placeholderClassName?: string
  focusOnReady?: boolean
  children: ReactNode
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('ready')
  const [enterTick, setEnterTick] = useState(0)
  const [loaderHeight, setLoaderHeight] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exiting = useSurfaceExiting()
  const exitTarget = useSurfaceExitTarget()
  const participatesInExit = frame === 'sheet'
  // Keep showing what the surface showed when its close began (surface-exit.ts).
  const frozenRef = useRef(children)
  if (!exiting) frozenRef.current = children
  const shown = exiting ? frozenRef.current : children

  const phaseRef = useRef<Phase>('ready')
  const go = useCallback((next: Phase): void => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const onPending = useCallback(
    (pending: boolean, height?: number): void => {
      if (delayRef.current) clearTimeout(delayRef.current)
      delayRef.current = null
      if (handoffRef.current) clearTimeout(handoffRef.current)
      handoffRef.current = null
      if (pending) {
        setLoaderHeight(null)
        go('pending')
        delayRef.current = setTimeout(() => {
          delayRef.current = null
          if (phaseRef.current === 'pending') go('loading')
        }, PANEL_LOADING_DELAY_MS)
        return
      }
      const reduced = prefersOverlayReducedMotion()
      if (reduced) {
        go('ready')
        return
      }
      setEnterTick((n) => n + 1)
      if (phaseRef.current !== 'loading') {
        go('ready')
        return
      }
      // The loader fades out where it stood, even when the arriving content is taller than the placeholder.
      if (frame !== 'sheet' && height) setLoaderHeight(height)
      go('handoff')
      handoffRef.current = setTimeout(() => {
        handoffRef.current = null
        go('ready')
      }, PANEL_HANDOFF_MS)
    },
    [frame, go]
  )

  useEffect(
    () => () => {
      if (delayRef.current) clearTimeout(delayRef.current)
      if (handoffRef.current) clearTimeout(handoffRef.current)
    },
    []
  )

  // Content that arrives from the placeholder, or replaces the previous view, fades in. Layout phase, so the
  // first painted frame is already the animation's start.
  const firstKeyRef = useRef(true)
  useLayoutEffect(() => {
    if (firstKeyRef.current) {
      firstKeyRef.current = false
      return
    }
    if (!prefersOverlayReducedMotion()) setEnterTick((n) => n + 1)
  }, [contentKey])
  useLayoutEffect(() => {
    if (enterTick === 0) return
    const el = contentRef.current
    if (!el) return
    el.removeAttribute('data-content-enter')
    void el.offsetWidth // restart the animation when a second switch lands mid-fade
    el.setAttribute('data-content-enter', '')
  }, [enterTick])

  const contentShown = phase === 'ready' || phase === 'handoff'
  useEffect(() => {
    if (!contentShown || !focusOnReady || exiting) return
    const el = contentRef.current
    if (el) focusSurfaceEntry(el)
  }, [contentShown, contentKey, focusOnReady, exiting])

  // Focus returns to the control that opened the surface (the Bar's M, History…) when it closes.
  useLayoutEffect(() => {
    if (!focusOnReady) return
    const root = rootRef.current
    const doc = root?.ownerDocument
    const invoker = doc?.activeElement as HTMLElement | null
    return () => {
      if (!root || !doc || !invoker || invoker === doc.body || !invoker.isConnected || root.contains(invoker)) return
      const active = doc.activeElement
      if (active && active !== doc.body && !root.contains(active)) return
      invoker.focus({ preventScroll: true })
    }
  }, [focusOnReady])

  const loaderShown = phase === 'loading' || phase === 'handoff'
  return (
    <div
      ref={rootRef}
      className={['lazy-panel', `lazy-panel--${frame}`, className].filter(Boolean).join(' ')}
      data-lazy-panel={label}
      data-lazy-phase={phase}
      data-surface-exiting={participatesInExit && exiting ? '' : undefined}
      {...(participatesInExit ? exitTarget : {})}
    >
      <Suspense fallback={<Placeholder frame={frame} className={placeholderClassName} onPending={onPending} />}>
        <div
          ref={contentRef}
          className="lazy-panel__content"
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) e.currentTarget.removeAttribute('data-content-enter')
          }}
        >
          {shown}
        </div>
      </Suspense>
      <span className="lazy-panel__status" role="status" aria-live="polite">
        {phase === 'loading' ? `Loading ${label}` : ''}
      </span>
      {loaderShown && (
        <div
          className="lazy-panel__loader"
          data-state={phase === 'handoff' ? 'out' : 'in'}
          aria-hidden="true"
          style={loaderHeight ? { height: loaderHeight } : undefined}
        >
          <AgentStatus kind="loading" size="hero" caption={false} />
        </div>
      )}
    </div>
  )
}

/** The Settings sheet's own frame (SettingsRoot's root), drawn by the placeholder until Settings arrives. */
export const SETTINGS_SHEET_FRAME_CLASS =
  'cl-root flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-panel)] text-[color:var(--cl-foreground)]'

/** Settings as a window-filling sheet under the Bar: every entry point (M, Command-Comma, tray, gates). */
export function SettingsSheet({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return (
    <LazyPanel
      label="Settings"
      frame="sheet"
      contentKey="settings"
      className={className ?? 'flex min-h-0 flex-1 flex-col'}
      placeholderClassName={SETTINGS_SHEET_FRAME_CLASS}
    >
      {children}
    </LazyPanel>
  )
}
