import { describe, expect, it } from 'vitest'
import type { DesktopActionRequest } from '../desktop-actions'
import { looksLikeQuestion, parseVoiceUtterance, startsWithActionVerb, type VoiceUtterance } from './voice-grammar'

const action = (request: DesktopActionRequest): VoiceUtterance => ({ kind: 'action', request })
const openNotes = action({ id: 'desktop.open_notes', args: {} })
const openArc = action({ id: 'desktop.open_arc', args: {} })
const openX = action({ id: 'desktop.open_x', args: {} })
const photo = action({ id: 'desktop.photo_booth_capture', args: {} })
const search = (q: string, browser?: 'arc'): VoiceUtterance =>
  action({ id: 'desktop.google_search', args: browser ? { q, browser } : { q } })
const note = (title: string, body?: string): VoiceUtterance =>
  action({ id: 'desktop.create_note', args: body === undefined ? { title } : { title, body } })

describe('voice grammar: open (en, fr, pt, es)', () => {
  it.each<[string, VoiceUtterance]>([
    ['open notes', openNotes],
    ['Open Notes.', openNotes],
    ['please open the notes app', openNotes],
    ['could you open Apple Notes', openNotes],
    ['launch notes', openNotes],
    ['ouvre notes', openNotes],
    ['Ouvre le bloc-notes', openNotes],
    ["ouvre l'application Notes", openNotes],
    ['abre notas', openNotes],
    ['abre o aplicativo de notas', openNotes],
    ['Abre las notas', openNotes],
    ['open arc', openArc],
    ['open the Arc browser', openArc],
    ['ouvre Arc', openArc],
    ['abre o navegador Arc', openArc],
    ['open x', openX],
    ['open twitter', openX],
    ['open x.com', openX],
    ['ouvre Twitter', openX],
    ['abre twitter', openX],
    ['abra o X', openX]
  ])('%s', (text, expected) => {
    expect(parseVoiceUtterance(text)).toEqual(expected)
  })

  it('names Arc only when it was said', () => {
    expect(parseVoiceUtterance('open x in Arc')).toEqual(action({ id: 'desktop.open_x', args: { browser: 'arc' } }))
    expect(parseVoiceUtterance('open x')).toEqual(openX)
  })

  it('an app outside the catalog is unsupported, never guessed', () => {
    for (const text of ['open spotify', 'ouvre Spotify', 'abre o Spotify', 'open notes and open arc', 'open']) {
      expect(parseVoiceUtterance(text).kind, text).toBe('unsupported')
    }
  })
})

describe('voice grammar: search (en, fr, pt, es)', () => {
  it.each<[string, VoiceUtterance]>([
    ['search for Norbert Wiener', search('Norbert Wiener')],
    ['Search Google for cybernetics', search('cybernetics')],
    ['google norbert wiener', search('norbert wiener')],
    ['look up the weather in Lisbon', search('the weather in Lisbon')],
    ['search cybernetics on Google', search('cybernetics')],
    ['cherche Norbert Wiener', search('Norbert Wiener')],
    ['recherche sur Google la cybernétique', search('la cybernétique')],
    ['Cherche météo à Paris sur Google', search('météo à Paris')],
    ['pesquisa Norbert Wiener', search('Norbert Wiener')],
    ['procura receitas de bolo', search('receitas de bolo')],
    ['pesquise no Google por cibernética', search('cibernética')],
    ['busca Norbert Wiener', search('Norbert Wiener')],
    ['googlea cibernética', search('cibernética')],
    ['busca en Google recetas de paella', search('recetas de paella')],
    ['search for cybernetics in Arc', search('cybernetics', 'arc')],
    ['cherche cybernétique dans Arc', search('cybernétique', 'arc')]
  ])('%s', (text, expected) => {
    expect(parseVoiceUtterance(text)).toEqual(expected)
  })

  it("a search about the person's own things is a question, not a web search", () => {
    for (const text of ['search my notes for the budget', 'cherche mes notes sur le budget', 'procura meus arquivos']) {
      expect(parseVoiceUtterance(text).kind, text).toBe('question')
    }
    // Naming Google makes it a web search again.
    expect(parseVoiceUtterance('google my name')).toEqual(search('my name'))
  })

  it('asks for the missing query instead of searching for nothing', () => {
    expect(parseVoiceUtterance('search')).toEqual({ kind: 'incomplete', missing: 'query' })
    expect(parseVoiceUtterance('google')).toEqual({ kind: 'incomplete', missing: 'query' })
  })

  it('bounds the query at 200 characters', () => {
    expect(parseVoiceUtterance(`search for ${'a'.repeat(200)}`).kind).toBe('action')
    expect(parseVoiceUtterance(`search for ${'a'.repeat(201)}`)).toEqual({ kind: 'incomplete', missing: 'too_long' })
  })
})

