/**
 * screen-check-context.ts — the facts the Settings "screen capture check" needs to pick a vision backend.
 * Extracted from index.ts unchanged so the entry file shrinks (FF-04); behaviour is identical.
 */
import { CLI_PROVIDER_IDS } from '@shared/ask-routing'
import { PROVIDERS, providerBaseUrl, requiresUserBaseUrl } from '@shared/providers'
import { isApiVisionCandidate, type VisionCheckContext } from '@shared/screen-capture-check'
import { isDownloaded as localModelDownloaded } from './llm/local-models'
import { localRuntimeBinaryPresent } from './llm/local-routing'
import { narrowAllowedForCapability } from './model-policy-client'
import { dustSelectedAgentVision, getAllowedProviders, getApiKey, getSettings } from './store'

export function visionCheckContextFromSettings(): VisionCheckContext {
  const s = getSettings()
  let localWeightsReady = false
  try {
    localWeightsReady = localModelDownloaded(s.localLlm.modelId) && localRuntimeBinaryPresent()
  } catch {
    localWeightsReady = false
  }
  const provider = s.provider
  const visionOk = provider === 'dust' ? dustSelectedAgentVision(s.providerModels['dust']) : PROVIDERS[provider].vision
  const configured =
    provider === 'local'
      ? false
      : PROVIDERS[provider].kind === 'cli'
        ? !!s.cliConnected[provider]
        : getApiKey(provider).length > 0 &&
          (provider !== 'dust' || !!s.dustWorkspaceId) &&
          (!requiresUserBaseUrl(provider) || !!providerBaseUrl(provider, s))
  const allowed = narrowAllowedForCapability(s, getAllowedProviders(), 'askChat', [...CLI_PROVIDER_IDS, 'local'])
  const orgOk = !allowed || allowed.includes(provider)
  return {
    localWeightsReady,
    localEnabled: s.localLlm.enabled,
    apiVisionReady: isApiVisionCandidate(provider, visionOk, configured && orgOk),
    activeProvider: provider
  }
}
