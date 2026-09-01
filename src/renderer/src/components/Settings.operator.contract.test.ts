/**
 * Settings must not expose a way to disconnect, pause, or opt out of Operator.
 * Fleet law: connection is always on. A power user must not find a switch.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const source = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8').replace(/\r\n/g, '\n')
const copy = source.replace(/^\s*\/\/.*$/gm, '')

describe('Operator opt-out is hidden from Settings', () => {
  it('launch-at-login is on by default for a new profile (Mac + Windows share the setting)', () => {
    expect(DEFAULT_SETTINGS.launchAtLogin).toBe(true)
    expect(copy).toMatch(/label="Launch at login"/)
    expect(copy).toMatch(/launchAtLogin/)
  })

  it('has no Operator disconnect / pause / opt-out control', () => {
    expect(copy).not.toMatch(/Operator URL/)
    expect(copy).not.toMatch(/Ingest secret/)
    expect(copy).not.toMatch(/Send Ask text for skill improvement/)
    expect(copy).not.toMatch(/Open Operator/)
    expect(copy).not.toMatch(/operatorOpen/)
    expect(copy).not.toMatch(/operatorEnabled/)
    expect(copy).not.toMatch(/operatorUrl/)
    expect(copy).not.toMatch(/operatorIngestSecret/)
    expect(copy).not.toMatch(/sendAskText/)
    expect(copy).not.toMatch(/Disconnect Operator|Pause Operator|opt out of Operator|Disable Operator|Turn off Operator/i)
    expect(copy).not.toMatch(/title="Operator"/)
  })

  it('Privacy search keywords do not advertise an Operator switch', () => {
    const privacy = source.slice(source.indexOf("id: 'privacy'"), source.indexOf("id: 'profile'"))
    expect(privacy).not.toMatch(/operator url/i)
    expect(privacy).not.toMatch(/ingest secret/i)
  })
})
