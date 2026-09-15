/**
 * Cloud STT language mapping (Nova-3 / Soniox) from Settings.asrLanguage.
 * Shared so main adapter + renderer Listen can pin multilingual auto without importing node:crypto.
 *
 * Product bar (Métis ~60 countries): Auto/multi must cover at least French, English, Spanish,
 * Portuguese, Italian — not French-special-cased only. Explicit Spoken language Settings still win.
 */

/**
 * Nova-3 / Deepgram language query from Settings.asrLanguage.
 *
 * Deepgram defaults `language=en` when omitted — non-English speech then yields empty/weak transcripts,
 * and under CLOUD_ONLY there is no Whisper/Parakeet adaptive follow to recover.
 *
 * - auto / empty → `language=multi` + `detect_language=true` (Nova multilingual codeswitch)
 * - explicit French → `fr-CA` (Ultron / Québec preference; explicit Settings still wins over auto)
 * - other LANGUAGE_NAMES → primary BCP-47 subtag (en, es, pt, it, …)
 * - raw BCP-47 (fr, fr-CA, es, pt-BR, …) passed through with region preserved when present
 * - sticky pin (mid-meeting follow): when Settings is auto and a pin is set, resolve the pin as
 *   an explicit language (detect_language=false) until a switch re-pins
 */
export type Nova3LanguageQuery = {
  language: string
  detect_language: boolean
}

/**
 * Core language hints for Soniox auto/multi — company languages that must never be FR-only.
 * Explicit Settings still send a single ISO code.
 */
export const CORE_SONIOX_AUTO_HINTS: readonly string[] = ['fr', 'en', 'es', 'pt', 'it'] as const

/** Settings display name → Deepgram/Nova language tag. French prefers fr-CA (Québec). */
const NOVA3_LANGUAGE_BY_NAME: Record<string, string> = {
  English: 'en',
  French: 'fr-CA',
  Spanish: 'es',
  German: 'de',
  Italian: 'it',
  Portuguese: 'pt',
  Dutch: 'nl',
  Polish: 'pl',
  Arabic: 'ar',
  Chinese: 'zh',
  Japanese: 'ja',
  Korean: 'ko',
  Hindi: 'hi',
  Russian: 'ru',
  Turkish: 'tr',
  Swedish: 'sv',
  Indonesian: 'id',
  Finnish: 'fi',
  Vietnamese: 'vi',
  Hebrew: 'he',
  Ukrainian: 'uk',
  Greek: 'el',
  Malay: 'ms',
  Czech: 'cs',
  Romanian: 'ro',
  Danish: 'da',
  Hungarian: 'hu',
  Tamil: 'ta',
  Norwegian: 'no',
  Thai: 'th',
  Urdu: 'ur',
  Croatian: 'hr',
  Bulgarian: 'bg',
  Lithuanian: 'lt',
  Catalan: 'ca',
  Slovak: 'sk',
  Telugu: 'te',
  Persian: 'fa',
  Latvian: 'lv',
  Bengali: 'bn',
  Serbian: 'sr',
  Azerbaijani: 'az',
  Slovenian: 'sl',
  Kannada: 'kn',
  Estonian: 'et',
  Macedonian: 'mk',
  Icelandic: 'is',
  Armenian: 'hy',
  Nepali: 'ne',
  Bosnian: 'bs',
  Kazakh: 'kk',
  Albanian: 'sq',
  Swahili: 'sw',
  Galician: 'gl',
  Marathi: 'mr',
  Punjabi: 'pa',
  Sinhala: 'si',
  Khmer: 'km',
  Georgian: 'ka',
  Belarusian: 'be',
  Gujarati: 'gu',
  Amharic: 'am',
  Afrikaans: 'af',
  Tagalog: 'tl',
  Welsh: 'cy',
  Maltese: 'mt',
  Basque: 'eu',
  Luxembourgish: 'lb',
  'Haitian Creole': 'ht',
  Cantonese: 'zh-HK',
  Malayalam: 'ml',
  Mongolian: 'mn'
}

