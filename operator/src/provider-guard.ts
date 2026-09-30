import { PROVIDERS, type ProviderDef, type ProviderId } from '../../src/shared/providers'

/** The one "provider not allowed for an Operator-funded call" guard shared by `/v1/ask` and `/v1/use`:
 *  only a catalogued HTTP provider can be called with a vaulted key, never a CLI, Dust or local one.
 *  Kept out of keys.ts so the SPA client bundle, which reaches keys.ts, does not pull in the provider catalog. */
export function operatorCallableProvider(provider: string): ProviderDef | null {
  const def = provider in PROVIDERS ? PROVIDERS[provider as ProviderId] : null
  if (!def || def.kind === 'cli' || def.kind === 'dust' || def.kind === 'local') return null
  return def
}
