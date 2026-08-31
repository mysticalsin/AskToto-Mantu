/**
 * Tiny on-device language identification for transcript text — no model, no network, ~O(words).
 *
 * Two mechanisms, matching how languages actually differ in a transcript:
 *   1. Script detection for languages whose writing system is unambiguous. Kana is checked before Han
 *      so Japanese text (which mixes kanji + kana) never reads as Chinese.
 *   2. Stopword scoring for Latin-script (and same-script family) languages: count high-frequency
 *      function words. A confident answer needs ≥2 hits AND a strict winner — otherwise null.
 *
 * Deliberately conservative: `null` means "don't know", and every consumer treats null as "no signal"
 * (no line tag, no decode re-pin, no transcript marker). A wrong guess is far worse than no guess here,
 * because the whisper worker uses this to steer which language it DECODES subsequent windows in.
 *
 * The language list is 60+ spoken languages. Every name lowercased is a valid Whisper language token —
 * the worker relies on that (whisper.worker.ts) and apple-speech.ts maps the same names to
 * SFSpeechRecognizer locales. Add a language in this file (names + detection + Apple locale) or not at all.
 * Settings consumes LANGUAGE_NAMES; it does not keep a parallel list.
 */

/** Official Whisper tokenizer language names (lowercase). LANGUAGE_NAMES must be a subset. */
export const WHISPER_LANGUAGE_TOKENS = new Set([
  'afrikaans', 'albanian', 'amharic', 'arabic', 'armenian', 'assamese', 'azerbaijani', 'bashkir',
  'basque', 'belarusian', 'bengali', 'bosnian', 'breton', 'bulgarian', 'burmese', 'cantonese',
  'catalan', 'chinese', 'croatian', 'czech', 'danish', 'dutch', 'english', 'estonian', 'faroese',
  'finnish', 'french', 'galician', 'georgian', 'german', 'greek', 'gujarati', 'haitian creole',
  'hausa', 'hawaiian', 'hebrew', 'hindi', 'hungarian', 'icelandic', 'indonesian', 'italian',
  'japanese', 'javanese', 'kannada', 'kazakh', 'khmer', 'korean', 'lao', 'latin', 'latvian',
  'lingala', 'lithuanian', 'luxembourgish', 'macedonian', 'malagasy', 'malay', 'malayalam',
  'maltese', 'maori', 'marathi', 'mongolian', 'myanmar', 'nepali', 'norwegian', 'nynorsk',
  'occitan', 'pashto', 'persian', 'polish', 'portuguese', 'punjabi', 'romanian', 'russian',
  'sanskrit', 'serbian', 'shona', 'sindhi', 'sinhala', 'slovak', 'slovenian', 'somali', 'spanish',
  'sundanese', 'swahili', 'swedish', 'tagalog', 'tajik', 'tamil', 'tatar', 'telugu', 'thai',
  'tibetan', 'turkish', 'turkmen', 'ukrainian', 'urdu', 'uzbek', 'vietnamese', 'welsh', 'yiddish',
  'yoruba'
])

export const LANGUAGE_NAMES = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Arabic',
  'Chinese', 'Japanese', 'Korean', 'Hindi', 'Russian', 'Turkish', 'Swedish', 'Indonesian', 'Finnish',
  'Vietnamese', 'Hebrew', 'Ukrainian', 'Greek', 'Malay', 'Czech', 'Romanian', 'Danish', 'Hungarian',
  'Tamil', 'Norwegian', 'Thai', 'Urdu', 'Croatian', 'Bulgarian', 'Lithuanian', 'Catalan', 'Slovak',
  'Telugu', 'Persian', 'Latvian', 'Bengali', 'Serbian', 'Azerbaijani', 'Slovenian', 'Kannada',
  'Estonian', 'Macedonian', 'Icelandic', 'Armenian', 'Nepali', 'Bosnian', 'Kazakh', 'Albanian',
  'Swahili', 'Galician', 'Marathi', 'Punjabi', 'Sinhala', 'Khmer', 'Georgian', 'Belarusian',
  'Gujarati', 'Amharic', 'Afrikaans', 'Tagalog', 'Welsh', 'Maltese', 'Basque', 'Luxembourgish',
  'Haitian Creole', 'Cantonese', 'Malayalam', 'Mongolian'
] as const
export type LanguageName = (typeof LANGUAGE_NAMES)[number]

/** Settings / Apple Speech consume this — one list, no parallel copies. */
export const LANGUAGE_OPTIONS = LANGUAGE_NAMES

