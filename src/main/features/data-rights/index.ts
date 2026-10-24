/** Public surface of the data-rights feature (G82). Other modules reach it only through this file. */
export {
  createDataRightsService,
  type DataRightsScope,
  type DataRightsService,
  type DataRightsServiceDeps
} from './service'
export { runErasure, type ErasureDeps, type StoreEraser } from './erasure-orchestrator'
export { createProductionErasers, type ErasureHost } from './erasers'
export { createDataExport, type DataExportDeps } from './data-export'
