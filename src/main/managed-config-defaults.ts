import type { Settings } from '@shared/ipc'

export const DUST_BASE_AGENT_ID = 'vJxYHvTRBT'
export const DUST_SPOTLIGHT_REF_AGENT_ID = 'GOr913Zr5V'

export const MANAGED_CONFIG_DEFAULTS: Partial<Settings> = {
  providerModels: { dust: DUST_BASE_AGENT_ID },
  providerModelsSpotlightRef: { dust: DUST_SPOTLIGHT_REF_AGENT_ID }
}
