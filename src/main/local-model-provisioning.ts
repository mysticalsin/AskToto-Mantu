/** Optional LLM provisioning policy. Transcription assets have a separate mandatory setup path. */
export async function provisionLocalModel(
  local: { enabled: boolean; modelId: string },
  allowedProviders: readonly string[] | null,
  ensure: (modelId: string) => Promise<boolean>,
  trigger: 'automatic' | 'explicit' = 'automatic'
): Promise<boolean> {
  if (allowedProviders && !allowedProviders.includes('local')) return false
  if (trigger === 'automatic' && !local.enabled) return false
  // The downloader owns model-id, RAM, disk, integrity and single-flight checks. Never replace the
  // selected model with a larger one merely because this machine has enough memory for it.
  return ensure(local.modelId)
}
