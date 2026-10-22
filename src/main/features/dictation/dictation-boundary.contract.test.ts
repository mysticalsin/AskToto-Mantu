import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const MEMORY_MODULES = [
  './dictation-memory',
  './dictation-memory-crypto',
  './dictation-memory-policy',
  './dictation-memory-registry',
  './dictation-journal',
  './dictation-dictionary',
  './dictation-owned-span',
  './dictation-term-diff'
]
const DICTATION_MODULES = [
  './dictation-session',
  './dictation-runtime',
  './dictation-context',
  './dictation-ports',
  ...MEMORY_MODULES
]

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

  it('the dictation memory (G26) uses async fs only, never imports electron or the meeting folders, and never logs text', () => {
    for (const spec of MEMORY_MODULES) {
      const text = readModuleSource(__dirname, spec).text
      expect(text, spec).not.toMatch(
        /\b(readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|readdirSync|statSync|unlinkSync|renameSync)\b/
      )
      expect(text, spec).not.toMatch(/from 'electron'|from "electron"/)
      expect(text, spec).not.toMatch(/console\.|mainLog|auditLog\(/)
      expect(text, spec).not.toMatch(/Documents|OneDrive|meetingsFolder|getPath\(/)
    }
  })

  it('the memory is encrypted with AES-256-GCM and no module writes the text to disk without sealing it', () => {
    const crypto = readModuleSource(__dirname, './dictation-memory-crypto').text
    expect(crypto).toContain('aes-256-gcm')
    for (const spec of ['./dictation-journal', './dictation-dictionary']) {
      const text = readModuleSource(__dirname, spec).text
      expect(text, spec).toMatch(/keyring\.seal\(/)
      expect(text, spec).not.toMatch(/writeFile\(/)
    }
  })

  it('the memory is the one consumer of the journal and dictionary, built from the owner-session wiring', () => {
    const wiring = readModuleSource(__dirname, '../../lifecycle/owner-session-wiring').text
    expect(wiring).toContain("from './dictation-memory-wiring'")
    const barrel = readModuleSource(__dirname, './index').text
    expect(barrel).toContain('currentDictationMemory')
    expect(barrel).not.toMatch(/createDictationJournal|createDictationDictionary|mintOwnedSpan/)
  })
})
