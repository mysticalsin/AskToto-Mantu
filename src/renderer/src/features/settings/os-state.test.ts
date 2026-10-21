import { describe, expect, it } from 'vitest'
import { loginItemView, notificationsView } from './os-state'

const MAC_WHERE = 'Turn on Métis in System Settings › General › Login Items.'
const WIN_WHERE = 'Turn on Métis in Settings › Apps › Startup.'

describe('OS-dependent toggles show what the OS will do (HIG)', () => {
  it('Launch at login follows the OS, with a hint only when the OS refuses a wanted login item', () => {
    expect(loginItemView(true, true, { supported: true, enabled: true, requiresApproval: false }, false)).toEqual({
      on: true,
      hint: null
    })
    expect(loginItemView(true, true, { supported: true, enabled: false, requiresApproval: false }, false)).toEqual({
      on: false,
      hint: `macOS didn't add Métis to your login items. ${MAC_WHERE}`
    })
    expect(loginItemView(false, false, { supported: true, enabled: false, requiresApproval: false }, false)).toEqual({
      on: false,
      hint: null
    })
    expect(loginItemView(true, true, { supported: true, enabled: true, requiresApproval: true }, false).hint).toBe(
      `macOS needs your approval before Métis can open at login. ${MAC_WHERE}`
    )
  })

  it('C32: on Windows the copy names Windows and Startup apps, never macOS', () => {
    expect(loginItemView(true, true, { supported: true, enabled: false, requiresApproval: false }, true).hint).toBe(
      `Windows didn't add Métis to your startup apps. ${WIN_WHERE}`
    )
    expect(loginItemView(true, true, { supported: true, enabled: true, requiresApproval: true }, true).hint).toBe(
      `Windows has turned off Métis in your startup apps. ${WIN_WHERE}`
    )
    expect(notificationsView(true, { supported: false }, true).hint).toBe(
      "This computer isn't letting Métis show notifications. Turn on notifications for Métis in Settings › System › Notifications."
    )
  })

  it('falls back to the cached OS read when a fresh one is unavailable', () => {
    expect(loginItemView(true, false, null, false)).toEqual({ on: false, hint: null })
    expect(loginItemView(false, true, { supported: false, enabled: false, requiresApproval: false }, false)).toEqual({
      on: true,
      hint: null
    })
  })

  it('Meeting alerts are off with a reason when the OS cannot show notifications', () => {
    expect(notificationsView(true, { supported: true }, false)).toEqual({ on: true, hint: null })
    expect(notificationsView(true, null, false)).toEqual({ on: true, hint: null })
    expect(notificationsView(true, { supported: false }, false)).toEqual({
      on: false,
      hint: "This computer isn't letting Métis show notifications. Turn on Allow Notifications for Métis in System Settings › Notifications."
    })
  })
})
