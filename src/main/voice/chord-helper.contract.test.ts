import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODIFIER_BITS } from '@shared/voice/modifier-mask'
import { readModuleSource } from '../../test-helpers/module-source'

const REPO_ROOT = process.cwd()
// A Windows checkout may carry CRLF; the body scan below looks for LF boundaries.
const swiftSource = readFileSync(join(REPO_ROOT, 'native', 'mac-helper', 'main.swift'), 'utf8').replace(/\r\n/g, '\n')
// Comments may name the calls the helper avoids.
const swift = swiftSource.replace(/\/\/[^\r\n]*/g, '')

function watchModifiersBody(): string {
  const start = swift.indexOf('func watchModifiers(')
  expect(start).toBeGreaterThan(-1)
  const close = swift.indexOf('\n}\n', start)
  expect(close).toBeGreaterThan(start)
  return swift.slice(start, close + 3)
}

describe('metis-mac-helper watch-modifiers: privacy by construction (path A, permission-free)', () => {
  it('is dispatched as a subcommand and listed in the usage line', () => {
    expect(swift).toMatch(/case "watch-modifiers":/)
    expect(swift).toMatch(/usage: metis-mac-helper <[^>\r\n]*watch-modifiers/)
  })

  it('observes with polling queries only: no event tap, no global monitor, no Input Monitoring request', () => {
    expect(swift).not.toMatch(/CGEvent\.tapCreate|CGEventTapCreate|tapCreate/)
    expect(swift).not.toMatch(/addGlobalMonitorForEvents|IOHIDManager|IOHIDRequestAccess/)
    expect(swift).not.toMatch(/CGRequestListenEventAccess|AXIsProcessTrustedWithOptions/)
    const body = watchModifiersBody()
    expect(body).toMatch(/CGEventSource\.flagsState\(\s*\.combinedSessionState\s*\)/)
    expect(swift).toMatch(/CGEventSource\.counterForEventType\(/)
  })

  it('never reads or prints a key code: the protocol has no field for one', () => {
    expect(swift).not.toMatch(/keyboardEventKeycode|\.keyCode\b|kCGKeyboardEventKeycode|\.getIntegerValueField/)
    const prints = [...watchModifiersBody().matchAll(/print\(([^\r\n]*)\)/g)].map((m) => m[1])
    expect(prints).toEqual(['"m \\(mask) \\(seq)"'])
  })

  it('exits with its parent and prints only on change', () => {
    const body = watchModifiersBody()
    expect(body).toMatch(/makeProcessSource\(identifier: parent, eventMask: \.exit/)
    expect(body).toMatch(/last == nil|last\?\.0 != mask|last != /)
  })
})

describe('mask bit parity: the helper and the recognizer agree on every bit', () => {
  const swiftNames: Record<keyof typeof MODIFIER_BITS, string> = {
    leftControl: 'modLeftControl',
    rightControl: 'modRightControl',
    leftAlt: 'modLeftOption',
    rightAlt: 'modRightOption',
    leftCommand: 'modLeftCommand',
    rightCommand: 'modRightCommand',
    leftShift: 'modLeftShift',
    rightShift: 'modRightShift',
    fn: 'modFn',
    unsided: 'modUnsided'
  }

  for (const [name, swiftName] of Object.entries(swiftNames)) {
    it(`${name} is ${swiftName} in main.swift`, () => {
      const match = new RegExp(`let ${swiftName} = (\\d+)`).exec(swift)
      expect(match, swiftName).not.toBeNull()
      expect(Number(match?.[1])).toBe(MODIFIER_BITS[name as keyof typeof MODIFIER_BITS])
    })
  }
})

describe('FF-10 and the Input Monitoring rule', () => {
  it('the watcher spawns nothing itself: the child process lives in src/main/infra/process', () => {
    const { text } = readModuleSource(__dirname, './chord-watcher')
    expect(text).not.toMatch(/from 'node:child_process'|from 'child_process'|require\('node:child_process'\)/)
    const wiring = readModuleSource(__dirname, './chord-wiring').text
    expect(wiring).not.toMatch(/from 'node:child_process'|from 'child_process'/)
    const host = readModuleSource(__dirname, '../infra/process/line-helper-host').text
    expect(host).toMatch(/from 'node:child_process'/)
  })

  it('nothing in the voice chord path can raise an Input Monitoring prompt at launch', () => {
    for (const specifier of ['./chord-watcher', './chord-wiring', '../infra/process/line-helper-host']) {
      const { text } = readModuleSource(__dirname, specifier)
      expect(text, specifier).not.toMatch(
        /inputMonitoring|ListenEvent|getMediaAccessStatus\('screen'\)|askForMediaAccess/
      )
    }
  })

  it('a chord press never starts a meeting capture: the chord path has no meeting-start call', () => {
    for (const specifier of ['./chord-watcher', './chord-wiring']) {
      const { text } = readModuleSource(__dirname, specifier)
      expect(text, specifier).not.toMatch(/reserveMeeting|startMeeting|setListeningActive|acceptLiveSpeakerTransition/)
    }
  })
})
