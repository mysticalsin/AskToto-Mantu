import type { RuntimeFeatureId, RuntimeModelId } from './runtime-lease'

export type RuntimeExecutionAuthority = (
  feature: RuntimeFeatureId,
  selectedModelId?: RuntimeModelId
) => Promise<boolean>

let authority: RuntimeExecutionAuthority | null = null
let revision = 0

export function configureRuntimeExecutionAuthority(check: RuntimeExecutionAuthority): void {
  authority = check
}

export function invalidateRuntimeExecutionAuthority(): void {
  revision++
}

export function runtimeExecutionAuthorityRevision(): number {
  return revision
}

export async function assertRuntimeExecutionAuthority(
  feature: RuntimeFeatureId,
  selectedModelId?: RuntimeModelId
): Promise<void> {
  if (authority && !(await authority(feature, selectedModelId))) {
    throw new Error('Optional runtime execution authority was revoked.')
  }
}
