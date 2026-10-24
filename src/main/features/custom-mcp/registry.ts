import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  CUSTOM_MCP_ID,
  CUSTOM_MCP_MAX_PER_SCOPE,
  CUSTOM_MCP_REFUSALS,
  CUSTOM_MCP_STATES,
  CustomMcpAuthSchema,
  CustomMcpTransportSchema
} from '@shared/custom-mcp'
import { connectorAccountScopeKey, within, writeJsonAtomic, type ConnectorAccountScope } from '../connectors'

const ValidatedToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  effect: z.enum(['read', 'create']),
  inputDigest: z.string(),
  required: z.array(z.string()),
  properties: z.array(z.string()),
  closed: z.boolean()
})

export const RegistrationSchema = z.object({
  id: z.string().regex(CUSTOM_MCP_ID),
  label: z.string().max(60),
  transport: CustomMcpTransportSchema,
  auth: CustomMcpAuthSchema,
  state: z.enum(CUSTOM_MCP_STATES),
  health: z.enum(['unknown', 'healthy', 'failing']),
  tools: z.array(ValidatedToolSchema),
  allowedTools: z.array(z.string()),
  catalogRevision: z.number().int().min(0),
  toolsFingerprint: z.string(),
  policyDigest: z.string(),
  reviewToken: z.object({ id: z.string(), digest: z.string(), expiresAt: z.number() }).optional(),
  lastError: z.enum(CUSTOM_MCP_REFUSALS).optional(),
  rule: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Registration = z.infer<typeof RegistrationSchema>
export type NewRegistration = Omit<Registration, 'id' | 'createdAt' | 'updatedAt'>

const StateSchema = z.object({ registrations: z.array(z.unknown()) })

export interface CustomMcpStore {
  load(scopeKey: string): Promise<unknown | null>
  save(scopeKey: string, state: unknown): Promise<void>
}

const SCOPE_KEY = /^[a-f0-9]{64}$/

export function createFileCustomMcpStore(userDataPath: () => string): CustomMcpStore {
  const pathFor = (scopeKey: string): string => {
    if (!SCOPE_KEY.test(scopeKey)) throw new Error('Unsafe custom MCP scope key.')
    const base = resolve(userDataPath(), 'custom-mcp')
    const path = resolve(base, `${scopeKey}.json`)
    if (!within(base, path)) throw new Error('Unsafe custom MCP storage path.')
    return path
  }
  return {
    async load(scopeKey) {
      try {
        return JSON.parse(await readFile(pathFor(scopeKey), 'utf8')) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
      }
    },
    save: (scopeKey, state) => writeJsonAtomic(pathFor(scopeKey), state)
  }
}

export function createMemoryCustomMcpStore(): CustomMcpStore {
  const records = new Map<string, unknown>()
  return {
    async load(scopeKey) {
      if (!SCOPE_KEY.test(scopeKey)) throw new Error('Unsafe custom MCP scope key.')
      const value = records.get(scopeKey)
      return value === undefined ? null : structuredClone(value)
    },
    async save(scopeKey, state) {
      if (!SCOPE_KEY.test(scopeKey)) throw new Error('Unsafe custom MCP scope key.')
      records.set(scopeKey, structuredClone(state))
    }
  }
}

export interface CustomMcpRegistryDeps {
  currentScope(): ConnectorAccountScope | null
  store: CustomMcpStore
  /** Removes the registration's secret from the existing mcpSecrets path. */
  clearSecret(id: string): void
  now?(): number
}

export type CreateResult =
  | { ok: true; registration: Registration }
  | { ok: false; error: 'auth_required' | 'too_many_servers' }

/** Owner/tenant-scoped persistence for custom MCP registrations. Ids are minted here, never accepted from callers. */
export function createCustomMcpRegistry(deps: CustomMcpRegistryDeps) {
  const now = deps.now ?? Date.now
  let chain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  const load = async (key: string): Promise<Registration[]> => {
    const parsed = StateSchema.safeParse(await deps.store.load(key))
    if (!parsed.success) return []
    const out: Registration[] = []
    for (const item of parsed.data.registrations) {
      const reg = RegistrationSchema.safeParse(item)
      if (reg.success) out.push(reg.data)
    }
    return out
  }
  const save = (key: string, registrations: Registration[]) => deps.store.save(key, { registrations })
  const keyFor = (scope: ConnectorAccountScope | null): string | null =>
    scope ? connectorAccountScopeKey(scope) : null
  const currentKey = (): string | null => {
    try {
      return keyFor(deps.currentScope())
    } catch {
      return null
    }
  }

  return {
    scopeKey: currentKey,

    list: (): Promise<Registration[]> =>
      serialized(async () => {
        const key = currentKey()
        return key ? load(key) : []
      }),

    get: (id: string): Promise<Registration | null> =>
      serialized(async () => {
        const key = currentKey()
        return key ? ((await load(key)).find((r) => r.id === id) ?? null) : null
      }),

    create: (input: NewRegistration): Promise<CreateResult> =>
      serialized(async () => {
        const key = currentKey()
        if (!key) return { ok: false, error: 'auth_required' } as const
        const all = await load(key)
        if (all.length >= CUSTOM_MCP_MAX_PER_SCOPE) return { ok: false, error: 'too_many_servers' } as const
        const stamp = now()
        const registration: Registration = {
          ...input,
          id: `cmcp-${randomBytes(12).toString('hex')}`,
          createdAt: stamp,
          updatedAt: stamp
        }
        await save(key, [...all, registration])
        return { ok: true, registration } as const
      }),

    update: (id: string, mutate: (r: Registration) => Registration): Promise<Registration | null> =>
      serialized(async () => {
        const key = currentKey()
        if (!key) return null
        const all = await load(key)
        const index = all.findIndex((r) => r.id === id)
        if (index < 0) return null
        const next: Registration = { ...mutate(all[index]), id, updatedAt: now() }
        all[index] = RegistrationSchema.parse(next)
        await save(key, all)
        return all[index]
      }),

    /** Removes the registration and its stored secret. Another scope's id is simply not found. */
    remove: (id: string): Promise<boolean> =>
      serialized(async () => {
        const key = currentKey()
        if (!key) return false
        const all = await load(key)
        if (!all.some((r) => r.id === id)) return false
        await save(
          key,
          all.filter((r) => r.id !== id)
        )
        deps.clearSecret(id)
        return true
      }),

    /** Owner signed out: nothing in that scope stays enabled. Returns the ids that were switched off. */
    disableAll: (scope: ConnectorAccountScope): Promise<string[]> =>
      serialized(async () => {
        const key = keyFor(scope)
        if (!key) return []
        const all = await load(key)
        const changed: string[] = []
        const next = all.map((r) => {
          if (r.state === 'disabled') return r
          changed.push(r.id)
          return { ...r, state: 'disabled' as const, reviewToken: undefined, updatedAt: now() }
        })
        if (changed.length) await save(key, next)
        return changed
      })
  }
}

export type CustomMcpRegistry = ReturnType<typeof createCustomMcpRegistry>
