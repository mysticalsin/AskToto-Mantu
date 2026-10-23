import { describe, expect, it } from 'vitest'
import { AMBIENT_OBSERVATION_ROWS } from '@shared/ambient-observation'
import { readModuleSource } from '../../../../test-helpers/module-source'

describe('Settings › Privacy › Background observation (R111, D-19)', () => {
  it('discloses the foreground app watcher as memory-only with no history', () => {
    const row = AMBIENT_OBSERVATION_ROWS.find((r) => r.id === 'foreground-app')
    expect(row).toBeDefined()
    expect(row?.keeps).toMatch(/memory only/i)
    expect(row?.keeps).toMatch(/never saved, logged, sent or reported/i)
    expect(row?.detail).toMatch(/does not run while both are off/i)
  })

  it('is rendered in the Privacy tab', () => {
    const root = readModuleSource(__dirname, './SettingsRoot').text
    const privacy = root.slice(root.indexOf("tab === 'privacy'"), root.indexOf("tab === 'meetings'"))
    expect(privacy).toContain('<PrivacyObservationSections />')
    const sections = readModuleSource(__dirname, './PrivacyObservationSections').text
    expect(sections).toContain('<AmbientObservationSection />')
    expect(sections).toContain('<TaskBrowserSection />')
  })
})
