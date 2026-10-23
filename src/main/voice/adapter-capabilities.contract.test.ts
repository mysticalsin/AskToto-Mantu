import { describe, expect, it } from 'vitest'
import { DESKTOP_ADAPTER_IDS, type DesktopActionRequest, type DesktopAdapterId } from '@shared/desktop-actions'
import { ADAPTER_CAPABILITIES, capabilityFor } from '@shared/voice/adapter-capabilities'
import { desktopActionResources } from '../tasks/desktop-action-task-policy'
import { createCommandPreflight } from './command-preflight'

const SAMPLES: Record<DesktopAdapterId, DesktopActionRequest[]> = {
  'desktop.open_notes': [{ id: 'desktop.open_notes', args: {} }],
  'desktop.create_note': [{ id: 'desktop.create_note', args: { title: 'Synthetic' } }],
  'desktop.open_arc': [{ id: 'desktop.open_arc', args: {} }],
  'desktop.google_search': [
    { id: 'desktop.google_search', args: { q: 'synthetic' } },
    { id: 'desktop.google_search', args: { q: 'synthetic', browser: 'arc' } }
  ],
  'desktop.open_x': [
    { id: 'desktop.open_x', args: {} },
    { id: 'desktop.open_x', args: { browser: 'arc' } }
  ],
  'desktop.photo_booth_capture': [{ id: 'desktop.photo_booth_capture', args: {} }]
}

describe('adapter capability declarations agree with the scheduler and the preflight (G40)', () => {
  it('declares every resource the scheduler locks for any request of the id', () => {
    for (const id of DESKTOP_ADAPTER_IDS) {
      for (const request of SAMPLES[id]) {
        for (const resource of desktopActionResources(request)) {
          expect(ADAPTER_CAPABILITIES[id].resources, `${id} ${resource}`).toContain(resource)
        }
      }
    }
  })

  it('declares accessibility exactly where the macOS preflight asks for it', async () => {
    const preflight = createCommandPreflight({
      platform: 'darwin',
      isAuthenticated: () => true,
      isRecordingMeeting: () => false,
      appInstalled: async () => true,
      automationStatus: async () => 'granted',
      accessibilityTrusted: () => false
    })
    for (const id of DESKTOP_ADAPTER_IDS) {
      const result = await preflight(SAMPLES[id][0]!, 'propose')
      const asksForAccessibility = !result.ok && result.notice.code === 'accessibility_needed'
      expect(capabilityFor(id, 'darwin')?.permissions.includes('accessibility') === true, id).toBe(asksForAccessibility)
    }
  })
})
