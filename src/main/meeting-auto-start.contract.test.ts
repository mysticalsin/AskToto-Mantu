import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const settingsSrc = readFileSync(join(root, 'src/renderer/src/components/Settings.tsx'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const appSrc = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const permsSrc = readFileSync(join(root, 'src/main/platform-perms.ts'), 'utf8')

describe('meeting auto-start wiring (foreground-watcher, no Accessibility)', () => {
  it('Settings ships the master copy and three platform toggles, with no em dash', () => {
    expect(settingsSrc).toContain('Start Listen when I join')
    expect(settingsSrc).toContain('Microsoft Teams')
    expect(settingsSrc).toContain('label="Zoom"')
    expect(settingsSrc).toContain('Google Meet')
    expect(settingsSrc).toContain('autoStartMeetings')
    const block = settingsSrc.slice(
      settingsSrc.indexOf('Start Listen when I join'),
      settingsSrc.indexOf('Start Listen when I join') + 2200
    )
    expect(block).not.toMatch(/\u2014/)
    expect(block).toContain('Microsoft Teams')
    expect(block).toContain('Google Meet')
  })

  it('main owns a foreground-watcher auto-start controller and pushes start-only IPC', () => {
    expect(indexSrc).toMatch(/createMeetingAutoStart/)
    expect(indexSrc).toMatch(/IPC\.meetingAutoStart/)
    expect(indexSrc).toMatch(/meetingAutoStart\.refresh\(\)/)
    expect(indexSrc).toMatch(/meetingAutoStart\.stop\(\)/)
    expect(indexSrc).not.toMatch(/src\/main\/meeting-detect/)
    expect(indexSrc).not.toMatch(/isTrustedAccessibilityClient/)
    expect(indexSrc).not.toMatch(/askForAccessibility/)
  })

  it('renderer reuses startListen and never toggles stop on auto-start', () => {
    expect(appSrc).toMatch(/onMeetingAutoStart/)
    const start = appSrc.indexOf('onMeetingAutoStart')
    const region = appSrc.slice(Math.max(0, start - 400), start + 200)
    expect(region).toMatch(/startListen\(\)/)
    expect(region).toMatch(/if \(listen\.listening\) return/)
    expect(region).not.toMatch(/toggleListen\(\)/)
  })

  it('platform permissions still do not mention Accessibility', () => {
    expect(permsSrc).not.toMatch(/[Aa]ccessibility/)
    expect(permsSrc).not.toMatch(/isTrustedAccessibilityClient/)
  })
})
