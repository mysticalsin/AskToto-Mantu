import { describe, it, expect } from 'vitest'
import { detectLanguage, LANGUAGE_NAMES } from './lang-id'

describe('detectLanguage — script-based (unambiguous writing systems)', () => {
  it('detects each non-Latin script', () => {
    expect(detectLanguage('я не знаю, что это очень хорошо').lang).toBe('Russian')
    expect(detectLanguage('هذا جيد جدا شكرا لكم').lang).toBe('Arabic')
    expect(detectLanguage('这是一个很好的会议我们明天继续').lang).toBe('Chinese')
    expect(detectLanguage('これはとても良い会議ですね').lang).toBe('Japanese')
    expect(detectLanguage('이것은 아주 좋은 회의입니다').lang).toBe('Korean')
    expect(detectLanguage('यह बहुत अच्छी बैठक है').lang).toBe('Hindi')
  })

  it('reads Japanese as Japanese even when kanji (Han) dominates, as long as kana is present', () => {
    // Kana share >=30% here; the kana check runs before Han so this never reads as Chinese.
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
  })

  it('discriminates Portuguese from Spanish on their distinctive function words', () => {
    expect(detectLanguage('não sei se você já falou com a gente sobre isso').lang).toBe('Portuguese')
    expect(detectLanguage('no sé si usted ya habló con nosotros pero es muy importante').lang).toBe('Spanish')
  })
})

describe('detectLanguage — conservative nulls (a wrong guess steers the ASR decoder)', () => {
  it('returns null on short, ambiguous, or gibberish text', () => {
    expect(detectLanguage('').lang).toBeNull()
    expect(detectLanguage('ok').lang).toBeNull() // < 4 letters
    expect(detectLanguage('de que para').lang).toBeNull() // ES/PT/FR tie — strictly ambiguous
    expect(detectLanguage('xyzzy blorp fnord glarb').lang).toBeNull() // no stopword hits
    expect(detectLanguage('12345 67890 !!!').lang).toBeNull() // no letters at all
  })

  it('requires at least two stopword hits — one shared word is not evidence', () => {
    expect(detectLanguage('contrato assinado ontem à tarde').lang).toBeNull()
  })
})

describe('LANGUAGE_NAMES contract', () => {
  it('every name lowercased is a valid Whisper language token shape (the worker relies on this)', () => {
    // Whisper's tokenizer accepts full lowercase English language names; this pins the list against
    // someone adding a display name ('Brazilian Portuguese') the decoder would throw on.
    const whisperNames = new Set([
      'english', 'french', 'spanish', 'german', 'italian', 'portuguese', 'dutch',
      'polish', 'arabic', 'chinese', 'japanese', 'korean', 'hindi', 'russian', 'turkish'
    ])
    for (const name of LANGUAGE_NAMES) expect(whisperNames.has(name.toLowerCase()), name).toBe(true)
  })
})
