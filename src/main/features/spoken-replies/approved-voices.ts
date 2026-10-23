/**
 * approved-voices.ts — which installed system voices Métis offers (D-13).
 *
 * The platform lists the voices that are installed on this computer; this module only filters that list. It never
 * names a voice to download, so a voice that is not installed is simply absent. A voice is approved when it is a
 * regular speech voice of the platform (not a novelty or robotic one) in a language Métis answers in.
 */
import { MAX_APPROVED_VOICES, TtsVoiceSchema, type TtsVoice } from '@shared/spoken-replies'

/** The languages Métis answers in (English, French, Portuguese, Spanish). Adding one is a one-line change here. */
export const APPROVED_VOICE_LANGUAGES: readonly string[] = ['en', 'fr', 'pt', 'es']

/** `com.apple.voice.*` and `com.apple.ttsbundle.*` are the Siri-family speech voices. Novelty and Eloquence voices are not. */
const MAC_APPROVED_ID = /^com\.apple\.(?:voice|ttsbundle)\./
/** Installed SAPI voices from Microsoft. A third-party SAPI voice is not approved. */
const WINDOWS_APPROVED_NAME = /^Microsoft /

function baseLanguage(language: string): string {
  return language.split(/[-_]/, 1)[0].toLowerCase()
}

function platformApproves(platform: NodeJS.Platform, voice: TtsVoice): boolean {
  if (platform === 'darwin') return MAC_APPROVED_ID.test(voice.id)
  if (platform === 'win32') return WINDOWS_APPROVED_NAME.test(voice.name)
  return false
}

export function approveVoices(platform: NodeJS.Platform, raw: readonly unknown[]): TtsVoice[] {
  const seen = new Set<string>()
  const approved: TtsVoice[] = []
  for (const candidate of raw) {
    const parsed = TtsVoiceSchema.safeParse(candidate)
    if (!parsed.success) continue
    const voice = parsed.data
    if (seen.has(voice.id)) continue
    if (!platformApproves(platform, voice)) continue
    if (!APPROVED_VOICE_LANGUAGES.includes(baseLanguage(voice.language))) continue
    seen.add(voice.id)
    approved.push(voice)
    if (approved.length >= MAX_APPROVED_VOICES) break
  }
  return approved
}

/** Pick an installed approved voice: retain a valid choice, otherwise use the first approved voice or refuse. */
export function resolveVoiceChoice(approved: readonly TtsVoice[], voiceId: string | null | undefined): string | null {
  if (typeof voiceId === 'string' && approved.some((voice) => voice.id === voiceId)) return voiceId
  return approved[0]?.id ?? null
}
