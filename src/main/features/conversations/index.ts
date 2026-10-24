/** Public surface of the conversations feature (G49, G50). Other modules reach it only through this file. */
export {
  createConversationService,
  type ConversationAuditPhase,
  type ConversationService,
  type ConversationServiceDeps
} from './conversation-service'
export { createConversationStore, type ConversationStore, type ConversationStoreDeps } from './conversation-store'
export {
  createWorkspaceService,
  type WorkspaceAuditPhase,
  type WorkspaceService,
  type WorkspaceServiceDeps
} from './workspace-service'
export { createWorkspaceStore, type WorkspaceStore, type WorkspaceStoreDeps } from './workspace-store'
