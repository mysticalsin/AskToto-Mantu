/**
 * dust-disconnect.ts — the settings a full Dust disconnect writes, moved out of DustSetup.tsx unchanged so the card
 * stays under its size ceiling. Pure: the card writes this patch first and clears the saved key last.
 */
import { DUST_BASE_AGENT_ID, type PublicSettings } from '@shared/ipc'
import { pickReadyProvider } from './provider-readiness'

export function dustDisconnectPatch(settings: PublicSettings): Partial<PublicSettings> {
  const nextThinking = { ...settings.providerModelsThinking }
  delete nextThinking.dust
  // Base is now user-changeable, so disconnect restores it to the Métis default rather than leaving
  // a stale custom agent id pointing at a workspace you just disconnected from. Spotlight Ref is left
  // untouched — it's a hard-locked app default, not user data.
  const next: Partial<PublicSettings> = {
    dustWorkspaceId: '',
    dustBaseUrl: 'https://dust.tt',
    providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID },
    providerModelsThinking: nextThinking,
    // Reset to the "never CLI-connected" default (0) — otherwise a stale CLI-origin timestamp survives
    // into a later manual-API-key connect and wrongly gates the live-check effect into probing a real
    // Dust CLI session that was never used for that connection (see the effect's own gating comment).
    dustTokenMintedAt: 0
  }
  if (settings.provider === 'dust')
    next.provider = pickReadyProvider(
      'dust',
      settings.hasKeys,
      settings.cliConnected ?? {},
      settings.dustWorkspaceId,
      settings.providerModels,
      settings.allowedProviders
    )
  return next
}
