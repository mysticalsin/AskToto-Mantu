/**
 * The overlay's code-split views, and when their chunks load.
 *
 * Heavy, rarely-first views are code-split so they don't weigh down the overlay's startup. Answer and Copilot
 * pull in Markdown.tsx -> streamdown + shiki/core, which have no reason to parse before the user has asked
 * anything. Settings, History and Review stay lazy too, but load on intent: the pointer resting on (or focus
 * reaching) the control that opens them, or a live meeting for Review. A chunk that loaded first renders
 * synchronously (see preloadableLazy), so a view opened after its intent never shows a loading state.
 */
import { lazy, useEffect, type ComponentType, type LazyExoticComponent } from 'react'

// React.lazy's own constraint; each view's props stay typed through T.
type AnyComponent = ComponentType<any>

export interface PreloadableView<T extends AnyComponent> {
  Component: LazyExoticComponent<T>
  /** Starts loading the chunk; resolves once it can render without suspending. Never rejects. */
  preload: () => Promise<void>
}

/**
 * React.lazy whose chunk can load before the first render. React 18 reads a thenable that resolves
 * synchronously inside `then` as already resolved, so a view whose chunk preloaded mounts in the same render
 * as the click that opened it, with no Suspense fallback at all. Without a preload it behaves like lazy().
 */
export function preloadableLazy<T extends AnyComponent>(load: () => Promise<{ default: T }>): PreloadableView<T> {
  let loaded: { default: T } | null = null
  let pending: Promise<{ default: T }> | null = null
  const start = (): Promise<{ default: T }> => {
    pending ??= load().then(
      (module) => {
        loaded = module
        return module
      },
      (error: unknown) => {
        pending = null // a failed chunk can be retried by the next intent or render
        throw error
      }
    )
    return pending
  }
  const Component = lazy(() => {
    const ready = loaded
    if (!ready) return start()
    return { then: (resolve: (module: { default: T }) => void) => resolve(ready) } as unknown as Promise<{ default: T }>
  })
  return {
    Component,
    preload: () =>
      start().then(
        () => undefined,
        () => undefined
      )
  }
}

const views = {
  settings: preloadableLazy(() => import('../components/Settings').then((m) => ({ default: m.Settings }))),
  review: preloadableLazy(() => import('../components/Review').then((m) => ({ default: m.Review }))),
  history: preloadableLazy(() => import('../components/RecallView').then((m) => ({ default: m.RecallView }))),
  agenda: preloadableLazy(() => import('../components/AgendaView').then((m) => ({ default: m.AgendaView }))),
  brain: preloadableLazy(() => import('../components/BrainView').then((m) => ({ default: m.BrainView }))),
  answer: preloadableLazy(() => import('../components/Answer').then((m) => ({ default: m.Answer }))),
  copilot: preloadableLazy(() => import('../components/Copilot').then((m) => ({ default: m.Copilot })))
}

export type LazyViewName = keyof typeof views

export const Settings = views.settings.Component
export const Review = views.review.Component
export const RecallView = views.history.Component
export const AgendaView = views.agenda.Component
export const BrainView = views.brain.Component
export const Answer = views.answer.Component
export const Copilot = views.copilot.Component

export function preloadView(name: LazyViewName): Promise<void> {
  return views[name].preload()
}

/** The Bar controls whose hover or focus says which view is about to open. */
export const VIEW_INTENT_TARGETS: ReadonlyArray<readonly [selector: string, view: LazyViewName]> = [
  ['[data-bar-mark]', 'settings'],
  ['[data-bar-history]', 'history']
]

/** The view a pointer or focus event's target announces, or null. */
export function intentViewFor(target: EventTarget | null): LazyViewName | null {
  if (!target || typeof (target as Element).closest !== 'function') return null
  for (const [selector, view] of VIEW_INTENT_TARGETS) {
    if ((target as Element).closest(selector)) return view
  }
  return null
}

/** Loads a view's chunk the moment its opening control is hovered or focused (HIG: content displays at once). */
export function useViewIntentPreload(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): void {
  useEffect(() => {
    if (!doc) return
    const onIntent = (event: Event): void => {
      const view = intentViewFor(event.target)
      if (view) void preloadView(view)
    }
    doc.addEventListener('pointerover', onIntent, true)
    doc.addEventListener('focusin', onIntent, true)
    return () => {
      doc.removeEventListener('pointerover', onIntent, true)
      doc.removeEventListener('focusin', onIntent, true)
    }
  }, [doc])
}

/**
 * Idle warm-ups. Answer and Copilot are reachable from the very first keystroke, and their first mount runs in a
 * transition (React #426, see App), so they load once the boot settles. Review loads while a meeting is live:
 * Stop always lands there. MQA-270 (B10) retired the boot-time Settings/Recall warm; those load on intent.
 */
export function useLazyViewWarmup(listening: boolean): void {
  useEffect(() => {
    idle(() => {
      void preloadView('answer')
      void preloadView('copilot')
    }, 2000)
  }, [])
  useEffect(() => {
    if (listening) idle(() => void preloadView('review'), 1000)
  }, [listening])
}

function idle(run: () => void, fallbackMs: number): void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
  if (ric) ric(run)
  else setTimeout(run, fallbackMs)
}

const SURFACE_LABELS: Readonly<Record<string, string>> = {
  settings: 'Settings',
  history: 'History',
  review: 'Review',
  agenda: 'Agenda',
  brain: 'Mantu Intelligence',
  answer: 'Answer',
  copilot: 'Suggestions',
  transcript: 'Transcript',
  details: 'Details'
}

/** The name a surface's loading state announces ("Loading History"). */
export function surfaceLabel(view: string): string {
  return SURFACE_LABELS[view] ?? 'Métis'
}
