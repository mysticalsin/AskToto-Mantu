import { describe, it, expect } from 'vitest'
import { serializeAsrCorrections, parseAsrCorrections, sameAsrCorrections, searchSettingsTabs } from './Settings'

describe('vocabulary-corrections helpers', () => {
  it('serializes one "heard => correct" line per correction, in order', () => {
    expect(serializeAsrCorrections([{ from: 'Mantoo', to: 'Mantu' }, { from: 'Bizioux', to: 'Bisiou' }]))
      .toBe('Mantoo => Mantu\nBizioux => Bisiou')
    expect(serializeAsrCorrections([])).toBe('')
  })

  it('round-trips serialize → parse', () => {
    const items = [{ from: 'Acme Corp', to: 'Acme' }, { from: 'L Oreal', to: 'L’Oréal' }]
    expect(parseAsrCorrections(serializeAsrCorrections(items))).toEqual(items)
  })

  it('parse tolerates in-progress edits (blank lines, lines with no "=>" yet, empty "from")', () => {
    // This is the crux of the fix: typing Enter (a trailing blank line) or a half-typed line must not
    // corrupt the committed set — those lines are simply "not a correction yet" and are dropped.
    expect(parseAsrCorrections('a => b\n\nnotyet\n => c\nx => y')).toEqual([{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }])
    expect(parseAsrCorrections('a => b\n')).toEqual([{ from: 'a', to: 'b' }]) // trailing newline mid-typing
    expect(parseAsrCorrections('   =>   ')).toEqual([]) // whitespace-only from → not a correction
  })

  it('parse trims and allows an empty replacement (delete a word)', () => {
    expect(parseAsrCorrections('  uh  =>  ')).toEqual([{ from: 'uh', to: '' }])
  })

  it('parse caps at 100 corrections', () => {
    const raw = Array.from({ length: 150 }, (_, i) => `f${i} => t${i}`).join('\n')
    expect(parseAsrCorrections(raw)).toHaveLength(100)
  })

  it('sameAsrCorrections is value-equal and order-sensitive', () => {
    const a = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }]
    expect(sameAsrCorrections(a, [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }])).toBe(true)
    expect(sameAsrCorrections(a, [{ from: 'c', to: 'd' }, { from: 'a', to: 'b' }])).toBe(false) // order matters
    expect(sameAsrCorrections(a, [{ from: 'a', to: 'b' }])).toBe(false)
  })
})

describe('searchSettingsTabs — settings search must find real section titles, not just tab labels', () => {
  it('finds the "Conversation memory" section (Privacy tab) by its exact title', () => {
    const matches = searchSettingsTabs('Conversation memory')
    expect(matches.map((m) => m.id)).toContain('privacy')
  })

  it('finds Conversation memory by its follow-up-question toggle wording too', () => {
    expect(searchSettingsTabs('follow-up').map((m) => m.id)).toContain('privacy')
    expect(searchSettingsTabs('memory').map((m) => m.id)).toContain('privacy')
  })

  it('finds the "CLI Integration" section (AI tab) by its exact title', () => {
    expect(searchSettingsTabs('CLI Integration').map((m) => m.id)).toContain('ai')
  })

  it('is case- and diacritic-insensitive, and empty for no match', () => {
    expect(searchSettingsTabs('CONVERSATION MEMORY').map((m) => m.id)).toContain('privacy')
    expect(searchSettingsTabs('metis').map((m) => m.id)).toContain('about') // "why métis" keyword
    expect(searchSettingsTabs('')).toEqual([])
    expect(searchSettingsTabs('zzz-not-a-real-setting')).toEqual([])
  })

  // MQA-131: caught by driving the real app — a `<Section title="…">` added without its title landing
  // in the owning tab's `keywords` is invisible to settings search (the INVARIANT documented above
  // TABS). Both task-manager connectors and the resilience card shipped that way.
  it('MQA-131: finds every connector section on the Intelligence tab by its exact title', () => {
    for (const title of ['Polo Pre-Sales', 'Plane', 'ClickUp']) {
      expect(searchSettingsTabs(title).map((m) => m.id), `search "${title}"`).toContain('intelligence')
    }
  })

  it('MQA-131: finds "Backups & limits" (AI tab) and the hedge toggle that lives inside it', () => {
    expect(searchSettingsTabs('Backups & limits').map((m) => m.id)).toContain('ai')
    expect(searchSettingsTabs('Race a backup provider').map((m) => m.id)).toContain('ai')
  })

  it('finds the default NVIDIA NIM provider by name', () => {
    expect(searchSettingsTabs('NVIDIA').map((m) => m.id)).toContain('ai')
  })

  it('finds the Identity tab by member pass, serial, and license', () => {
    expect(searchSettingsTabs('Identity').map((m) => m.id)).toContain('profile')
    expect(searchSettingsTabs('member pass').map((m) => m.id)).toContain('profile')
    expect(searchSettingsTabs('serial').map((m) => m.id)).toContain('profile')
    expect(searchSettingsTabs('About you').map((m) => m.id)).toContain('profile')
    expect(searchSettingsTabs('License').map((m) => m.id)).toContain('profile')
  })
})
