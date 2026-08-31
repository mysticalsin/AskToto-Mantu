import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { screenRecordingJustGranted } from './Settings'
import { nextScreenCheckPass } from '@shared/screen-capture-check'

const settingsSrc = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8')

describe('screenRecordingJustGranted — the Restart Métis trigger', () => {
  it('is false on the first observation since mount, even if already granted', () => {
    expect(screenRecordingJustGranted(null, 'granted', false)).toBe(false)
  })

  it('is true when a not-yet-granted status flips to granted while mounted', () => {
    expect(screenRecordingJustGranted('unknown', 'granted', false)).toBe(true)
    expect(screenRecordingJustGranted('denied', 'granted', false)).toBe(true)
  })

  it('is false when the status was already granted and stays granted', () => {
    expect(screenRecordingJustGranted('granted', 'granted', false)).toBe(false)
  })

  it('is false when the status is not granted', () => {
    expect(screenRecordingJustGranted('unknown', 'denied', false)).toBe(false)
    expect(screenRecordingJustGranted('unknown', 'unknown', false)).toBe(false)
  })

  it('is false on Windows, which has no relaunch-to-apply quirk', () => {
    expect(screenRecordingJustGranted('unknown', 'granted', true)).toBe(false)
  })
})

describe('PermissionsSection — screen capture self-check is two passes', () => {
  it('first click is the OS probe; the second click is a vision pass', () => {
    expect(nextScreenCheckPass(null)).toBe('probe')
    expect(nextScreenCheckPass('probe')).toBe('vision')
    expect(settingsSrc).toMatch(/const pass = nextScreenCheckPass\(lastCheckPass\)/)
    expect(settingsSrc).toMatch(/window\.toto[\s\S]{0,40}screenCaptureCheck\(pass\)/)
    expect(settingsSrc).toMatch(/Check screen capture/)
    expect(settingsSrc).toMatch(/Check again with AI/)
  })

  it('never turns the self-check into an overlay ask or a teammate send', () => {
    const start = settingsSrc.indexOf('const runScreenCheck =')
    expect(start).toBeGreaterThan(-1)
    const block = settingsSrc.slice(start, start + 1800)
    expect(block).toMatch(/screenCaptureCheck\(pass\)/)
    expect(block).not.toMatch(/window\.toto\.ask\(/)
    expect(block).not.toMatch(/mcpPush|outlookCreate|timeSavedRecord/)
  })
})
