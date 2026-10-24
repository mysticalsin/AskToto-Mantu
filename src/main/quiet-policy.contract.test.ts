import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

const source = (fromDir: string, specifier: string): string => readModuleSource(fromDir, specifier).text

const mainIndex = source('src/main', './index')
const updater = source('src/main', './updater')
const notification = source('src/main', './quiet-output')
const settingsIpc = source('src/main/ipc', './settings-system-ipc')
const askTurns = source('src/main/features/session-context', './ask-turn')
const overlayToasts = source('src/renderer/src/components', './OverlayToasts')
const app = source('src/renderer/src', './App')
const audioSettings = source('src/renderer/src/features/settings', './AudioTab')

describe('G68 unsolicited output wiring', () => {
  it('routes all native notification producers through the quiet output gate', () => {
    // One producer: src/main/quiet-output.ts builds every native Notification, behind submitQuietOutput.
    expect(notification).toMatch(/submitQuietOutput\(\s*'toast'/)
    expect(notification.match(/new\s+Notification\s*\(/g)).toHaveLength(1)
    for (const sourceText of [mainIndex, updater]) {
      expect(sourceText).not.toMatch(/new\s+Notification\s*\(/)
      expect(sourceText).toMatch(/(showQuietNotification|notifyImportComplete)\(/)
    }
    // The only owner-requested notification is the confirmation after the owner connects Dust.
    expect(mainIndex.match(/directRequest: true/g)).toHaveLength(1)
    expect(mainIndex).toMatch(/Dust connected[^}]*directRequest: true/)
    expect(settingsIpc).toContain('QUIET_IPC.outputOffer')
  })

  it('classifies each unsolicited overlay toast and keeps owner-triggered toasts separate', () => {
    expect(overlayToasts).toContain('QUIET_TOAST_COMPONENTS')
    expect(overlayToasts).toContain('DIRECT_TOAST_COMPONENTS')
    expect(overlayToasts).toContain('quietOutputOffer')
    const rendered = [...overlayToasts.matchAll(/^\s*<([A-Z][A-Za-z0-9]+)/gm)].map((match) => match[1])
    const inventory = (name: string): string[] => {
      const start = overlayToasts.indexOf(`export const ${name} =`)
      const end = overlayToasts.indexOf('as const', start)
      return [...overlayToasts.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
    }
    const quiet = inventory('QUIET_TOAST_COMPONENTS')
    const direct = inventory('DIRECT_TOAST_COMPONENTS')
    expect(new Set(rendered)).toEqual(new Set([...quiet, ...direct]))
  })

  it('marks ambient suggestion and wrap-up requests for the main ask-turn gate', () => {
    expect(app).toContain("outputIntent: 'ambient'")
    expect(askTurns).toContain('outputIntent')
    expect(askTurns).toContain('quietAction')
  })

  it('exposes one quiet setting with the agreed copy and all three choices', () => {
    expect(audioSettings).toContain('Stay quiet during calls and screen sharing')
    for (const value of ['off', 'calls-and-screen-sharing', 'always'])
      expect(audioSettings).toContain(`value="${value}"`)
  })
})
