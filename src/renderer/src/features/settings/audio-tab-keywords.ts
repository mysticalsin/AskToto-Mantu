/**
 * Settings search keywords for the Speech tab. Each Section title under the tab must appear here verbatim (the
 * INVARIANT above TABS in SettingsRoot.tsx), so a search for it is a real proof. Kept in its own module so the
 * Voice actions section adds its words without growing SettingsRoot.
 */
export const AUDIO_TAB_KEYWORDS: string[] = [
  'audio',
  'speech',
  'microphone',
  'listen to',
  'in meetings',
  'vocabulary corrections',
  'transcription',
  'asr',
  'parakeet',
  'whisper',
  'apple speech',
  'speaker identification',
  'transcript source',
  'nova',
  'soniox',
  'cf ai gateway',
  'cloudflare account id',
  // Voice actions (V06)
  'voice actions',
  'hold to talk',
  'talk shortcut',
  'push to talk',
  'hey métis',
  'hey metis',
  'wake word',
  'double press',
  'dictation',
  // Spoken replies (G27)
  'spoken replies',
  'read answers aloud',
  'text to speech',
  'tts',
  'speak',
  'voice',
  'speed',
  'preview voice'
]
