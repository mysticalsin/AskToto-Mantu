/** Public surface of the user-memory feature (G57). Other modules reach it only through this file. */
export {
  createUserMemory,
  currentUserMemory,
  installUserMemory,
  type UserMemory,
  type UserMemoryPromptBlocks
} from './user-memory'
export { parseRememberIntent, type RememberIntent } from './user-memory-intent'
export {
  createUserMemoryStore,
  type Retrieved,
  type UserMemoryStore,
  type UserMemoryStoreDeps
} from './user-memory-store'
