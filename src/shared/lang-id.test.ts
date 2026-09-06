import { describe, it, expect } from 'vitest'
import {
  detectLanguage,
  detectLanguages,
  LANGUAGE_NAMES,
  LANGUAGE_OPTIONS,
  WHISPER_LANGUAGE_TOKENS,
  APPLE_LOCALES
} from './lang-id'

describe('detectLanguage — script-based (unambiguous writing systems)', () => {
  it('detects each non-Latin script', () => {
    expect(detectLanguage('я не знаю, что это очень хорошо').lang).toBe('Russian')
    expect(detectLanguage('هذا جيد جدا شكرا لكم').lang).toBe('Arabic')
    expect(detectLanguage('这是一个很好的会议我们明天继续').lang).toBe('Chinese')
    expect(detectLanguage('これはとても良い会議ですね').lang).toBe('Japanese')
    expect(detectLanguage('이것은 아주 좋은 회의입니다').lang).toBe('Korean')
    expect(detectLanguage('यह बहुत अच्छी बैठक है').lang).toBe('Hindi')
    expect(detectLanguage('นี่คือการประชุมที่ดีมากขอบคุณครับ').lang).toBe('Thai')
    expect(detectLanguage('זה פגישה טובה מאוד תודה רבה').lang).toBe('Hebrew')
    expect(detectLanguage('αυτή είναι μια καλή συνάντηση').lang).toBe('Greek')
  })

  it('reads Japanese as Japanese even when kanji (Han) dominates, as long as kana is present', () => {
    expect(detectLanguage('会議は明日ですね、ありがとうございます').lang).toBe('Japanese')
  })
})

describe('detectLanguage — stopword-based (Latin scripts)', () => {
  it('detects each Latin-script language from a realistic transcript line', () => {
    expect(detectLanguage('então a gente vai ver isso com você, não é? vamos fechar o contrato').lang).toBe('Portuguese')
    expect(detectLanguage('entonces vamos a ver esto con usted, pero no es para hoy').lang).toBe('Spanish')
    expect(detectLanguage("alors nous allons voir ça avec vous, mais pas pour aujourd'hui").lang).toBe('French')
    expect(detectLanguage('so we are going to look at this with you, but not for today').lang).toBe('English')
    expect(detectLanguage('wir haben das nicht mit der neuen Version gemacht, aber das ist gut').lang).toBe('German')
    expect(detectLanguage('allora non è per oggi, ma possiamo vedere questo con il team').lang).toBe('Italian')
    expect(detectLanguage('we hebben dat niet met de nieuwe versie gedaan, maar het is ook goed').lang).toBe('Dutch')
    expect(detectLanguage('nie wiem czy to jest bardzo dobre, ale tak myślę').lang).toBe('Polish')
    expect(detectLanguage('evet bu çok iyi ama daha fazla zaman var mı bilmiyorum').lang).toBe('Turkish')
    expect(detectLanguage('jag är inte säker men vi kan titta på det tillsammans').lang).toBe('Swedish')
    expect(detectLanguage('ini tidak bisa untuk kami dan saya sudah ada waktu').lang).toBe('Indonesian')
  })

  it('discriminates Portuguese from Spanish on their distinctive function words', () => {
    expect(detectLanguage('não sei se você já falou com a gente sobre isso').lang).toBe('Portuguese')
    expect(detectLanguage('no sé si usted ya habló con nosotros pero es muy importante').lang).toBe('Spanish')
  })
})

describe('detectLanguage — conservative nulls (a wrong guess steers the ASR decoder)', () => {
  it('returns null on short, ambiguous, or gibberish text', () => {
    expect(detectLanguage('').lang).toBeNull()
    expect(detectLanguage('ok').lang).toBeNull()
    expect(detectLanguage('de que para').lang).toBeNull()
    expect(detectLanguage('xyzzy blorp fnord glarb').lang).toBeNull()
    expect(detectLanguage('12345 67890 !!!').lang).toBeNull()
  })

  it('requires at least two stopword hits — one shared word is not evidence', () => {
    expect(detectLanguage('contrato assinado ontem à tarde').lang).toBeNull()
  })
})

describe('detectLanguages — mid-utterance code-switch', () => {
  it('flags a window that contains two confident languages', () => {
    const mixed = detectLanguages(
      'então a gente vai ver isso com você, não é? so we are going to look at this with you, but not for today'
    )
    expect(mixed.mixed).toBe(true)
    expect(mixed.langs).toEqual(expect.arrayContaining(['Portuguese', 'English']))
  })

  it('is not mixed on a monoglot French line', () => {
    const one = detectLanguages("alors nous allons voir ça avec vous, mais pas pour aujourd'hui")
    expect(one.primary).toBe('French')
    expect(one.mixed).toBe(false)
  })
})

describe('LANGUAGE_NAMES contract — 60+ Whisper tokens, one list', () => {
  it('covers 60+ spoken languages', () => {
    expect(LANGUAGE_NAMES.length).toBeGreaterThanOrEqual(60)
  })

  it('every name lowercased is a valid Whisper language token', () => {
    for (const name of LANGUAGE_NAMES) {
      expect(WHISPER_LANGUAGE_TOKENS.has(name.toLowerCase()), name).toBe(true)
    }
  })

  it('Settings and Apple Speech consume the same list (no parallel copies)', () => {
    expect(LANGUAGE_OPTIONS).toBe(LANGUAGE_NAMES)
    for (const name of LANGUAGE_NAMES) {
      expect(APPLE_LOCALES[name], name).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/)
    }
  })
})
