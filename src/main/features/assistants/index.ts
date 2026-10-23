/** Public surface of the assistants feature (G48). Other modules reach it only through this file. */
export {
  createAssistantService,
  type AssistantAuditPhase,
  type AssistantService,
  type AssistantServiceDeps
} from './assistant-service'
export { createAssistantStore, type AssistantFileIo, type AssistantScope, type AssistantStore } from './assistant-store'
export type { CustomMode } from './assistant-model'
