import { z } from 'zod'
import type { MemoryScope } from '@shared/contracts/memory-partition'
import { verifiedMemoryScope } from '../memory-partition/memory-access'
import {
  MemoryServerCorrectionSchema,
  MemoryServerDeleteTargetSchema,
  MemoryServerRecordSchema,
  MemoryServerRetainSchema,
  MemoryServerTombstoneSchema,
  memoryServerResultSchema,
  sameMemoryScope,
  unavailableMemoryServerResult,
  type MemoryServerAdapter,
  type MemoryServerDeleteTarget,
  type MemoryServerResult,
  type MemoryServerRetain,
  type MemoryServerTombstone
} from './contract'
import { createTombstoneGuardedMemoryServerAdapter } from './tombstone-guard'

export interface ProductionMemoryServerConfig {
  /** Exact HTTPS contract endpoint supplied by the owner; the client does not invent a host or route. */
  endpoint?: string | null
  /** Main-owned verifier. Tenant/user identifiers from renderer payloads are never used. */
  verifiedScope(): MemoryScope | null
  /** Main-owned identity provider. Return null until the host and identity have been provisioned. */
  bearerToken(): Promise<string | null>
  fetch?: typeof globalThis.fetch
}

function configuredEndpoint(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const endpoint = new URL(raw)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      return null
    return endpoint.toString()
  } catch {
    return null
  }
}

function denied<T>(): MemoryServerResult<T> {
  return { status: 'denied' }
}

/** Client for the owner-provided contract endpoint. No endpoint or identity means an honest `unavailable`. */
export function createProductionMemoryServerAdapter(config: ProductionMemoryServerConfig): MemoryServerAdapter {
  const endpoint = configuredEndpoint(config.endpoint)
  const fetcher = config.fetch ?? globalThis.fetch

  const call = async <T>(
    requestScope: MemoryScope,
    operation: 'retain' | 'recall' | 'correct' | 'delete' | 'tombstones',
    payload: unknown,
    valueSchema: z.ZodTypeAny
  ): Promise<MemoryServerResult<T>> => {
    let verifiedBefore: MemoryScope | null
    try {
      verifiedBefore = config.verifiedScope()
    } catch {
      return denied()
    }
    if (!verifiedBefore || !sameMemoryScope(requestScope, verifiedBefore)) return denied()
    if (!endpoint) return unavailableMemoryServerResult()
    let token: string | null
    try {
      token = await config.bearerToken()
    } catch {
      return unavailableMemoryServerResult()
    }
    if (!token || !token.trim()) return unavailableMemoryServerResult()

    let response: Response
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, operation, scope: requestScope, payload }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      return unavailableMemoryServerResult()
    }
    if (response.status === 401 || response.status === 403) return denied()
    if (!response.ok) return unavailableMemoryServerResult()

    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      return unavailableMemoryServerResult()
    }
    const parsed = memoryServerResultSchema(valueSchema).safeParse(raw)
    if (!parsed.success) return unavailableMemoryServerResult()
    let verifiedAfter: MemoryScope | null
    try {
      verifiedAfter = config.verifiedScope()
    } catch {
      return denied()
    }
    if (!verifiedAfter || !sameMemoryScope(requestScope, verifiedAfter)) return denied()
    return parsed.data as MemoryServerResult<T>
  }

  const adapter: MemoryServerAdapter = {
    retain: (scope, input) => {
      const parsed = MemoryServerRetainSchema.safeParse(input)
      if (!parsed.success) return Promise.resolve(denied())
      return call(scope, 'retain', { record: parsed.data }, MemoryServerRecordSchema)
    },
    recall: (scope, query) => {
      if (typeof query !== 'string' || query.length > 4_000) return Promise.resolve(denied())
      return call(scope, 'recall', { query }, z.array(MemoryServerRecordSchema).max(64))
    },
    correct: (scope, memoryId, correction) => {
      const parsed = MemoryServerCorrectionSchema.safeParse(correction)
      if (!parsed.success || !MemoryServerRecordSchema.shape.id.safeParse(memoryId).success)
        return Promise.resolve(denied())
      return call(scope, 'correct', { memoryId, correction: parsed.data }, MemoryServerRecordSchema)
    },
    delete: (scope, target: MemoryServerDeleteTarget) => {
      const parsed = MemoryServerDeleteTargetSchema.safeParse(target)
      if (!parsed.success) return Promise.resolve(denied())
      return call(scope, 'delete', { target: parsed.data }, z.array(MemoryServerTombstoneSchema).max(256))
    },
    listTombstones: (scope, sourceId) => {
      if (sourceId !== undefined && !MemoryServerTombstoneSchema.shape.sourceId.safeParse(sourceId).success)
        return Promise.resolve(denied())
      return call(
        scope,
        'tombstones',
        { ...(sourceId ? { sourceId } : {}) },
        z.array(MemoryServerTombstoneSchema).max(4096)
      )
    }
  }
  return createTombstoneGuardedMemoryServerAdapter(adapter)
}

let configuredAdapter: MemoryServerAdapter | null = null

/** Install only from trusted Main configuration after the owner supplies both endpoint and identity. */
export function configureMemoryServerClient(config: ProductionMemoryServerConfig | null): void {
  configuredAdapter = config && configuredEndpoint(config.endpoint) ? createProductionMemoryServerAdapter(config) : null
}

export function configuredMemoryServerAdapter(): MemoryServerAdapter | null {
  return configuredAdapter
}

export function memoryServerClientEnabled(): boolean {
  return configuredAdapter !== null
}

/** Main-only convenience path for retrieval; scope always comes from the active G19 partition. */
export async function recallMemoryForCurrentOwner(
  query: string
): Promise<MemoryServerResult<import('./contract').MemoryServerRecord[]>> {
  const adapter = configuredAdapter
  if (!adapter) return unavailableMemoryServerResult()
  const scope = verifiedMemoryScope()
  if (!scope) return denied()
  return adapter.recall(scope, query)
}

/** Main-only convenience path used after a local meeting deletion has succeeded. */
export async function deleteMemoryForCurrentOwner(
  target: MemoryServerDeleteTarget
): Promise<MemoryServerResult<MemoryServerTombstone[]>> {
  const adapter = configuredAdapter
  if (!adapter) return unavailableMemoryServerResult()
  const scope = verifiedMemoryScope()
  if (!scope) return denied()
  return adapter.delete(scope, target)
}
