/**
 * Clarify protocol (G35): an underspecified owner request becomes at most ONE question, never a chain.
 *
 * Pure state machine, no I/O. The voice turn pipeline owns the wiring:
 *
 *   1. A request that is missing one detail (a note with no title, a search with no query) opens a clarification.
 *      Before it asks, the pipeline may run the declared preparation, which is read-only or reversible and safe
 *      without the missing detail (`CLARIFY_PREPARATION`, checked against the catalog classes).
 *   2. The next owner turn is the answer. It is bound to the owner, the session and the task lineage that opened
 *      the question and expires after `ttlMs`. Content (another speaker, a screen, a document) is never an
 *      answer (G36), and an answer from a different session or task leaves the question untouched.
 *   3. A usable answer completes into an ordinary catalog request. This module never runs, sends, types, creates
 *      or deletes anything: the request goes through the normal executor, so a create still gets its confirm card.
 *   4. An answer that is still unusable ends with honest copy. There is no second question.
 *
 * Stop, sign-out, an owner switch or an expiry drop the pending clarification. No words are kept beyond the
 * request being completed: the machine stores ids, the action id and times only.
 */
import { mayProposeActions, type ContextRecord } from '@shared/context-authority'
import {
  clarifyEndCopy,
  clarifyQuestionCopy,
  type ClarifyAction,
  type ClarifyEndReason,
  type ClarifyMissing
} from '@shared/clarify-copy'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { classifyDesktopRequest, validateDesktopRequest } from '@shared/voice/catalog'
import { parseVoiceUtterance, provisionalIntent } from '@shared/voice/voice-grammar'

export const CLARIFY_TTL_MS = 90_000

/** Who the question belongs to. All three must match for an answer to count. */
export interface ClarifyBinding {
  readonly ownerId: string
  readonly sessionId: string
  readonly taskId: string
}

/**
 * The only work allowed before the answer: a read or reversible catalog request that does not need the missing
 * detail. A search has none (opening a browser would guess which one).
 */
export const CLARIFY_PREPARATION: Readonly<Record<ClarifyAction, DesktopActionRequest | null>> = {
  'desktop.create_note': { id: 'desktop.open_notes', args: {} },
  'desktop.google_search': null
}

export function isSafePreparation(request: DesktopActionRequest | null): boolean {
  if (!request) return true
  const cls = classifyDesktopRequest(request, 'darwin')
  return cls === 'read' || cls === 'reversible'
}

/** The clarifiable action named by an incomplete utterance, or null (nothing to ask about, so no question). */
export function clarifiableAction(utteranceText: string): ClarifyAction | null {
  const intent = provisionalIntent(utteranceText)
  return intent === 'desktop.create_note' || intent === 'desktop.google_search' ? intent : null
}

export type ClarifyDropReason = 'stop' | 'sign_out' | 'owner_switch' | 'revoked' | 'meeting' | 'replaced'

export type ClarifyAnswer =
  /** Nothing is pending: route the turn as usual. */
  | { kind: 'none' }
  /** The turn is not an answer to this question (content, another session or task, a fresh command): route as usual. */
  | { kind: 'not_an_answer' }
  /** The answer is complete. The request still goes through the normal executor and confirm path. */
  | { kind: 'complete'; request: DesktopActionRequest; taskId: string }
  /** The question is over and nothing was done. `copy` is what to say. */
  | { kind: 'ended'; reason: ClarifyEndReason; copy: string; action: ClarifyAction }

export interface ClarifyOpened {
  question: string
  action: ClarifyAction
  taskId: string
  expiresAt: number
}

export interface ClarifyMachine {
  /** Open the one question. Replaces any pending one: there is never more than one. */
  open(input: { action: ClarifyAction; missing: ClarifyMissing; binding: ClarifyBinding }): ClarifyOpened
  /** Take the owner's next turn. `binding` is the live owner, session and task lineage. */
  answer(record: ContextRecord, binding: ClarifyBinding | null): ClarifyAnswer
  drop(reason: ClarifyDropReason): boolean
  pending(): boolean
}

interface Pending {
  readonly action: ClarifyAction
  readonly binding: ClarifyBinding
  readonly expiresAt: number
}

const TRAILING = /[\s.!?,;:…]+$/u

function requestFromAnswer(action: ClarifyAction, raw: string): DesktopActionRequest | null {
  const slot = raw.normalize('NFC').trim().replace(TRAILING, '').trim()
  if (!slot) return null
  return validateDesktopRequest(
    action === 'desktop.create_note'
      ? { id: 'desktop.create_note', args: { title: slot } }
      : { id: 'desktop.google_search', args: { q: slot } }
  )
}

export function createClarifyMachine(deps: { now(): number; ttlMs?: number }): ClarifyMachine {
  const ttlMs = deps.ttlMs ?? CLARIFY_TTL_MS
  let pending: Pending | null = null

  return {
    open({ action, missing, binding }) {
      const expiresAt = deps.now() + ttlMs
      pending = { action, binding, expiresAt }
      return { question: clarifyQuestionCopy(action, missing), action, taskId: binding.taskId, expiresAt }
    },
    answer(record, binding) {
      const current = pending
      if (!current) return { kind: 'none' }
      if (deps.now() >= current.expiresAt) {
        pending = null
        return {
          kind: 'ended',
          reason: 'expired',
          copy: clarifyEndCopy(current.action, 'expired'),
          action: current.action
        }
      }
      // Content is data, whatever it says: it is not an answer and does not disturb the question.
      if (!mayProposeActions(record)) return { kind: 'not_an_answer' }
      // The live owner changed: the question belonged to someone else and is gone.
      if (!binding || binding.ownerId !== current.binding.ownerId) {
        pending = null
        return { kind: 'none' }
      }
      if (binding.sessionId !== current.binding.sessionId || binding.taskId !== current.binding.taskId) {
        return { kind: 'not_an_answer' }
      }
      const spoken = parseVoiceUtterance(record.text)
      if (spoken.kind === 'cancelled') {
        pending = null
        return {
          kind: 'ended',
          reason: 'cancelled',
          copy: clarifyEndCopy(current.action, 'cancelled'),
          action: current.action
        }
      }
      // A complete new command is a new request, not the answer to this one.
      if (spoken.kind === 'action') {
        pending = null
        return { kind: 'not_an_answer' }
      }
      pending = null
      const request = requestFromAnswer(current.action, record.text)
      if (!request) {
        return {
          kind: 'ended',
          reason: 'gave_up',
          copy: clarifyEndCopy(current.action, 'gave_up'),
          action: current.action
        }
      }
      return { kind: 'complete', request, taskId: current.binding.taskId }
    },
    drop() {
      const had = pending !== null
      pending = null
      return had
    },
    pending: () => pending !== null
  }
}
