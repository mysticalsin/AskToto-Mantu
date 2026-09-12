import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { emptyLicenseStatus, type IdentitySnapshot } from '@shared/ipc'
import { IdentityCard, passAriaLabel } from './IdentityCard'

const SNAP: IdentitySnapshot = {
  installId: '11111111-1111-4111-8111-111111111111',
  installedAt: '2026-03-19T08:11:00.000Z',
  installedAtLabel: 'Installed 19 Mar 2026',
  memberNumber: null,
  memberNumberLabel: 'pending',
  deviceName: 'MacBook Pro',
  serialKind: 'hardware',
  serialDisplay: 'C02X · 1841 · KQ8L',
  license: emptyLicenseStatus()
}

describe('IdentityCard', () => {
  it('names the pass for VoiceOver with member, device, and license state', () => {
    expect(passAriaLabel(SNAP)).toBe(
      'Métis member pass. Member pending. MacBook Pro. License Personal.'
    )
    expect(passAriaLabel({ ...SNAP, memberNumber: 1284, memberNumberLabel: '1284' })).toBe(
      'Métis member pass. Member 1284. MacBook Pro. License Personal.'
    )
  })

  it('renders identity on the front and the license face on the back', () => {
    const html = renderToStaticMarkup(<IdentityCard snapshot={SNAP} reducedMotion />)
    expect(html).toContain('pending')
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('C02X · 1841 · KQ8L')
    expect(html).toContain('Installed 19 Mar 2026')
    expect(html).toContain('Serial')
    expect(html).toContain('License')
    expect(html).toContain('Personal')
    expect(html).toContain('Activate your Métis licence below')
    expect(html).not.toContain('Activation is not open yet')
    expect(html).toContain('metis-pass--static')
    expect(html).toContain('aria-label="Métis member pass. Member pending. MacBook Pro. License Personal."')
  })

  it('labels an install-id fallback as Install ID, never Serial', () => {
    const html = renderToStaticMarkup(
      <IdentityCard
        snapshot={{ ...SNAP, serialKind: 'install', serialDisplay: '···7890' }}
        reducedMotion
      />
    )
    expect(html).toContain('Install ID')
    expect(html).not.toMatch(/>Serial</)
  })

  it('does not invent a member number when pending', () => {
    const html = renderToStaticMarkup(<IdentityCard snapshot={SNAP} reducedMotion />)
    expect(html).not.toContain('Nº 1')
    expect(html).not.toContain('Nº 0')
    expect(html).toContain('pending')
  })

  it('MQA-304 — shows a verified managed licence instead of the legacy Personal state', () => {
    for (const [tier, label] of [['metis', 'Métis'], ['metis-light', 'Métis Light']] as const) {
      const html = renderToStaticMarkup(<IdentityCard snapshot={SNAP} managedTier={tier} reducedMotion />)
      expect(html).toContain(`License ${label}.`)
      expect(html).toContain('Managed licence verified')
      expect(html).not.toContain('License Personal.')
      expect(html).not.toContain('Activation is not open yet')
    }
  })
})
