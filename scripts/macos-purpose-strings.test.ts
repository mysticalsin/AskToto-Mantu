import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * C26 (Apple HIG, Privacy → purpose strings) — every macOS permission prompt Métis can raise carries "a brief,
 * complete sentence that's straightforward, specific, and easy to understand", in sentence case, active voice,
 * ending with a period. These are the exact strings the system alerts show, in the Electron app (direct and Mac
 * App Store builds, and the QA identity that extends them), the Apple Speech helper and the native app.
 */
const root = join(__dirname, '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

const MICROPHONE = 'Métis uses the microphone to transcribe your side of the meetings you start.'
const SYSTEM_AUDIO = 'Métis uses system audio to transcribe the other side of the meetings you start.'
const SCREEN = 'Métis uses screen recording to hear meeting audio and to see your screen when you ask.'
const APPLE_SPEECH = 'Métis uses Apple Speech to transcribe meetings on this Mac when you choose it in Settings.'
const APPLE_EVENTS = 'Métis uses Apple Events to carry out desktop commands you confirm, such as creating a note.'
const CALENDAR = 'Métis uses your calendar to add events you confirm and to check they were saved.'
const NATIVE_SPEECH = 'Métis uses speech recognition to transcribe your meetings on this Mac.'

const ELECTRON_APP: Record<string, string> = {
  NSMicrophoneUsageDescription: MICROPHONE,
  NSAudioCaptureUsageDescription: SYSTEM_AUDIO,
  NSScreenCaptureUsageDescription: SCREEN,
  NSSpeechRecognitionUsageDescription: APPLE_SPEECH,
  NSAppleEventsUsageDescription: APPLE_EVENTS,
  NSCalendarsFullAccessUsageDescription: CALENDAR,
  NSCalendarsUsageDescription: CALENDAR
}

/** The `extendInfo:` map of one top-level electron-builder section (`mac:`, `mas:`), as plain key/value text. */
function extendInfo(yml: string, section: string): Record<string, string> {
  const lines = yml.split('\n')
  const start = lines.findIndex((line) => line === `${section}:`)
  expect(start, `${section}: section`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line))
  const body = lines.slice(start + 1, end === -1 ? undefined : end)
  const at = body.findIndex((line) => line === '  extendInfo:')
  expect(at, `${section}.extendInfo`).toBeGreaterThanOrEqual(0)
  const entries: Record<string, string> = {}
  for (const line of body.slice(at + 1)) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^ {4}([A-Za-z]+): (.+)$/)
    if (!m) break
    entries[m[1]] = m[2]
  }
  return entries
}

/** HIG shape: one sentence naming Métis, active ("Métis uses …"), sentence case, a single final period. */
function expectHigSentence(text: string): void {
  expect(text).toMatch(/^Métis uses [a-zA-Z]/)
  expect(text.endsWith('.')).toBe(true)
  expect(text.slice(0, -1)).not.toMatch(/[.!?]/)
  expect(text.length).toBeLessThanOrEqual(110)
  expect(text).not.toMatch(/\b(is|are|was|were|be|been) (used|captured|recorded|sent)\b/)
}

describe('C26 — macOS purpose strings follow the HIG', () => {
  const builder = read('electron-builder.yml')

  it.each(['mac', 'mas'])('the %s build shows one specific active sentence for every prompt', (section) => {
    const info = extendInfo(builder, section)
    for (const [key, text] of Object.entries(ELECTRON_APP)) {
      expect(info[key], key).toBe(text)
      expectHigSentence(text)
    }
  })

  it('the QA identity inherits the same strings instead of overriding them', () => {
    // electron-builder deep-merges `extends`; an override here would silently ship different copy to QA.
    expect(read('build', 'qa-identity.electron-builder.yml')).not.toMatch(/UsageDescription/)
  })

  it('the Apple Speech helper embeds its own sentence (it requests authorization itself)', () => {
    const plist = read('native', 'mac-helper', 'Info.plist')
    expect(plist).toContain(`<key>NSSpeechRecognitionUsageDescription</key>\n  <string>${APPLE_SPEECH}</string>`)
  })

  it('calendar purpose strings pinned in the helper that raises the EventKit prompt and in both entitlement files', () => {
    const plist = read('native', 'mac-helper', 'Info.plist')
    expect(plist).toContain(`<key>NSCalendarsFullAccessUsageDescription</key>\n  <string>${CALENDAR}</string>`)
    expect(plist).toContain(`<key>NSCalendarsUsageDescription</key>\n  <string>${CALENDAR}</string>`)
    expectHigSentence(CALENDAR)
    for (const file of ['entitlements.mac.plist', 'entitlements.mas.plist']) {
      expect(read('build', file), file).toContain('<key>com.apple.security.personal-information.calendars</key>')
    }
    expect(read('native-app', 'project.yml')).toContain(
      `INFOPLIST_KEY_NSCalendarsFullAccessUsageDescription: "${CALENDAR}"`
    )
  })

  it('the native app uses the same voice for the prompts it declares', () => {
    const project = read('native-app', 'project.yml')
    expect(project).toContain(`INFOPLIST_KEY_NSMicrophoneUsageDescription: "${MICROPHONE}"`)
    expect(project).toContain(`INFOPLIST_KEY_NSSpeechRecognitionUsageDescription: "${NATIVE_SPEECH}"`)
    expectHigSentence(NATIVE_SPEECH)
  })
})
