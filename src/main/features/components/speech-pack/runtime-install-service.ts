import type { OptionalRuntimeTarget } from './runtime-components'
import { createRuntimeInstallPlanBook, type RuntimeInstallAuthoritySnapshot } from './runtime-install-plans'
import { createRuntimeInstaller, type RuntimeInstallSelfTest } from './runtime-installer'
import type { RuntimeGenerationProvider } from './runtime-generation-provider'

/** Compose the app-owned plan book and verified installer; callers cannot provide runtime paths or rows. */
export function createRuntimeInstallService(options: {
  readonly provider: RuntimeGenerationProvider
  readonly resourcesRoot: string
  readonly storeRoot: string
  readonly readAuthority: (
    feature: import('./runtime-lease').RuntimeFeatureId
  ) => Promise<RuntimeInstallAuthoritySnapshot>
  readonly readTarget: () => Promise<OptionalRuntimeTarget>
  readonly selfTest: RuntimeInstallSelfTest
}) {
  const installer = createRuntimeInstaller(options)
  return createRuntimeInstallPlanBook({
    provider: options.provider,
    readAuthority: options.readAuthority,
    readTarget: options.readTarget,
    readPreviousActiveBytes: (feature) => options.provider.previousActiveBytes(feature),
    run: (plan, signal, assertCurrent) =>
      installer.install({
        feature: plan.feature,
        selectedModelId: plan.selectedModelId,
        target: plan.target,
        artifactIds: plan.artifactIds,
        catalogIdentity: plan.catalogIdentity,
        signal,
        assertCurrent
      })
  })
}
