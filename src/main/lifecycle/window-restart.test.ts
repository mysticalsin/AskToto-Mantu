import { describe, expect, it } from 'vitest'
import { captureActiveForWindowRestart, type WindowRestartCaptureState } from './window-restart'

const idle: WindowRestartCaptureState = {
  listeningActive: false,
  audioArmed: false,
  legacyListeningActive: false,
  cloudSttActive: false
}

describe('window restart capture guard', () => {
  it('enables Restart Métis window only while no capture owner is active', () => {
    expect(captureActiveForWindowRestart(idle)).toBe(false)
  })

  it.each([
    ['renderer listening', { listeningActive: true }],
    ['armed loopback audio', { audioArmed: true }],
    ['legacy listening', { legacyListeningActive: true }],
    ['cloud STT owner', { cloudSttActive: true }]
  ] as const)('disables Restart Métis window while %s is active', (_label, active) => {
    expect(captureActiveForWindowRestart({ ...idle, ...active })).toBe(true)
  })
})
