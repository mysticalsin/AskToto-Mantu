/**
 * The suggestion carousel (G69, CAP-32). In Settings it is a direct request and always shows. In the overlay it is
 * unsolicited, so it shows only while the quiet policy allows proactive suggestions; otherwise it renders nothing and
 * offers the held output to quiet mode once. Docked at the top of the overlay stack (persistent UI at the top edge);
 * dismiss reasons, the accept receipt and the edit field open beside the clicked control.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { DISMISS_REASONS, SUGGESTION_TITLE_MAX, type CardView, type ListResult } from '@shared/suggestions'
import type { QuietPolicy } from '@shared/quiet-mode-settings'
import { useReducedMotion } from '../../lib/use-reduced-motion'
import { AnchoredPopover } from './AnchoredPopover'
import { SuggestionCard } from './SuggestionCard'
import {
  carouselReducer,
  createShownTracker,
  currentCard,
  initialCarousel,
  isCardStale,
  refOf,
  type CarouselState
} from './carousel-model'
import { AdjustSession, ackShown, type SuggestionsApi } from './suggestion-actions'
import { DISMISS_REASON_COPY, ackRefusalCopy, acceptOutcomeCopy } from './suggestion-copy'

export type CarouselMode = 'overlay' | 'settings'

const REFETCH_MS = 60_000
const TICK_MS = 30_000

export function quietGate(mode: CarouselMode, policy: QuietPolicy | null | undefined): 'show' | 'hold' {
  if (mode === 'settings') return 'show'
  return policy?.proactiveSuggestion === 'allow' ? 'show' : 'hold'
}

/** Offers held suggestions to quiet mode once per hold episode (re-arms when there is nothing held, or it shows). */
export function createOfferLatch(offer: () => void): { update(gate: 'show' | 'hold', hasCards: boolean): void } {
  let offered = false
  return {
    update(gate, hasCards) {
      if (gate === 'show' || !hasCards) offered = false
      else if (!offered) {
        offered = true
        offer()
      }
    }
  }
}

export interface SuggestionSource {
  list: ListResult | null
  refetch: () => Promise<void>
}

