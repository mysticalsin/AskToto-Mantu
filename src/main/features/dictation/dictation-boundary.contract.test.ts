import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const DICTATION_MODULES = ['./dictation-session', './dictation-runtime', './dictation-context', './dictation-ports']

describe('dictation boundary (G22)', () => {
  it('no dictation module opens a microphone, starts a process, types, touches the clipboard or the meeting pipeline', () => {
    for (const spec of DICTATION_MODULES) {
      const text = readModuleSource(__dirname, spec).text
      expect(text, spec).not.toMatch(/getUserMedia|AudioContext|startInputSession/)
      expect(text, spec).not.toMatch(/child_process|execFile|spawn\(/)
      expect(text, spec).not.toMatch(/clipboard|sendInput|keystroke|robotjs|nut-js/i)
      expect(text, spec).not.toMatch(
        /from '\.\.\/(meetings|\.\.\/transcripts|\.\.\/meeting-|\.\.\/speaker|\.\.\/live-)/
      )
      expect(text, spec).not.toMatch(/reserveMeeting|releaseMeeting|hardStopMeetingCapture/)
      expect(text, spec).not.toMatch(/renderer\/src/)
    }
  })

  it('the activation is minted by the voice actions runtime only; no dictation module touches the activation authority', () => {
    for (const spec of DICTATION_MODULES) {
      expect(readModuleSource(__dirname, spec).text, spec).not.toContain('mintFromHardware')
    }
    const runtime = readModuleSource(__dirname, '../../voice/voice-actions-runtime').text
    expect(runtime).toContain("mintFromHardware(frame, 'hardware-dictation')")
    expect(runtime).toContain("revokeHardware('hardware-dictation')")
  })

  it('the voice actions runtime is the one consumer, and it builds the dictation watcher after the voice watcher', () => {
    const runtime = readModuleSource(__dirname, '../../voice/voice-actions-runtime').text
    expect(runtime).toContain("from '../features/dictation'")
    expect(runtime.indexOf('createVoiceChordWiring({')).toBeLessThan(runtime.indexOf('createDictationRuntime({'))
    const index = readModuleSource(__dirname, '../../index').text
    expect(index).not.toMatch(/createDictationRuntime|features\/dictation/)
  })

  it('production ships unsupported ports until G23 and G24: nothing real is bound here', () => {
    const ports = readModuleSource(__dirname, './dictation-ports').text
    expect(ports).toMatch(/UNSUPPORTED_DICTATION_PORTS/)
    expect(ports).toMatch(/reason: 'unsupported'/)
    expect(ports).toMatch(/outcome: 'unsupported'/)
    const runtime = readModuleSource(__dirname, './dictation-runtime').text
    expect(runtime).toContain('deps.ports ?? UNSUPPORTED_DICTATION_PORTS')
  })

  it('the desktop contract barrel exports the guard but not the routine coordinator (no dead consumer)', () => {
    const barrel = readModuleSource(__dirname, '../desktop-contract').text
    expect(barrel).toContain('DictationTargetGuard')
    expect(barrel).not.toMatch(/routine-coordinator|RoutineCoordinator/)
  })

  it('dictation is a Preview feature: the release flag is a single literal false until the owner flips it', () => {
    const settings = readModuleSource(__dirname, '../../../shared/dictation-options').text
    expect(settings).toMatch(/export const DICTATION_RELEASE_DEFAULT_ON = false\r?\n/)
  })

  it('dictation never reaches the command panel or the voice pipeline: the runtime owns a dictation lease transcript', () => {
    const runtime = readModuleSource(__dirname, '../../voice/voice-actions-runtime').text
    expect(runtime).toMatch(
      /if \(!isVoiceLease\(deps\.authority\.activeLease\)\) return dictation\.onTranscript\(text\)/
    )
  })
})
