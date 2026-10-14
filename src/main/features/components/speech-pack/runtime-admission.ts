import { app } from 'electron'
import type { PackageRuntimeContract } from './package-contract'
import { assertLegacyRuntimeClosure, getPackageRuntimeContract } from './package-runtime-state'
import { runtimeTargetFor } from './runtime-components'
import {
  acquireFeatureRuntime,
  type RuntimeFeatureId,
  type RuntimeFeatureLease,
  type RuntimeModelId
} from './runtime-lease'

function packageIdentity(contract: PackageRuntimeContract): string {
  if (contract.status === 'verified') return `${contract.profile}:${contract.inventory.identity}`
  return `${contract.status}:${contract.profile}`
}

/**
 * Full and development builds retain their established resource closure. Packaged lean builds require a
 * catalog-verified lease for the exact package/ABI target. No user setting or writable folder can select
 * the development path.
 */
export async function acquirePackageRuntimeLease(
  feature: RuntimeFeatureId,
  selectedModelId?: RuntimeModelId,
  signal?: AbortSignal
): Promise<RuntimeFeatureLease | null> {
  if (signal?.aborted) throw signal.reason ?? new Error('Optional runtime admission was cancelled.')
  const before = await getPackageRuntimeContract()
  if (before.status === 'invalid') throw new Error('The packaged runtime contract is invalid.')
  if (before.status !== 'verified' || before.profile !== 'lean') {
    const legacyFeature = feature === 'offline-asr' ? 'asr' : feature === 'speaker-embedding' ? 'speaker embedding' : 'local LLM'
    await assertLegacyRuntimeClosure(legacyFeature)
    return null
  }
  const identity = packageIdentity(before)
  const lease = await acquireFeatureRuntime(feature, runtimeTargetFor(before, app.getVersion()), selectedModelId, signal)
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('Optional runtime admission was cancelled.')
    const after = await getPackageRuntimeContract()
    if (after.status === 'invalid' || after.status !== 'verified' || packageIdentity(after) !== identity) {
      throw new Error('The package runtime identity changed during admission.')
    }
    return lease
  } catch (error) {
    await lease.release()
    throw error
  }
}
