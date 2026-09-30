import { describe, expect, it } from 'vitest'
import { createScreenCaptureGrantGate } from './screen-capture-eligibility'

describe('createScreenCaptureGrantGate', () => {
  it('requires a live macOS Screen Recording grant', () => {
    const gate = createScreenCaptureGrantGate({
      platform: 'darwin',
      macScreenStatus: () => 'granted',
      windowsScreenStatus: () => 'denied'
    })

    expect(gate?.()).toBe(true)
  })

  it('requires a probed Windows capture grant; unknown and denied both fail closed', () => {
    let status: 'unknown' | 'denied' | 'granted' = 'unknown'
    const gate = createScreenCaptureGrantGate({
      platform: 'win32',
      macScreenStatus: () => 'granted',
      windowsScreenStatus: () => status
    })

    expect(gate?.()).toBe(false)
    status = 'denied'
    expect(gate?.()).toBe(false)
    status = 'granted'
    expect(gate?.()).toBe(true)
  })

  it('leaves non-desktop platforms without a screen-capture grant dependency', () => {
    expect(
      createScreenCaptureGrantGate({
        platform: 'linux',
        macScreenStatus: () => 'denied',
        windowsScreenStatus: () => 'denied'
      })
    ).toBeUndefined()
  })
})
