/** The partition in force and the verified owner and tenant keys. */
export interface SealedScope {
  partitionId: string
  ownerKey: string
  tenantKey: string
}

/** What every document must carry so the store can prove it belongs to the scope in force. */
export interface SealedScopedDoc {
  partitionId: string
  ownerKey: string
  tenantKey: string
}

export interface SealedScopedIo {
  /** `name` picks one of several documents inside a partition; omitted for a store with one document per partition. */
  read(partitionId: string, name?: string): Promise<Buffer | null>
  write(partitionId: string, data: Buffer, name?: string): Promise<void>
}

export interface SealedScopedStoreDeps<D extends SealedScopedDoc> {
  schema: { safeParse(raw: unknown): { success: true; data: D } | { success: false } }
  /** The document for a scope when nothing is stored yet. */
  empty(scope: SealedScope, name: string | undefined): D
  /** An extra proof the opened document is the one asked for (for example its own id equals `name`). */
  accept?(doc: D, name: string | undefined): boolean
  io: SealedScopedIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): SealedScope | null
}

export type DocOutcome<D, T> = { commit: false; value: T } | { commit: true; doc: D; value: T }
export type TxResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed-out' | 'unavailable' | 'stale' }

export interface SealedScopedStore<D extends SealedScopedDoc> {
  /**
   * Runs `fn` over the stored document and, when it asks to commit, writes it sealed. Transactions run one at a time.
   * The transaction is refused (`stale`) if the expected scope changed before it starts, while it reads, or before it
   * writes. A write already in flight stays bound to its captured partition, and its result is withheld if scope changes.
   * A file that cannot be opened or validated, or that belongs to another owner, tenant or partition, is never overwritten.
   */
  transact<T>(
    fn: (doc: D, scope: SealedScope) => DocOutcome<D, T>,
    expectedScope?: SealedScope,
    name?: string
  ): Promise<TxResult<T>>
}

export const sameSealedScope = (a: SealedScope, b: SealedScope | null): boolean =>
  b !== null && a.partitionId === b.partitionId && a.ownerKey === b.ownerKey && a.tenantKey === b.tenantKey

export function createSealedScopedStore<D extends SealedScopedDoc>(
  deps: SealedScopedStoreDeps<D>
): SealedScopedStore<D> {
  let tail: Promise<unknown> = Promise.resolve()

  const load = async (scope: SealedScope, name: string | undefined): Promise<D | null> => {
    const bytes = await deps.io.read(scope.partitionId, name)
    if (bytes === null) return deps.empty(scope, name)
    try {
      const parsed = deps.schema.safeParse(JSON.parse(deps.open(bytes)))
      return parsed.success &&
        parsed.data.partitionId === scope.partitionId &&
        parsed.data.ownerKey === scope.ownerKey &&
        parsed.data.tenantKey === scope.tenantKey &&
        (deps.accept?.(parsed.data, name) ?? true)
        ? parsed.data
        : null
    } catch {
      return null
    }
  }

  const run = async <T>(
    fn: (doc: D, scope: SealedScope) => DocOutcome<D, T>,
    expectedScope: SealedScope | undefined,
    name: string | undefined
  ): Promise<TxResult<T>> => {
    const scope = deps.scope()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    if (expectedScope && !sameSealedScope(expectedScope, scope)) return { ok: false, reason: 'stale' }
    let doc: D | null
    try {
      doc = await load(scope, name)
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!sameSealedScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    if (doc === null) return { ok: false, reason: 'unavailable' }
    let outcome: DocOutcome<D, T>
    try {
      outcome = fn(doc, scope)
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    if (!outcome.commit) return { ok: true, value: outcome.value }
    const next: D = {
      ...outcome.doc,
      v: 1,
      partitionId: scope.partitionId,
      ownerKey: scope.ownerKey,
      tenantKey: scope.tenantKey
    }
    if (!sameSealedScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    try {
      await deps.io.write(scope.partitionId, deps.seal(JSON.stringify(next)), name)
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    // The write was bound to the captured partition, but its result must not be delivered after an owner switch.
    if (!sameSealedScope(scope, deps.scope())) return { ok: false, reason: 'stale' }
    return { ok: true, value: outcome.value }
  }

  return {
    transact<T>(
      fn: (doc: D, scope: SealedScope) => DocOutcome<D, T>,
      expectedScope?: SealedScope,
      name?: string
    ): Promise<TxResult<T>> {
      const result = tail.then(() => run(fn, expectedScope, name))
      tail = result.catch(() => undefined)
      return result
    }
  }
}
