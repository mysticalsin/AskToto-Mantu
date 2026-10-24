import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePlaybackLine } from './tts-protocol'

// A Windows checkout may carry CRLF.
const source = readFileSync(join(process.cwd(), 'native', 'mac-helper', 'main.swift'), 'utf8').replace(/\r\n/g, '\n')
const swift = source.replace(/\/\/[^\n]*/g, '')

function body(signature: string): string {
  const start = swift.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  const close = swift.indexOf('\n}\n', start)
  expect(close).toBeGreaterThan(start)
  return swift.slice(start, close + 3)
}

describe('metis-mac-helper speak (G27): the Swift side of the line protocol', () => {
  it('is dispatched as two subcommands and listed in the usage line', () => {
    expect(swift).toMatch(/case "speak":/)
    expect(swift).toMatch(/case "speak-voices":/)
    expect(swift).toMatch(/usage: metis-mac-helper <[^>\n]*speak[^>\n]*>/)
  })

  it('prints exactly the lines TypeScript parses: started, ended, cancelled and error no_voice (a failed engine is an exit without `started`)', () => {
    const speak = body('func runSpeak(')
    const printed = [...speak.matchAll(/emitSpeakLine\("([^"]+)"\)/g)].map((m) => m[1])
    expect(new Set(printed)).toEqual(new Set(['started', 'ended', 'cancelled', 'error no_voice']))
    for (const line of printed) expect(parsePlaybackLine(line), line).not.toBeNull()
  })

  it('reads the text from stdin, so it is never in argv, and speaks with AVSpeechSynthesizer only', () => {
    const speak = body('func runSpeak(')
    expect(speak).toMatch(/FileHandle\.standardInput\.readDataToEndOfFile\(\)/)
    expect(speak).toMatch(/AVSpeechSynthesizer\(\)/)
    expect(speak).toMatch(/guard let id = voiceId, let voice = AVSpeechSynthesisVoice\(identifier: id\)/)
    expect(speak).not.toMatch(/arguments\[[^\]]*\]\s*\)\s*$/m)
    expect(swift).not.toMatch(/NSSpeechSynthesizer|\/usr\/bin\/say|Process\(\)\.executableURL.*say/)
  })

  it('stops on SIGTERM at once and exits with its parent', () => {
    const speak = body('func runSpeak(')
    expect(speak).toMatch(/DispatchSource\.makeSignalSource\(signal: SIGTERM/)
    expect(speak).toMatch(/stopSpeaking\(at: \.immediate\)/)
    expect(speak).toMatch(/makeProcessSource\(identifier: parent, eventMask: \.exit/)
    expect(speak).toMatch(/withExtendedLifetime\(parentWatch\)/)
    expect(speak).toMatch(/withExtendedLifetime\(terminate\)/)
    expect(speak).toMatch(/withExtendedLifetime\(synthesizer\)/)
    expect(speak).toMatch(/withExtendedLifetime\(delegate\)/)
  })

  it('bounds the text and the rate, and never touches the network, the pasteboard or a download', () => {
    const speak = body('func runSpeak(')
    // The speak functions only: G23's AX insertion, which legitimately owns the pasteboard, shares this file.
    const tts = ['func emitSpeakLine(', 'func runSpeak(', 'func runSpeakVoices('].map(body).join('\n')
    expect(speak).toMatch(/maxSpeakChars/)
    expect(speak).toMatch(/min\(1\.5, max\(0\.5/)
    expect(tts).not.toMatch(/NSPasteboard|UIPasteboard/)
    expect(swift).not.toMatch(/AVSpeechSynthesisVoice\.(download|request)|requestPersonalVoice/i)
  })

  it('lists only installed voices, as one JSON object with id, name and language', () => {
    const voices = body('func runSpeakVoices(')
    expect(voices).toMatch(/AVSpeechSynthesisVoice\.speechVoices\(\)/)
    expect(voices).toMatch(/"id"|id:/)
    expect(voices).toMatch(/language/)
  })
})
