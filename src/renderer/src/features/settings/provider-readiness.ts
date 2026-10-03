import { PROVIDERS, PROVIDER_IDS, isDustReady, type ProviderId } from '@shared/providers'

/**
 * After disconnecting/removing the active provider, pick another provider that is actually ready
 * (CLI providers need a live connection; the rest need a saved key) so the user is never left on a
 * provider that can't answer. Falls back to Anthropic, which then shows the normal "add a key" prompt.
 * MQA-095: `allowed` is the org data-residency allowlist (null = unrestricted) — a provider outside it
 * is never "ready", because the main process rejects every ask sent to it. Exported for a focused test.
 */
export function pickReadyProvider(
  exclude: ProviderId,
  hasKeys: Record<string, boolean>,
  cliConnected: Record<string, boolean>,
  dustWorkspaceId: string,
  providerModels: Partial<Record<string, string>>,
  allowed: string[] | null
): ProviderId {
  const permitted = (p: ProviderId): boolean => !allowed || allowed.includes(p)
  const ready = PROVIDER_IDS.find((p) => {
    if (p === exclude || !permitted(p)) return false
    if (p === 'dust') return isDustReady(hasKeys, dustWorkspaceId, providerModels)
    return PROVIDERS[p].kind === 'cli' ? !!cliConnected[p] : !!hasKeys[p]
  })
  if (ready) return ready
  // Nothing is ready. Anthropic's "add a key" prompt is the normal landing spot, but when the org
  // excludes it, land on an approved provider instead — otherwise the panel sits on a provider that has
  // no tile in the grid and that every ask then rejects.
  return permitted('anthropic') ? 'anthropic' : (PROVIDER_IDS.find(permitted) ?? 'anthropic')
}
