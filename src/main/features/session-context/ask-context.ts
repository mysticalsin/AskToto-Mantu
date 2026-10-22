import type { AskStart } from '@shared/ipc'
import { redactSecrets } from '@shared/redact'
import type { ContextCheck, FrameKey, MeetingContextRegistry } from './meeting-context-registry'
import { fillSlots, lastThemText, transcriptTailText } from './transcript-text'

/** Shown instead of an answer that would have been built from nothing. */
export const NO_CONVERSATION_MESSAGE = 'Métis has no live conversation to use yet. Start listening, then ask again.'
/** Shown instead of an answer built from a context that is no longer in force. */
export const STALE_CONVERSATION_MESSAGE = 'The conversation changed while this answer was starting. Ask again.'
/** A suggestion cannot be built from renderer-supplied text any more; the request must name its context. */
export const MISSING_CONTEXT_MESSAGE = 'Could not start the answer.'

export interface AskContextDeps {
  readonly registry: Pick<MeetingContextRegistry, 'acquire'>
  /** The sender's frame, from the IPC event (never from the payload). */
  readonly frame: FrameKey | null | undefined
  /** `settings.redactSensitive`: strip high-confidence secrets from captured speech before it leaves the device. */
  readonly redact: boolean
}

/** Modes whose only transcript source used to be the renderer's `transcript` field. Recap and summary keep theirs. */
const MAIN_DERIVED_MODES: ReadonlySet<string> = new Set(['suggest', 'answer', 'vision'])

/**
 * Applies a request's declared conversation context from the main-owned snapshot, in place, and returns the refusal
 * message when the ask must not run. The transcript the renderer may have put on a suggest, answer or vision request is
 * discarded first: only text from a SessionContext snapshot of the ledger main owns reaches the prompt, redacted here,
 * before the request is handed to any provider. Typed text is never touched. Recap and summary requests, whose
 * transcript is the saved meeting, pass through unchanged.
 */
export function applyAskContext(req: AskStart, deps: AskContextDeps, gate: AskContextGate): string | null {
  const request = req.context
  req.context = undefined
  gate.clear()
  if (MAIN_DERIVED_MODES.has(req.mode)) req.transcript = undefined
  if (!request) return req.mode === 'suggest' ? MISSING_CONTEXT_MESSAGE : redactCarried(req, deps)

  const handle = deps.frame ? deps.registry.acquire(deps.frame, request.kind) : null
  const redact = (text: string): string => (deps.redact ? redactSecrets(text) : text)
  const transcript = handle ? redact(transcriptTailText(handle.snapshot, request.tailChars)) : ''
  if (request.requireTranscript && !transcript.trim()) return NO_CONVERSATION_MESSAGE
  // With no line from the other side yet, the claim falls back to the bounded transcript, as the renderer used to.
  const lastThem = (handle ? redact(lastThemText(handle.snapshot, request.tailChars)) : '') || transcript
  req.prompt = fillSlots(req.prompt, { transcript, lastThem })
  if (request.field) req.transcript = transcript
  if (handle) gate.arm(() => handle.check())
  return redactCarried(req, deps)
}

/** The renderer-supplied `transcript` that remains (recap and summary) is redacted exactly as before. */
function redactCarried(req: AskStart, deps: AskContextDeps): null {
  if (deps.redact && req.transcript) req.transcript = redactSecrets(req.transcript)
  return null
}

/**
 * One ask's freshness gate. `refusal()` is asked at every provider dispatch (the first attempt, a retry, a failover,
 * a hedged leg): it is null while the snapshot the prompt was built from is still the one in force, or only the
 * transcript has moved on (the answer is for the moment the user asked), and a message once the session stopped, the
 * meeting changed, or permissions changed since.
 */
export interface AskContextGate {
  arm(check: () => ContextCheck): void
  clear(): void
  refusal(): string | null
}

export function createAskContextGate(): AskContextGate {
  let check: (() => ContextCheck) | null = null
  return {
    arm: (next) => {
      check = next
    },
    clear: () => {
      check = null
    },
    refusal: () => {
      const result = check?.()
      return result?.state === 'stale' ? STALE_CONVERSATION_MESSAGE : null
    }
  }
}
