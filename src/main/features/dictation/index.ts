/** Public surface of the dictation feature (G22). Other modules reach it only through this file. */
export {
  createDictationRuntime,
  type DictationRuntime,
  type DictationRuntimeDeps
} from './dictation-runtime'
export {
  UNSUPPORTED_DICTATION_PORTS,
  type DictationHostPorts,
  type DictationInsertionPort,
  type DictationInsertionResult,
  type DictationTargetObservation,
  type DictationTargetSource,
  type DictationTargetUnavailable
} from './dictation-ports'
export type { DictationReason, DictationSnapshot, DictationUiState } from './dictation-session'