/** Settings' asrLanguage display names → a pragmatic BCP-47 locale for SFSpeechRecognizer. */
export const APPLE_LOCALES: Record<LanguageName, string> = {
  English: 'en-US',
  French: 'fr-FR',
  Spanish: 'es-ES',
  German: 'de-DE',
  Italian: 'it-IT',
  Portuguese: 'pt-BR',
  Dutch: 'nl-NL',
  Polish: 'pl-PL',
  Arabic: 'ar-SA',
  Chinese: 'zh-CN',
  Japanese: 'ja-JP',
  Korean: 'ko-KR',
  Hindi: 'hi-IN',
  Russian: 'ru-RU',
  Turkish: 'tr-TR',
  Swedish: 'sv-SE',
  Indonesian: 'id-ID',
  Finnish: 'fi-FI',
  Vietnamese: 'vi-VN',
  Hebrew: 'he-IL',
  Ukrainian: 'uk-UA',
  Greek: 'el-GR',
  Malay: 'ms-MY',
  Czech: 'cs-CZ',
  Romanian: 'ro-RO',
  Danish: 'da-DK',
  Hungarian: 'hu-HU',
  Tamil: 'ta-IN',
  Norwegian: 'nb-NO',
  Thai: 'th-TH',
  Urdu: 'ur-PK',
  Croatian: 'hr-HR',
  Bulgarian: 'bg-BG',
  Lithuanian: 'lt-LT',
  Catalan: 'ca-ES',
  Slovak: 'sk-SK',
  Telugu: 'te-IN',
  Persian: 'fa-IR',
  Latvian: 'lv-LV',
  Bengali: 'bn-IN',
  Serbian: 'sr-RS',
  Azerbaijani: 'az-AZ',
  Slovenian: 'sl-SI',
  Kannada: 'kn-IN',
  Estonian: 'et-EE',
  Macedonian: 'mk-MK',
  Icelandic: 'is-IS',
  Armenian: 'hy-AM',
  Nepali: 'ne-NP',
  Bosnian: 'bs-BA',
  Kazakh: 'kk-KZ',
  Albanian: 'sq-AL',
  Swahili: 'sw-KE',
  Galician: 'gl-ES',
  Marathi: 'mr-IN',
  Punjabi: 'pa-IN',
  Sinhala: 'si-LK',
  Khmer: 'km-KH',
  Georgian: 'ka-GE',
  Belarusian: 'be-BY',
  Gujarati: 'gu-IN',
  Amharic: 'am-ET',
  Afrikaans: 'af-ZA',
  Tagalog: 'tl-PH',
  Welsh: 'cy-GB',
  Maltese: 'mt-MT',
  Basque: 'eu-ES',
  Luxembourgish: 'lb-LU',
  'Haitian Creole': 'ht-HT',
  Cantonese: 'zh-HK',
  Malayalam: 'ml-IN',
  Mongolian: 'mn-MN'
}

// Order matters: kana before Han (Japanese mixes kanji + kana; Chinese never contains kana).
const SCRIPTS: Array<{ lang: LanguageName; re: RegExp }> = [
  { lang: 'Japanese', re: /[\u3040-\u30ff]/g },
  { lang: 'Chinese', re: /[\u4e00-\u9fff]/g },
  { lang: 'Korean', re: /[\uac00-\ud7af]/g },
  { lang: 'Arabic', re: /[\u0600-\u06ff]/g },
  { lang: 'Hindi', re: /[\u0900-\u097f]/g },
  { lang: 'Russian', re: /[\u0400-\u04ff]/g },
  { lang: 'Thai', re: /[\u0e00-\u0e7f]/g },
  { lang: 'Hebrew', re: /[\u0590-\u05ff]/g },
  { lang: 'Greek', re: /[\u0370-\u03ff]/g },
  { lang: 'Armenian', re: /[\u0530-\u058f]/g },
  { lang: 'Georgian', re: /[\u10a0-\u10ff]/g },
  { lang: 'Tamil', re: /[\u0b80-\u0bff]/g },
  { lang: 'Telugu', re: /[\u0c00-\u0c7f]/g },
  { lang: 'Kannada', re: /[\u0c80-\u0cff]/g },
  { lang: 'Malayalam', re: /[\u0d00-\u0d7f]/g },
  { lang: 'Bengali', re: /[\u0980-\u09ff]/g },
  { lang: 'Gujarati', re: /[\u0a80-\u0aff]/g },
  { lang: 'Punjabi', re: /[\u0a00-\u0a7f]/g },
  { lang: 'Sinhala', re: /[\u0d80-\u0dff]/g },
  { lang: 'Khmer', re: /[\u1780-\u17ff]/g },
  { lang: 'Amharic', re: /[\u1200-\u137f]/g }
]

