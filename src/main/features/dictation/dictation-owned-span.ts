/**
 * The owned span (G26): text Métis itself dictated for this person, the only text the dictionary may learn from.
 *
 * "Owned" is a fact main establishes, never a claim a caller makes. An `OwnedSpan` can only come from
 * `mintOwnedSpan`, and the minted objects are remembered in a registry, so a literal, a spread copy or a string
 * cannot pass for one. Its text comes from two places, both inside main and both a dictation of this person's own
 * voice: the draft a dictation journal entry holds (a recovered draft the person corrected in Métis) and the text
 * of a dictation just verified into a field (held here for the twenty second correction window, in memory only).
 *
 * What can never become an owned span: a meeting transcript, another person's speech, the text read back from a
 * field or a screen, anything a renderer sends. The renderer supplies only the corrected text; the original is main's.
 */
import { randomBytes } from 'node:crypto'
import { OWNED_SPAN_MAX, OWNED_SPAN_WINDOW_MS } from './dictation-memory-policy'

export type OwnedSpanOrigin = 'dictation-turn' | 'recovered-draft'

export interface OwnedSpan {
  readonly text: string
  readonly origin: OwnedSpanOrigin
}

const minted = new WeakSet<object>()

/** Only the journal (a recovered draft) and the ledger below (a verified dictation) call this. */
export function mintOwnedSpan(text: string, origin: OwnedSpanOrigin): OwnedSpan {
  const span: OwnedSpan = Object.freeze({ text, origin })
  minted.add(span)
  return span
}

export function isOwnedSpan(value: unknown): value is OwnedSpan {
  return typeof value === 'object' && value !== null && minted.has(value)
}

export interface RecentOwnedSpan {
  readonly id: string
  readonly text: string
  readonly insertedAtMs: number
  readonly expiresAtMs: number
}

export interface OwnedSpanLedger {
  /** Remember a dictation that was verified into a field. Returns its id, or null for blank text. */
  mint(text: string): string | null
  /** Spans still inside the window, newest first. */
  recent(): RecentOwnedSpan[]
  /** Hand a span out once; null when unknown or expired. */
  claim(id: string): OwnedSpan | null
  clear(): void
}

interface Held {
  readonly id: string
  readonly text: string
  readonly insertedAtMs: number
}

export function createOwnedSpanLedger(deps: { now(): number; newId?(): string }): OwnedSpanLedger {
  const newId = deps.newId ?? ((): string => randomBytes(16).toString('hex'))
  let held: Held[] = []
  const live = (): Held[] => {
    const cutoff = deps.now() - OWNED_SPAN_WINDOW_MS
    held = held.filter((span) => span.insertedAtMs >= cutoff)
    return held
  }
  return {
    mint(text) {
      if (text.trim().length === 0) return null
      live()
      const id = newId()
      held.push({ id, text, insertedAtMs: deps.now() })
      if (held.length > OWNED_SPAN_MAX) held = held.slice(held.length - OWNED_SPAN_MAX)
      return id
    },
    recent() {
      return live()
        .map((span) => ({
          id: span.id,
          text: span.text,
          insertedAtMs: span.insertedAtMs,
          expiresAtMs: span.insertedAtMs + OWNED_SPAN_WINDOW_MS
        }))
        .reverse()
    },
    claim(id) {
      const span = live().find((candidate) => candidate.id === id)
      if (!span) return null
      held = held.filter((candidate) => candidate !== span)
      return mintOwnedSpan(span.text, 'dictation-turn')
    },
    clear() {
      held = []
    }
  }
}
