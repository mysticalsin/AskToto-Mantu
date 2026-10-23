/**
 * tts-protocol.ts — the line protocol the platform speech helpers print (G27).
 *
 * macOS `metis-mac-helper speak` and the Windows PowerShell script both print one word per line: `started` when audio
 * begins, then `ended` (it finished) or `cancelled` (it was stopped). A failure is `error <code>`. The voice list is
 * one JSON document. This is the only place that grammar is written down.
 */
import { TtsVoiceSchema, type TtsVoice } from '@shared/spoken-replies'

export type PlaybackErrorCode = 'no_voice' | 'engine'
export type PlaybackLine =
  | { readonly type: 'started' }
  | { readonly type: 'ended' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly code: PlaybackErrorCode }

export function parsePlaybackLine(line: string): PlaybackLine | null {
  const text = line.trim()
  if (text === 'started' || text === 'ended' || text === 'cancelled') return { type: text }
  const error = /^error ([a-z_]{1,32})$/.exec(text)
  if (error) return { type: 'error', code: error[1] === 'no_voice' ? 'no_voice' : 'engine' }
  return null
}

/** A voice list longer than this is not a voice list. */
export const MAX_VOICE_LIST_CHARS = 64 * 1024

/**
 * Reads the helper's voice list. Accepts `{voices:[...]}`, a bare array, or one object (PowerShell's ConvertTo-Json
 * collapses a one-item array). Malformed entries are dropped; unparseable output is null (the engine is unavailable).
 */
export function parseVoiceList(stdout: string): TtsVoice[] | null {
  if (stdout.length > MAX_VOICE_LIST_CHARS) return null
  const text = stdout.replace(/^﻿/, '').trim()
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && 'voices' in value
      ? (value as { voices: unknown }).voices
      : [value]
  if (!Array.isArray(list)) return null
  const voices: TtsVoice[] = []
  for (const entry of list) {
    const parsed = TtsVoiceSchema.safeParse(entry)
    if (parsed.success) voices.push(parsed.data)
  }
  return voices
}