// High-frequency function words per language. Words shared across languages appear in every set they
// belong to — they inflate all their languages equally, and the distinctive words break the tie.
const STOPWORDS: Record<string, readonly string[]> = {
  English: ['the', 'and', 'is', 'of', 'to', 'that', 'it', 'you', 'for', 'we', 'this', 'have', 'are',
    'what', 'not', 'with', 'be', 'on', 'so', 'but', 'yes', 'okay', 'thanks', 'about', 'going'],
  French: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'que', 'qui', 'pas', 'vous', 'nous', 'dans',
    'pour', 'ce', 'je', 'sur', 'avec', 'une', 'un', 'mais', 'oui', 'alors', 'donc', 'très', 'merci',
    'être', 'fait', 'ça'],
  Spanish: ['el', 'los', 'las', 'de', 'es', 'que', 'en', 'un', 'una', 'por', 'para', 'con', 'no', 'se',
    'lo', 'pero', 'como', 'muy', 'esto', 'está', 'gracias', 'entonces', 'también', 'hay', 'sí'],
  German: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'wir', 'ein', 'eine', 'mit', 'für', 'auf',
    'zu', 'haben', 'aber', 'ja', 'auch', 'den', 'dem', 'was', 'sie', 'wie'],
  Italian: ['il', 'lo', 'gli', 'di', 'che', 'per', 'con', 'non', 'una', 'sono', 'ma', 'come', 'anche',
    'però', 'allora', 'quindi', 'grazie', 'più', 'questo', 'della', 'nel', 'si'],
  Portuguese: ['os', 'as', 'de', 'do', 'da', 'dos', 'das', 'que', 'em', 'um', 'uma', 'para', 'com',
    'não', 'se', 'mas', 'isso', 'você', 'está', 'vamos', 'gente', 'então', 'já', 'obrigado', 'também',
    'muito', 'pra', 'tem', 'foi'],
  Dutch: ['de', 'het', 'een', 'en', 'is', 'van', 'dat', 'niet', 'ik', 'we', 'met', 'voor', 'op', 'maar',
    'ook', 'ja', 'wat', 'zijn', 'aan', 'dus'],
  Polish: ['nie', 'to', 'się', 'jest', 'że', 'na', 'do', 'ale', 'jak', 'tak', 'czy', 'co', 'po',
    'bardzo', 'dziękuję', 'być', 'już', 'tego'],
  Turkish: ['ve', 'bir', 'bu', 'için', 'ama', 'evet', 'çok', 'daha', 'ne', 'ben', 'biz', 'var', 'yok',
    'tamam', 'gibi', 'sen', 'de', 'da', 'mı'],
  Swedish: ['och', 'det', 'att', 'är', 'för', 'inte', 'jag', 'vi', 'på', 'som', 'har', 'men', 'om',
    'kan', 'var', 'ska', 'till'],
  Indonesian: ['dan', 'yang', 'itu', 'ini', 'tidak', 'dengan', 'untuk', 'kami', 'ada', 'dari', 'sudah',
    'bisa', 'saya', 'akan', 'juga'],
  Finnish: ['ja', 'on', 'ei', 'että', 'se', 'hän', 'mutta', 'oli', 'kun', 'niin', 'minä', 'me', 'tämä'],
  Vietnamese: ['và', 'của', 'là', 'không', 'trong', 'một', 'các', 'có', 'được', 'này', 'với', 'cho'],
  Malay: ['dan', 'yang', 'ini', 'itu', 'tidak', 'untuk', 'dengan', 'ada', 'kami', 'saya', 'akan'],
  Czech: ['a', 'je', 'to', 'se', 'na', 'že', 'jsem', 'ale', 'jako', 'pro', 'jsme', 'nebo', 'když'],
  Romanian: ['și', 'este', 'pentru', 'nu', 'care', 'din', 'cu', 'un', 'o', 'că', 'sunt', 'mai'],
  Danish: ['og', 'det', 'er', 'at', 'ikke', 'på', 'for', 'jeg', 'vi', 'har', 'med', 'til', 'som'],
  Hungarian: ['és', 'a', 'az', 'hogy', 'nem', 'egy', 'van', 'de', 'ez', 'meg', 'már', 'volt'],
  Norwegian: ['og', 'det', 'er', 'ikke', 'på', 'at', 'jeg', 'vi', 'for', 'har', 'med', 'til', 'som'],
  Croatian: ['i', 'je', 'se', 'da', 'na', 'ne', 'su', 'za', 'to', 'ali', 'sam', 'smo', 'kako'],
  Lithuanian: ['ir', 'yra', 'kad', 'tai', 'su', 'ne', 'kaip', 'bet', 'ar', 'mes', 'jūs'],
  Catalan: ['el', 'la', 'els', 'les', 'que', 'amb', 'per', 'no', 'és', 'un', 'una', 'del', 'com'],
  Slovak: ['a', 'je', 'to', 'sa', 'na', 'že', 'som', 'ale', 'ako', 'pre', 'sme', 'nie'],
  Latvian: ['un', 'ir', 'ka', 'ar', 'nav', 'tas', 'bet', 'kā', 'mēs', 'jūs', 'šis'],
  Serbian: ['i', 'je', 'se', 'da', 'na', 'ne', 'su', 'za', 'to', 'ali', 'sam', 'smo'],
  Azerbaijani: ['və', 'bir', 'bu', 'üçün', 'amma', 'yox', 'var', 'mən', 'biz', 'də'],
  Slovenian: ['in', 'je', 'se', 'da', 'na', 'ne', 'za', 'to', 'ali', 'sem', 'smo', 'kot'],
  Estonian: ['ja', 'on', 'et', 'ei', 'see', 'aga', 'kui', 'me', 'sa', 'oli', 'ka'],
  Macedonian: ['и', 'е', 'се', 'да', 'на', 'не', 'за', 'тоа', 'но', 'сум'],
  Icelandic: ['og', 'er', 'að', 'ekki', 'það', 'á', 'við', 'ég', 'fyrir', 'með'],
  Bosnian: ['i', 'je', 'se', 'da', 'na', 'ne', 'su', 'za', 'to', 'ali', 'sam'],
  Albanian: ['dhe', 'është', 'në', 'për', 'nuk', 'që', 'me', 'një', 'por', 'si'],
  Swahili: ['na', 'ya', 'wa', 'ni', 'kwa', 'si', 'lakini', 'hii', 'sisi', 'yake'],
  Galician: ['e', 'o', 'a', 'de', 'que', 'en', 'non', 'por', 'unha', 'como', 'mais'],
  Afrikaans: ['en', 'die', 'is', 'van', 'nie', 'dit', 'met', 'vir', 'op', 'maar', 'ons'],
  Tagalog: ['ang', 'ng', 'sa', 'na', 'ay', 'mga', 'hindi', 'ko', 'kami', 'para'],
  Welsh: ['yn', 'y', 'a', 'i', 'o', 'yr', 'bod', 'mae', 'nid', 'ond', 'gyda'],
  Maltese: ['u', 'li', 'ta', 'il', 'ma', 'għal', 'dan', 'kien', 'mhux'],
  Basque: ['eta', 'da', 'ez', 'bat', 'hori', 'baina', 'ere', 'nire', 'gure'],
  Luxembourgish: ['an', 'ass', 'dat', 'net', 'ech', 'mir', 'mat', 'fir', 'awer'],
  'Haitian Creole': ['ak', 'yo', 'li', 'nan', 'pou', 'pa', 'nou', 'sa', 'se', 'ki'],
  Ukrainian: ['не', 'що', 'це', 'як', 'ми', 'ви', 'але', 'так', 'він', 'вона', 'є'],
  Bulgarian: ['не', 'съм', 'това', 'които', 'за', 'от', 'ще', 'сме', 'те'],
  Belarusian: ['не', 'што', 'гэта', 'як', 'мы', 'вы', 'але', 'ёсць'],
  Kazakh: ['және', 'бұл', 'үшін', 'емес', 'бар', 'жоқ', 'мен', 'біз'],
  Mongolian: ['ба', 'нь', 'биш', 'энэ', 'бид', 'юу', 'гэж'],
  Persian: ['است', 'که', 'این', 'را', 'های', 'برای', 'با', 'من', 'ما'],
  Urdu: ['ہے', 'اور', 'یہ', 'کے', 'میں', 'کو', 'نے', 'ہم', 'آپ'],
  Arabic: ['في', 'من', 'على', 'هذا', 'التي', 'أن', 'إلى', 'كان', 'ما']
}

