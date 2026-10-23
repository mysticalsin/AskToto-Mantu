import { describe, expect, it } from 'vitest'
import { createFakeTtsPort } from '../../../test-helpers/fake-tts-process'
import {
  createMacTtsAdapter,
  createTtsAdapter,
  createWindowsTtsAdapter,
  rateToSapi,
  WINDOWS_SPEAK_SCRIPT,
  WINDOWS_VOICES_SCRIPT,
  type TtsAdapter,
  type TtsPlaybackHandlers
} from './tts-adapter'

const macHelper = {
  speakSpec: (voiceId: string, rate: number) => ({
    command: '/synthetic/metis-mac-helper',
    args: ['speak', '--voice', voiceId, '--rate', String(rate)]
  }),
  voicesSpec: () => ({ command: '/synthetic/metis-mac-helper', args: ['speak-voices'] })
}
const MAC_VOICE = 'com.apple.voice.compact.en-US.Samantha'
const WINDOWS_VOICE = 'Microsoft Zira Desktop'
const HOSTILE_TTS_TEXT = 'TTS-SENTINEL-7f2a; $(DoNotRun) `Invoke-Expression`'

function assertTextIsOnlyOnStdin(
  spec: { command: string; args: readonly string[]; stdin: string; env?: Readonly<Record<string, string>> },
  text: string
) {
  expect(spec.stdin).toBe(text)
  expect(spec.command).not.toContain(text)
  expect(spec.args.join('\0')).not.toContain(text)
  expect(Object.values(spec.env ?? {}).join('\0')).not.toContain(text)
}

function recorder() {
  const events: string[] = []
  const handlers: TtsPlaybackHandlers = {
    onStarted: () => events.push('started'),
    onEnded: (reason) => events.push(`ended:${reason}`),
    onFailed: (code) => events.push(`failed:${code}`)
  }
  return { events, handlers }
}

const decode = (args: readonly string[]): string =>
  Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')

