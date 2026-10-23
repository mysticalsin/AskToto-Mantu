/**
 * Single-use nonce memory (G37). A nonce is remembered until its envelope expires, so a replay inside the window
 * is refused and the ledger stays small. It fails closed when full: refusing a new handoff is safe, forgetting an
 * old nonce is not. An optional store keeps it across a restart inside the 15 minute window.
 */
export const NONCE_LEDGER_MAX = 512

export interface NonceStore {
  load(): Promise<Record<string, number>>
  save(entries: Record<string, number>): Promise<void>
}

export interface NonceLedger {
  /** Loads the remembered nonces. Await it before the first `consume`. Never rejects. */
  hydrate(): Promise<void>
  consume(nonce: string, expiresAt: number): 'ok' | 'replayed' | 'full'
  size(): number
}

export function createNonceLedger(deps: { now: () => number; store?: NonceStore; max?: number }): NonceLedger {
  const max = deps.max ?? NONCE_LEDGER_MAX
  const seen = new Map<string, number>()
  const prune = (): void => {
    const now = deps.now()
    for (const [nonce, expiresAt] of seen) if (expiresAt <= now) seen.delete(nonce)
  }
  return {
    async hydrate() {
      try {
        for (const [nonce, expiresAt] of Object.entries((await deps.store?.load()) ?? {})) {
          if (typeof expiresAt === 'number') seen.set(nonce, expiresAt)
        }
      } catch {
        // An unreadable store starts empty; the envelope window is still bounded to 15 minutes.
      }
    },
    consume(nonce, expiresAt) {
      prune()
      if (seen.has(nonce)) return 'replayed'
      if (seen.size >= max) return 'full'
      seen.set(nonce, expiresAt)
      // Memory still refuses a replay in this run if the write fails.
      void deps.store?.save(Object.fromEntries(seen)).catch(() => undefined)
      return 'ok'
    },
    size() {
      prune()
      return seen.size
    }
  }
}
