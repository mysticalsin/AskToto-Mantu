import { randomBytes } from 'node:crypto'
import type { OptionalRuntimeTarget } from './runtime-components'
import { calculateRuntimeInstallRequirements, type RuntimeGenerationProvider } from './runtime-generation-provider'
import type { RuntimeFeatureId, RuntimeModelId } from './runtime-lease'
import type { RuntimeInstallPlanPreview } from '../../../../shared/runtime-install'

const PLAN_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_PLANS = 16

export interface RuntimeInstallAuthoritySnapshot {
  readonly readable: boolean
  readonly allowedFeatures: readonly RuntimeFeatureId[]
  readonly profileIdentity: string
  readonly policyIdentity: string
  readonly selectionIdentity: string
  readonly captureIdentity: string
  readonly authorityEpoch: number
  readonly captureActive: boolean
  readonly transferAllowed: boolean
  readonly selectedModelId: RuntimeModelId | null
}

export interface RuntimeInstallAuthorizedPlan {
  readonly planId: string
  readonly feature: RuntimeFeatureId
  readonly selectedModelId: RuntimeModelId | null
  readonly target: OptionalRuntimeTarget
  readonly catalogIdentity: string
  readonly artifactIds: readonly string[]
}

export interface RuntimeInstallCallerContext {
  readonly identity: string
  readonly assertCurrent: () => void
  readonly assertAuthorityCurrent: (authority: RuntimeInstallAuthoritySnapshot, feature: RuntimeFeatureId) => void
}

interface PlanRecord {
  readonly preview: RuntimeInstallPlanPreview
  readonly target: OptionalRuntimeTarget
  readonly catalogIdentity: string
  readonly artifactIds: readonly string[]
  readonly authority: RuntimeInstallAuthoritySnapshot
  readonly callerIdentity: string
  readonly expiresAt: number
}

function identitySnapshot(value: RuntimeInstallAuthoritySnapshot): string {
  return JSON.stringify({
    readable: value.readable,
    allowedFeatures: [...value.allowedFeatures].sort(),
    profileIdentity: value.profileIdentity,
    policyIdentity: value.policyIdentity,
    selectionIdentity: value.selectionIdentity,
    captureIdentity: value.captureIdentity,
    authorityEpoch: value.authorityEpoch,
    captureActive: value.captureActive,
    transferAllowed: value.transferAllowed,
    selectedModelId: value.selectedModelId
  })
}

function validAuthority(value: RuntimeInstallAuthoritySnapshot, feature: RuntimeFeatureId): boolean {
  return Boolean(
    value &&
      value.readable === true &&
      Array.isArray(value.allowedFeatures) &&
      value.allowedFeatures.includes(feature) &&
      typeof value.profileIdentity === 'string' &&
      value.profileIdentity.length > 0 &&
      value.profileIdentity.length <= 256 &&
      typeof value.policyIdentity === 'string' &&
      value.policyIdentity.length > 0 &&
      value.policyIdentity.length <= 256 &&
      typeof value.selectionIdentity === 'string' &&
      value.selectionIdentity.length > 0 &&
      value.selectionIdentity.length <= 256 &&
      typeof value.captureIdentity === 'string' &&
      value.captureIdentity.length > 0 &&
      value.captureIdentity.length <= 256 &&
      Number.isSafeInteger(value.authorityEpoch) &&
      value.authorityEpoch >= 0 &&
      value.captureActive === false &&
      value.transferAllowed === true &&
      (value.selectedModelId === null ||
        [
          'asr.parakeet-tdt-0.6b-v3-int8',
          'asr.whisper-base-q8',
          'speaker.embedding',
          'qwen3.5-0.8b',
          'qwen3.5-4b'
        ].includes(value.selectedModelId))
  )
}

function snapshotAuthority(value: RuntimeInstallAuthoritySnapshot): RuntimeInstallAuthoritySnapshot {
  return Object.freeze({ ...value, allowedFeatures: Object.freeze([...value.allowedFeatures]) })
}

