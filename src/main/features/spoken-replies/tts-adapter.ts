/**
 * tts-adapter.ts — the typed text-to-speech adapter per platform (G27, D-13).
 *
 * Platform on-device voices only: macOS AVSpeechSynthesizer through `metis-mac-helper speak`, Windows SAPI through a
 * fixed PowerShell script. No vendor, no key, no network, no voice download. Every process goes through the TTS
 * process port (src/main/infra/process/tts-process-host.ts), so this file starts nothing itself.
 *
 * The text of an answer travels on the child's stdin only. The voice id and the rate are the only values that reach a
 * command line (macOS) or the environment (Windows), and a voice id that is not a plain name is refused here as well
 * as being checked against the approved list by the caller.
 *
 * BLOCKED (not verifiable on this Mac): the Windows script has never been run against a real SAPI voice. Its argv,
 * environment, stdin and line handling are unit-tested through the port; running it on Windows hardware is part of
 * the owner's audio checklist.
 */
import { win32 as winPath } from 'node:path'
import type { TtsVoice } from '@shared/spoken-replies'
import { clampSpeechRate } from '@shared/spoken-replies-settings'
import type { TtsProcessPort, TtsProcessSpec } from '../../infra/process/tts-process-host'
import { parsePlaybackLine, parseVoiceList } from './tts-protocol'

export interface TtsSpeakRequest {
  readonly text: string
  /** A voice id resolved from the approved installed list; the OS default is never used as a fallback. */
  readonly voiceId: string
  /** Multiplier, 0.5 to 1.5. */
  readonly rate: number
}

export type TtsEndReason = 'finished' | 'interrupted'
export type TtsFailureCode = 'no_voice' | 'engine' | 'spawn'

/** Exactly one of onEnded and onFailed fires, at most once; onStarted may come first. Nothing fires after cancel(). */
export interface TtsPlaybackHandlers {
  onStarted(): void
  onEnded(reason: TtsEndReason): void
  onFailed(code: TtsFailureCode): void
}

export interface TtsPlayback {
  /** Stops the voice at once. Idempotent. No handler fires afterwards. */
  cancel(): void
}

export interface TtsAdapter {
  readonly platform: 'darwin' | 'win32'
  /** The voices installed on this computer, or null when the engine cannot be reached. */
  listVoices(): Promise<TtsVoice[] | null>
  speak(request: TtsSpeakRequest, handlers: TtsPlaybackHandlers): TtsPlayback
}

/** How long the voice list may take before the engine counts as unavailable. */
const VOICE_LIST_TIMEOUT_MS = 8_000

const MAC_VOICE_ID = /^[A-Za-z0-9._-]{1,200}$/
const WINDOWS_VOICE_NAME = /^[\p{L}\p{N} ._()-]{1,120}$/u

function startPlayback(port: TtsProcessPort, spec: TtsProcessSpec, handlers: TtsPlaybackHandlers): TtsPlayback {
  let started = false
  let settled = false
  const settle = (): boolean => {
    if (settled) return false
    settled = true
    return true
  }
  const handle = port.start(spec, {
    onLine(line) {
      if (settled) return
      const event = parsePlaybackLine(line)
      if (!event) return
      if (event.type === 'started') {
        if (!started) {
          started = true
          handlers.onStarted()
        }
      } else if (event.type === 'ended') {
        if (settle()) handlers.onEnded('finished')
      } else if (event.type === 'cancelled') {
        if (settle()) handlers.onEnded('interrupted')
      } else if (settle()) handlers.onFailed(event.code)
    },
    onExit(info) {
      if (!settle()) return
      if (info.error) handlers.onFailed('spawn')
      else if (started) handlers.onEnded('interrupted')
      else handlers.onFailed('engine')
    }
  })
  return {
    cancel() {
      if (!settle()) return
      handle.kill()
    }
  }
}

const refused = (handlers: TtsPlaybackHandlers, code: TtsFailureCode): TtsPlayback => {
  handlers.onFailed(code)
  return { cancel() {} }
}

const speedArgument = (rate: number): string => String(Math.round(clampSpeechRate(rate) * 100) / 100)

// --- macOS --------------------------------------------------------------------------------------------------------

export interface MacTtsHelper {
  /** `metis-mac-helper speak [--voice <id>] --rate <multiplier>`; null when the helper is not installed. */
  speakSpec(voiceId: string, rate: number): { command: string; args: string[] } | null
  /** `metis-mac-helper speak-voices`; null when the helper is not installed. */
  voicesSpec(): { command: string; args: string[] } | null
}

