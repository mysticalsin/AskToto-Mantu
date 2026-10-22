import { createHash } from 'node:crypto'
import type { DesktopActionReceipt, DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'

/**
 * Pure ActionGuard rules for confirmed desktop commands (G04, ported from the 2.12 reference kernel):
 *   - approval binds the exact request through an argsHash, not only a nonce;
 *   - an action may depend on earlier actions, and only a verified dependency unlocks it;
 *   - every dispatch carries a deterministic idempotency key;
 *   - an effect is verified only by an observed receipt bound to that key and hash.
 * The proposal lifecycle lives in CommandControl and the durable lifecycle in the task bridge. This module
 * holds the rules both share so they cannot drift apart. It performs no I/O and owns no state.
 */

/** Longest dependency list a single action may carry. */
export const ACTION_DEPENDENCY_LIMIT = 16
/** Longest observation text kept from a receipt. */
export const ACTION_OBSERVATION_MAX_CHARS = 1_000

/** The identity an adapter must echo in its receipt. Main derives it; the renderer never supplies it. */
export type ActionEnvelope = { argsHash: string; idempotencyKey: string }

/** Stable text for hashing: key order must not change the identity of the same request. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Hash of the whole request (action id and arguments). The same value is the task's arguments digest. */
export function actionArgsHash(request: DesktopActionRequest): string {
  return sha256Hex(request)
}

/**
 * Deterministic per proposal: the same confirmed proposal always yields the same key, a different proposal or
 * different arguments never do. An adapter that can deduplicate may use it; a receipt must echo it.
 */
export function actionIdempotencyKey(proposalId: string, argsHash: string): string {
  return sha256Hex(['desktop-action', proposalId, argsHash])
}

export function actionEnvelope(proposalId: string, request: DesktopActionRequest): ActionEnvelope {
  const argsHash = actionArgsHash(request)
  return { argsHash, idempotencyKey: actionIdempotencyKey(proposalId, argsHash) }
}

/** Constant-shape check that a client-supplied hash is a SHA-256 hex digest. */
export function isArgsHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export type DependencyCheck =
  | { ok: true; dependsOn: readonly string[] }
  | { ok: false; reason: 'DEPENDENCY_LIMIT' | 'DEPENDENCY_INVALID' | 'DEPENDENCY_DUPLICATE' }

/** Dependencies are proposal ids: a bounded list of unique 32-hex ids. */
export function checkDependsOn(dependsOn: unknown): DependencyCheck {
  if (!Array.isArray(dependsOn)) return { ok: false, reason: 'DEPENDENCY_INVALID' }
  if (dependsOn.length > ACTION_DEPENDENCY_LIMIT) return { ok: false, reason: 'DEPENDENCY_LIMIT' }
  if (!dependsOn.every((id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))) {
    return { ok: false, reason: 'DEPENDENCY_INVALID' }
  }
  if (new Set(dependsOn).size !== dependsOn.length) return { ok: false, reason: 'DEPENDENCY_DUPLICATE' }
  return { ok: true, dependsOn: Object.freeze([...(dependsOn as string[])]) }
}

/** A receipt proves an effect only when it names this exact dispatch and carries a non-empty observation. */
export function isBoundReceipt(receipt: DesktopActionReceipt | undefined, envelope: ActionEnvelope): boolean {
  return (
    !!receipt &&
    receipt.idempotencyKey === envelope.idempotencyKey &&
    receipt.argsHash === envelope.argsHash &&
    typeof receipt.observation === 'string' &&
    receipt.observation.trim().length > 0 &&
    receipt.observation.length <= ACTION_OBSERVATION_MAX_CHARS
  )
}

/**
 * The observed-receipt rule: `verified` is a claim, a bound receipt is the evidence. A verified result for the
 * requested action without a matching receipt stays unverified, so it is never reported as done and never replayed.
 */
export function isObservedVerified(
  request: DesktopActionRequest,
  result: DesktopActionResult,
  envelope: ActionEnvelope
): boolean {
  return (
    result.id === request.id && result.ok && result.outcome === 'verified' && isBoundReceipt(result.receipt, envelope)
  )
}
