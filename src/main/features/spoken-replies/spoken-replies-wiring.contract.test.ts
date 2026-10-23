import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const FEATURE_MODULES = [
  './spoken-replies-service',
  './spoken-replies-runtime',
  './tts-adapter',
  './tts-protocol',
  './approved-voices',
  './speech-text',
  './index'
]
const read = (spec: string): string => readModuleSource(__dirname, spec).text
/** Source without comments: a comment may name what the code never does. */
const code = (spec: string): string =>
  read(spec)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('spoken replies wiring (G27)', () => {
  const index = read('../../index')
  const wiring = read('../../spoken-replies-wiring')

  it('index.ts builds the runtime once, before the voice actions runtime that is told about it', () => {
    expect(index).toContain("from './spoken-replies-wiring'")
    const built = index.indexOf('const spokenRepliesWiring = createSpokenRepliesWiring(')
    const voice = index.indexOf('voiceActions = createVoiceActionsRuntime(')
    expect(built).toBeGreaterThan(-1)
    expect(built).toBeLessThan(voice)
    expect(index.slice(voice, voice + 1500)).toMatch(/\n\s+spokenReplies:\s*spokenRepliesWiring\.runtime,?\r?\n/)
    expect(wiring).toContain("runtime.bargeIn('hard-stop')")
    expect(wiring).toContain('registerSpokenRepliesIpc(ipcMain, assertMainWindow, runtime)')
  })

  it('the ask turn registry is observed, so main hears the answer from its own stream and never from the renderer', () => {
    expect(index).toMatch(/createAskTurns\(\{[^}]*observe: spokenRepliesWiring\.runtime\.observeAsk[^}]*\}\)/)
    const turns = read('../session-context/ask-turn')
    expect(turns).toMatch(/deps\.observe\?\.\(event\)/)
  })

  it('the renderer IPC is registered behind the main-window check, from main', () => {
    expect(index).toMatch(/spokenRepliesWiring\.registerIpc\(ipcMain, assertMainWindow\)/)
  })

  it('the preload bridge is part of the composed feature APIs', () => {
    expect(read('../../../preload/feature-apis')).toContain('createSpokenRepliesPreloadApi(ipc)')
  })
})

describe('spoken replies boundary (G27)', () => {
  it('no feature module starts a process, touches the clipboard, opens a microphone or reads meeting data', () => {
    for (const spec of FEATURE_MODULES) {
      const text = code(spec)
      expect(text, spec).not.toMatch(/child_process|execFile|spawn\(/)
      expect(text, spec).not.toMatch(/clipboard|pasteboard/i)
      expect(text, spec).not.toMatch(/getUserMedia|AudioContext|startInputSession/)
      expect(text, spec).not.toMatch(
        /from '\.\.\/(meetings|\.\.\/transcripts|\.\.\/meeting-|\.\.\/speaker|\.\.\/live-|\.\.\/brain)/
      )
      expect(text, spec).not.toMatch(/renderer\/src/)
    }
  })

  it('the Electron-free modules import nothing from electron', () => {
    for (const spec of [
      './spoken-replies-service',
      './tts-adapter',
      './tts-protocol',
      './approved-voices',
      './speech-text'
    ]) {
      expect(read(spec), spec).not.toMatch(/from 'electron'/)
    }
  })

  it('processes are started only by the infra process host, and the answer text only ever goes to stdin', () => {
    const host = read('../../infra/process/tts-process-host')
    expect(host).toMatch(/stdio: \['pipe', 'pipe', 'ignore'\]/)
    expect(host).toContain('shell: false')
    const adapter = code('./tts-adapter')
    expect(adapter).toMatch(/stdin: request\.text/)
  })

  it('only the assistant answer modes are spoken, and spoken replies are OFF by default until the owner checklist passes', () => {
    expect(code('./spoken-replies-service')).toMatch(/new Set\(\['answer', 'vision'\]\)/)
    expect(read('../../../shared/spoken-replies-settings')).toMatch(/speakReplies: z\.boolean\(\)\.default\(false\)/)
  })

  it('the Settings section mounts in the speech tab', () => {
    expect(read('../../../renderer/src/features/settings/AudioTab')).toContain('<SpokenRepliesSection')
  })
})