export function resolveNova3LanguageQuery(asrLanguage?: string | null): Nova3LanguageQuery {
  const raw = (asrLanguage ?? 'auto').trim()
  if (!raw || raw.toLowerCase() === 'auto' || raw.toLowerCase() === 'same') {
    return { language: 'multi', detect_language: true }
  }
  if (NOVA3_LANGUAGE_BY_NAME[raw]) {
    return { language: NOVA3_LANGUAGE_BY_NAME[raw], detect_language: false }
  }
  // Case-insensitive display-name match (Settings sometimes lowercases).
  const named = Object.keys(NOVA3_LANGUAGE_BY_NAME).find((k) => k.toLowerCase() === raw.toLowerCase())
  if (named) {
    return { language: NOVA3_LANGUAGE_BY_NAME[named], detect_language: false }
  }
  // Already a BCP-47 / Deepgram code (fr, fr-CA, fr-FR, multi, …).
  if (/^[a-z]{2}(-[A-Za-z0-9]+)*$/i.test(raw) || raw.toLowerCase() === 'multi') {
    const lower = raw.toLowerCase()
    if (lower === 'multi') return { language: 'multi', detect_language: true }
    // Bare `fr` → Québec preference; explicit fr-CA / fr-FR / fr-BE keep their region.
    if (lower === 'fr') return { language: 'fr-CA', detect_language: false }
    const parts = raw.split('-')
    const tag = parts.length === 1
      ? parts[0]!.toLowerCase()
      : `${parts[0]!.toLowerCase()}-${parts.slice(1).join('-')}`
    return { language: tag, detect_language: false }
  }
  // Unknown → multilingual detect rather than inventing English.
  return { language: 'multi', detect_language: true }
}

/**
 * Sticky pin for cloud Nova path: when Settings is auto and a mid-meeting pin exists
 * (from whisper/parakeet-style probes or provider language tags), resolve the pin as explicit.
 * Explicit Spoken language Settings always win over the pin.
 */
export function resolveNova3LanguageQueryPinned(
  asrLanguage?: string | null,
  pinnedLang?: string | null
): Nova3LanguageQuery {
  const settings = (asrLanguage ?? 'auto').trim() || 'auto'
  const pin = (pinnedLang ?? '').trim()
  if (pin && (!settings || settings.toLowerCase() === 'auto' || settings.toLowerCase() === 'same')) {
    return resolveNova3LanguageQuery(pin)
  }
  return resolveNova3LanguageQuery(asrLanguage)
}

/**
 * Soniox websocket start config language_hints from Settings.asrLanguage.
 * Auto → core multilingual hints (fr/en/es/pt/it); explicit → single ISO code.
 */
export type SonioxLanguageConfig = {
  language_hints: string[]
  /** True when Settings left language on auto/detect. */
  autoDetect: boolean
}

export function resolveSonioxLanguageConfig(asrLanguage?: string | null): SonioxLanguageConfig {
  const nova = resolveNova3LanguageQuery(asrLanguage)
  if (nova.detect_language || nova.language === 'multi') {
    // Cost-first multilingual bias across company languages — never English-only, never FR-only.
    return { language_hints: [...CORE_SONIOX_AUTO_HINTS], autoDetect: true }
  }
  const primary = nova.language.split('-')[0]!.toLowerCase()
  return { language_hints: [primary], autoDetect: false }
}

/** Sticky pin for Soniox: same rules as Nova pin helper. */
export function resolveSonioxLanguageConfigPinned(
  asrLanguage?: string | null,
  pinnedLang?: string | null
): SonioxLanguageConfig {
  const settings = (asrLanguage ?? 'auto').trim() || 'auto'
  const pin = (pinnedLang ?? '').trim()
  if (pin && (!settings || settings.toLowerCase() === 'auto' || settings.toLowerCase() === 'same')) {
    return resolveSonioxLanguageConfig(pin)
  }
  return resolveSonioxLanguageConfig(asrLanguage)
}
