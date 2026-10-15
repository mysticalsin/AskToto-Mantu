import type { PackageRuntimeContract } from './package-contract'
import { app } from 'electron'

let loadContract: (() => Promise<PackageRuntimeContract>) | null = null

/** Installed by the main startup boundary before ASR/LLM consumers can run. */
export function configurePackageRuntimeContractProvider(provider: () => Promise<PackageRuntimeContract>): void {
  if (loadContract && loadContract !== provider)
    throw new Error('Package runtime contract provider is already configured.')
  loadContract = provider
}

/** Consumers reuse startup-validated package facts; an unconfigured boundary fails closed. */
export async function getPackageRuntimeContract(): Promise<PackageRuntimeContract> {
  if (!loadContract) {
    if (!app.isPackaged) return { status: 'development', profile: 'development', inventory: null }
    return { status: 'invalid', reason: 'inventory-invalid', profile: null, inventory: null }
  }
  try {
    return await loadContract()
  } catch {
    return { status: 'invalid', reason: 'inventory-invalid', profile: null, inventory: null }
  }
}

export async function legacyRuntimeClosureAvailable(): Promise<boolean> {
  const contract = await getPackageRuntimeContract()
  return contract.status !== 'invalid' && contract.profile !== 'lean'
}

export async function assertLegacyRuntimeClosure(feature: 'asr' | 'speaker embedding' | 'local LLM'): Promise<void> {
  if (!(await legacyRuntimeClosureAvailable())) {
    throw new Error(`The optional ${feature} runtime is not configured for this package.`)
  }
}
