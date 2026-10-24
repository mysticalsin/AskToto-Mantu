export {
  createSpeechPackService,
  type SpeechPackService,
  type SpeechPackActionRequest,
  type SpeechPackActionResult,
  type SpeechPackInstallWithPlanRequest,
  type SpeechPackInstallWithPlanResult,
  type SpeechPackPlanPreviewRequest,
  type SpeechPackPlanPreviewResult,
  type SpeechPackSnapshot,
  type SpeechPackProgress
} from './speech-pack/service'
export { componentManifestIdentity, resolveSpeechPack, type SpeechPackReadiness } from './speech-pack/resolver'
export { readSpeechPackProfile, type SpeechPackProfileRead } from './speech-pack/profile'
export {
  readPackageRuntimeContract,
  createPackageRuntimeContractProvider,
  type PackageInventoryCoreFile,
  type PackageInventoryV1,
  type PackageRuntimeContract,
  type PackageRuntimeContractOptions
} from './speech-pack/package-contract'
export {
  configurePackageRuntimeContractProvider,
  getPackageRuntimeContract,
  legacyRuntimeClosureAvailable,
  assertLegacyRuntimeClosure
} from './speech-pack/package-runtime-state'
export {
  OPTIONAL_RUNTIME_COMPONENTS,
  resolveOptionalRuntimeReadiness,
  runtimeHostFacts,
  runtimeIdsForEngine,
  runtimeIdsForLocalLlm,
  type OptionalRuntimeComponent,
  type OptionalRuntimeComponentId,
  type OptionalRuntimeFeature,
  type OptionalRuntimeHost,
  type OptionalRuntimeHostFacts,
  type OptionalRuntimeReadiness,
  type OptionalRuntimeAbiKind,
  type OptionalRuntimeTarget
} from './speech-pack/runtime-components'
export {
  SPEECH_PACK_COMPONENTS,
  PARAKEET_TDT_V3_INT8,
  WHISPER_BASE_Q8,
  type SpeechPackComponentId
} from './speech-pack/manifest'
export {
  createComponentOffloadService,
  type ComponentOffloadDeps,
  type ComponentOffloadService,
  type OffloadTarget
} from './offload/service'
export { createOffloadReceiptStore, type OffloadReceiptStore } from './offload/receipts'
export { createLocalModelTarget, createSpeechPackTarget } from './offload/targets'
export type { LocalModelFacts } from './speech-pack/optional-components'
