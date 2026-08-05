import { describe, it, expect } from 'vitest'
import { providerTileDisabledReason } from './Onboarding'

describe('providerTileDisabledReason — step-5 provider tiles must not misreport why they are disabled', () => {
  it('is null (tappable) when nothing blocks the tile', () => {
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true })).toBeNull()
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true, busy: false })).toBeNull()
  })

  it('is "org" when provider is locked by managed config, regardless of busy', () => {
    expect(providerTileDisabledReason({ providerLocked: true, pathAllowed: true })).toBe('org')
    expect(providerTileDisabledReason({ providerLocked: true, pathAllowed: true, busy: true })).toBe('org')
  })

  it('is "org" when the org data-residency allowlist excludes this path, regardless of busy', () => {
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: false })).toBe('org')
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: false, busy: true })).toBe('org')
  })

  it('is "busy" only when nothing org-related blocks it AND busy is explicitly passed true', () => {
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true, busy: true })).toBe('busy')
  })

  it('never returns "busy" for a tile that does not pass busy at all — the CLI probe must not leak ' +
      'into the API-key or Mantu Dust tiles', () => {
    // The bug: cliBusy used to disable all three ProviderOption tiles, and the disabled badge always
    // said "Restricted by your organization" — so for ~45s the API-key and Dust tiles looked
    // org-restricted too. Callers for those tiles never pass `busy`, so this must stay null here.
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true })).toBeNull()
  })
})