/** Main-owned one-shot plan book. Preview reads only app-owned pins; install calls its runner only after consent. */
export function createRuntimeInstallPlanBook(options: {
  readonly provider: RuntimeGenerationProvider
  readonly readAuthority: (feature: RuntimeFeatureId) => Promise<RuntimeInstallAuthoritySnapshot>
  readonly readTarget: () => Promise<OptionalRuntimeTarget>
  readonly readPreviousActiveBytes: (feature: RuntimeFeatureId) => Promise<number>
  readonly now?: () => number
  readonly token?: () => string
  readonly run: (
    plan: RuntimeInstallAuthorizedPlan,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
    assertCurrentSync: () => void
  ) => Promise<unknown>
}) {
  const plans = new Map<string, PlanRecord>()
  const active = new Map<string, { controller: AbortController; callerIdentity: string }>()
  const now = options.now ?? Date.now
  const token = options.token ?? (() => randomBytes(32).toString('hex'))

  const currentAuthority = async (feature: RuntimeFeatureId): Promise<RuntimeInstallAuthoritySnapshot> => {
    const authority = await options.readAuthority(feature)
    if (!validAuthority(authority, feature)) throw new Error('RUNTIME_INSTALL_AUTHORITY_UNAVAILABLE')
    return snapshotAuthority(authority)
  }

  const assertPlanCurrent = async (plan: PlanRecord, caller: RuntimeInstallCallerContext): Promise<void> => {
    caller.assertCurrent()
    if (caller.identity !== plan.callerIdentity) throw new Error('RUNTIME_INSTALL_CALLER_CHANGED')
    if (now() >= plan.expiresAt) throw new Error('RUNTIME_INSTALL_PLAN_EXPIRED')
    const authority = await currentAuthority(plan.preview.feature)
    caller.assertCurrent()
    const target = await options.readTarget()
    caller.assertCurrent()
    await options.provider.initialize()
    caller.assertCurrent()
    const catalog = await options.provider.catalogSnapshot()
    caller.assertCurrent()
    const latestAuthority = await currentAuthority(plan.preview.feature)
    caller.assertCurrent()
    const latestTarget = await options.readTarget()
    caller.assertCurrent()
    const latestCatalog = await options.provider.catalogSnapshot()
    caller.assertCurrent()
    if (
      identitySnapshot(authority) !== identitySnapshot(plan.authority) ||
      JSON.stringify(target) !== JSON.stringify(plan.target) ||
      catalog.catalogIdentity !== plan.catalogIdentity ||
      identitySnapshot(latestAuthority) !== identitySnapshot(plan.authority) ||
      JSON.stringify(latestTarget) !== JSON.stringify(plan.target) ||
      latestCatalog.catalogIdentity !== plan.catalogIdentity ||
      !plan.artifactIds.every((id) => catalog.catalog.targets.some((row) => row.artifactId === id))
    ) {
      throw new Error('RUNTIME_INSTALL_PLAN_STALE')
    }
  }

  const assertPlanCurrentSync = (plan: PlanRecord, caller: RuntimeInstallCallerContext): void => {
    caller.assertCurrent()
    if (caller.identity !== plan.callerIdentity) throw new Error('RUNTIME_INSTALL_CALLER_CHANGED')
    if (now() >= plan.expiresAt) throw new Error('RUNTIME_INSTALL_PLAN_EXPIRED')
    caller.assertAuthorityCurrent(plan.authority, plan.preview.feature)
  }

  return Object.freeze({
    async preview(
      feature: RuntimeFeatureId,
      caller: RuntimeInstallCallerContext
    ): Promise<RuntimeInstallPlanPreview | null> {
      caller.assertCurrent()
      const authority = await currentAuthority(feature)
      caller.assertCurrent()
      const target = await options.readTarget()
      caller.assertCurrent()
      await options.provider.initialize()
      caller.assertCurrent()
      const catalog = await options.provider.catalogSnapshot()
      caller.assertCurrent()
      const previousActiveBytes = await options.readPreviousActiveBytes(feature)
      caller.assertCurrent()
      const latestAuthority = await currentAuthority(feature)
      caller.assertCurrent()
      const latestTarget = await options.readTarget()
      caller.assertCurrent()
      const latestCatalog = await options.provider.catalogSnapshot()
      caller.assertCurrent()
      if (
        identitySnapshot(authority) !== identitySnapshot(latestAuthority) ||
        JSON.stringify(target) !== JSON.stringify(latestTarget) ||
        catalog.catalogIdentity !== latestCatalog.catalogIdentity
      )
        return null
      let requirements
      try {
        requirements = calculateRuntimeInstallRequirements({
          rows: catalog.catalog.targets,
          feature,
          target,
          selectedModelId: feature === 'local-llm' ? (authority.selectedModelId ?? undefined) : undefined,
          previousActiveBytes
        })
      } catch {
        return null
      }
      if (!requirements) return null
      const planId = token()
      if (!/^[0-9a-f]{64}$/.test(planId)) throw new Error('RUNTIME_PLAN_TOKEN_INVALID')
      const expiresAt = now() + PLAN_TTL_MS
      const preview = Object.freeze({
        planId,
        feature,
        selectedModelId: feature === 'local-llm' ? authority.selectedModelId : null,
        downloadBytes: requirements.downloadBytes,
        installedBytes: requirements.installedBytes,
        peakScratchBytes: requirements.peakScratchBytes,
        expiresInMs: PLAN_TTL_MS
      })
      plans.set(planId, {
        preview,
        target: Object.freeze({ ...target }),
        catalogIdentity: catalog.catalogIdentity,
        artifactIds: requirements.artifactIds,
        authority,
        callerIdentity: caller.identity,
        expiresAt
      })
      while (plans.size > MAX_PENDING_PLANS) plans.delete(plans.keys().next().value as string)
      return preview
    },

    async installWithPlan(input: {
      readonly planId: string
      readonly action: 'install' | 'cancel'
      readonly caller: RuntimeInstallCallerContext
    }): Promise<unknown | { readonly cancelled: true }> {
      if (!/^[0-9a-f]{64}$/.test(input.planId)) throw new Error('RUNTIME_INSTALL_PLAN_INVALID')
      input.caller.assertCurrent()
      if (input.action === 'cancel') {
        const current = active.get(input.planId)
        if (current && current.callerIdentity !== input.caller.identity) {
          throw new Error('RUNTIME_INSTALL_PLAN_INVALID')
        }
        current?.controller.abort(new Error('RUNTIME_INSTALL_CANCELLED'))
        plans.delete(input.planId)
        return Object.freeze({ cancelled: true })
      }
      if (input.action !== 'install' || active.has(input.planId)) throw new Error('RUNTIME_INSTALL_PLAN_INVALID')
      const plan = plans.get(input.planId)
      if (!plan || input.caller.identity !== plan.callerIdentity) throw new Error('RUNTIME_INSTALL_PLAN_INVALID')
      plans.delete(input.planId)
      if (now() >= plan.expiresAt) throw new Error('RUNTIME_INSTALL_PLAN_EXPIRED')
      const controller = new AbortController()
      active.set(input.planId, { controller, callerIdentity: input.caller.identity })
      const signal = controller.signal
      try {
        await assertPlanCurrent(plan, input.caller)
        if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
        return await options.run(
          Object.freeze({
            planId: plan.preview.planId,
            feature: plan.preview.feature,
            selectedModelId: plan.preview.selectedModelId,
            target: plan.target,
            catalogIdentity: plan.catalogIdentity,
            artifactIds: plan.artifactIds
          }),
          signal,
          async () => {
            if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
            await assertPlanCurrent(plan, input.caller)
          },
          () => {
            if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
            assertPlanCurrentSync(plan, input.caller)
          }
        )
      } finally {
        if (active.get(input.planId)?.controller === controller) active.delete(input.planId)
      }
    },

    clear(): void {
      plans.clear()
      for (const entry of active.values()) entry.controller.abort(new Error('RUNTIME_INSTALL_CANCELLED'))
      active.clear()
    }
  })
}

export type RuntimeInstallPlanBook = ReturnType<typeof createRuntimeInstallPlanBook>
