/**
 * macOS dictation ports (G23): the typed adapter between a dictation session (G22) and the metis-mac-helper
 * `ax-focus-snapshot` / `ax-insert` commands.
 *
 * - `captureTarget` turns one focused-field snapshot into the guard's `DictationTarget`. The field's text never
 *   crosses: the target carries its SHA-256, its length and the selection, which is exactly what the helper
 *   compares again at the moment of the write (compare-and-insert). Nothing about the field is kept here, so there
 *   is no stale state to trust.
 * - `insert` hands the helper the guard's one-use request. The helper re-resolves the focused field, refuses a secure
 *   field always and anything that no longer matches, writes through Accessibility (a paste only when Accessibility
 *   refused the write; terminals are paste-only, inert, never a Return) and reads the value back.
 *
 * Outcomes are `inserted_verified`, `inserted_unverified` and `refused(secure_field | target_changed | permission |
 * unsupported)`. Only a verified readback may become a guard receipt. Audit metadata never carries text.
 */
import { createHash } from 'node:crypto'
import type { DictationInsertRequest, DictationTarget } from '../desktop-contract'
import {
  macAxHelperClient,
  type AxFocusSnapshot,
  type AxHelperClient,
  type AxInsertResult,
  type AxRefusalReason
} from '../../mac-ax-helper'
import { macHelperPresent } from '../../mac-helper'
import type {
  DictationHostPorts,
  DictationInsertionPort,
  DictationInsertionResult,
  DictationTargetObservation,
  DictationTargetSource
} from './dictation-ports'

export type MacInsertOutcome =
  | { readonly kind: 'inserted_verified'; readonly method: 'ax' | 'paste' }
  | { readonly kind: 'inserted_unverified'; readonly method: 'ax' | 'paste' }
  | { readonly kind: 'refused'; readonly reason: 'secure_field' | 'target_changed' | 'permission' | 'unsupported' }

/** Metadata only: an enum outcome, a method, flags and a length. Never the text, a hash of it, an app or a field. */
export interface MacInsertAudit {
  readonly outcome: MacInsertOutcome['kind']
  readonly reason?: string
  readonly method?: 'ax' | 'paste'
  readonly terminal: boolean
  readonly sanitized: boolean
  readonly textLength: number
  readonly clipboard: AxInsertResult['clipboard']
}

export interface MacDictationPortsDeps {
  /** Defaults to the real helper client. */
  client?: AxHelperClient
  /** Whether the helper exists on this build. Defaults to the real check. */
  helperPresent?: () => boolean
  platform?: NodeJS.Platform
  /**
   * The one platform this adapter serves. Defaults to 'darwin'; the Windows backend (G24, dictation-insert-win.ts)
   * reuses this whole adapter (target binding, helper request, outcome classification, audit) over its own client.
   */
  expectedPlatform?: NodeJS.Platform
  /** The clock the guard measures target freshness with. */
  now?: () => number
  audit?: (detail: MacInsertAudit) => void
}

