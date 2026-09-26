import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ADAPTER_IDS,
  WINDOWS_DESKTOP_EQUIVALENTS,
  desktopActionFingerprint,
  desktopActionMayReachDecide,
  isDesktopAdapterId
} from './desktop-actions'

describe('Cap2 desktop adapter contracts', () => {
  it('locks the six video adapter IDs', () => {
    expect([...DESKTOP_ADAPTER_IDS]).toEqual([
      'desktop.open_notes',
      'desktop.create_note',
      'desktop.open_arc',
      'desktop.google_search',
      'desktop.open_x',
      'desktop.photo_booth_capture'
    ])
  })

  it('rejects unknown ids', () => {
    expect(isDesktopAdapterId('desktop.open_notes')).toBe(true)
    expect(isDesktopAdapterId('shell.exec')).toBe(false)
  })

  it('fingerprints create_note + google_search by args', () => {
    expect(
      desktopActionFingerprint({ id: 'desktop.create_note', args: { title: 'hello' } })
    ).toBe('desktop.create_note:hello')
    expect(
      desktopActionFingerprint({ id: 'desktop.google_search', args: { q: 'Norbert Wiener' } })
    ).toBe('desktop.google_search:Norbert Wiener')
    expect(desktopActionFingerprint({ id: 'desktop.open_notes', args: {} })).toBe('desktop.open_notes')
  })

  it('photo booth must never reach decide/Jev', () => {
    expect(desktopActionMayReachDecide('desktop.photo_booth_capture')).toBe(false)
    expect(desktopActionMayReachDecide('desktop.open_notes')).toBe(true)
  })

  it('discloses Windows equivalents for every adapter', () => {
    for (const id of DESKTOP_ADAPTER_IDS) {
      expect(WINDOWS_DESKTOP_EQUIVALENTS[id].preferred.length).toBeGreaterThan(0)
      expect(WINDOWS_DESKTOP_EQUIVALENTS[id].note.length).toBeGreaterThan(0)
    }
    expect(WINDOWS_DESKTOP_EQUIVALENTS['desktop.open_arc'].note).toMatch(/silent/i)
  })
})
