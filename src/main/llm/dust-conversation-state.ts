/**
 * What persisted conversations (G49) need to know about the remote Dust conversation: which epoch it is in (bumped on
 * every reset, so a stamped thread can tell its remote one was dropped), whether one is held, and how long it lives.
 * dust.ts registers its state here when it loads, so the conversation wiring does not import the provider.
 */
export interface DustConversationState {
  epoch: number
  active: boolean
  ttlMs: number
}

let provider: (() => DustConversationState) | null = null

export function registerDustConversationState(read: () => DustConversationState): void {
  provider = read
}

/** Without a registered provider no remote conversation is held, so nothing is stamped and nothing is lost. */
export function dustConversationState(): DustConversationState {
  return provider ? provider() : { epoch: 0, active: false, ttlMs: 0 }
}
