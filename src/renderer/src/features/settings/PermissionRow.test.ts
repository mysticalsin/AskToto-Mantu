import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PermissionRow } from './PermissionsSection'
import { openSettingsTitle, osSettingsWhere } from '../../lib/os-settings-copy'

/**
 * C32 (Apple HIG Privacy) — Settings' permission rows, rendered for macOS and Windows on any host. Not asked: one
 * "Continue" (macOS only; Windows raises no prompt). Denied: the exact click path and ONE action titled for the
 * platform. Granted: no action, on either platform (the old Windows link showed even when granted).
 */
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1])
const render = (props: Parameters<typeof PermissionRow>[0]): string =>
  renderToStaticMarkup(createElement(PermissionRow, props))
const decode = (html: string): string => html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'")

describe('Settings permission rows per platform', () => {
  for (const windows of [false, true]) {
    const os = windows ? 'Windows' : 'macOS'
    for (const kind of ['microphone', 'screenRecording'] as const) {
      it(`${os} ${kind}: denied says where to click and offers one "${openSettingsTitle(windows)}"`, () => {
        const html = render({ kind, label: kind, status: 'denied', windows })
        expect(buttons(html)).toEqual([openSettingsTitle(windows)])
        expect(decode(html)).toContain(osSettingsWhere(kind, windows))
      })

      it(`${os} ${kind}: granted shows no action`, () => {
        expect(buttons(render({ kind, label: kind, status: 'granted', windows }))).toEqual([])
      })
    }

    it(`${os}: not asked yet`, () => {
      const html = render({ kind: 'microphone', label: 'Microphone', status: 'not-determined', windows })
      expect(buttons(html)).toEqual(windows ? [] : ['Continue'])
      expect(html).not.toMatch(/Allow|Request permission/)
    })
  }

  it('the titles and click paths', () => {
    expect(openSettingsTitle(false)).toBe('Open System Settings')
    expect(openSettingsTitle(true)).toBe('Open Settings')
    expect(osSettingsWhere('microphone', false)).toBe(
      'Turn on Métis in System Settings › Privacy & Security › Microphone.'
    )
    expect(osSettingsWhere('microphone', true)).toContain('Settings › Privacy & security › Microphone')
    expect(osSettingsWhere('screenRecording', false)).toContain('Screen & System Audio Recording, then relaunch Métis.')
    expect(osSettingsWhere('loginItems', true)).toBe('Turn on Métis in Settings › Apps › Startup.')
  })

  it('a grant that needs the next process offers one Relaunch', () => {
    const html = render({
      kind: 'screenRecording',
      label: 'Screen / system audio',
      status: 'granted',
      windows: false,
      relaunch: { busy: false, run: () => {} }
    })
    expect(buttons(html)).toEqual(['Relaunch'])
  })
})
