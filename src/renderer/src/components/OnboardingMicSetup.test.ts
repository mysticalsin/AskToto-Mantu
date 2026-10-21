import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PlatformPermissions, ScreenDiagnosisState } from '@shared/screen-permission'
import { MEETING_AUDIO_SCREEN_WHY } from '../lib/screen-permission-copy'
import { MicSetupActions } from './OnboardingMicSetup'
import { ScreenSetupActions } from './OnboardingScreenSetup'

// These rows pin the macOS copy and deep links. Node exposes the host's navigator.platform, so on a Windows
// runner isWindows would be true and the rows would render their Windows variants instead.
vi.mock('../lib/keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/keys')>()),
  isWindows: false
}))

/**
 * C26 (HIG P3) — a pre-alert row explains why first, then offers ONE button titled "Continue" that opens the
 * system alert. Never "Allow" (the system alert owns that word), and no second control that skips the alert.
 */
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1])
const noop = (): void => {}

function screenPerms(state: ScreenDiagnosisState): PlatformPermissions {
  return {
    microphone: 'granted',
    screenRecording: state === 'granted' ? 'granted' : 'unknown',
    screenDiagnosis: { state, reasons: [], action: 'none', duplicates: [], grantedFor: null, repairFailed: false }
  }
}

describe('C26 — onboarding microphone row', () => {
  it('not yet asked: the why-copy, then exactly one "Continue" described by it', () => {
    const html = renderToStaticMarkup(createElement(MicSetupActions, { state: 'action', onContinue: noop }))
    expect(html).toContain('Lets Métis hear your side of the call.')
    expect(buttons(html)).toEqual(['Continue'])
    expect(html).not.toMatch(/Allow/)
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    expect(html).toContain(`id="${describedBy}"`)
    expect(html.indexOf('Lets Métis hear')).toBeLessThan(html.indexOf('<button'))
  })

  it('denied: no prompt button, the "won\'t ask again" copy and the Privacy pane deep link', () => {
    const html = renderToStaticMarkup(createElement(MicSetupActions, { state: 'blocked', onContinue: noop }))
    expect(html).toContain('macOS won&#x27;t ask again once you&#x27;ve said no.')
    expect(buttons(html)).toEqual(['Open System Settings'])
    expect(html).toContain('Turn on Métis in System Settings › Privacy &amp; Security › Microphone.')
  })

  it('granted (or still checking): nothing to ask, so no actions', () => {
    for (const state of ['ready', 'checking', 'loading', 'skipped'] as const) {
      expect(renderToStaticMarkup(createElement(MicSetupActions, { state, onContinue: noop }))).toBe('')
    }
  })
})

describe('C26 — onboarding meeting audio & screen row', () => {
  const render = (state: ScreenDiagnosisState): string =>
    renderToStaticMarkup(
      createElement(ScreenSetupActions, { perms: screenPerms(state), check: 'idle', onRequest: noop, onRecheck: noop })
    )

  it('not yet asked: the why-copy, then exactly one "Continue" described by it', () => {
    const html = render('not-asked')
    expect(html).toContain(MEETING_AUDIO_SCREEN_WHY)
    expect(buttons(html)).toEqual(['Continue'])
    expect(html).not.toMatch(/Allow/)
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    expect(html).toContain(`id="${describedBy}"`)
  })

  it('denied: never a prompt button, only the Screen Recording pane', () => {
    const html = render('denied')
    expect(buttons(html)).not.toContain('Continue')
    expect(buttons(html)).toEqual(['Open System Settings', 'Relaunch'])
  })
})

describe('C32 — the same rows on Windows (platform injected, any host)', () => {
  it('microphone denied: Windows copy with the exact click path and one "Open Settings"', () => {
    const html = renderToStaticMarkup(
      createElement(MicSetupActions, { state: 'blocked', onContinue: noop, windows: true })
    )
    expect(buttons(html)).toEqual(['Open Settings'])
    expect(html).toContain('Settings › Privacy &amp; security › Microphone.')
    expect(html).not.toMatch(/macOS/)
  })

  it('screen capture refused: one "Open Settings"; available or unknown: nothing to do', () => {
    const perms = (screenRecording: PlatformPermissions['screenRecording']): PlatformPermissions => ({
      microphone: 'granted',
      screenRecording
    })
    const render = (p: PlatformPermissions): string =>
      renderToStaticMarkup(
        createElement(ScreenSetupActions, { perms: p, check: 'idle', onRequest: noop, onRecheck: noop, windows: true })
      )
    expect(buttons(render(perms('denied')))).toEqual(['Open Settings'])
    expect(render(perms('denied'))).toContain('Windows is blocking screen capture.')
    expect(render(perms('granted'))).toBe('')
    expect(render(perms('unknown'))).toBe('')
  })
})
