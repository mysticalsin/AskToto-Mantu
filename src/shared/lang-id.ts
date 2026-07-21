/**
 * Tiny on-device language identification for transcript text — no model, no network, ~O(words).
 *
 * Two mechanisms, matching how languages actually differ in a transcript:
 *   1. Script detection for languages whose writing system is unambiguous (Arabic, Chinese, Japanese,
 *      Korean, Hindi, Russian): if ≥30% of the letters are in that script, that's the language. Kana is
 *      checked before Han so Japanese text (which mixes kanji + kana) never reads as Chinese.
 *   2. Stopword scoring for Latin-script languages: count occurrences of each language's high-frequency
 *      function words. A confident answer needs ≥2 hits AND a strict winner — otherwise null.
 *
 * Deliberately conservative: `null` means "don't know", and every consumer treats null as "no signal"
 * (no line tag, no decode re-pin, no transcript marker). A wrong guess is far worse than no guess here,
 * because the whisper worker uses this to steer which language it DECODES subsequent windows in.
 *
 * The language list mirrors Settings' LANGUAGE_OPTIONS and every name is a valid Whisper language token
 * when lowercased — the worker relies on that (whisper.worker.ts) and apple-speech.ts maps the same
 * names to SFSpeechRecognizer locales. Add a language in all three places or not at all.
 */

export const LANGUAGE_NAMES = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Dutch',
  'Polish', 'Arabic', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Russian', 'Turkish'
] as const
export type LanguageName = (typeof LANGUAGE_NAMES)[number]

// Order matters: kana before Han (Japanese mixes kanji + kana; Chinese never contains kana).
const SCRIPTS: Array<{ lang: LanguageName; re: RegExp }> = [
  { lang: 'Japanese', re: /[぀-ヿ]/g },
  { lang: 'Chinese', re: /[一-鿿]/g },
  { lang: 'Korean', re: /[가-힯]/g },
  { lang: 'Arabic', re: /[؀-ۿ]/g },
  { lang: 'Hindi', re: /[ऀ-ॿ]/g },
  { lang: 'Russian', re: /[Ѐ-ӿ]/g }
]

// High-frequency function words per Latin-script language. Words shared across languages ('de', 'que',
// 'para') appear in every set they belong to — they inflate all their languages equally, and the
// distinctive words ('não', 'pero', 'avec', 'nicht') break the tie. Single letters are excluded
// (lowercased English 'I' would collide with Polish 'i', Portuguese 'e' with Italian 'e', …).
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
    'tamam', 'gibi', 'sen', 'de', 'da', 'mı']
}

// word → every language claiming it, built once at module load.
const WORD_INDEX = new Map<string, LanguageName[]>()
for (const [lang, words] of Object.entries(STOPWORDS)) {
  for (const w of words) {
    const entry = WORD_INDEX.get(w)
    if (entry) entry.push(lang as LanguageName)
    else WORD_INDEX.set(w, [lang as LanguageName])
  }
}

const MIN_HITS = 2 // fewer stopword hits than this = no confident answer

export interface DetectedLanguage {
  lang: LanguageName | null
  /** Stopword occurrences for the winner (0 for script-detected and null results). */
  hits: number
}

export function detectLanguage(text: string): DetectedLanguage {
  const letters = text.match(/\p{L}/gu)
  if (!letters || letters.length < 4) return { lang: null, hits: 0 }

  for (const { lang, re } of SCRIPTS) {
    const count = text.match(re)?.length ?? 0
    if (count / letters.length >= 0.3) return { lang, hits: 0 }
  }

  const tokens = text.toLowerCase().split(/[^\p{L}]+/u)
  const counts = new Map<LanguageName, number>()
  for (const tok of tokens) {
    const langs = WORD_INDEX.get(tok)
    if (!langs) continue
    for (const lang of langs) counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  let winner: LanguageName | null = null
  let best = 0
  let runnerUp = 0
  for (const [lang, count] of counts) {
    if (count > best) {
      runnerUp = best
      best = count
      winner = lang
    } else if (count > runnerUp) {
      runnerUp = count
    }
  }
  // Strict winner required: a tie (Spanish vs Portuguese sharing 'que de para…') is "don't know".
  if (!winner || best < MIN_HITS || best === runnerUp) return { lang: null, hits: 0 }
  return { lang: winner, hits: best }
}