/** Fetches the list on mount, when the window becomes visible, and every minute while mounted. */
export function useSuggestionList(enabled = true): SuggestionSource {
  const [list, setList] = useState<ListResult | null>(null)
  const refetch = useCallback(async (): Promise<void> => {
    setList(await window.toto.suggestions.list())
  }, [])
  useEffect(() => {
    if (!enabled) return
    void refetch()
    const timer = setInterval(() => void refetch(), REFETCH_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refetch()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refetch])
  return { list, refetch }
}

type Anchored = (card: CardView, anchor: HTMLElement) => void

interface EditingState {
  id: string
  text: string
  anchor: HTMLElement | null
}

export function SuggestionCarouselView({
  state,
  mode,
  announcement,
  editing,
  reducedMotion,
  onPrev,
  onNext,
  onAccept,
  onDismiss,
  onEdit,
  onEditChange,
  onEditSave,
  onEditCancel
}: {
  state: CarouselState
  mode: CarouselMode
  announcement: string
  editing: EditingState | null
  reducedMotion: boolean
  onPrev: () => void
  onNext: () => void
  onAccept: Anchored
  onDismiss: Anchored
  onEdit: Anchored
  onEditChange: (text: string) => void
  onEditSave: () => void
  onEditCancel: () => void
}): JSX.Element | null {
  const card = currentCard(state)
  const index = card ? state.cards.indexOf(card) : -1
  const total = state.cards.length
  const live = (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  )
  if (!card) return mode === 'overlay' ? live : <div>{live}</div>
  const nav =
    'no-drag cl-focus flex size-7 shrink-0 items-center justify-center rounded-md text-[13px] text-[color:var(--cl-muted-foreground)] hover:bg-white/10 hover:text-[color:var(--cl-foreground)] disabled:opacity-30'
  const fade = reducedMotion ? '' : 'transition-opacity duration-[160ms] motion-reduce:transition-none'
  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label="Suggestions"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).tagName === 'INPUT') return
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onPrev()
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onNext()
        }
      }}
      className={
        mode === 'overlay'
          ? 'glass-strong mx-auto flex max-h-[132px] w-full max-w-[500px] items-start gap-1 overflow-hidden rounded-[14px] px-2 py-2'
          : 'flex items-start gap-1 rounded-[var(--cl-radius)] border border-[var(--cl-border)] px-2 py-2'
      }
    >
      <button type="button" className={nav} aria-label="Previous suggestion" disabled={index <= 0} onClick={onPrev}>
        ‹
      </button>
      <div
        key={card.id}
        role="group"
        aria-roledescription="slide"
        aria-label={`Suggestion ${index + 1} of ${total}`}
        className={`min-w-0 flex-1 ${fade}`}
      >
        <SuggestionCard
          card={card}
          stale={isCardStale(state, card)}
          now={state.now}
          compact={mode === 'overlay'}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onEdit={onEdit}
        />
      </div>
      <button type="button" className={nav} aria-label="Next suggestion" disabled={index >= total - 1} onClick={onNext}>
        ›
      </button>
      {live}
      {editing && editing.id === card.id && (
        <AnchoredPopover anchor={editing.anchor} label="Edit suggestion" onClose={onEditCancel}>
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (editing.text.trim() !== '') onEditSave()
            }}
          >
            <input
              aria-label="Suggestion title"
              className="no-drag cl-input cl-focus px-2 py-1.5 text-[12px]"
              maxLength={SUGGESTION_TITLE_MAX}
              value={editing.text}
              onChange={(e) => onEditChange(e.target.value)}
            />
            <div className="flex gap-1">
              <button
                type="submit"
                className="no-drag cl-focus min-h-[28px] rounded-md px-2.5 text-[12px] text-[color:var(--cl-primary)] hover:bg-white/10"
              >
                Save
              </button>
              <button
                type="button"
                className="no-drag cl-focus min-h-[28px] rounded-md px-2.5 text-[12px] hover:bg-white/10"
                onClick={onEditCancel}
              >
                Cancel
              </button>
            </div>
          </form>
        </AnchoredPopover>
      )}
    </section>
  )
}

type Popover =
  | { kind: 'dismiss'; card: CardView; anchor: HTMLElement }
  | { kind: 'receipt'; anchor: HTMLElement; text: string }

