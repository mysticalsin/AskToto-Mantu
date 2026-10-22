import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const mainDir = join(__dirname, '..')

function productionSources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...productionSources(path))
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push({ file: path, text: readFileSync(path, 'utf8') })
  }
  return out
}

describe('voice actions boundary: the activation is main-only and the meeting pipeline is never touched', () => {
  it('mintFromHardware is called only by the voice runtime, never from an IPC handler or the preload', () => {
    const callers = productionSources(mainDir)
      .filter(({ text }) => text.includes('mintFromHardware'))
      .map(({ file }) => file.slice(mainDir.length + 1).replace(/\\/g, '/'))
      .sort()
    expect(callers).toEqual(['command-mic-activation-authority.ts', 'voice/voice-actions-runtime.ts'])
    for (const spec of [
      '../ipc/input-capture-ipc',
      '../input-session-ipc',
      '../../preload/index',
      '../../preload/voice-actions'
    ]) {
      expect(readModuleSource(__dirname, spec).text, spec).not.toContain('mintFromHardware')
    }
  })

  it('no renderer-reachable call can start a turn: the preload bridge has no start, mint or begin sender', () => {
    const preload = readModuleSource(__dirname, '../../preload/voice-actions').text
    expect(preload).not.toMatch(/ipc\.invoke\(VOICE_ACTIONS_IPC\.(begin|end|state|ask)/)
    expect(preload).not.toMatch(/\.send\(/)
  })

  it('the voice modules never open a microphone or touch the meeting pipeline', () => {
    for (const spec of ['./voice-session', './voice-actions-runtime', './voice-availability', './chord-watcher-port']) {
      const text = readModuleSource(__dirname, spec).text
      expect(text, spec).not.toMatch(/getUserMedia|AudioContext|startInputSession/)
      expect(text, spec).not.toMatch(/from '\.\.\/(features\/meetings|transcripts|meeting-|speaker|live-)/)
      expect(text, spec).not.toMatch(/reserveMeeting|releaseMeeting|hardStopMeetingCapture/)
    }
  })

  it('a voice turn asks for its own lease: push-to-talk with the command purpose, never conversation or dictation', () => {
    const capture = readModuleSource(__dirname, '../../renderer/src/lib/voice-turn-capture').text
    expect(capture).toContain("source: 'push-to-talk'")
    expect(capture).not.toMatch(/'conversation'|'dictation'|deliberate-talk/)
  })

  it('index.ts wires the runtime through the authority hooks, the speech capture and the window', () => {
    const index = readModuleSource(__dirname, '../index').text
    expect(index).toMatch(/onHardStop: \(reason\) => voiceActions\?\.onHardStop\(reason\)/)
    expect(index).toMatch(/onMeetingReserved: \(\) => voiceActions\?\.onMeetingReserved\(\)/)
    expect(index).toMatch(/onFinished: \(sessionId, result\) => voiceActions\?\.onSpeechFinished\(sessionId, result\)/)
    expect(index).toContain('voiceActions?.registerIpc(ipcMain, assertMainWindow)')
    expect(index).toContain('voiceActions?.bindWebContents(win.webContents)')
    expect(index).toContain('voiceActions?.dispose()')
    expect(index).toMatch(/activation: commandMicActivationAuthority/)
  })

  it('the renderer installs the headless capture at boot', () => {
    expect(readModuleSource(__dirname, '../../renderer/src/main').text).toContain('installVoiceTurnCapture()')
  })

  it('release builds default to Preview: the release flag is a single literal false until the owner flips it', () => {
    const settings = readModuleSource(__dirname, '../../shared/voice-actions-settings').text
    expect(settings).toMatch(/export const VOICE_ACTIONS_RELEASE_DEFAULT_ON = false\r?\n/)
  })
})
