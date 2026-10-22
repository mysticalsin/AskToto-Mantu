/**
 * Public surface of the desktop-contract feature. Other features reach it only through this file (FF-01).
 *
 * Exported: the dictation target guard (G07 port, consumed by the dictation session, G22) and the contract error it
 * throws. The routine coordinator is deliberately not exported: nothing consumes it yet (G66/G69), and an export
 * here would be a dead import written to satisfy the reachability ratchet.
 */
export { DesktopContractError } from './contract-data'
export {
  DictationTargetGuard,
  MAX_PRIOR_DRAFTS,
  type DictationActor,
  type DictationContext,
  type DictationInsertArgs,
  type DictationInsertRequest,
  type DictationInspection,
  type DictationLease,
  type DictationMode,
  type DictationReceipt,
  type DictationState,
  type DictationTarget,
  type PriorDraft
} from './dictation-target-guard'
