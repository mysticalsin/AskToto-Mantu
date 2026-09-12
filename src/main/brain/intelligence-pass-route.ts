/**
 * Routing for the Update Intelligence button only.
 * Local first when Settings → Local AI is ready. Configured API once if Local is missing,
 * refused (disk/RAM), locked out, or errors. See docs/design/INTELLIGENCE-UPDATE.md.
 */
import type { Settings } from '@shared/ipc'
import {
  PROVIDERS,
  providerBaseUrl,
  requiresUserBaseUrl,
  resolveModelTier,
  type ProviderId
} from '@shared/providers'
import { getApiKey, getAllowedProviders } from '../store'
import { localBaseReady } from '../llm/local-routing'
import { getState as localRuntimeState } from '../llm/local-runtime'
import { operatorAskTransport, operatorFundedProviders } from '../operator-ingest'
import { resolvePortalCloudflareModel } from '@shared/ask-routing'
import { intelligenceRequiresLocal } from '@shared/intelligence-pass'

export type IntelligencePassCandidate = {
  provider: ProviderId
  model: string
  key: string
  operatorTransport?: { url: string; secret: string }
}

export {
  INTELLIGENCE_PASS_NO_PROVIDER,
  INTELLIGENCE_PASS_BOTH_FAILED
} from '@shared/intelligence-pass'

function pickConfiguredApiCandidate(
  s: Settings,
  allowed: string[] | null
): IntelligencePassCandidate | null {
  const order = [s.provider, ...(Object.keys(PROVIDERS) as ProviderId[])]
  const seen = new Set<ProviderId>()
  const funded = operatorFundedProviders()
  const transport = operatorAskTransport(s)
  for (const p of order) {
    if (p === 'local' || seen.has(p)) continue
    seen.add(p)
    if (allowed && !allowed.includes(p)) continue
    const def = PROVIDERS[p]
    if (!def) continue
    const key = getApiKey(p)
    const operatorTransport = !key && def.kind !== 'cli' && funded.includes(p) ? transport : null
    const connected = def.kind === 'cli' ? !!s.cliConnected[p] : key.length > 0 || !!operatorTransport
    if (!connected) continue
    if (p === 'dust' && !s.dustWorkspaceId) continue
    if (!operatorTransport && requiresUserBaseUrl(p) && !providerBaseUrl(p, s)) continue
    let model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
    if (operatorTransport && p === 'cloudflare') model = resolvePortalCloudflareModel(model, 'deep')
    if (def.kind !== 'cli' && !model) continue
    return { provider: p, model, key, ...(operatorTransport ? { operatorTransport } : {}) }
  }
  return null
}

/** Local is ready for this pass: enabled, on disk, RAM ok, org allows it, runtime not locked out. */
export function intelligencePassLocalReady(s: Settings, allowed: string[] | null = getAllowedProviders()): boolean {
  return localBaseReady(s, allowed) && localRuntimeState() !== 'unavailable'
}

/**
 * Ordered candidates for the Update Intelligence pass only.
 * [local?, configuredApi?] — local first when ready, API once as failover. Never the reverse
 * while Local is ready. Never the full cloud waterfall.
 */
export function pickIntelligencePassCandidates(s: Settings): IntelligencePassCandidate[] {
  const allowed = getAllowedProviders()
  const out: IntelligencePassCandidate[] = []
  if (intelligencePassLocalReady(s, allowed)) {
    out.push({ provider: 'local', model: s.localLlm.modelId, key: '' })
  }
  if (intelligenceRequiresLocal(s)) return out
  const api = pickConfiguredApiCandidate(s, allowed)
  if (api) out.push(api)
  return out
}
