/**
 * The two typed ports between a dictation session (G22) and the operating system. The session decides when and
 * whether to dictate; the ports are the only way it can look at another application or write into one.
 *
 * Both are unsupported in production until G23 (macOS accessibility insertion) and G24 (Windows UI Automation):
 * `UNSUPPORTED_DICTATION_PORTS` is what ships. Tests drive the session with synthetic ports. Nothing in this file
 * sends input events, reads or writes pasteboards or runs native code.
 */
import type { DictationInsertRequest, DictationReceipt, DictationTarget } from '../desktop-contract'

/** Why no target could be bound. Machine reasons only. */
export type DictationTargetUnavailable = 'unsupported' | 'no_focus' | 'secure_field' | 'permission'

export type DictationTargetObservation =
  /** A fresh snapshot of the focused field (`observedAtMs` is the observation time, not a cached one). */
  | { readonly kind: 'target'; readonly target: DictationTarget }
  | { readonly kind: 'unavailable'; readonly reason: DictationTargetUnavailable }

/** The focused app and field fingerprint, observed by a trusted OS adapter (G23, G24). */
export interface DictationTargetSource {
  captureTarget(): Promise<DictationTargetObservation>
}

export type DictationInsertionResult =
  /** The adapter cannot insert on this build or platform. Nothing was written. */
  | { readonly outcome: 'unsupported' }
  /** Written and read back. The receipt must match the bound target, the text hash and the arguments hash. */
  | {
      readonly outcome: 'verified'
      readonly receipt: Partial<DictationReceipt>
      readonly evidenceId: string
    }
  | { readonly outcome: 'no_effect' | 'uncertain'; readonly evidenceId: string }

/**
 * Insertion is atomic and compare-first in the native adapter: it re-checks the target in the same step as the
 * write. It is handed exactly the guard's one-use request (the immutable arguments and their hash, which the
 * receipt must echo) and nothing else.
 */
export interface DictationInsertionPort {
  insert(request: DictationInsertRequest): Promise<DictationInsertionResult>
}

export interface DictationHostPorts {
  readonly target: DictationTargetSource
  readonly insertion: DictationInsertionPort
}

/** What ships until G23 and G24: no target can be bound, so a dictation is refused before the microphone opens. */
export const UNSUPPORTED_DICTATION_PORTS: DictationHostPorts = Object.freeze({
  target: Object.freeze({
    async captureTarget(): Promise<DictationTargetObservation> {
      return { kind: 'unavailable', reason: 'unsupported' }
    }
  }),
  insertion: Object.freeze({
    async insert(): Promise<DictationInsertionResult> {
      return { outcome: 'unsupported' }
    }
  })
})
