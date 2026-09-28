import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IdentitySection } from './IdentitySection'

describe('MQA-304 — one working licence activation surface', () => {
  it('the member pass never exposes the unavailable legacy activation or import controls', () => {
    const html = renderToStaticMarkup(<IdentitySection managedTier="metis" />)
    expect(html).toContain('License Métis.')
    expect(html).not.toContain('Activation is not open yet')
    expect(html).not.toContain('license.metis')
    expect(html).not.toContain('<input')
  })

  it('Identity uses the verified Operator flow and its live status, not memberLicenseActivate', () => {
    const panelSource = readFileSync(join(__dirname, '../features/settings/SettingsPanel.tsx'), 'utf8')
    const integrationsSource = readFileSync(join(__dirname, '../features/settings/Integrations.tsx'), 'utf8')
    const profile = panelSource.slice(panelSource.indexOf("{tab === 'profile' && ("), panelSource.indexOf("{tab === 'about' && ("))
    expect(profile).toContain('<OperatorLicenseCard refreshSettings={refreshSettings} showIdentity />')
    expect(integrationsSource).toContain('<IdentitySection managedTier={status?.tier ?? null} />')
    expect(integrationsSource).toContain("aria-label=\"Métis licence key\"")
    const identity = readFileSync(join(__dirname, 'IdentitySection.tsx'), 'utf8')
    expect(identity).not.toMatch(/memberLicenseActivate|memberLicenseImportFile/)
  })
})
