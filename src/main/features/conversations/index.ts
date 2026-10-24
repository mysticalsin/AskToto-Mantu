/** Public surface of the conversations feature (G49). Other modules reach it only through this file. */
export {
  createConversationService,
  type ConversationAuditPhase,
  type ConversationService,
  type ConversationServiceDeps
} from './conversation-service'
export { createConversationStore, type ConversationStore, type ConversationStoreDeps } from './conversation-store'