export function createMacTtsAdapter(deps: { port: TtsProcessPort; helper: MacTtsHelper }): TtsAdapter {
  return {
    platform: 'darwin',
    async listVoices() {
      const spec = deps.helper.voicesSpec()
      if (!spec) return null
      const result = await deps.port.probe({ ...spec, stdin: '' }, VOICE_LIST_TIMEOUT_MS)
      return result.ok ? parseVoiceList(result.stdout) : null
    },
    speak(request, handlers) {
      if (typeof request.voiceId !== 'string' || !MAC_VOICE_ID.test(request.voiceId))
        return refused(handlers, 'no_voice')
      const spec = deps.helper.speakSpec(request.voiceId, clampSpeechRate(request.rate))
      if (!spec) return refused(handlers, 'spawn')
      return startPlayback(deps.port, { ...spec, stdin: request.text }, handlers)
    }
  }
}

// --- Windows ------------------------------------------------------------------------------------------------------

/** SAPI's rate is an integer from -10 to 10. 0.5 to 1.5 maps onto -5 to 5, so the normal rate stays 0. */
export function rateToSapi(rate: number): number {
  return Math.round((clampSpeechRate(rate) - 1) * 10)
}

/**
 * The speak script. It is a constant: it reads the text from stdin and the voice and rate from the environment, so no
 * answer text is ever spliced into a command string. It prints `started`, then `ended`, or `error <code>`.
 */
export const WINDOWS_SPEAK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  [Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '  Add-Type -AssemblyName System.Speech',
  '  $text = [Console]::In.ReadToEnd()',
  '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "  if (-not $env:METIS_TTS_VOICE) { [Console]::Out.WriteLine('error no_voice'); exit 2 }",
  "  try { $synth.SelectVoice($env:METIS_TTS_VOICE) } catch { [Console]::Out.WriteLine('error no_voice'); exit 2 }",
  '  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$env:METIS_TTS_RATE))',
  '  $synth.SetOutputToDefaultAudioDevice()',
  '  $prompt = $synth.SpeakAsync($text)',
  "  [Console]::Out.WriteLine('started')",
  '  while (-not $prompt.IsCompleted) { Start-Sleep -Milliseconds 25 }',
  "  [Console]::Out.WriteLine('ended')",
  "} catch { [Console]::Out.WriteLine('error engine'); exit 1 }"
].join('\n')

/** Lists the installed SAPI voices as JSON. Installed voices only: nothing here can add one. */
export const WINDOWS_VOICES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Speech',
  '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $i = $_.VoiceInfo; [ordered]@{ id = $i.Name; name = $i.Name; language = $i.Culture.Name } })',
  '  ConvertTo-Json -InputObject $voices -Compress',
  '} catch { exit 1 }'
].join('\n')

const encodePowerShell = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')

export function createWindowsTtsAdapter(deps: { port: TtsProcessPort; systemRoot?: string }): TtsAdapter {
  const powershell = winPath.join(
    deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const argsFor = (script: string): string[] => [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShell(script)
  ]
  return {
    platform: 'win32',
    async listVoices() {
      const result = await deps.port.probe(
        { command: powershell, args: argsFor(WINDOWS_VOICES_SCRIPT), stdin: '' },
        VOICE_LIST_TIMEOUT_MS
      )
      return result.ok ? parseVoiceList(result.stdout) : null
    },
    speak(request, handlers) {
      if (typeof request.voiceId !== 'string' || !WINDOWS_VOICE_NAME.test(request.voiceId))
        return refused(handlers, 'no_voice')
      const env: Record<string, string> = {
        METIS_TTS_RATE: String(rateToSapi(request.rate)),
        METIS_TTS_VOICE: request.voiceId
      }
      return startPlayback(
        deps.port,
        { command: powershell, args: argsFor(WINDOWS_SPEAK_SCRIPT), env, stdin: request.text },
        handlers
      )
    }
  }
}

export function createTtsAdapter(
  platform: NodeJS.Platform,
  deps: { port: TtsProcessPort; macHelper?: MacTtsHelper; systemRoot?: string }
): TtsAdapter | null {
  if (platform === 'darwin')
    return deps.macHelper ? createMacTtsAdapter({ port: deps.port, helper: deps.macHelper }) : null
  if (platform === 'win32') return createWindowsTtsAdapter({ port: deps.port, systemRoot: deps.systemRoot })
  return null
}