const WORD_INDEX = new Map<string, LanguageName[]>()
for (const [lang, words] of Object.entries(STOPWORDS)) {
  for (const w of words) {
    const entry = WORD_INDEX.get(w)
    if (entry) entry.push(lang as LanguageName)
    else WORD_INDEX.set(w, [lang as LanguageName])
  }
}

const MIN_HITS = 2

export interface DetectedLanguage {
  lang: LanguageName | null
  /** Stopword occurrences for the winner (0 for script-detected and null results). */
  hits: number
}

export interface DetectedLanguages {
  /** Strict single winner — same as detectLanguage().lang. */
  primary: LanguageName | null
  /** Every language that cleared the conservative bar in this window (1+). */
  langs: LanguageName[]
  /** True when two (or more) languages are confidently present — mid-utterance code-switch. */
  mixed: boolean
}

function scoreStopwords(text: string): Map<LanguageName, number> {
  const tokens = text.toLowerCase().split(/[^\p{L}]+/u)
  const counts = new Map<LanguageName, number>()
  for (const tok of tokens) {
    const langs = WORD_INDEX.get(tok)
    if (!langs) continue
    for (const lang of langs) counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  return counts
}

function rankedStopwords(counts: Map<LanguageName, number>): Array<{ lang: LanguageName; hits: number }> {
  return [...counts.entries()]
    .map(([lang, hits]) => ({ lang, hits }))
    .filter((row) => row.hits >= MIN_HITS)
    .sort((a, b) => b.hits - a.hits)
}

function scriptHits(text: string, letters: number): Array<{ lang: LanguageName; ratio: number }> {
  const out: Array<{ lang: LanguageName; ratio: number }> = []
  for (const { lang, re } of SCRIPTS) {
    const count = text.match(re)?.length ?? 0
    const ratio = count / letters
    if (ratio >= 0.2) out.push({ lang, ratio })
  }
  return out.sort((a, b) => b.ratio - a.ratio)
}

export function detectLanguage(text: string): DetectedLanguage {
  const all = detectLanguages(text)
  if (!all.primary) return { lang: null, hits: 0 }
  return { lang: all.primary, hits: all.mixed ? 0 : 1 }
}

/**
 * Detect every confident language in a window. Mid-sentence code-switch surfaces as `mixed: true`
 * with two (or more) langs — the live pin uses that as strong evidence of the *new* language
 * without waiting for a second monoglot window.
 */
export function detectLanguages(text: string): DetectedLanguages {
  const letters = text.match(/\p{L}/gu)
  if (!letters || letters.length < 4) return { primary: null, langs: [], mixed: false }

  const scripts = scriptHits(text, letters.length)
  const ranked = rankedStopwords(scoreStopwords(text))

  const langs: LanguageName[] = []
  const seen = new Set<LanguageName>()
  const add = (lang: LanguageName): void => {
    if (seen.has(lang)) return
    seen.add(lang)
    langs.push(lang)
  }

  // Dominant unambiguous script (≥30%) pins that language unless a same-script stopword winner exists
  // (Cyrillic → Ukrainian vs Russian; Arabic script → Persian vs Arabic).
  const hasJapanese = scripts.some((s) => s.lang === 'Japanese' && s.ratio >= 0.3)
  for (const s of scripts) {
    if (s.ratio < 0.3) continue
    if (s.lang === 'Chinese' && hasJapanese) continue
    add(s.lang)
  }
  for (const row of ranked) add(row.lang)
  // Weaker script presence still counts toward mixed when paired with Latin stopwords.
  // Japanese mixes kanji + kana — Han hits are not a second language.
  for (const s of scripts) {
    if (s.lang === 'Chinese' && seen.has('Japanese')) continue
    add(s.lang)
  }

  if (langs.length === 0) return { primary: null, langs: [], mixed: false }

  let primary: LanguageName | null = langs[0]
  if (ranked.length >= 1) {
    const best = ranked[0]
    const runner = ranked[1]
    // Strict winner required: a tie (Spanish vs Portuguese sharing 'que de para…') is "don't know".
    if (runner && best.hits === runner.hits && scripts.length === 0) {
      return { primary: null, langs: [], mixed: false }
    }
    primary = best.lang
  }

  const mixed = langs.length >= 2
  return { primary, langs, mixed }
}

export function isWhisperLanguageName(name: string): name is LanguageName {
  return (LANGUAGE_NAMES as readonly string[]).includes(name)
}
