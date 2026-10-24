/** Public surface of the read-only research and suggestion pipeline (G67). Other modules reach it only through this file. */
export { createReadOnlyConnectorPort, ResearchWriteRefused, type ReadOnlyConnectorPort } from './read-only-port'
export {
  createRoutineResearchPort,
  createSuggestionService,
  type RoutineResearchResult,
  type SuggestionAuditPhase,
  type SuggestionAuditRecord,
  type SuggestionService,
  type SuggestionServiceDeps
} from './service'
export { calendarSource, memorySource, type ResearchSource } from './sources'
export { createSuggestionStore, type SuggestionFileIo, type SuggestionScope, type SuggestionStore } from './store'