describe('voice grammar: create a note (en, fr, pt, es)', () => {
  it.each<[string, VoiceUtterance]>([
    ['create a note called Groceries', note('Groceries')],
    ['create a new note titled Shopping list', note('Shopping list')],
    ['make a note called Ideas saying buy milk and eggs', note('Ideas', 'buy milk and eggs')],
    ['new note called Plan', note('Plan')],
    ['crée une note intitulée Courses', note('Courses')],
    ['Crée une nouvelle note intitulée Idées disant acheter du lait', note('Idées', 'acheter du lait')],
    ['nouvelle note appelée Projet', note('Projet')],
    ['cria uma nota chamada Compras', note('Compras')],
    ['cria uma nova nota intitulada Ideias dizendo comprar leite', note('Ideias', 'comprar leite')],
    ['nova nota chamada Plano', note('Plano')],
    ['crea una nota llamada Compras', note('Compras')],
    ['crea una nueva nota titulada Ideas diciendo comprar leche', note('Ideas', 'comprar leche')],
    ['nueva nota llamada Plan', note('Plan')]
  ])('%s', (text, expected) => {
    expect(parseVoiceUtterance(text)).toEqual(expected)
  })

  it('a note needs a title', () => {
    for (const text of [
      'create a note',
      'crée une note',
      'cria uma nota',
      'crea una nota',
      'create a note saying buy milk'
    ]) {
      expect(parseVoiceUtterance(text), text).toEqual({ kind: 'incomplete', missing: 'title' })
    }
  })

  it('bounds the title at 120 characters and the body at 2000', () => {
    expect(parseVoiceUtterance(`create a note called ${'t'.repeat(120)}`).kind).toBe('action')
    expect(parseVoiceUtterance(`create a note called ${'t'.repeat(121)}`)).toEqual({
      kind: 'incomplete',
      missing: 'too_long'
    })
    expect(parseVoiceUtterance(`create a note called Long saying ${'b'.repeat(2001)}`)).toEqual({
      kind: 'incomplete',
      missing: 'too_long'
    })
  })
})

describe('voice grammar: photo (en, fr, pt, es)', () => {
  it.each([
    'take a photo',
    'take a picture',
    'take a selfie',
    'prends une photo',
    'tira uma foto',
    'toma una foto',
    'take a picture with Photo Booth'
  ])('%s', (text) => {
    expect(parseVoiceUtterance(text)).toEqual(photo)
  })

  it('a picture of something else is not a Photo Booth capture', () => {
    expect(parseVoiceUtterance('take a picture of my screen').kind).toBe('unsupported')
  })
})

describe('voice grammar: slots are verbatim', () => {
  it('keeps accents, quotes, emoji and case exactly', () => {
    expect(parseVoiceUtterance('create a note called Café “Été” 😀 Ünïcode')).toEqual(note('Café “Été” 😀 Ünïcode'))
    expect(parseVoiceUtterance('search for naïve Bayes "quoted" 🚀')).toEqual(search('naïve Bayes "quoted" 🚀'))
  })

  it('strips only one matched pair of outer quotes and trailing sentence punctuation', () => {
    expect(parseVoiceUtterance('create a note called "Groceries".')).toEqual(note('Groceries'))
    expect(parseVoiceUtterance('create a note called «Courses»')).toEqual(note('Courses'))
    expect(parseVoiceUtterance('create a note called “He said “hi””')).toEqual(note('He said “hi”'))
    expect(parseVoiceUtterance("create a note called Don't panic!")).toEqual(note("Don't panic"))
  })

  it('the wake word is dropped only at the start, so a title may contain it', () => {
    expect(parseVoiceUtterance('Métis, create a note called Métis roadmap')).toEqual(note('Métis roadmap'))
    expect(parseVoiceUtterance('Hey Metis open notes')).toEqual(openNotes)
    expect(parseVoiceUtterance('create a note called Métis')).toEqual(note('Métis'))
  })

  it('treats shell and script syntax as plain text in a slot', () => {
    const hostile = 'x" & do shell script "rm -rf ~" & "'
    expect(parseVoiceUtterance(`create a note called ${hostile}`)).toEqual(note(hostile))
    expect(parseVoiceUtterance('create a note called end tell; do shell script "id"')).toEqual(
      note('end tell; do shell script "id"')
    )
  })

  it('rejects a title with a control character or a bidirectional override', () => {
    expect(parseVoiceUtterance('create a note called a\u202eb').kind).toBe('unsupported')
    expect(parseVoiceUtterance('create a note called a\u0007b').kind).toBe('unsupported')
  })
})

describe('voice grammar: negation and cancellation', () => {
  it.each([
    'never mind',
    "don't open notes",
    'actually do not',
    'open notes actually do not',
    'cancel that',
    'laisse tomber',
    'annule ça',
    'deixa pra lá',
    'esquece isso',
    'olvídalo',
    'cancela eso'
  ])('%s', (text) => {
    expect(parseVoiceUtterance(text)).toEqual({ kind: 'cancelled' })
  })
})

describe('voice grammar: questions and the rest', () => {
  it.each([
    'what is the capital of Portugal',
    'How do I export a meeting?',
    'why is the sky blue',
    'who wrote this',
    "qu'est-ce que la cybernétique",
    'comment ça marche',
    'pourquoi le ciel est bleu',
    'o que é cibernética',
    'como funciona',
    'por que o céu é azul',
    'qué es la cibernética',
    'cómo funciona',
    'is this correct?'
  ])('question: %s', (text) => {
    expect(parseVoiceUtterance(text)).toEqual({ kind: 'question', text })
    expect(looksLikeQuestion(text)).toBe(true)
  })

  it('an action verb with no catalog match is unsupported, not a question', () => {
    for (const text of [
      'delete my email',
      'send a message to Ana',
      'supprime mon e-mail',
      'envia uma mensagem',
      'borra mi correo',
      'close the window',
      'schedule a meeting tomorrow'
    ]) {
      expect(parseVoiceUtterance(text).kind, text).toBe('unsupported')
      expect(startsWithActionVerb(text), text).toBe(true)
    }
  })

  it('unrecognised plain text is neither a question nor an action', () => {
    expect(parseVoiceUtterance('the meeting went well')).toEqual({ kind: 'none' })
    expect(parseVoiceUtterance('')).toEqual({ kind: 'none' })
    expect(parseVoiceUtterance('x'.repeat(5000))).toEqual({ kind: 'none' })
  })

  it('"can you open notes?" is an action even with a question mark', () => {
    expect(parseVoiceUtterance('can you open notes?')).toEqual(openNotes)
  })
})
