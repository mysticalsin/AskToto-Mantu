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
  /** Loads the remembered nonces. Never rejects; `consume` retries it until it has succeeded. */
  hydrate(): Promise<void>
  /**
   * Resolves only after the nonce is durable. `unavailable` means the store could not be read or written: the
   * handoff must be refused, because an unrecorded nonce could be replayed after a restart.
   */
  consume(nonce: string, expiresAt: number): Promise<'ok' | 'replayed' | 'full' | 'unavailable'>
  size(): number
}

export function createNonceLedger(deps: { now: () => number; store?: NonceStore; max?: number }): NonceLedger {
  const max = deps.max ?? NONCE_LEDGER_MAX
  const seen = new Map<string, number>()
  let hydrated = !deps.store
  let queue: Promise<unknown> = Promise.resolve()
  const prune = (): void => {
    const now = deps.now()
    for (const [nonce, expiresAt] of seen) if (expiresAt <= now) seen.delete(nonce)
  }
  /** True once the durable entries are in memory. A missing store file is empty; a corrupt one is a failure. */
  const load = async (): Promise<boolean> => {
    if (hydrated) return true
    try {
      for (const [nonce, expiresAt] of Object.entries((await deps.store?.load()) ?? {})) {
        if (typeof expiresAt === 'number') seen.set(nonce, expiresAt)
      }
      hydrated = true
    } catch {
      // Stays unhydrated: consume fails closed and the next call tries again.
    }
    return hydrated
  }
  const consumeNow = async (nonce: string, expiresAt: number): Promise<'ok' | 'replayed' | 'full' | 'unavailable'> => {
    if (!(await load())) return 'unavailable'
    prune()
    if (seen.has(nonce)) return 'replayed'
    if (seen.size >= max) return 'full'
    seen.set(nonce, expiresAt)
    try {
      await deps.store?.save(Object.fromEntries(seen))
    } catch {
      // Memory keeps the nonce (this run still refuses a replay), but the caller must not accept the handoff.
      return 'unavailable'
    }
    return 'ok'
  }
  return {
    async hydrate() {
      await load()
    },
    consume(nonce, expiresAt) {
      // One consume at a time: each save sees every earlier nonce, and a replay waits for the first to finish.
      const run = queue.then(() => consumeNow(nonce, expiresAt))
      queue = run.catch(() => undefined)
      return run
    },
    size() {
      prune()
      return seen.size
    }
  }
}
