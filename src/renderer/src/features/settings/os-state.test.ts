import { describe, expect, it } from 'vitest'
import { loginItemView, notificationsView } from './os-state'

describe('OS-dependent toggles show what the OS will do (HIG)', () => {
  it('Launch at login follows the OS, with a hint only when the OS refuses a wanted login item', () => {
    expect(loginItemView(true, true, { supported: true, enabled: true, requiresApproval: false })).toEqual({
      on: true,
      hint: null
    })
    expect(loginItemView(true, true, { supported: true, enabled: false, requiresApproval: false })).toEqual({
      on: false,
      hint: "macOS didn't add Métis to your login items."
    })
    expect(loginItemView(false, false, { supported: true, enabled: false, requiresApproval: false })).toEqual({
      on: false,
      hint: null
    })
    expect(loginItemView(true, true, { supported: true, enabled: true, requiresApproval: true }).hint).toBe(
      'macOS needs your approval before Métis can open at login.'
    )
  })

  it('falls back to the cached OS read when a fresh one is unavailable', () => {
    expect(loginItemView(true, false, null)).toEqual({ on: false, hint: null })
    expect(loginItemView(false, true, { supported: false, enabled: false, requiresApproval: false })).toEqual({
      on: true,
      hint: null
    })
  })

  it('Meeting alerts are off with a reason when the OS cannot show notifications', () => {
    expect(notificationsView(true, { supported: true })).toEqual({ on: true, hint: null })
    expect(notificationsView(true, null)).toEqual({ on: true, hint: null })
    expect(notificationsView(true, { supported: false })).toEqual({
      on: false,
      hint: "This computer isn't letting Métis show notifications."
    })
  })
})