const fnv32 = (text: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** `<value sha256>.<length>.<selection start>.<selection length>`: the revision the helper compares again. */
const REVISION = /^([0-9a-f]{64})\.(\d{1,8})\.(\d{1,8})\.(\d{1,8})$/
const PROCESS_INSTANCE = /^p(\d{1,10})\.(\d{1,16})$/

/** The guard's target for one snapshot, or the reason none can be bound. Pure. */
export function targetFromSnapshot(snapshot: AxFocusSnapshot | null, observedAtMs: number): DictationTargetObservation {
  if (snapshot === null) return { kind: 'unavailable', reason: 'unsupported' }
  if (snapshot.status === 'permission') return { kind: 'unavailable', reason: 'permission' }
  if (snapshot.status === 'no_focus') return { kind: 'unavailable', reason: 'no_focus' }
  // A secure field is never bound, whatever else the snapshot says.
  if (snapshot.secure) return { kind: 'unavailable', reason: 'secure_field' }
  const { pid, bundleId, processStartMs, windowId, token, valueHash, valueLength, selection } = snapshot
  if (
    pid === null ||
    bundleId === null ||
    processStartMs === null ||
    windowId === null ||
    token === null ||
    valueHash === null ||
    valueLength === null ||
    selection === null ||
    snapshot.valueTooLarge
  ) {
    return { kind: 'unavailable', reason: 'unsupported' }
  }
  const target: DictationTarget = {
    appId: bundleId,
    processInstanceId: `p${pid}.${processStartMs}`,
    windowId,
    elementId: token,
    focusRevision: fnv32(token),
    selectionRevision: fnv32(`${selection.location}:${selection.length}`),
    documentRevision: `${valueHash}.${valueLength}.${selection.location}.${selection.length}`,
    editable: snapshot.editable,
    secure: false,
    observedAtMs
  }
  return { kind: 'target', target }
}

type HelperRequest = Parameters<AxHelperClient['insert']>[0]

/** The helper request that re-states exactly what the target bound, or null when the target is not one of ours. */
export function helperRequestFor(request: DictationInsertRequest): HelperRequest | null {
  const { target, text } = request.args
  const revision = REVISION.exec(target.documentRevision)
  const instance = PROCESS_INSTANCE.exec(target.processInstanceId)
  if (!revision || !instance || target.secure || !target.editable || text.length === 0) return null
  const pid = Number(instance[1])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return null
  return {
    pid,
    windowId: target.windowId,
    token: target.elementId,
    valueHash: revision[1],
    valueLength: Number(revision[2]),
    selectionLocation: Number(revision[3]),
    selectionLength: Number(revision[4]),
    text,
    allowPaste: true
  }
}

function classify(result: AxInsertResult): MacInsertOutcome {
  if (result.outcome === 'verified')
    return { kind: 'inserted_verified', method: result.method === 'paste' ? 'paste' : 'ax' }
  if (result.outcome === 'unverified')
    return { kind: 'inserted_unverified', method: result.method === 'paste' ? 'paste' : 'ax' }
  const reason: AxRefusalReason | null = result.reason
  if (result.outcome === 'unsupported') return { kind: 'refused', reason: 'unsupported' }
  if (reason === 'secure_field' || reason === 'permission' || reason === 'unsupported')
    return { kind: 'refused', reason }
  return { kind: 'refused', reason: 'target_changed' }
}

export function createMacDictationPorts(deps: MacDictationPortsDeps = {}): DictationHostPorts {
  const client = deps.client ?? macAxHelperClient
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const present = deps.helperPresent ?? (() => macHelperPresent(platform))
  const usable = (): boolean => platform === (deps.expectedPlatform ?? 'darwin') && present()
  const audit = (detail: MacInsertAudit): void => {
    try {
      deps.audit?.(detail)
    } catch {
      /* an audit sink can never change what was written */
    }
  }
  const auditOnly = (
    outcome: MacInsertOutcome,
    request: DictationInsertRequest,
    result: AxInsertResult | null
  ): void => {
    audit({
      outcome: outcome.kind,
      ...(outcome.kind === 'refused' ? { reason: outcome.reason } : { method: outcome.method }),
      terminal: result?.terminal ?? false,
      sanitized: result?.sanitized ?? false,
      textLength: request.args.text.length,
      clipboard: result?.clipboard ?? 'not_used'
    })
  }

  const target: DictationTargetSource = {
    async captureTarget(): Promise<DictationTargetObservation> {
      if (!usable()) return { kind: 'unavailable', reason: 'unsupported' }
      let snapshot: AxFocusSnapshot | null
      try {
        snapshot = await client.snapshot()
      } catch {
        snapshot = null
      }
      // Stamped after the read returned: the guard measures freshness from the observation, not the request.
      return targetFromSnapshot(snapshot, now())
    }
  }

  const insertion: DictationInsertionPort = {
    async insert(request: DictationInsertRequest): Promise<DictationInsertionResult> {
      if (!usable()) return { outcome: 'unsupported' }
      const helperRequest = helperRequestFor(request)
      if (helperRequest === null) {
        auditOnly({ kind: 'refused', reason: 'target_changed' }, request, null)
        return { outcome: 'no_effect', evidenceId: 'ax:refused:target_changed' }
      }
      let result: AxInsertResult | null
      try {
        result = await client.insert(helperRequest)
      } catch {
        result = null
      }
      if (result === null) {
        // The helper died, timed out or answered nonsense after it may have written. Never retried, never verified.
        audit({
          outcome: 'inserted_unverified',
          terminal: false,
          sanitized: false,
          textLength: request.args.text.length,
          clipboard: 'not_used'
        })
        return { outcome: 'uncertain', evidenceId: 'ax:helper-failed' }
      }
      const outcome = classify(result)
      auditOnly(outcome, request, result)
      if (outcome.kind === 'refused') {
        return outcome.reason === 'unsupported'
          ? { outcome: 'unsupported' }
          : { outcome: 'no_effect', evidenceId: `ax:refused:${outcome.reason}` }
      }
      if (outcome.kind === 'inserted_unverified')
        return { outcome: 'uncertain', evidenceId: `ax:unverified:${outcome.method}` }
      // A verified claim must name the text the helper reports writing. A terminal may have made it inert (spaces for
      // line breaks, control characters dropped), which is then the one allowed difference.
      if (result.textHash === null || (!result.sanitized && result.textHash !== sha256(request.args.text))) {
        return { outcome: 'uncertain', evidenceId: 'ax:text-hash-mismatch' }
      }
      return {
        outcome: 'verified',
        receipt: {
          operationId: request.args.operationId,
          argsHash: request.argsHash,
          targetFingerprint: request.args.targetFingerprint,
          textHash: request.args.textHash
        },
        evidenceId: `ax:verified:${outcome.method}${result.sanitized ? ':inert' : ''}`
      }
    }
  }
  return Object.freeze({ target, insertion })
}
