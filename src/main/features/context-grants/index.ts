/** Public surface of the context-grants feature (G46). Other modules reach it only through this file. */
export { applyAmbientScreenContext } from './ambient-screen'
export { createDocumentGrants, type DocumentGrants } from './document-grants'
export { createManifestCollector, createManifestLog, type ManifestCollector, type ManifestLog } from './manifest'
export { createContextRuntime, type ContextRuntime, type TurnExtras, type TurnInput } from './runtime'
export { createSnapshotStore, type ObservedContent, type SnapshotIo, type SnapshotStore } from './snapshot-store'
export { composeContextGrants } from './compose'
export { createContextGrants, type ContextGrants, type ContextGrantsDeps } from './wiring'
