import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CONNECTOR_KINDS, type AccountRef, type ConnectorEffect, type ConnectorKind } from '@shared/connector-catalog'
import {
  ConnectorAccountHealthSchema,
  ConnectorAccountHealthSignalSchema,
  ConnectorAccountRefSchema,
  ConnectorAccountViewSchema,
  ConnectorOnboardingFlowViewSchema,
  type ConnectorAccountHealthSignal,
  type ConnectorAccountView,
  type ConnectorOnboardingFlowView,
  type ConnectorOnboardingInterruption
} from '@shared/connector-accounts'
import {
  applyConnectorAccountHealthSignal,
  initialConnectorAccountHealth,
  isConnectorAccountReady
} from './account-health'
import type { ConnectorAccountHealthRecord } from './account-health'
import { connectorAccountScopeKey, deriveConnectorAccountRef, maskedAccountHint } from './account-ref'
import type { AccountResolver, ConnectorAccountScope } from './account-ref'
import type { ConnectorAccountStore } from './account-store'

export const CONNECTOR_ONBOARDING_TIMEOUT_MS = 10 * 60 * 1000

const StoredAccountSchema = z
  .object({
    accountRef: ConnectorAccountRefSchema,
    kind: z.enum(CONNECTOR_KINDS),
    label: z.string().min(1).max(60),
    maskedHint: z.string().max(120).optional(),
    createdAt: z.number().int().nonnegative(),
    health: z
      .object({
        health: ConnectorAccountHealthSchema,
        reason: ConnectorAccountHealthSignalSchema,
        lastCheckedAt: z.number().int().nonnegative().nullable(),
        updatedAt: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()
const StoredStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    accounts: z.array(StoredAccountSchema).max(500),
    flows: z.array(ConnectorOnboardingFlowViewSchema).max(500)
  })
  .strict()

type StoredAccount = z.infer<typeof StoredAccountSchema>
type StoredFlow = ConnectorOnboardingFlowView
interface Partition {
  accounts: Map<AccountRef, StoredAccount>
  flows: Map<string, StoredFlow>
}

export interface EnsureConnectorAccountInput {
  kind: ConnectorKind
  /** Main-only provider identity. It is HMACed immediately and never persisted. */
  providerAccountId: string
  label?: string
}

export type ConnectorAccountVerificationSignal = Extract<
  ConnectorAccountHealthSignal,
  | 'token_refresh_succeeded'
  | 'token_refresh_rejected'
  | 'token_refresh_transient'
  | 'operation_succeeded'
  | 'transient_failure'
  | 'consent_required'
>

export type ConnectorFlowActionResult =
  | { ok: true; flow: ConnectorOnboardingFlowView }
  | { ok: false; reason: 'flow_not_found' | 'flow_expired' }

export type CompleteConnectorOnboardingResult =
  | { ok: true; account: ConnectorAccountView; flow: ConnectorOnboardingFlowView }
  | { ok: false; reason: 'flow_not_found' | 'flow_expired' }

export interface ConnectorAccountRegistry extends AccountResolver {
  prepareCurrentScope(): Promise<void>
  ensureAccount(input: EnsureConnectorAccountInput): Promise<AccountRef>
  listViews(): Promise<ConnectorAccountView[]>
  beginOnboarding(input: { kind: ConnectorKind; label: string }): Promise<ConnectorOnboardingFlowView>
  listOnboardingFlows(): Promise<ConnectorOnboardingFlowView[]>
  listFlowHistory(): Promise<ConnectorOnboardingFlowView[]>
  pausePendingFlows(
    reason: Extract<ConnectorOnboardingInterruption, 'app_quit' | 'sign_out'>,
    scope?: ConnectorAccountScope | null
  ): Promise<void>
  resumeOnboarding(flowId: string): Promise<ConnectorFlowActionResult>
  abandonOnboarding(flowId: string): Promise<ConnectorFlowActionResult>
  completeOnboarding(
    flowId: string,
    identity: Omit<EnsureConnectorAccountInput, 'kind' | 'label'> & { kind?: ConnectorKind },
    signal: ConnectorAccountVerificationSignal
  ): Promise<CompleteConnectorOnboardingResult>
  disconnectOwnerAccounts(scope: ConnectorAccountScope, signal?: 'auth_session_ended'): Promise<void>
}

export function createConnectorAccountRegistry(deps: {
  currentScope(): ConnectorAccountScope | null
  store: ConnectorAccountStore
  now?: () => number
  uuid?: () => string
}): ConnectorAccountRegistry {
  const now = deps.now ?? Date.now
  const uuid = deps.uuid ?? randomUUID
  const partitions = new Map<string, Partition>()
  const locks = new Map<string, Promise<unknown>>()
  const preparedScopes = new Set<string>()

  const partitionKey = (scope: ConnectorAccountScope, kind: ConnectorKind): string =>
    `${connectorAccountScopeKey(scope)}:${kind}`

  const exclusive = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(action, action)
    locks.set(key, next)
    void next
      .finally(() => {
        if (locks.get(key) === next) locks.delete(key)
      })
      .catch(() => undefined)
    return next
  }

  const loadPartition = async (scope: ConnectorAccountScope, kind: ConnectorKind): Promise<Partition> => {
    const key = partitionKey(scope, kind)
    const loaded = partitions.get(key)
    if (loaded) return loaded
    const scopeKey = connectorAccountScopeKey(scope)
    const raw = await deps.store.load(kind, scopeKey)
    const parsed = raw === null ? { schemaVersion: 1 as const, accounts: [], flows: [] } : StoredStateSchema.parse(raw)
    if (parsed.accounts.some((account) => account.kind !== kind)) {
      throw new Error('Connector account store contains a mismatched kind.')
    }
    const partition: Partition = {
      accounts: new Map(parsed.accounts.map((account) => [account.accountRef, account])),
      flows: new Map(parsed.flows.map((flow) => [flow.flowId, flow]))
    }
    partitions.set(key, partition)
    return partition
  }

  const serialize = (partition: Partition) =>
    StoredStateSchema.parse({
      schemaVersion: 1,
      accounts: [...partition.accounts.values()],
      flows: [...partition.flows.values()]
    })

  const persist = async (scope: ConnectorAccountScope, kind: ConnectorKind, partition: Partition): Promise<void> => {
    await deps.store.save(kind, connectorAccountScopeKey(scope), serialize(partition))
  }

  const withPartition = <T>(
    scope: ConnectorAccountScope,
    kind: ConnectorKind,
    action: (partition: Partition) => T | Promise<T>
  ) => exclusive(partitionKey(scope, kind), async () => action(await loadPartition(scope, kind)))

  const currentScope = (): ConnectorAccountScope | null => {
    const scope = deps.currentScope()
    if (!scope) return null
    connectorAccountScopeKey(scope)
    return scope
  }

  const viewOf = (account: StoredAccount): ConnectorAccountView =>
    ConnectorAccountViewSchema.parse({
      accountRef: account.accountRef,
      kind: account.kind,
      label: account.label,
      ...(account.maskedHint ? { maskedHint: account.maskedHint } : {}),
      health: account.health.health,
      reason: account.health.reason,
      lastCheckedAt: account.health.lastCheckedAt
    })

  const saveFlow = (partition: Partition, flow: StoredFlow): StoredFlow => {
    const validated = ConnectorOnboardingFlowViewSchema.parse(flow)
    partition.flows.set(validated.flowId, validated)
    return validated
  }

  const findFlow = async (scope: ConnectorAccountScope, flowId: string) => {
    for (const kind of CONNECTOR_KINDS) {
      const key = partitionKey(scope, kind)
      const flow = partitions.get(key)?.flows.get(flowId)
      if (flow) return { kind, flow }
    }
    for (const kind of CONNECTOR_KINDS) {
      const found = await withPartition(scope, kind, (partition) => {
        const flow = partition.flows.get(flowId)
        return flow ? { kind, flow } : null
      })
      if (found) return found
    }
    return null
  }

  const expireFlows = (partition: Partition, at: number): boolean => {
    let changed = false
    for (const flow of partition.flows.values()) {
      if ((flow.status !== 'pending' && flow.status !== 'paused') || flow.expiresAt > at) continue
      saveFlow(partition, { ...flow, status: 'abandoned', reason: 'timeout', updatedAt: at })
      if (flow.accountRef) {
        const account = partition.accounts.get(flow.accountRef)
        if (account?.health.health === 'connecting') {
          account.health = applyConnectorAccountHealthSignal(account.health, 'connect_timed_out', at)
          partition.accounts.set(account.accountRef, account)
        }
      }
      changed = true
    }
    return changed
  }

  const upsertAccount = (
    partition: Partition,
    scope: ConnectorAccountScope,
    input: EnsureConnectorAccountInput,
    at: number
  ): StoredAccount => {
    const ref = deriveConnectorAccountRef(scope, input.kind, input.providerAccountId)
    const prior = partition.accounts.get(ref)
    const hint = maskedAccountHint(input.providerAccountId)
    const requestedLabel = input.label?.trim().slice(0, 60)
    const label = requestedLabel || hint || input.kind
    if (!prior) {
      const record: StoredAccount = {
        accountRef: ref,
        kind: input.kind,
        label,
        ...(hint ? { maskedHint: hint } : {}),
        createdAt: at,
        health: initialConnectorAccountHealth(at)
      }
      partition.accounts.set(ref, record)
      return record
    }
    if (prior.kind !== input.kind) throw new Error('Connector account reference kind mismatch.')
    const record: StoredAccount = {
      ...prior,
      ...(requestedLabel ? { label: requestedLabel } : {}),
      ...(hint ? { maskedHint: hint } : {}),
      health:
        prior.health.health === 'disconnected'
          ? applyConnectorAccountHealthSignal(prior.health, 'connect_started', at)
          : prior.health
    }
    partition.accounts.set(ref, record)
    return record
  }

  const applySignal = (
    partition: Partition,
    kind: ConnectorKind,
    ref: AccountRef,
    signal: ConnectorAccountHealthSignal,
    at: number
  ): boolean => {
    const account = partition.accounts.get(ref)
    if (!account || account.kind !== kind) return false
    const nextHealth = applyConnectorAccountHealthSignal(account.health, signal, at)
    if (nextHealth === account.health) return false
    partition.accounts.set(ref, { ...account, health: nextHealth })
    if (signal === 'token_refresh_succeeded' || signal === 'operation_succeeded') {
      for (const flow of partition.flows.values()) {
        if (flow.accountRef === ref && (flow.status === 'pending' || flow.status === 'paused')) {
          const { reason: _reason, ...withoutReason } = flow
          saveFlow(partition, { ...withoutReason, status: 'completed', updatedAt: at })
        }
      }
    } else if (
      signal === 'token_refresh_rejected' ||
      signal === 'token_refresh_transient' ||
      signal === 'consent_required' ||
      signal === 'transient_failure'
    ) {
      for (const flow of partition.flows.values()) {
        if (flow.accountRef === ref && flow.status === 'pending') {
          saveFlow(partition, { ...flow, status: 'paused', updatedAt: at })
        }
      }
    }
    return true
  }

  const prepareKind = async (scope: ConnectorAccountScope, kind: ConnectorKind): Promise<void> => {
    await withPartition(scope, kind, async (partition) => {
      const at = now()
      let changed = expireFlows(partition, at)
      for (const flow of partition.flows.values()) {
        if (flow.status === 'pending') {
          saveFlow(partition, { ...flow, status: 'paused', reason: 'app_quit', updatedAt: at })
          changed = true
        }
      }
      if (changed) await persist(scope, kind, partition)
    })
  }

  const refreshKind = async (scope: ConnectorAccountScope, kind: ConnectorKind): Promise<void> => {
    await withPartition(scope, kind, async (partition) => {
      if (expireFlows(partition, now())) await persist(scope, kind, partition)
    })
  }

  return {
    async prepareCurrentScope() {
      const scope = currentScope()
      if (!scope) return
      const scopeKey = connectorAccountScopeKey(scope)
      if (preparedScopes.has(scopeKey)) return
      await Promise.all(CONNECTOR_KINDS.map((kind) => prepareKind(scope, kind)))
      preparedScopes.add(scopeKey)
    },

    async ensureAccount(input) {
      const scope = currentScope()
      if (!scope) throw new Error('Connector account scope is unavailable.')
      const label = input.label?.trim().slice(0, 60)
      const parsed = {
        ...input,
        ...(label ? { label } : {})
      }
      return withPartition(scope, input.kind, async (partition) => {
        const record = upsertAccount(partition, scope, parsed, now())
        await persist(scope, input.kind, partition)
        return record.accountRef
      })
    },

    resolve(kind, requestedAccountRef) {
      const scope = currentScope()
      if (!scope) return null
      const partition = partitions.get(partitionKey(scope, kind))
      if (!partition) return null
      const available = [...partition.accounts.values()].filter((account) => account.health.health !== 'disconnected')
      if (requestedAccountRef) {
        return available.some((account) => account.accountRef === requestedAccountRef) ? requestedAccountRef : null
      }
      return available.length === 1 ? available[0].accountRef : null
    },

    isReady(kind, accountRef, effect) {
      const scope = currentScope()
      if (!scope) return false
      const account = partitions.get(partitionKey(scope, kind))?.accounts.get(accountRef)
      return !!account && isConnectorAccountReady(account.health.health, effect)
    },

    async observe(kind, accountRef, signal) {
      const scope = currentScope()
      if (!scope) return false
      return withPartition(scope, kind, async (partition) => {
        const changed = applySignal(partition, kind, accountRef, signal, now())
        if (changed) await persist(scope, kind, partition)
        return changed
      })
    },

    async listViews() {
      const scope = currentScope()
      if (!scope) return []
      await Promise.all(CONNECTOR_KINDS.map((kind) => refreshKind(scope, kind)))
      return CONNECTOR_KINDS.flatMap((kind) =>
        [...(partitions.get(partitionKey(scope, kind))?.accounts.values() ?? [])].map(viewOf)
      ).sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.accountRef.localeCompare(b.accountRef)
      )
    },

    async beginOnboarding(input) {
      const scope = currentScope()
      if (!scope) throw new Error('Connector account scope is unavailable.')
      const label = z.string().trim().min(1).max(60).parse(input.label)
      return withPartition(scope, input.kind, async (partition) => {
        expireFlows(partition, now())
        const flowId = uuid()
        if (!z.string().uuid().safeParse(flowId).success || partition.flows.has(flowId)) {
          throw new Error('Connector onboarding flow id is invalid.')
        }
        const at = now()
        const flow = saveFlow(partition, {
          flowId,
          kind: input.kind,
          label,
          status: 'pending',
          startedAt: at,
          updatedAt: at,
          expiresAt: at + CONNECTOR_ONBOARDING_TIMEOUT_MS
        })
        await persist(scope, input.kind, partition)
        return flow
      })
    },

    async listOnboardingFlows() {
      const scope = currentScope()
      if (!scope) return []
      await Promise.all(CONNECTOR_KINDS.map((kind) => refreshKind(scope, kind)))
      return CONNECTOR_KINDS.flatMap((kind) =>
        [...(partitions.get(partitionKey(scope, kind))?.flows.values() ?? [])].filter(
          (flow) => flow.status === 'pending' || flow.status === 'paused'
        )
      ).sort((a, b) => a.startedAt - b.startedAt || a.flowId.localeCompare(b.flowId))
    },

    async listFlowHistory() {
      const scope = currentScope()
      if (!scope) return []
      await Promise.all(CONNECTOR_KINDS.map((kind) => refreshKind(scope, kind)))
      return CONNECTOR_KINDS.flatMap((kind) => [
        ...(partitions.get(partitionKey(scope, kind))?.flows.values() ?? [])
      ]).sort((a, b) => a.startedAt - b.startedAt || a.flowId.localeCompare(b.flowId))
    },

    async pausePendingFlows(reason, scopeOverride) {
      const scope = scopeOverride === undefined ? currentScope() : scopeOverride
      if (!scope) return
      await Promise.all(
        CONNECTOR_KINDS.map((kind) =>
          withPartition(scope, kind, async (partition) => {
            const at = now()
            let changed = expireFlows(partition, at)
            for (const flow of partition.flows.values()) {
              if (flow.status !== 'pending') continue
              saveFlow(partition, { ...flow, status: 'paused', reason, updatedAt: at })
              changed = true
            }
            if (changed) await persist(scope, kind, partition)
          })
        )
      )
    },

    async resumeOnboarding(flowId) {
      const scope = currentScope()
      if (!scope) return { ok: false, reason: 'flow_not_found' }
      const found = await findFlow(scope, flowId)
      if (!found) return { ok: false, reason: 'flow_not_found' }
      return withPartition(scope, found.kind, async (partition) => {
        const at = now()
        if (expireFlows(partition, at)) await persist(scope, found.kind, partition)
        const flow = partition.flows.get(flowId)
        if (!flow) return { ok: false, reason: 'flow_not_found' } as const
        if (flow.status === 'abandoned') return { ok: false, reason: 'flow_expired' } as const
        if (flow.status === 'completed') return { ok: false, reason: 'flow_not_found' } as const
        if (flow.status === 'pending') return { ok: true, flow } as const
        const { reason: _previousReason, ...resumable } = flow
        const resumed = saveFlow(partition, {
          ...resumable,
          status: 'pending',
          updatedAt: at,
          expiresAt: at + CONNECTOR_ONBOARDING_TIMEOUT_MS
        })
        if (flow.accountRef) {
          const account = partition.accounts.get(flow.accountRef)
          if (account && account.health.health !== 'healthy') {
            account.health = applyConnectorAccountHealthSignal(account.health, 'connect_resumed', at)
            partition.accounts.set(account.accountRef, account)
          }
        }
        await persist(scope, found.kind, partition)
        return { ok: true, flow: resumed } as const
      })
    },

    async abandonOnboarding(flowId) {
      const scope = currentScope()
      if (!scope) return { ok: false, reason: 'flow_not_found' }
      const found = await findFlow(scope, flowId)
      if (!found) return { ok: false, reason: 'flow_not_found' }
      return withPartition(scope, found.kind, async (partition) => {
        const at = now()
        if (expireFlows(partition, at)) await persist(scope, found.kind, partition)
        const flow = partition.flows.get(flowId)
        if (!flow || flow.status === 'completed') return { ok: false, reason: 'flow_not_found' } as const
        if (flow.status === 'abandoned') return { ok: true, flow } as const
        const abandoned = saveFlow(partition, { ...flow, status: 'abandoned', reason: 'abandoned', updatedAt: at })
        if (flow.accountRef) {
          const account = partition.accounts.get(flow.accountRef)
          if (account?.health.health === 'connecting') {
            account.health = applyConnectorAccountHealthSignal(account.health, 'connect_abandoned', at)
            partition.accounts.set(account.accountRef, account)
          }
        }
        await persist(scope, found.kind, partition)
        return { ok: true, flow: abandoned } as const
      })
    },

    async completeOnboarding(flowId, identity, signal) {
      const scope = currentScope()
      if (!scope) return { ok: false, reason: 'flow_not_found' }
      const found = await findFlow(scope, flowId)
      if (!found) return { ok: false, reason: 'flow_not_found' }
      return withPartition(scope, found.kind, async (partition) => {
        const at = now()
        if (expireFlows(partition, at)) await persist(scope, found.kind, partition)
        const flow = partition.flows.get(flowId)
        if (!flow) return { ok: false, reason: 'flow_not_found' } as const
        if (flow.status === 'abandoned') return { ok: false, reason: 'flow_expired' } as const
        if (flow.status === 'completed') {
          const account = flow.accountRef ? partition.accounts.get(flow.accountRef) : undefined
          return account
            ? ({ ok: true, account: viewOf(account), flow } as const)
            : ({ ok: false, reason: 'flow_not_found' } as const)
        }
        const account = upsertAccount(
          partition,
          scope,
          {
            kind: identity.kind ?? flow.kind,
            providerAccountId: identity.providerAccountId,
            label: flow.label
          },
          at
        )
        if (account.kind !== flow.kind) return { ok: false, reason: 'flow_not_found' } as const
        applySignal(partition, flow.kind, account.accountRef, signal, at)
        const current = partition.accounts.get(account.accountRef) ?? account
        const success = signal === 'token_refresh_succeeded' || signal === 'operation_succeeded'
        const { reason: _previousReason, ...flowWithoutReason } = flow
        const nextFlow = saveFlow(partition, {
          ...flowWithoutReason,
          accountRef: account.accountRef,
          status: success ? 'completed' : 'paused',
          updatedAt: at
        })
        await persist(scope, found.kind, partition)
        return { ok: true, account: viewOf(current), flow: nextFlow } as const
      })
    },

    async disconnectOwnerAccounts(scope, signal = 'auth_session_ended') {
      await Promise.all(
        CONNECTOR_KINDS.map((kind) =>
          withPartition(scope, kind, async (partition) => {
            const at = now()
            let changed = false
            for (const account of partition.accounts.values()) {
              if (account.health.health === 'disconnected') continue
              const health = applyConnectorAccountHealthSignal(account.health, signal, at)
              if (health !== account.health) {
                partition.accounts.set(account.accountRef, { ...account, health })
                changed = true
              }
            }
            for (const flow of partition.flows.values()) {
              if (flow.status === 'pending') {
                saveFlow(partition, { ...flow, status: 'paused', reason: 'sign_out', updatedAt: at })
                changed = true
              }
            }
            if (changed) await persist(scope, kind, partition)
          })
        )
      )
    }
  }
}