describe('macOS adapter (G27)', () => {
  it('speaks through the helper: text on stdin, voice and rate as arguments, never the text in argv', () => {
    const fake = createFakeTtsPort()
    const adapter = createMacTtsAdapter({ port: fake.port, helper: macHelper })
    adapter.speak(
      { text: HOSTILE_TTS_TEXT, voiceId: 'com.apple.voice.compact.fr-FR.Amelie', rate: 1.25 },
      recorder().handlers
    )
    const [child] = fake.children
    expect(child.spec.command).toBe('/synthetic/metis-mac-helper')
    expect(child.spec.args).toEqual(['speak', '--voice', 'com.apple.voice.compact.fr-FR.Amelie', '--rate', '1.25'])
    assertTextIsOnlyOnStdin(child.spec, HOSTILE_TTS_TEXT)
  })

  it('refuses a missing voice id instead of delegating to the OS default', () => {
    const fake = createFakeTtsPort()
    const result = recorder()
    createMacTtsAdapter({ port: fake.port, helper: macHelper }).speak(
      { text: 'Hi', voiceId: null as never, rate: 1 },
      result.handlers
    )
    expect(result.events).toEqual(['failed:no_voice'])
    expect(fake.children).toHaveLength(0)
  })

  it('clamps the rate and refuses an unsafe voice id', () => {
    const fake = createFakeTtsPort()
    const adapter = createMacTtsAdapter({ port: fake.port, helper: macHelper })
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 9 }, recorder().handlers)
    expect(fake.children[0].spec.args).toContain('1.5')
    const { events, handlers } = recorder()
    adapter.speak({ text: 'a', voiceId: '--evil;rm', rate: 1 }, handlers)
    expect(events).toEqual(['failed:no_voice'])
    expect(fake.children).toHaveLength(1)
  })

  it('maps the helper lines and exit to started, ended and failed', () => {
    const fake = createFakeTtsPort()
    const adapter = createMacTtsAdapter({ port: fake.port, helper: macHelper })
    const a = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, a.handlers)
    fake.children[0].line('started')
    fake.children[0].line('ended')
    fake.children[0].exit(0)
    expect(a.events).toEqual(['started', 'ended:finished'])

    const b = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, b.handlers)
    fake.children[1].line('started')
    fake.children[1].line('cancelled')
    expect(b.events).toEqual(['started', 'ended:interrupted'])

    const c = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, c.handlers)
    fake.children[2].line('error no_voice')
    expect(c.events).toEqual(['failed:no_voice'])
  })

  it('an exit before any ended line is an interrupted end after audio began and an engine failure before', () => {
    const fake = createFakeTtsPort()
    const adapter = createMacTtsAdapter({ port: fake.port, helper: macHelper })
    const a = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, a.handlers)
    fake.children[0].line('started')
    fake.children[0].exit(0)
    expect(a.events).toEqual(['started', 'ended:interrupted'])
    const b = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, b.handlers)
    fake.children[1].exit(1)
    expect(b.events).toEqual(['failed:engine'])
    const c = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, c.handlers)
    fake.children[2].fail('spawn ENOENT')
    expect(c.events).toEqual(['failed:spawn'])
  })

  it('cancel kills the child at once and nothing more is reported', () => {
    const fake = createFakeTtsPort()
    const adapter = createMacTtsAdapter({ port: fake.port, helper: macHelper })
    const r = recorder()
    const playback = adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, r.handlers)
    fake.children[0].line('started')
    playback.cancel()
    playback.cancel()
    fake.children[0].line('ended')
    fake.children[0].exit(0)
    expect(fake.children[0].killed).toBe(1)
    expect(r.events).toEqual(['started'])
  })

  it('is unavailable (no process, no throw) when the helper is absent', async () => {
    const fake = createFakeTtsPort()
    const adapter = createMacTtsAdapter({ port: fake.port, helper: { speakSpec: () => null, voicesSpec: () => null } })
    const r = recorder()
    adapter.speak({ text: 'a', voiceId: MAC_VOICE, rate: 1 }, r.handlers)
    expect(r.events).toEqual(['failed:spawn'])
    await expect(adapter.listVoices()).resolves.toBeNull()
    expect(fake.children).toHaveLength(0)
  })

  it('lists the installed voices through a bounded one-shot', async () => {
    const fake = createFakeTtsPort()
    fake.probeResult = {
      ok: true,
      stdout: '{"voices":[{"id":"com.apple.voice.compact.en-US.Samantha","name":"Samantha","language":"en-US"}]}'
    }
    const adapter = createMacTtsAdapter({ port: fake.port, helper: macHelper })
    await expect(adapter.listVoices()).resolves.toEqual([
      { id: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US' }
    ])
    expect(fake.probes[0].spec.args).toEqual(['speak-voices'])
    expect(fake.probes[0].timeoutMs).toBeGreaterThan(0)
    fake.probeResult = { ok: false, stdout: '' }
    await expect(adapter.listVoices()).resolves.toBeNull()
  })
})

