import { SUGGESTION_TITLE_MAX, EVIDENCE_LABEL_MAX } from '@shared/suggestions'
import { actionDigest, canonicalJson } from '../../action-guard'
import type { Evidence, Feedback, SourceItem } from './model'

/** An event counts as an anchor only when it starts within a day of now (either side). */
export const FRESH_ANCHOR_MS = 24 * 3_600_000
/** An item whose own time is older than this is dropped unless a fresh anchor matches it. */
export const STALE_ITEM_MS = 7 * 24 * 3_600_000
export const MIN_SHARED_TERMS = 2
export const MAX_EVIDENCE = 8
const MAX_TERMS = 12
const MIN_TERM_LENGTH = 4

export interface Candidate {
  fingerprint: string
  evidenceDigest: string
  title: string
  evidence: Evidence[]
}

/** Lowercased distinct words of 4+ characters, at most 12. The only thing kept of a source's text besides its short label. */
export function termsOf(text: string): string[] {
  const terms: string[] = []
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= MIN_TERM_LENGTH && !terms.includes(word)) terms.push(word)
    if (terms.length === MAX_TERMS) break
  }
  return terms
}

const shared = (a: readonly string[], b: readonly string[]): number => a.filter((term) => b.includes(term)).length
const evidenceKey = (e: Evidence): string => `${e.sourceKind}:${canonicalJson(e.ref)}`

/** Identity of an evidence set: sources, event times and labels, order independent. `retrievedAt` is left out on purpose. */
export function evidenceDigest(evidence: readonly Evidence[]): string {
  return actionDigest(
    evidence
      .map((e) => canonicalJson({ sourceKind: e.sourceKind, ref: e.ref, eventAt: e.eventAt, label: e.label }))
      .sort()
  )
}

/**
 * Turns what the sources returned into suggestion candidates (deterministic, no model). An anchor is an event within a
 * day of now. Supporting items join it only by sharing at least two terms, which is also what keeps a stale item
 * (older than a week) out unless a fresh anchor matches it. The same topic from two sources has one fingerprint, so it
 * becomes one candidate that lists both.
 */
export function buildCandidates(items: readonly SourceItem[], now: number): Candidate[] {
  const anchors = items.filter(
    (item) =>
      item.role === 'anchor' &&
      item.evidence.eventAt !== null &&
      Math.abs(item.evidence.eventAt - now) <= FRESH_ANCHOR_MS
  )
  const supports = items.filter((item) => item.role === 'support')
  const byFingerprint = new Map<string, { title: string; evidence: Map<string, Evidence> }>()
  for (const anchor of anchors) {
    const fingerprint = actionDigest({ kind: 'prepare_for_event', anchorTerms: [...anchor.evidence.terms].sort() })
    const group = byFingerprint.get(fingerprint) ?? {
      title: `Prepare for: ${anchor.evidence.label}`.slice(0, SUGGESTION_TITLE_MAX),
      evidence: new Map<string, Evidence>()
    }
    byFingerprint.set(fingerprint, group)
    group.evidence.set(evidenceKey(anchor.evidence), clip(anchor.evidence))
    for (const support of supports) {
      if (shared(anchor.evidence.terms, support.evidence.terms) >= MIN_SHARED_TERMS) {
        group.evidence.set(evidenceKey(support.evidence), clip(support.evidence))
      }
    }
  }
  return [...byFingerprint].map(([fingerprint, group]) => {
    const evidence = [...group.evidence.values()].slice(0, MAX_EVIDENCE)
    return { fingerprint, evidenceDigest: evidenceDigest(evidence), title: group.title, evidence }
  })
}

const clip = (e: Evidence): Evidence => ({ ...e, label: e.label.slice(0, EVIDENCE_LABEL_MAX) })

/** Drops a candidate the owner already answered for exactly this evidence. A changed evidence set lets it back. */
export function filterByFeedback(candidates: readonly Candidate[], feedback: readonly Feedback[]): Candidate[] {
  return candidates.filter(
    (c) => !feedback.some((f) => f.fingerprint === c.fingerprint && f.evidenceDigest === c.evidenceDigest)
  )
}