export function SuggestionCarousel({
  mode,
  quietPolicy,
  source,
  suspended = false
}: {
  mode: CarouselMode
  quietPolicy?: QuietPolicy | null
  /** The overlay is minimized to its control pill: hold the carousel without offering it to quiet mode. */
  suspended?: boolean
  /** Settings passes its own list so queue health and the carousel share one fetch. */
  source?: SuggestionSource
}): JSX.Element | null {
  const own = useSuggestionList(!source)
  const { list, refetch } = source ?? own
  // Read lazily: a held overlay never touches the bridge during render.
  const api = (): SuggestionsApi => window.toto.suggestions
  const gate = quietGate(mode, quietPolicy)
  const reducedMotion = useReducedMotion()
  const [state, dispatch] = useReducer(carouselReducer, Date.now(), initialCarousel)
  const [announcement, setAnnouncement] = useState('')
  const [popover, setPopover] = useState<Popover | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const session = useRef<AdjustSession | null>(null)
  const tracker = useRef(createShownTracker())
  const latch = useRef(createOfferLatch(() => void window.toto.quietOutputOffer('proactiveSuggestion').catch(() => {})))

  useEffect(() => {
    if (list?.ok) dispatch({ type: 'loaded', cards: list.cards, lastShownId: list.lastShownId })
    else if (list) dispatch({ type: 'loaded', cards: [], lastShownId: null })
  }, [list])

  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const hasCards = state.cards.length > 0
  useEffect(() => latch.current.update(gate, hasCards), [gate, hasCards])

  const card = currentCard(state)
  useEffect(() => {
    if (!card || gate !== 'show' || suspended || document.visibilityState !== 'visible') return
    void ackShown(window.toto.suggestions, tracker.current, card)
  }, [card, gate, suspended])

  if (gate === 'hold' || suspended) return null

  const settle = (text: string, anchor: HTMLElement | null): void => {
    setAnnouncement(text)
    if (anchor) setPopover({ kind: 'receipt', anchor, text })
  }
  const onAccept = (target: CardView, anchor: HTMLElement): void => {
    void api()
      .accept(refOf(target))
      .then((result) => {
        settle(acceptOutcomeCopy(result), anchor)
        if (result.ok) dispatch({ type: 'removed', id: target.id })
        else if (result.reason === 'stale' || result.reason === 'sources_changed')
          dispatch({ type: 'markStale', id: target.id })
        void refetch()
      })
  }
  const onDismissReason = (target: CardView, reason: (typeof DISMISS_REASONS)[number]): void => {
    setPopover(null)
    void api()
      .dismiss(refOf(target), reason)
      .then((result) => {
        if (result.ok) {
          dispatch({ type: 'removed', id: target.id })
          setAnnouncement('Dismissed.')
        } else {
          if (result.reason === 'stale') dispatch({ type: 'markStale', id: target.id })
          setAnnouncement(ackRefusalCopy(result.reason))
        }
        void refetch()
      })
  }
  const closeEdit = (): void => {
    const pending = session.current
    session.current = null
    setEditing(null)
    void pending?.cancel()
  }
  const saveEdit = (): void => {
    const pending = session.current
    const draft = editing
    if (!pending || !draft) return
    void (async () => {
      const drafted = await pending.draft(draft.text.trim())
      const saved = drafted.ok ? await pending.save() : drafted
      if (!saved.ok) {
        await pending.cancel()
        setAnnouncement(ackRefusalCopy(saved.reason))
        if (saved.reason === 'stale') dispatch({ type: 'markStale', id: draft.id })
      } else setAnnouncement('Saved.')
      session.current = null
      setEditing(null)
      await refetch()
    })()
  }

  return (
    <>
      <SuggestionCarouselView
        state={state}
        mode={mode}
        announcement={announcement}
        editing={editing}
        reducedMotion={reducedMotion}
        onPrev={() => dispatch({ type: 'prev' })}
        onNext={() => dispatch({ type: 'next' })}
        onAccept={onAccept}
        onDismiss={(target, anchor) => setPopover({ kind: 'dismiss', card: target, anchor })}
        onEdit={(target, anchor) => {
          session.current = new AdjustSession(api(), target)
          setEditing({ id: target.id, text: target.title, anchor })
        }}
        onEditChange={(text) => setEditing((current) => (current ? { ...current, text } : current))}
        onEditSave={saveEdit}
        onEditCancel={closeEdit}
      />
      {popover?.kind === 'dismiss' && (
        <AnchoredPopover anchor={popover.anchor} label="Why dismiss" onClose={() => setPopover(null)}>
          {DISMISS_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              className="no-drag cl-focus min-h-[28px] rounded-md px-2.5 text-left text-[12px] hover:bg-white/10"
              onClick={() => onDismissReason(popover.card, reason)}
            >
              {DISMISS_REASON_COPY[reason]}
            </button>
          ))}
        </AnchoredPopover>
      )}
      {popover?.kind === 'receipt' && (
        <AnchoredPopover
          anchor={popover.anchor.isConnected ? popover.anchor : null}
          label="Result"
          onClose={() => setPopover(null)}
        >
          <div className="px-1">{popover.text}</div>
          <button
            type="button"
            className="no-drag cl-focus min-h-[28px] self-end rounded-md px-2.5 text-[12px] hover:bg-white/10"
            onClick={() => setPopover(null)}
          >
            OK
          </button>
        </AnchoredPopover>
      )}
    </>
  )
}