describe('Windows adapter (G27, BLOCKED: PowerShell is not run here)', () => {
  const adapterFor = (fake: ReturnType<typeof createFakeTtsPort>): TtsAdapter =>
    createWindowsTtsAdapter({ port: fake.port, systemRoot: 'C:\\Windows' })

  it('runs a fixed script through powershell.exe by absolute path, with text on stdin and voice/rate in the environment', () => {
    const fake = createFakeTtsPort()
    adapterFor(fake).speak(
      { text: HOSTILE_TTS_TEXT, voiceId: 'Microsoft Zira Desktop', rate: 1.5 },
      recorder().handlers
    )
    const [child] = fake.children
    expect(child.spec.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(child.spec.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(decode(child.spec.args)).toBe(WINDOWS_SPEAK_SCRIPT)
    assertTextIsOnlyOnStdin(child.spec, HOSTILE_TTS_TEXT)
    expect(child.spec.env).toEqual({ METIS_TTS_VOICE: 'Microsoft Zira Desktop', METIS_TTS_RATE: '5' })
  })

  it('the script reads the text from stdin and never contains a text placeholder, and prints the playback lines', () => {
    expect(WINDOWS_SPEAK_SCRIPT).toContain('[Console]::In.ReadToEnd()')
    expect(WINDOWS_SPEAK_SCRIPT).toContain('System.Speech')
    expect(WINDOWS_SPEAK_SCRIPT).toContain('if (-not $env:METIS_TTS_VOICE)')
    expect(WINDOWS_SPEAK_SCRIPT).toMatch(/started/)
    expect(WINDOWS_SPEAK_SCRIPT).toMatch(/ended/)
    expect(WINDOWS_SPEAK_SCRIPT).not.toMatch(/Invoke-Expression|iex |Start-Process|DownloadString|Net\.WebClient/i)
    expect(WINDOWS_VOICES_SCRIPT).toContain('GetInstalledVoices')
    expect(WINDOWS_VOICES_SCRIPT).not.toMatch(/Invoke-Expression|Start-Process|DownloadString|Net\.WebClient/i)
  })

  it('maps rate 0.5 to 1.5 onto the SAPI range, with 1 as the normal rate', () => {
    expect([rateToSapi(0.5), rateToSapi(1), rateToSapi(1.25), rateToSapi(1.5)]).toEqual([-5, 0, 3, 5])
    expect(rateToSapi(99)).toBe(5)
    expect(rateToSapi(Number.NaN)).toBe(0)
  })

  it('refuses unsafe or absent voice names instead of delegating to the OS default', () => {
    const fake = createFakeTtsPort()
    const adapter = adapterFor(fake)
    const bad = recorder()
    adapter.speak({ text: 'a', voiceId: 'x"; calc; "', rate: 1 }, bad.handlers)
    expect(bad.events).toEqual(['failed:no_voice'])
    const missing = recorder()
    adapter.speak({ text: 'a', voiceId: null as never, rate: 1 }, missing.handlers)
    expect(missing.events).toEqual(['failed:no_voice'])
    expect(fake.children).toHaveLength(0)
  })

  it('maps lines, exit and cancel the same way as macOS', () => {
    const fake = createFakeTtsPort()
    const adapter = adapterFor(fake)
    const r = recorder()
    const playback = adapter.speak({ text: 'a', voiceId: WINDOWS_VOICE, rate: 1 }, r.handlers)
    fake.children[0].line('started')
    fake.children[0].line('ended')
    expect(r.events).toEqual(['started', 'ended:finished'])
    const s = recorder()
    const second = adapter.speak({ text: 'a', voiceId: WINDOWS_VOICE, rate: 1 }, s.handlers)
    fake.children[1].line('started')
    second.cancel()
    expect(fake.children[1].killed).toBe(1)
    expect(s.events).toEqual(['started'])
    void playback
  })

  it('lists voices through the fixed voices script', async () => {
    const fake = createFakeTtsPort()
    fake.probeResult = {
      ok: true,
      stdout: '{"id":"Microsoft Zira Desktop","name":"Microsoft Zira Desktop","language":"en-US"}'
    }
    const voices = await adapterFor(fake).listVoices()
    expect(voices).toEqual([{ id: 'Microsoft Zira Desktop', name: 'Microsoft Zira Desktop', language: 'en-US' }])
    expect(decode(fake.probes[0].spec.args)).toBe(WINDOWS_VOICES_SCRIPT)
    expect(fake.probes[0].spec.stdin).toBe('')
  })
})

describe('createTtsAdapter (G27)', () => {
  it('picks the platform engine and returns null where there is none', () => {
    const fake = createFakeTtsPort()
    expect(createTtsAdapter('darwin', { port: fake.port, macHelper })?.platform).toBe('darwin')
    expect(createTtsAdapter('win32', { port: fake.port })?.platform).toBe('win32')
    expect(createTtsAdapter('linux', { port: fake.port, macHelper })).toBeNull()
    expect(createTtsAdapter('darwin', { port: fake.port })).toBeNull()
  })
})
