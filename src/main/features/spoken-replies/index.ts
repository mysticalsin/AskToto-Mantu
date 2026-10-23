/** Public surface of the spoken replies feature (G27). Other modules reach it only through this file. */
export { createSpokenRepliesRuntime, type SpokenRepliesRuntimeDeps } from './spoken-replies-runtime'
export type { AskObservation, BargeInReason, SpokenReplies } from './spoken-replies-service'
